import { rgbToPng } from "./png.mjs";

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
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const p = raw.readUInt16LE(i * 2);
    const r = (p >> 11) & 0x1f;
    const g = (p >> 5) & 0x3f;
    const b = p & 0x1f;
    rgb[i * 3] = (r << 3) | (r >> 2);
    rgb[i * 3 + 1] = (g << 2) | (g >> 4);
    rgb[i * 3 + 2] = (b << 3) | (b >> 2);
  }
  return rgbToPng(rgb, width, height);
}
