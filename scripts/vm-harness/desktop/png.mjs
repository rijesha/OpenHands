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
 * Encodes packed 8-bit RGB pixels (3 bytes per pixel, rows top to bottom) as a PNG. No dependencies.
 * @param {Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function rgbToPng(rgb, width, height) {
  const row = width * 3;
  if (rgb.length < row * height)
    throw new Error(`RGB buffer too small: ${rgb.length} < ${row * height}`);
  const stride = row + 1;
  const scan = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    scan[y * stride] = 0; // filter: none
    rgb.copy(scan, y * stride + 1, y * row, (y + 1) * row);
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
