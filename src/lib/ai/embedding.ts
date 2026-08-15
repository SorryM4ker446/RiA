import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai/client";
import { setupServerProxy } from "@/lib/server/proxy";

function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

/**
 * Generates embeddings for a list of texts. Returns null entries when the
 * embedding backend is unavailable or a call fails, so callers can fall back
 * to keyword scoring.
 */
export async function embedTexts(values: string[]): Promise<Array<number[] | null>> {
  if (values.length === 0 || !isEmbeddingAvailable()) {
    return values.map(() => null);
  }

  const normalized = values.map((value) => value.replace(/\s+/g, " ").trim());

  try {
    setupServerProxy();
    const { embeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: normalized,
    });

    return embeddings.map((embedding) => (Array.isArray(embedding) ? embedding : null));
  } catch (error) {
    console.warn("embedding generation failed, falling back to keyword scoring", error);
    return values.map(() => null);
  }
}

export async function embedText(value: string): Promise<number[] | null> {
  const results = await embedTexts([value]);
  return results[0] ?? null;
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
