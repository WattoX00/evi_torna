import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const background = [23, 76, 105, 255];
const foreground = [245, 247, 250, 255];
const accent = [98, 214, 196, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (Math.floor(y) * size + Math.floor(x)) * 4;
    pixels.set(color, offset);
  };
  const ellipse = (cx, cy, rx, ry, color) => {
    cx *= scale; cy *= scale; rx *= scale; ry *= scale;
    for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(size, cy + ry); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(size, cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) set(x, y, color);
      }
    }
  };
  const line = (x1, y1, x2, y2, width, color) => {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.floor(length * scale * 1.5));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      ellipse(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, width / 2, color);
    }
  };

  const radius = 112 * scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(Math.max(x, radius), size - radius);
      const cy = Math.min(Math.max(y, radius), size - radius);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) set(x, y, background);
    }
  }
  ellipse(256, 137, 58, 66, foreground);
  line(256, 190, 256, 390, 26, foreground);
  line(256, 233, 190, 257, 21, foreground);
  line(256, 233, 322, 257, 21, foreground);
  line(256, 282, 202, 322, 21, foreground);
  line(256, 282, 310, 322, 21, foreground);
  line(256, 331, 220, 376, 18, foreground);
  line(256, 331, 292, 376, 18, foreground);
  for (const [y, left, right] of [[220, 153, 359], [280, 154, 358], [342, 170, 342]]) {
    line(left, y, left + 45, y, 16, accent);
    line(right - 45, y, right, y, 16, accent);
  }
  return pixels;
}

function encodePng(size, pixels) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

await mkdir(root, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await writeFile(resolve(root, name), encodePng(size, render(size)));
  console.log(`Wrote public/icons/${name}`);
}
