'use strict';
// Reads small bits of metadata without any extra tools:
//   - MP3 genre from ID3 tags
//   - MP4/MOV sound format (codec) and genre
const fs = require('fs');

// ID3v1 genre numbers 0-79 (also used by "(17)" style ID3v2 genres and MP4 'gnre').
const ID3_GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
  'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul',
  'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave',
  'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave',
  'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];

// Genres that say nothing useful about a karaoke track.
const USELESS_GENRES = /^(karaoke|other|unknown|genre|none|misc|\s*)$/i;

function cleanGenre(g) {
  g = String(g || '').replace(/\0/g, '').trim();
  const num = /^\(?(\d{1,3})\)?/.exec(g); // "(17)", "17", "(17)Rock"
  if (num && ID3_GENRES[+num[1]] && !/[a-z]/i.test(g.slice(num[0].length))) g = ID3_GENRES[+num[1]];
  else if (num) g = g.slice(num[0].length).trim() || ID3_GENRES[+num[1]] || '';
  g = g.split(/[;/\\]/)[0].trim();
  return USELESS_GENRES.test(g) ? '' : g.replace(/\b\w/g, c => c.toUpperCase());
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

function decodeText(buf) {
  const enc = buf[0], body = buf.subarray(1);
  if (enc === 1 || enc === 2) { // UTF-16 with BOM / UTF-16BE
    let b = body, le = enc === 1;
    if (b[0] === 0xff && b[1] === 0xfe) { le = true; b = b.subarray(2); }
    else if (b[0] === 0xfe && b[1] === 0xff) { le = false; b = b.subarray(2); }
    if (!le) { b = Buffer.from(b); b.swap16?.(); }
    return b.toString('utf16le');
  }
  return body.toString(enc === 3 ? 'utf8' : 'latin1');
}

async function mp3Genre(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = await readAt(fh, 0, 10);
    if (head.length === 10 && head.toString('latin1', 0, 3) === 'ID3') {
      const ver = head[3];
      const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      const tag = await readAt(fh, 10, Math.min(size, 256 * 1024));
      let p = 0;
      const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
      while (p + hdrLen <= tag.length) {
        const id = tag.toString('latin1', p, p + idLen);
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let len;
        if (ver === 2) len = (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5];
        else if (ver === 4) len = (tag[p + 4] << 21) | (tag[p + 5] << 14) | (tag[p + 6] << 7) | tag[p + 7];
        else len = tag.readUInt32BE(p + 4);
        if (id === 'TCON' || id === 'TCO') {
          const g = cleanGenre(decodeText(tag.subarray(p + hdrLen, p + hdrLen + len)));
          if (g) return g;
        }
        p += hdrLen + len;
      }
    }
    const { size } = await fh.stat();
    if (size > 128) {
      const v1 = await readAt(fh, size - 128, 128);
      if (v1.toString('latin1', 0, 3) === 'TAG' && ID3_GENRES[v1[127]]) return cleanGenre(ID3_GENRES[v1[127]]);
    }
    return '';
  } finally {
    await fh.close();
  }
}

// MP4/MOV: finds each track's type and sample format, plus the genre tag.
// `base` is where the MP4 starts inside the file (non-zero for a video stored in a zip).
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst', 'edts']);
async function mp4Info(file, base = 0, length = Infinity) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const end = Math.min(base + length, (await fh.stat()).size);
    let pos = base, moov = null;
    while (pos + 8 <= end) {
      const h = await readAt(fh, pos, 16);
      let size = h.readUInt32BE(0), hdr = 8;
      const type = h.toString('latin1', 4, 8);
      if (size === 1) { size = Number(h.readBigUInt64BE(8)); hdr = 16; }
      else if (size === 0) size = end - pos;
      if (size < hdr) break;
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) break;
        moov = await readAt(fh, pos + hdr, size - hdr);
        break;
      }
      pos += size;
    }
    const info = { audio: null, video: null, genre: '' };
    if (!moov) return info;

    let handler = null;
    (function walk(buf) {
      let p = 0;
      while (p + 8 <= buf.length) {
        let size = buf.readUInt32BE(p), hdr = 8;
        const type = buf.toString('latin1', p + 4, p + 8);
        if (size === 1 && p + 16 <= buf.length) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
        else if (size === 0) size = buf.length - p;
        if (size < hdr || p + size > buf.length) break;
        const body = buf.subarray(p + hdr, p + size);
        if (type === 'trak') handler = null;
        if (CONTAINERS.has(type)) walk(body);
        else if (type === 'meta') walk(body.subarray(4)); // version/flags first
        else if (type === 'hdlr' && body.length >= 12) handler = body.toString('latin1', 8, 12);
        else if (type === 'stsd' && body.length >= 16) {
          const fmt = body.toString('latin1', 12, 16);
          if (handler === 'soun' && !info.audio) info.audio = fmt;
          if (handler === 'vide' && !info.video) info.video = fmt;
        } else if (type === '©gen' || type === 'gnre') {
          // child 'data' box: 8-byte header, 4 bytes type, 4 bytes locale, then the value
          if (body.length > 16 && body.toString('latin1', 4, 8) === 'data') {
            const val = body.subarray(16);
            const g = type === 'gnre' ? ID3_GENRES[val.readUInt16BE(0) - 1] : val.toString('utf8');
            if (!info.genre) info.genre = cleanGenre(g);
          }
        }
        p += size;
      }
    })(moov);
    return info;
  } finally {
    await fh.close();
  }
}

// Sound formats every current browser plays inside MP4. Anything else (ac-3, ec-3, dts, alac, ...) may play silently.
const SAFE_AUDIO = new Set(['mp4a', 'Opus', 'opus', '.mp3', 'mp3 ', 'fLaC', 'vorb']);
const AUDIO_NAMES = { 'ac-3': 'Dolby Digital (AC-3)', 'ec-3': 'Dolby Digital Plus (E-AC-3)', dtsc: 'DTS', dtsh: 'DTS-HD', alac: 'Apple Lossless', samr: 'AMR', sowt: 'PCM', twos: 'PCM', lpcm: 'PCM' };
const audioName = fourcc => AUDIO_NAMES[fourcc] || fourcc;

module.exports = { mp3Genre, mp4Info, cleanGenre, SAFE_AUDIO, audioName };
