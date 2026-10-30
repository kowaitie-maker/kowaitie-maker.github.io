import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

/** Abstract placeholder image: diagonal gradient with soft light blobs. */
export function placeholderPng(width, height, from = '#6c47ff', to = '#ff2d6f', seed = 1) {
  const a = hex(from);
  const b = hex(to);
  let r = seed * 9301 + 49297;
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const blobs = Array.from({ length: 4 }, () => ({ x: rand() * width, y: rand() * height, rad: (0.18 + rand() * 0.3) * width, s: 0.25 + rand() * 0.35 }));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.max(0, (x / width) * 0.35 + (y / height) * 0.65));
      let light = 0;
      for (const bl of blobs) {
        const d = Math.hypot(x - bl.x, y - bl.y) / bl.rad;
        if (d < 1) light += (1 - d * d) * bl.s;
      }
      for (let c = 0; c < 3; c++) {
        const base = a[c] + (b[c] - a[c]) * t;
        raw[row + 1 + x * 3 + c] = Math.min(255, Math.round(base + (255 - base) * Math.min(light, 0.6)));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
