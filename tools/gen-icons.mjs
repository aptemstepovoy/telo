// Генератор PNG-иконок без внешних зависимостей.
// Рисует ту же иконку, что и icon.svg (гантель на мятном градиенте),
// с супердискретизацией 4x для сглаживания, и кодирует PNG через zlib.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- PNG encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // raw scanlines with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ----
const C0 = [0x34, 0xe0, 0xa1]; // mint
const C1 = [0x13, 0xb8, 0x94]; // teal
const DARK = [0x0a, 0x0e, 0x13];

function lerp(a, b, t) { return a + (b - a) * t; }

// rounded-rect inside test on a 512-grid (sx,sy in [0,512))
function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const ix0 = rx + r, ix1 = rx + w - r, iy0 = ry + r, iy1 = ry + h - r;
  const cx = x < ix0 ? ix0 : x > ix1 ? ix1 : x;
  const cy = y < iy0 ? iy0 : y > iy1 ? iy1 : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// dumbbell parts on the 512 reference grid
const PARTS = [
  [96, 216, 24, 80, 10],
  [120, 196, 56, 120, 16],
  [176, 243, 160, 26, 13],
  [336, 196, 56, 120, 16],
  [392, 216, 24, 80, 10],
];

// returns [r,g,b,a] for a reference-grid sample point, or null if transparent
function sampleRef(x, y) {
  // outside background rounded square -> transparent
  if (!inRoundRect(x, y, 0, 0, 512, 512, 112)) return null;
  // glyph?
  for (const [rx, ry, w, h, r] of PARTS) {
    if (inRoundRect(x, y, rx, ry, w, h, r)) return [DARK[0], DARK[1], DARK[2], 255];
  }
  // gradient background
  const t = ((x / 512) + (y / 512)) / 2;
  return [
    Math.round(lerp(C0[0], C1[0], t)),
    Math.round(lerp(C0[1], C1[1], t)),
    Math.round(lerp(C0[2], C1[2], t)),
    255,
  ];
}

function render(size) {
  const SS = 4; // supersample factor
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = ((px + (sx + 0.5) / SS) / size) * 512;
          const fy = ((py + (sy + 0.5) / SS) / size) * 512;
          const c = sampleRef(fx, fy);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      // premultiply-aware: average color over covered samples, alpha over all
      const cov = a / 255; // sum of alpha/255 == covered sample count
      if (cov > 0) {
        rgba[i] = Math.round(r / cov);
        rgba[i + 1] = Math.round(g / cov);
        rgba[i + 2] = Math.round(b / cov);
      }
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

const targets = [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32],
];
for (const [name, size] of targets) {
  const png = render(size);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('wrote', name, size + 'x' + size, png.length + 'B');
}
console.log('done');
