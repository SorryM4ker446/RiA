/*
 * How a document vector is stored: scaled to unit length, then little-endian
 * Float32 in a BLOB. Unit length makes similarity a plain dot product, and the
 * binary form is a quarter of the JSON it replaced. The desktop migrator writes
 * the same bytes when it converts older vectors (electron/migration-steps.ts);
 * a test checks the two agree.
 */

/** The longest vector kept; a provider returning more is treated as a failed embedding. */
export const MAX_VECTOR_DIMENSIONS = 8192;

/** A provider's embedding scaled to unit length, or null when it is not a usable vector. */
export function normalizeVector(values: unknown): Float32Array | null {
  if (!Array.isArray(values) && !(values instanceof Float32Array)) return null;
  const length = values.length;
  if (!length || length > MAX_VECTOR_DIMENSIONS) return null;
  let norm = 0;
  for (let index = 0; index < length; index++) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    norm += value * value;
  }
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const scale = 1 / Math.sqrt(norm);
  const vector = new Float32Array(length);
  for (let index = 0; index < length; index++) vector[index] = (values[index] as number) * scale;
  return vector;
}

export function encodeDocumentVector(values: unknown): Uint8Array<ArrayBuffer> | null {
  const vector = normalizeVector(values);
  if (!vector) return null;
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index++) view.setFloat32(index * 4, vector[index], true);
  return bytes;
}

/** A stored vector, or null when the bytes are not one (wrong length, too long, not finite, all zero). */
export function decodeDocumentVector(bytes: Uint8Array | null | undefined): Float32Array | null {
  if (!bytes || !bytes.byteLength || bytes.byteLength % 4 || bytes.byteLength / 4 > MAX_VECTOR_DIMENSIONS) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.byteLength / 4);
  let norm = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
    norm += value * value;
  }
  return norm > 0 ? vector : null;
}

export function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
  return sum;
}
