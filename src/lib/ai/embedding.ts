import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai/client";
import { setupServerProxy } from "@/lib/server/proxy";
import { getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import type { ModelRef } from "@/lib/models/preferences-schema";

/**
 * Desktop smoke mode must never reach a paid provider.
 *
 * The packaged smoke run imports documents, and indexing embeds their text. With
 * a real OPENROUTER_API_KEY in .env that turned every smoke run into a live,
 * billable request that could hang until the 120s timeout when the network was
 * slow — and a test that quietly spends money is worse than no test.
 *
 * The offline harness swaps the model factory at loader level, but that only
 * works for the isolated server-test child process. The smoke run boots the real
 * Next service, so the substitution has to live in the application and key off
 * the flag the smoke launcher already exports.
 */
const SMOKE_EMBEDDING_DIMENSIONS = 256;
const SMOKE_EMBEDDING_MODEL_ID = "offline-smoke-hash-v1";

function isSmokeMode(): boolean {
  return process.env.DESKTOP_SMOKE_TEST === "1";
}

/**
 * Deterministic bag-of-words vector.
 *
 * Hashing is not an embedding model, but it keeps the two properties the smoke
 * assertions rely on: identical text always scores 1, and texts sharing words
 * score above texts that do not. Retrieval therefore still distinguishes a hit
 * from a miss, which a constant or random vector would destroy.
 */
function offlineEmbedding(value: string): number[] {
  const vector = new Array<number>(SMOKE_EMBEDDING_DIMENSIONS).fill(0);
  for (const token of value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % SMOKE_EMBEDDING_DIMENSIONS] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  return magnitude === 0 ? vector : vector.map((component) => component / magnitude);
}

function isEmbeddingAvailable(): boolean {
  return getModelProvider(SMOKE_EMBEDDING_PROVIDER).isConfigured();
}

const SMOKE_EMBEDDING_PROVIDER = "openrouter";

/**
 * Generates embeddings for a list of texts. Returns null entries when the
 * embedding backend is unavailable or a call fails, so callers can fall back
 * to keyword scoring.
 */
export async function embedTextsWithModel(values: string[], signal?: AbortSignal): Promise<{ embeddings: Array<number[] | null>; modelRef: ModelRef | null }> {
  if (values.length === 0) {
    return { embeddings: values.map(() => null), modelRef: null };
  }

  // Checked before the key probe: a developer machine with a real key in .env
  // must still get the offline path, or the smoke run quietly bills them.
  if (isSmokeMode()) {
    return { embeddings: values.map(offlineEmbedding), modelRef: { providerId: SMOKE_EMBEDDING_PROVIDER, modelId: SMOKE_EMBEDDING_MODEL_ID } };
  }

  if (!isEmbeddingAvailable()) {
    return { embeddings: values.map(() => null), modelRef: null };
  }

  const normalized = values.map((value) => value.replace(/\s+/g, " ").trim());

  try {
    const preferences = await getModelPreferences();
    const modelRef = preferences.embedding;
    if (!modelRef || !await modelInLibrary("embedding", modelRef)) return { embeddings: values.map(() => null), modelRef: null };
    if (!getModelProvider(modelRef.providerId).isConfigured()) return { embeddings: values.map(() => null), modelRef: null };
    setupServerProxy();
    const { embeddings } = await embedMany({ model: getEmbeddingModel(modelRef), values: normalized, abortSignal: signal, maxRetries: 0, maxParallelCalls: 1 });
    return { embeddings: embeddings.map((embedding) => (Array.isArray(embedding) ? embedding : null)), modelRef };
  } catch (error) {
    console.warn("embedding generation failed, falling back to keyword scoring", error instanceof Error ? error.name : "UnknownError");
    return { embeddings: values.map(() => null), modelRef: null };
  }
}

export async function embedTextWithModel(value: string, signal?: AbortSignal): Promise<{ embedding: number[] | null; modelRef: ModelRef | null }> {
  const result = await embedTextsWithModel([value], signal);
  return { embedding: result.embeddings[0] ?? null, modelRef: result.modelRef };
}

export function cosineSimilarity(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
): number {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length === 0 ||
    b.length === 0 ||
    a.length !== b.length
  ) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Coerces a Prisma `Json` column value into a numeric vector, or null when it
 * is not a valid embedding.
 */
export function toEmbeddingVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;

  const vector = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (vector.length === 0) return null;
  return vector;
}
