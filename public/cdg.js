
/* ---------- CD+G decoder ----------
   A .cdg file is a stream of 24-byte packets played at 300 packets/second.
   The screen is 300x216 pixels with a 16-color palette; the safe area is 288x192. */
class CDG {
  constructor() {
    this.W = 300; this.H = 216;
    this.vram = new Uint8Array(this.W * this.H);
    this.pal = new Uint32Array(16);
    this.data = new Uint8Array(0);
    this.reset();
  }
  load(buf) { this.data = new Uint8Array(buf); this.reset(); }
  reset() {
    this.vram.fill(0); this.pal.fill(0xff000000);
    this.hOff = 0; this.vOff = 0; this.pos = 0; this.dirty = true;
  }
  get packets() { return (this.data.length / 24) | 0; }
  advanceTo(n) {
    if (n < this.pos) this.reset();            // seeking backwards: replay from the start
    const end = Math.min(n, this.packets);
    for (; this.pos < end; this.pos++) this.exec(this.pos * 24);
  }
  exec(o) {
    const d = this.data;
    if ((d[o] & 0x3f) !== 0x09) return;          // not a CD+G command
    const ins = d[o + 1] & 0x3f, p = o + 4;
    switch (ins) {
      case 1:  this.vram.fill(d[p] & 15); this.dirty = true; break;                 // memory preset
      case 2:  this.border(d[p] & 15); break;                                         // border preset
      case 6:  this.tile(p, false); break;                                            // tile block
      case 38: this.tile(p, true); break;                                             // tile block XOR
      case 20: this.scroll(p, false); break;                                          // scroll preset
      case 24: this.scroll(p, true); break;                                           // scroll copy
      case 30: this.palette(p, 0); break;                                             // colors 0-7
      case 31: this.palette(p, 8); break;                                             // colors 8-15
    }
  }
  border(c) {
    const { W, H, vram } = this;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (x < 6 || x >= 294 || y < 12 || y >= 204) vram[y * W + x] = c;
    this.dirty = true;
  }
  tile(p, xor) {
    const d = this.data, c0 = d[p] & 15, c1 = d[p + 1] & 15;
    const row = d[p + 2] & 31, col = d[p + 3] & 63;
    if (row >= 18 || col >= 50) return;
    const x0 = col * 6, y0 = row * 12, vram = this.vram;
    for (let y = 0; y < 12; y++) {
      const bits = d[p + 4 + y] & 63, base = (y0 + y) * 300 + x0;
      for (let x = 0; x < 6; x++) {
        const c = (bits >> (5 - x)) & 1 ? c1 : c0;
        if (xor) vram[base + x] ^= c; else vram[base + x] = c;
      }
    }
    this.dirty = true;
  }
  scroll(p, copy) {
    const d = this.data, color = d[p] & 15, hs = d[p + 1] & 63, vs = d[p + 2] & 63;
    const hCmd = (hs & 0x30) >> 4, vCmd = (vs & 0x30) >> 4;
    this.hOff = Math.min(hs & 7, 5); this.vOff = Math.min(vs & 15, 11);
    const dx = hCmd === 1 ? 6 : hCmd === 2 ? -6 : 0;
    const dy = vCmd === 1 ? 12 : vCmd === 2 ? -12 : 0;
    if (dx || dy) {
      const { W, H } = this, src = this.vram.slice(), dst = this.vram;
      for (let y = 0; y < H; y++) {
        let sy = y - dy;
        if (copy) sy = (sy + H) % H;
        for (let x = 0; x < W; x++) {
          let sx = x - dx;
          if (copy) sx = (sx + W) % W;
          dst[y * W + x] = (sx < 0 || sx >= W || sy < 0 || sy >= H) ? color : src[sy * W + sx];
        }
      }
    }
    this.dirty = true;
  }
  palette(p, base) {
    const d = this.data;
    for (let i = 0; i < 8; i++) {
      const hi = d[p + 2 * i] & 63, lo = d[p + 2 * i + 1] & 63;
      const r = (hi >> 2) & 15, g = ((hi & 3) << 2) | ((lo >> 4) & 3), b = lo & 15;
      this.pal[base + i] = 0xff000000 | (b * 17 << 16) | (g * 17 << 8) | (r * 17);
    }
    this.dirty = true;
  }
  // Writes the visible screen (with fine-scroll offsets applied) as palette indices.
  render(out) {
    const { W, H, vram, hOff, vOff } = this;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let i;
        if (x < 6 || x >= 294 || y < 12 || y >= 204) i = y * W + x;
        else i = Math.min(y + vOff, H - 1) * W + Math.min(x + hOff, W - 1);
        out[y * W + x] = vram[i];
      }
    }
    this.dirty = false;
  }
}

/* Scale2x (EPX): doubles an indexed image and rounds off stair-step edges.
   Run twice for 4x, which turns blocky CDG lettering into smooth curves. */
function scale2x(src, w, h, dst) {
  const W2 = w * 2;
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w, row = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : x, r = x < w - 1 ? x + 1 : x;
      const B = src[up + x], D = src[row + l], E = src[row + x], F = src[row + r], H = src[dn + x];
      const o = (y * 2) * W2 + x * 2;
      if (B !== H && D !== F) {
        dst[o]          = D === B ? D : E;
        dst[o + 1]      = B === F ? F : E;
        dst[o + W2]     = D === H ? D : E;
        dst[o + W2 + 1] = H === F ? F : E;
      } else {
        dst[o] = dst[o + 1] = dst[o + W2] = dst[o + W2 + 1] = E;
      }
    }
  }
}
