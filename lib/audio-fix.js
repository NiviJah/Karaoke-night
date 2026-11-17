'use strict';
// Some karaoke videos carry sound that browsers can't play (most often Dolby AC-3 from DVDs): the picture plays,
// the sound is silent. If ffmpeg is installed, we make a copy with the sound converted to AAC (the picture is
// copied as-is, so it's quick) and play that instead. Originals are never changed.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readZipEntry, zipDataStart } = require('./zip');

let ffmpeg = null, ffprobe = null, cacheDir = null;
const jobs = new Map();   // key -> { state: 'converting' | 'failed', error }
const waiting = [];       // songs queued for conversion, one runs at a time
let running = false;

function works(cmd) {
  try { return spawnSync(cmd, ['-version'], { timeout: 8000, windowsHide: true }).status === 0; } catch { return false; }
}

function init(appDir, dataDir, configuredPath) {
  cacheDir = path.join(dataDir, 'converted');
  const candidates = [configuredPath, 'ffmpeg'];
  if (process.platform === 'win32') candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(appDir, 'ffmpeg.exe'));
  else candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(appDir, 'ffmpeg'));
  ffmpeg = candidates.filter(Boolean).find(works) || null;
  if (ffmpeg) {
    const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, m => m.replace(/ffmpeg/i, 'ffprobe'));
    ffprobe = works(probe) ? probe : null;
  }
  return ffmpeg;
}

// For MKV/WebM (which we can't read ourselves): ask ffprobe for the sound format. Returns an MP4-style code.
const PROBE_TO_CODE = { aac: 'mp4a', opus: 'Opus', mp3: '.mp3', flac: 'fLaC', vorbis: 'vorb', ac3: 'ac-3', eac3: 'ec-3', dts: 'dtsc', truehd: 'mlpa' };
function probeAudio(file) {
  if (!ffprobe) return Promise.resolve(null);
  return new Promise(resolve => {
    let out = '';
    const p = spawn(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { windowsHide: true });
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => { const c = out.trim().split(/\s/)[0]; resolve(c ? (PROBE_TO_CODE[c] || (c.startsWith('pcm') ? 'lpcm' : c)) : null); });
  });
}

const fixedPath = key => path.join(cacheDir, `${key}.mp4`);

// 'not-needed' | 'ready' | 'converting' | 'pending' | 'failed' | 'unavailable' (no ffmpeg)
function state(song) {
  if (!song.needsAudioFix) return 'not-needed';
  if (fs.existsSync(fixedPath(song.key))) return 'ready';
  const job = jobs.get(song.key);
  if (job) return job.state;
  return ffmpeg ? 'pending' : 'unavailable';
}
const errorFor = song => jobs.get(song.key)?.error || '';

function request(song) {
  if (state(song) !== 'pending') return;
  jobs.set(song.key, { state: 'converting' });
  waiting.push(song);
  next();
}

function run(args) {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn(ffmpeg, args, { windowsHide: true });
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`)));
  });
}

async function convert(song) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const src = song.video;
  let input = src.file, tempInput = null;
  if (src.entry) { // video inside a zip: ffmpeg needs a real file
    tempInput = path.join(cacheDir, `${song.key}.source${src.ext}`);
    if (src.entry.method === 0) {
      const start = await zipDataStart(src.file, src.entry);
      await new Promise((res, rej) => fs.createReadStream(src.file, { start, end: start + src.entry.size - 1 })
        .pipe(fs.createWriteStream(tempInput)).on('finish', res).on('error', rej));
    } else {
      fs.writeFileSync(tempInput, await readZipEntry(src.file, src.entry));
    }
    input = tempInput;
  }
  const out = fixedPath(song.key), tmp = `${out}.part.mp4`;
  const common = ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0'];
  const audio = ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', tmp];
  try {
    try {
      await run([...common, '-c:v', 'copy', ...audio]);                         // fast: picture copied as-is
    } catch {
      await run([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...audio]); // slower fallback
    }
    fs.renameSync(tmp, out);
  } finally {
    if (tempInput) fs.rmSync(tempInput, { force: true });
    fs.rmSync(tmp, { force: true });
  }
}

async function next() {
  if (running || !waiting.length) return;
  running = true;
  const song = waiting.shift();
  const started = Date.now();
  console.log(`Converting the sound of "${song.title}" so browsers can play it...`);
  try {
    await convert(song);
    jobs.delete(song.key);
    console.log(`  done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  } catch (err) {
    jobs.set(song.key, { state: 'failed', error: err.message });
    console.warn(`  failed: ${err.message}`);
  }
  running = false;
  next();
}

module.exports = { init, probeAudio, state, errorFor, request, fixedPath, available: () => !!ffmpeg };
