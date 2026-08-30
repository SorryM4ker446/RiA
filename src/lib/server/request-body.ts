import { ApiError } from "@/lib/server/api-error";
import { MEDIA_LIMITS } from "@/lib/media/limits";

export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const bytes = await readLimitedBody(request, MEDIA_LIMITS.jsonBodyBytes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid JSON body" }); }
}
