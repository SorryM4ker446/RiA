/**
 * Shared body reader for provider catalog responses.
 *
 * A catalog is third-party data fetched over the network, so the limit is
 * enforced while the body streams in rather than after `json()` has already
 * materialized it. Every provider adapter uses this instead of rolling its own
 * reader, so the cap cannot drift between them.
 */
export type BodyReadFailure = "tooLarge" | "empty" | "notJson" | "invalidShape";

export class BodyReadError extends Error {
  constructor(readonly failure: BodyReadFailure) {
    super(failure);
  }
}

export async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new BodyReadError("tooLarge");
  if (!response.body) throw new BodyReadError("empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BodyReadError("tooLarge"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new BodyReadError("notJson"); }
}
