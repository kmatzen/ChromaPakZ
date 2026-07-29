/** Reader for quant_golden.csv (format documented in regen_quant_golden.mjs). */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** "nan" | "inf" | "-inf" | "0xXXXXXXXX" -> the exact float32 value. */
export function decodeFloat(tok) {
  if (tok === 'nan') return NaN;
  if (tok === 'inf') return Infinity;
  if (tok === '-inf') return -Infinity;
  u32[0] = Number.parseInt(tok, 16);
  return f32[0];
}

export function parseGolden(text) {
  const cases = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('near,')) continue;
    const [near, far, levels, z, code, back] = line.split(',');
    cases.push({
      near: Number(near), far: Number(far), levels: Number(levels),
      z: decodeFloat(z), code: Number(code), back: decodeFloat(back),
    });
  }
  return cases;
}

export const describeCase = (c) =>
  `near=${c.near} far=${c.far} levels=${c.levels} z=${c.z}`;
