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

function assertJsonContentType(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" });
  }
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid JSON body" }); }
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 32) throw new ApiError({ code: "VALIDATION_ERROR", message: "JSON nesting is too deep" });
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}

export async function readJsonBody(request: Request, limit: number = MEDIA_LIMITS.jsonBodyBytes): Promise<unknown> {
  assertJsonContentType(request);
  return parseJsonBytes(await readLimitedBody(request, limit));
}

export async function readEmptyBody(request: Request) {
  // Next.js can provide an empty stream for a bodyless HTTP POST/DELETE.
  const bytes = await readLimitedBody(request, 16 * 1024);
  if (!bytes.length) return;
  assertJsonContentType(request);
  const body = parseJsonBytes(bytes);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "This operation accepts no fields" });
  }
}
