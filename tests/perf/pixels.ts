import { inflateSync } from "node:zlib";

/** Decode Playwright's RGB/RGBA PNG screenshots without adding a dependency. */
export function pixels(png: Buffer) {
  let width = 0,
    height = 0,
    channels = 0;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error("Unsupported PNG");
    }
    if (type === "IDAT") chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * channels;
  const decoded = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const a = x >= channels ? decoded[at - channels]! : 0;
      const b = y ? decoded[at - stride]! : 0;
      const c = y && x >= channels ? decoded[at - stride - channels]! : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : filter === 4
                  ? pa <= pb && pa <= pc
                    ? a
                    : pb <= pc
                      ? b
                      : c
                  : NaN;
      if (!Number.isFinite(predictor)) throw new Error("Unsupported PNG filter");
      decoded[at] = raw[y * (stride + 1) + x + 1]! + predictor;
    }
  }
  const luminance = (x: number, y: number) => {
    const i =
      (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) *
      channels;
    return (0.2126 * decoded[i]! + 0.7152 * decoded[i + 1]! + 0.0722 * decoded[i + 2]!) / 255;
  };
  let bright = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (luminance(x, y) > 0.6) bright++;
  return { width, height, nearWhiteFraction: bright / (width * height), luminance };
}
