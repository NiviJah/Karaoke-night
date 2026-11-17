'use strict';
// Imported YouTube karaoke channels and playlists, saved in youtube-library.json next to the app.
// Listing a playlist costs 1 unit of YouTube's free daily quota per 50 videos (one search costs 100),
// so whole channels can be imported once and then searched inside the app with no limit.
const fs = require('fs');
const crypto = require('crypto');

const MAX_VIDEOS = 5000;          // per channel or playlist
const MAX_SECONDS = 20 * 60;      // longer videos are compilations, not songs

// Bracketed bits and words that describe the video, not the song.
const NOISE = /karaoke|instrumental|lyrics?|backing track|sing ?along|minus ?one|version|official|\bhd\b|\b4k\b|קריוקי|פלייבק|ביצוע/i;
// Labels left after the song name without brackets: "ילד השדה קריוקי פסנתר", "Hello karaoke version".
const TRAILING_NOISE = /\s+(?:קריוקי(?:\s+פסנתר)?|פלייבק|karaoke(?:\s+version)?|backing track)$/i;
// Category labels, not artists: "Chanukah Songs", "שירי חנוכה".
const CATEGORY = /^(?:(?:jewish|israeli|hebrew)\s+)*(?:chanukah|hanukkah|hanuka|chanuka)\s+songs$|^שירי\s+חנוכה$/i;
// Female-key versions are worth keeping apart from the regular one.
const FEMALE_KEY = /גרסת\s+בנות|female\s+key|women'?s\s+key/i;

// "DANCING QUEEN" -> "Dancing Queen", used only when a title's song and artist are all in capitals.
const shouting = s => /[A-Z]/.test(s) && !/[a-z]/.test(s);
const titleCase = s => s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// Splits a video title into its meaningful parts (song, artist), dropping karaoke labels and the channel name.
// Parts are separated by " - " or by " | " (some channels put the song between labels: "Karaoke | Song | Artist").
function titleParts(raw, channel) {
  const t = String(raw || '').replace(/[([{][^)\]}]*[)\]}]/g, m => (NOISE.test(m) || FEMALE_KEY.test(m) ? ' ' : m));
  const ch = String(channel || '').toLowerCase().trim();
  const parts = [];
  for (const seg of t.split(/\s+[|｜•]\s+|\s\/\/\s/)) {
    for (const piece of seg.split(/\s+[-–—]\s+/)) {
      const full = piece.replace(/\s+/g, ' ').replace(/^[|｜•\s]+|[|｜•\s]+$/g, '');
      const p = full.replace(TRAILING_NOISE, '').trim();
      if (!p || p.toLowerCase() === ch || CATEGORY.test(p) || FEMALE_KEY.test(p) || (NOISE.test(p) && p.split(' ').length <= 4)) continue;
      parts.push(Object.assign(new String(p), { labelled: p !== full })); // labelled: had "karaoke" etc. after it
    }
  }
  return parts;
}

// Karaoke channels put "Artist - Song" or "Song - Artist" consistently. Artist names repeat across a
// channel's videos and song names rarely do, so the position that repeats more is the artist.
function parseTitles(videos) {
  let parts = videos.map(v => titleParts(v.title, v.channel));
  // Channel branding ("אשירה קריוקי", "Jewish karaoke") carries a karaoke label and is on many of a channel's
  // videos (40% or more); a song name never is. Drop such parts.
  if (videos.length >= 3) {
    const count = new Map();
    for (const p of parts) for (const x of new Set(p.filter(x => x.labelled).map(String))) count.set(x, (count.get(x) || 0) + 1);
    parts = parts.map(p => p.filter(x => !(x.labelled && count.get(String(x)) >= videos.length * 0.4)));
  }
  parts = parts.map(p => p.map(String));
  const freq = [new Map(), new Map()];
  for (const p of parts) if (p.length >= 2) for (const i of [0, 1]) { const k = p[i].toLowerCase(); freq[i].set(k, (freq[i].get(k) || 0) + 1); }
  let score0 = 0, score1 = 0;
  for (const p of parts) if (p.length >= 2) {
    if (freq[0].get(p[0].toLowerCase()) > 1) score0++;
    if (freq[1].get(p[1].toLowerCase()) > 1) score1++;
  }
  const artistFirst = score0 >= score1;
  return videos.map((v, i) => {
    const p = parts[i];
    const fix = shouting(p.join(' ')) ? titleCase : x => x;
    const female = FEMALE_KEY.test(v.title) ? (/[\u0590-\u05FF]/.test(v.title) ? ' (גרסת בנות)' : ' (female key)') : '';
    if (p.length >= 2) {
      const [a, s] = artistFirst ? [p[0], p[1]] : [p[1], p[0]];
      return { ...v, artist: fix(a), song: fix(s) + female };
    }
    return { ...v, artist: '', song: fix(p[0] || v.title) + female };
  });
}

// Accepts a playlist link (...list=PL...), a channel link (/channel/UC..., /@handle, /user/name) or just "@handle".
function parseLink(link) {
  const text = String(link || '').trim();
  if (/^@[\w.-]+$/.test(text)) return { handle: text };
  let u;
  try { u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!/(^|\.)youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return null;
  const list = u.searchParams.get('list');
  if (list) return { playlist: list };
  let m;
  if ((m = /^\/channel\/(UC[\w-]{22})/.exec(u.pathname))) return { channelId: m[1] };
  if ((m = /^\/(@[^/]+)/.exec(u.pathname))) return { handle: decodeURIComponent(m[1]) };
  if ((m = /^\/user\/([^/]+)/.exec(u.pathname))) return { username: m[1] };
  if (/^\/c\//.test(u.pathname)) return { unsupported: true };
  return null;
}

function create({ file, api }) {
  let data = { sources: [], videos: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(data));

  async function resolve(link) {
    let p = parseLink(link);
    const text = String(link || '').trim();
    // Not a link: treat it as a channel name and look it up (one search, about 100 quota units).
    if (!p && text && !/^https?:|\.(com|be)\//i.test(text)) {
      const j = await api(`search?part=snippet&type=channel&maxResults=5&q=${encodeURIComponent(text)}`);
      const items = j.items || [];
      const exact = items.find(i => (i.snippet?.title || '').trim().toLowerCase() === text.toLowerCase());
      const best = exact || items[0];
      if (!best) throw new Error(`No YouTube channel called "${text}". Paste the channel's link instead.`);
      p = { channelId: best.snippet?.channelId || best.id?.channelId };
    }
    if (!p) throw new Error("That isn't a YouTube channel or playlist link.");
    if (p.unsupported) throw new Error('Open the channel on YouTube and copy the link with "@" in it (youtube.com/@name).');
    if (p.playlist) {
      const j = await api(`playlists?part=snippet&id=${encodeURIComponent(p.playlist)}`);
      const pl = j.items?.[0];
      if (!pl) throw new Error("Can't find that playlist. It may be private.");
      return { id: p.playlist, kind: 'playlist', title: pl.snippet.title };
    }
    const q = p.channelId ? `id=${p.channelId}` : p.handle ? `forHandle=${encodeURIComponent(p.handle)}` : `forUsername=${encodeURIComponent(p.username)}`;
    const j = await api(`channels?part=snippet,contentDetails&${q}`);
    const ch = j.items?.[0];
    if (!ch) throw new Error("Can't find that channel.");
    return { id: ch.contentDetails.relatedPlaylists.uploads, kind: 'channel', title: ch.snippet.title };
  }

  async function fetchVideos(playlistId) {
    const found = [];
    let page = '';
    do {
      const j = await api(`playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}${page ? `&pageToken=${page}` : ''}`);
      for (const it of j.items || []) {
        const id = it.contentDetails?.videoId;
        if (!id || !it.snippet?.videoOwnerChannelTitle) continue; // private or deleted
        found.push({ id, title: it.snippet.title, channel: it.snippet.videoOwnerChannelTitle });
      }
      page = j.nextPageToken || '';
    } while (page && found.length < MAX_VIDEOS);
    // Lengths, to leave out hour-long compilations (also 1 unit per 50 videos).
    const seconds = {};
    for (let i = 0; i < found.length; i += 50) {
      const j = await api(`videos?part=contentDetails&id=${found.slice(i, i + 50).map(v => v.id).join(',')}`);
      for (const v of j.items || []) {
        const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails?.duration || '');
        seconds[v.id] = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
      }
    }
    return parseTitles(found.filter(v => v.id in seconds && seconds[v.id] > 0 && seconds[v.id] <= MAX_SECONDS)
      .map(v => ({ ...v, seconds: seconds[v.id] })));
  }

  async function importLink(link) {
    const src = await resolve(link);
    const videos = await fetchVideos(src.id);
    data.videos[src.id] = videos;
    data.sources = data.sources.filter(s => s.id !== src.id);
    data.sources.push({ ...src, link: String(link).trim(), importedAt: new Date().toISOString(), count: videos.length });
    save();
    return data.sources.at(-1);
  }

  async function refresh(id) {
    const src = data.sources.find(s => s.id === id);
    if (!src) throw new Error('That channel or playlist is no longer in the list.');
    data.videos[id] = await fetchVideos(id);
    Object.assign(src, { importedAt: new Date().toISOString(), count: data.videos[id].length });
    save();
    return src;
  }

  function remove(id) {
    data.sources = data.sources.filter(s => s.id !== id);
    delete data.videos[id];
    save();
  }

  // Song entries for the catalog. A video in several imported lists appears once.
  function songs() {
    const seen = new Set(), out = [];
    for (const src of data.sources) {
      for (const v of data.videos[src.id] || []) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        out.push({
          key: crypto.createHash('sha1').update(`youtube:${v.id}`).digest('hex').slice(0, 12),
          kind: 'youtube', youtube: v.id, artist: v.artist, title: v.song, genre: src.title,
          search: `${v.artist} ${v.song} ${v.title} ${v.channel}`.toLowerCase(),
        });
      }
    }
    return out;
  }

  return { sources: () => data.sources, importLink, refresh, remove, songs };
}

module.exports = { create, parseTitles, titleParts, parseLink };
