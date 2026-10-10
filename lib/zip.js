'use strict';
// Minimal ZIP reader: lists entries and extracts one entry (stored or deflated).
// Enough for karaoke packs (one .mp3 + one .cdg per zip); no ZIP64 or encryption.
const fs = require('fs');
const zlib = require('zlib');

async function readZipIndex(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      if (!name.endsWith('/') && !(flags & 1)) {
        entries.push({
          name,
          method: cd.readUInt16LE(p + 10),
          compressedSize: cd.readUInt32LE(p + 20),
          size: cd.readUInt32LE(p + 24),
          headerOffset: cd.readUInt32LE(p + 42),
        });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

// Byte offset in the zip file where an entry's (possibly compressed) data starts.
async function zipDataStart(file, entry) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(30);
    await fh.read(header, 0, 30, entry.headerOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('bad zip entry header');
    return entry.headerOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

async function readZipEntry(file, entry) {
  const start = await zipDataStart(file, entry);
  const fh = await fs.promises.open(file, 'r');
  try {
    const data = Buffer.alloc(entry.compressedSize);
    await fh.read(data, 0, entry.compressedSize, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${entry.method}`);
  } finally {
    await fh.close();
  }
}

module.exports = { readZipIndex, readZipEntry, zipDataStart };
