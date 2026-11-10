import zlib from "node:zlib";

const CRC_TABLE = (() => {
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Converts little-endian RGB565 pixels (the Hyper-V thumbnail format) to an RGB PNG. No dependencies.
 * @param {Buffer} raw
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function rgb565ToPng(raw, width, height) {
  if (raw.length < width * height * 2) {
    throw new Error(
      `RGB565 buffer too small: ${raw.length} < ${width * height * 2}`,
    );
  }
  const stride = width * 3 + 1;
  const scan = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    scan[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = raw.readUInt16LE((y * width + x) * 2);
      const r = (p >> 11) & 0x1f;
      const g = (p >> 5) & 0x3f;
      const b = p & 0x1f;
      const o = y * stride + 1 + x * 3;
      scan[o] = (r << 3) | (r >> 2);
      scan[o + 1] = (g << 2) | (g >> 4);
      scan[o + 2] = (b << 3) | (b >> 2);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(scan)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
