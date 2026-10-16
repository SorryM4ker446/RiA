import { tokenizeQuery } from "@/lib/memory/retrieval";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
export function documentTerms(text: string) {
  const allowed = new Set(tokenizeQuery(text).filter(term => term.length <= 100));
  const frequencies = new Map<string, number>();
  let tokenCount = 0;
  for (const part of segmenter.segment(text.normalize("NFKC").toLowerCase())) {
    if (!allowed.has(part.segment)) continue;
    frequencies.set(part.segment, (frequencies.get(part.segment) ?? 0) + 1);
    tokenCount++;
  }
  return { tokenCount, terms: [...frequencies].map(([term, frequency]) => ({ term, frequency })) };
}

export function documentEmbeddingText(chunk: { text: string; heading?: string | null }, document: { filename: string; collection?: string | null }) {
  return [document.filename, document.collection, chunk.heading, chunk.text].filter(Boolean).join("\n");
}
