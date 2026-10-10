#!/usr/bin/env node
'use strict';
// Karaoke Night server.
//   node server.js [song folder] [port]
// The song folder can also be chosen on the TV's setup screen, which saves it to config.json.
// Serves the TV player at /tv and the phone remote at /, and keeps one shared queue.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readZipIndex, readZipEntry, zipDataStart } = require('./lib/zip');
const { mp3Genre, mp4Info, SAFE_AUDIO, audioName } = require('./lib/media-info');
const audioFix = require('./lib/audio-fix');

const args = process.argv.slice(2);
// Tidy up a folder path typed into a start script: stray spaces, quotes, and a bare drive letter.
function cleanDir(raw) {
  let d = String(raw || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (/^[a-zA-Z]:$/.test(d)) d += '\\'; // "E:" alone means E's current folder on Windows; we want the drive root
  return d;
}
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// Where the songs folder comes from, in order: command line, SONG_DIR in the start file, the setup screen.
// There is no default: if none is set, the TV shows the setup screen.
const sources = [
  [cleanDir(args[0]), 'the command line'],
  [cleanDir(process.env.SONG_DIR), 'SONG_DIR in the start file'],
  [cleanDir(loadConfig().songDir), 'the TV setup screen (config.json)'],
].filter(([d]) => d);
let SONG_DIR = sources.length ? path.resolve(sources[0][0]) : null;
let SONG_DIR_SOURCE = sources.length ? sources[0][1] : 'nothing';

function isFolder(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }
const songDirOk = () => !!SONG_DIR && isFolder(SONG_DIR);
const START_PORT = Number(args[1] || process.env.PORT || 8080);
let PORT = START_PORT; // may move up if the port is taken
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.flac']);
// Karaoke videos with the lyrics in the picture. MP4 (H.264/AAC) plays in every browser; WebM/MKV/MOV in most.
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.cdg': 'application/octet-stream',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
};

/* ---------- Song catalog ---------- */

let songs = [];              // sorted by artist, numbered
let songsByTitle = [];       // same songs sorted by title
let genres = [];             // genres found, for the phone's filter
let songsByKey = new Map();  // stable key -> song (survives rescans)
let scanning = false;

// "SC8125-03 - Queen - Bohemian Rhapsody" -> { artist: 'Queen', title: 'Bohemian Rhapsody' }
function parseName(name) {
  const parts = name.replace(/_/g, ' ').split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 3 && /\d/.test(parts[0]) && !/\s/.test(parts[0])) parts.shift(); // disc code
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { artist: '', title: parts[0] || name };
}

async function scan() {
  if (scanning) return;
  if (!songDirOk()) {
    songs = []; songsByKey = new Map();
    console.log(SONG_DIR
      ? `Can't find the songs folder ${SONG_DIR} (set by ${SONG_DIR_SOURCE}). Choose it on the TV setup screen.`
      : 'No songs folder chosen yet. Open the TV screen to choose one.');
    broadcastState();
    return;
  }
  scanning = true;
  const started = Date.now();
  const pairs = new Map();
  const add = (stemKey, kind, source, name) => {
    const p = pairs.get(stemKey) || { name, stemKey };
    p[kind] = source;
    pairs.set(stemKey, p);
  };

  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (err) { console.warn(`Can't read ${dir}: ${err.message}`); return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      const stem = full.slice(0, -ext.length);
      if (ext === '.cdg') add(stem.toLowerCase(), 'cdg', { file: full, ext }, path.basename(stem));
      else if (AUDIO_EXT.has(ext)) add(stem.toLowerCase(), 'audio', { file: full, ext }, path.basename(stem));
      else if (VIDEO_EXT.has(ext)) add(`${stem}|video`.toLowerCase(), 'video', { file: full, ext }, path.basename(stem));
      else if (ext === '.zip') {
        try {
          for (const z of await readZipIndex(full)) {
            const zext = path.extname(z.name).toLowerCase();
            const kind = zext === '.cdg' ? 'cdg' : AUDIO_EXT.has(zext) ? 'audio' : VIDEO_EXT.has(zext) ? 'video' : null;
            if (!kind) continue;
            const zstem = z.name.slice(0, -zext.length);
            add(`${full}::${zstem}${kind === 'video' ? '|video' : ''}`.toLowerCase(), kind,
              { file: full, entry: z, ext: zext }, path.basename(zstem.split('/').pop()));
          }
        } catch (err) { console.warn(`Skipping ${full}: ${err.message}`); }
      }
    }
  }

  await walk(SONG_DIR);
  const list = [];
  const byKey = new Map();
  for (const p of pairs.values()) {
    if (!p.video && !(p.audio && p.cdg)) continue;
    const key = crypto.createHash('sha1').update(p.stemKey).digest('hex').slice(0, 12);
    const song = p.video
      ? { key, ...parseName(p.name), kind: 'video', video: p.video }
      : { key, ...parseName(p.name), kind: 'cdg', audio: p.audio, cdg: p.cdg };
    song.search = `${song.artist} ${song.title} ${p.name}`.toLowerCase();
    list.push(song);
    byKey.set(key, song);
  }
  await addMetadata(list);
  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  list.sort((a, b) => cmp(a.artist || a.title, b.artist || b.title) || cmp(a.title, b.title));
  list.forEach((s, i) => { s.number = i + 1; });
  songs = list;
  songsByTitle = [...list].sort((a, b) => cmp(a.title, b.title) || cmp(a.artist, b.artist));
  genres = [...new Set(list.map(s => s.genre).filter(Boolean))].sort(cmp);
  songsByKey = byKey;
  scanning = false;
  console.log(`Found ${songs.length} songs in ${SONG_DIR} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  broadcastState();
}

// Genre comes from the file's own tags; otherwise from its top folder, e.g. "Rock/Queen - ....mp3" -> "Rock".
// Videos also get their sound format checked, since some (e.g. Dolby AC-3) play silently in browsers.
// Folder names that describe the files, not the music.
const NOT_A_GENRE = /^(videos?|mp4s?|mp3s?|cdgs?|mp3\s*\+\s*g|zips?|karaoke|songs?|music|tracks?|downloads?|new|misc|other|all|various|unsorted)$/i;
const metaCache = new Map(); // "file|size|mtime" -> { genre, audio }
async function addMetadata(list) {
  const jobs = list.map(song => async () => {
    const src = song.kind === 'video' ? song.video : song.audio;
    const rel = path.relative(SONG_DIR, src.file).split(path.sep);
    let folderGenre = rel.length > 1 ? rel[0].replace(/[_-]+/g, ' ').trim() : '';
    if (NOT_A_GENRE.test(folderGenre)) folderGenre = '';
    let meta = { genre: '', audio: null };
    try {
      const st = await fs.promises.stat(src.file);
      const id = `${src.file}|${src.entry ? src.entry.name : ''}|${st.size}|${st.mtimeMs}`;
      if (metaCache.has(id)) meta = metaCache.get(id);
      else {
        if (song.kind === 'cdg' && src.ext === '.mp3' && !src.entry) meta.genre = await mp3Genre(src.file);
        if (song.kind === 'video' && ['.mp4', '.m4v', '.mov'].includes(src.ext)) {
          const base = src.entry ? await zipDataStart(src.file, src.entry) : 0;
          if (!src.entry || src.entry.method === 0) {
            const info = await mp4Info(src.file, base, src.entry ? src.entry.size : Infinity);
            meta = { genre: info.genre, audio: info.audio };
          }
        } else if (song.kind === 'video' && !src.entry) {
          meta.audio = await audioFix.probeAudio(src.file); // MKV/WebM: only if ffprobe is installed
        }
        metaCache.set(id, meta);
      }
    } catch {}
    song.genre = meta.genre || folderGenre;
    if (song.kind === 'video') {
      song.audioCodec = meta.audio;
      song.needsAudioFix = !!meta.audio && !SAFE_AUDIO.has(meta.audio);
    }
  });
  for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16).map(j => j()));
}

const publicSong = s => ({ key: s.key, number: s.number, artist: s.artist, title: s.title, kind: s.kind, genre: s.genre || '' });

// A-Z index letter for a name: accents removed; digits and symbols go under '#'.
const indexLetter = name => {
  const c = (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
};

function searchSongs({ q = '', kind = 'all', genre = '', sort = 'artist', offset = 0, limit = 50 }) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (sort === 'title' ? songsByTitle : songs).filter(s =>
    (kind === 'all' || s.kind === kind)
    && (!genre || s.genre === genre)
    && words.every(w => s.search.includes(w) || String(s.number) === w));
  const letters = {};
  hits.forEach((s, i) => {
    const L = indexLetter(sort === 'title' ? s.title : (s.artist || s.title));
    if (!(L in letters)) letters[L] = i;
  });
  return {
    total: hits.length, offset, letters, genres,
    counts: { video: songs.filter(s => s.kind === 'video').length, cdg: songs.filter(s => s.kind === 'cdg').length },
    songs: hits.slice(offset, offset + limit).map(publicSong),
  };
}

/* ---------- Queue and live updates ---------- */

let queue = [];          // { id, singer, song: publicSong }
let nowPlaying = null;   // same shape as a queue entry
let status = { state: 'idle', time: 0, duration: 0 };
let nextId = 1;
const listeners = new Set();

const state = () => ({ nowPlaying, queue, status, songCount: songs.length, scanning, setupNeeded: !songDirOk() });

/* ---------- Setup (only from the computer running the server) ---------- */

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function settings() {
  return { songDir: SONG_DIR, source: SONG_DIR_SOURCE, ok: songDirOk(), songCount: songs.length, scanning };
}

// Lists drives (when dir is empty) or the subfolders of dir, for the TV's folder picker.
async function browse(dir) {
  if (!dir) {
    let roots = [];
    if (process.platform === 'win32') {
      for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (isFolder(`${L}:\\`)) roots.push(`${L}:\\`);
    } else {
      for (const base of ['/Volumes', '/media', '/mnt', `/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`]) {
        try {
          for (const e of await fs.promises.readdir(base, { withFileTypes: true }))
            if (e.isDirectory() || e.isSymbolicLink()) roots.push(path.join(base, e.name));
        } catch {}
      }
      roots.push(os.homedir());
    }
    return { dir: '', parent: null, folders: [...new Set(roots)].map(p => ({ name: p, path: p })), songFiles: 0 };
  }
  dir = path.resolve(dir);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const songFiles = entries.filter(e => e.isFile() && /\.(cdg|zip)$/i.test(e.name)).length;
  const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
  return { dir, parent, folders, songFiles };
}

function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of listeners) send(res, event, data); }
function broadcastState() { broadcast('state', state()); }

/* ---------- Media ---------- */

const zipCache = new Map(); // small LRU of extracted zip entries
async function zipBuffer(src) {
  const id = `${src.file}::${src.entry.name}`;
  if (zipCache.has(id)) { const b = zipCache.get(id); zipCache.delete(id); zipCache.set(id, b); return b; }
  const buf = await readZipEntry(src.file, src.entry);
  if (buf.length > 150 * 1024 * 1024) return buf; // too big to keep in memory
  zipCache.set(id, buf);
  while (zipCache.size > 6) zipCache.delete(zipCache.keys().next().value);
  return buf;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
  if (isNaN(start) || start < 0 || start >= size || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

async function sendMedia(req, res, src) {
  const type = MIME[src.ext] || 'application/octet-stream';
  let size, open;
  if (src.entry && src.entry.method === 0) {
    // Stored (uncompressed) zip entry, the usual case for videos: stream straight from the zip.
    const base = await zipDataStart(src.file, src.entry);
    size = src.entry.size;
    open = (start, end) => fs.createReadStream(src.file, { start: base + start, end: base + end });
  } else if (src.entry) {
    const buf = await zipBuffer(src);
    size = buf.length;
    open = (start, end) => ({ pipe: r => r.end(buf.subarray(start, end + 1)) });
  } else {
    size = (await fs.promises.stat(src.file)).size;
    open = (start, end) => fs.createReadStream(src.file, { start, end });
  }
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  const { start, end } = range || { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  open(start, end).pipe(res);
}

/* ---------- HTTP ---------- */

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

async function serveStatic(res, file) {
  try {
    const data = await fs.promises.readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { json(res, 404, { error: 'Not found' }); }
}

// Network addresses phones can use, best first. Computers often have extra virtual adapters
// (VPN, WSL, Hyper-V, Docker, VirtualBox) whose addresses phones can't reach, so those go last.
// To force one, add  "address": "192.168.1.20"  to config.json.
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|vbox|wsl|hyper-v|docker|br-|veth|utun|tun|tap|zerotier|tailscale|hamachi|vpn|loopback|bluetooth/i;
function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      let score = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      if (VIRTUAL_ADAPTER.test(name)) score += 10;
      list.push({ address: a.address, name, score });
    }
  }
  list.sort((x, y) => x.score - y.score);
  const forced = String(loadConfig().address || '').trim();
  if (forced) list.unshift({ address: forced, name: 'config.json', score: -1 });
  return list;
}
function lanUrls() {
  const urls = [...new Set(lanAddresses().map(a => `http://${a.address}:${PORT}`))];
  return urls.length ? urls : [`http://localhost:${PORT}`];
}

/* ---------- YouTube links ---------- */

// Off by default: in testing, YouTube blocked every karaoke video from playing outside youtube.com.
// To try it anyway, add  "youtube": true  to config.json.
const youtubeEnabled = () => loadConfig().youtube === true;

// Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/, m. and music. links.
function youtubeId(link) {
  let u;
  try { u = new URL(String(link || '').trim().replace(/^(?!https?:\/\/)/i, 'https://')); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (/^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname) || [])[2];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

async function youtubeSong(link) {
  const id = youtubeId(link);
  if (!id) return { error: "That doesn't look like a YouTube video link. Copy it from the Share button in YouTube." };
  let title = 'YouTube video', artist = 'YouTube';
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`,
      { signal: AbortSignal.timeout(6000) });
    if (r.status === 401 || r.status === 403) return { error: "This video's owner doesn't allow it to play outside YouTube. Try a different karaoke version." };
    if (r.status === 400 || r.status === 404) return { error: "Can't find that video. It may be private or deleted." };
    if (r.ok) { const j = await r.json(); title = j.title || title; artist = j.author_name || artist; }
  } catch {
    // No internet on this computer, or YouTube didn't answer: still queue it; the TV will report if it can't play.
  }
  return { song: { key: `yt-${id}`, number: 'YT', artist, title, youtube: id } };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && (p === '/' || p === '/remote')) return serveStatic(res, 'remote.html');
  if (m === 'GET' && p === '/tv') return serveStatic(res, 'tv.html');
  if (m === 'GET' && (p === '/cdg.js' || p === '/qrcode.js')) return serveStatic(res, p.slice(1));

  if (m === 'GET' && p === '/api/info') return json(res, 200, { urls: lanUrls(), songCount: songs.length, youtube: youtubeEnabled() });
  if (m === 'GET' && p === '/api/state') return json(res, 200, state());
  if (m === 'GET' && p === '/api/songs') {
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const sp = url.searchParams;
    return json(res, 200, searchSongs({
      q: sp.get('q') || '', kind: ['cdg', 'video'].includes(sp.get('kind')) ? sp.get('kind') : 'all',
      genre: sp.get('genre') || '', sort: sp.get('sort') === 'title' ? 'title' : 'artist', offset, limit,
    }));
  }

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    send(res, 'state', state());
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); listeners.delete(res); });
    return;
  }

  if (m === 'POST' && p === '/api/queue') {
    const body = await readBody(req);
    let song;
    if (body.youtube) {
      if (!youtubeEnabled()) return json(res, 400, { error: 'YouTube links are turned off on this karaoke machine.' });
      const yt = await youtubeSong(body.youtube);
      if (yt.error) return json(res, 400, { error: yt.error });
      song = yt.song;
    } else {
      const found = songsByKey.get(body.key);
      if (!found) return json(res, 404, { error: 'That song is no longer in the catalog.' });
      song = publicSong(found);
      audioFix.request(found); // start fixing silent-video sound now, so it's ready by this singer's turn
    }
    const singer = String(body.singer || '').trim().slice(0, 40) || 'Guest';
    const entry = { id: nextId++, singer, song };
    queue.push(entry);
    broadcastState();
    return json(res, 200, { entry, position: queue.length });
  }

  let qm;
  if (m === 'DELETE' && (qm = /^\/api\/queue\/(\d+)$/.exec(p))) {
    queue = queue.filter(e => e.id !== Number(qm[1]));
    broadcastState();
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && (qm = /^\/api\/queue\/(\d+)\/move$/.exec(p))) {
    const { to, index } = await readBody(req); // to: 'up' | 'down' | 'top', or index: new position (drag and drop)
    const i = queue.findIndex(e => e.id === Number(qm[1]));
    if (i >= 0) {
      const [e] = queue.splice(i, 1);
      const j = Number.isInteger(index) ? Math.max(0, Math.min(queue.length, index))
        : to === 'top' ? 0 : to === 'up' ? Math.max(0, i - 1) : Math.min(queue.length, i + 1);
      queue.splice(j, 0, e);
      broadcastState();
    }
    return json(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/control') {
    const { action } = await readBody(req);
    if (!['pause', 'resume', 'skip', 'restart'].includes(action)) return json(res, 400, { error: 'Unknown action' });
    broadcast('command', { action });
    return json(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/rescan') { scan(); return json(res, 200, { ok: true }); }

  if (p === '/api/settings' || p === '/api/browse') {
    if (!isLocal(req)) return json(res, 403, { error: 'Setup is only available on the computer running Karaoke Night.' });
    if (m === 'GET' && p === '/api/settings') return json(res, 200, settings());
    if (m === 'GET' && p === '/api/browse') {
      try { return json(res, 200, await browse(url.searchParams.get('dir') || '')); }
      catch (err) { return json(res, 400, { error: `Can't open that folder: ${err.message}` }); }
    }
    if (m === 'POST' && p === '/api/settings') {
      const dir = cleanDir((await readBody(req)).songDir);
      if (!dir || !isFolder(path.resolve(dir))) return json(res, 400, { error: `Can't find the folder "${dir}".` });
      SONG_DIR = path.resolve(dir);
      SONG_DIR_SOURCE = 'the TV setup screen (config.json)';
      saveConfig({ ...loadConfig(), songDir: SONG_DIR });
      console.log(`Songs folder changed to ${SONG_DIR}`);
      await scan();
      return json(res, 200, settings());
    }
  }

  // Called by the TV player.
  if (m === 'POST' && p === '/api/player/next') {
    nowPlaying = queue.shift() || null;
    status = { state: nowPlaying ? 'intro' : 'idle', time: 0, duration: 0 };
    broadcastState();
    return json(res, 200, { nowPlaying });
  }
  if (m === 'POST' && p === '/api/player/status') {
    const b = await readBody(req);
    status = { state: String(b.state || 'idle'), time: Number(b.time) || 0, duration: Number(b.duration) || 0 };
    if (status.state === 'idle') nowPlaying = null;
    broadcast('status', status);
    return json(res, 200, { ok: true });
  }

  // The TV asks whether a video's sound is playable / being converted.
  let am;
  if (m === 'GET' && (am = /^\/api\/sound\/([0-9a-f]{12})$/.exec(p))) {
    const song = songsByKey.get(am[1]);
    if (!song) return json(res, 404, { error: 'Song not found' });
    if (audioFix.state(song) === 'pending') audioFix.request(song);
    return json(res, 200, {
      state: audioFix.state(song), error: audioFix.errorFor(song),
      format: song.audioCodec ? audioName(song.audioCodec) : null,
    });
  }

  let mm;
  if ((m === 'GET' || m === 'HEAD') && (mm = /^\/media\/([0-9a-f]{12})\/(audio|cdg|video)$/.exec(p))) {
    const song = songsByKey.get(mm[1]);
    if (!song) return json(res, 404, { error: 'Song not found' });
    if (!song[mm[2]]) return json(res, 404, { error: 'Not found' });
    if (mm[2] === 'video' && audioFix.state(song) === 'ready') return sendMedia(req, res, { file: audioFix.fixedPath(song.key), ext: '.mp4' });
    return sendMedia(req, res, song[mm[2]]);
  }

  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

// If the port is taken (another program, or Karaoke Night already running), try the next ones.
// Windows also reserves some port ranges, which shows up as EACCES.
server.on('error', err => {
  if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && PORT < START_PORT + 20) {
    console.log(`Port ${PORT} is busy, trying ${PORT + 1}...`);
    PORT += 1;
    setTimeout(() => server.listen(PORT), 100);
    return;
  }
  console.error(`\nCould not start the server: ${err.message}`);
  console.error('Close any other Karaoke Night window, or start with a different port, e.g.  node server.js "E:\\Karaoke" 9090');
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\nKaraoke Night is running.');
  console.log(`  Songs folder: ${SONG_DIR || '(not chosen yet)'}   <- set by ${SONG_DIR_SOURCE}`);
  console.log(`  TV screen:    http://localhost:${PORT}/tv`);
  const addrs = lanAddresses();
  if (!addrs.length) console.log(`  Phones:       (no network found; connect this computer to Wi-Fi)`);
  addrs.forEach((a, i) => console.log(i === 0
    ? `  Phones:       http://${a.address}:${PORT}   <- shown on the TV (${a.name})`
    : `  Also:         http://${a.address}:${PORT}   (${a.name})`));
  if (addrs.length > 1) console.log('  If phones can\'t open the TV address, add "address": "<one of the others>" to config.json.');
  const ff = audioFix.init(__dirname, loadConfig().ffmpeg);
  console.log(ff
    ? `  ffmpeg:       found, so videos with sound browsers can't play (e.g. Dolby AC-3) get converted`
    : `  ffmpeg:       not installed. Needed only for videos whose sound plays silent (see README)`);
  console.log('');
  scan();
});
