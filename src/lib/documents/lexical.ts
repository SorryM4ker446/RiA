import { tokenizeQuery } from "@/lib/knowledge/entry-retrieval";

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

/**
 * A term as the full-text index stores and matches it: its UTF-8 bytes in
 * hexadecimal. The index's ASCII tokenizer keeps that whole, so a term with an
 * underscore, apostrophe or dot is never split, and nothing is case-folded twice.
 */
export const searchToken = (term: string) => Buffer.from(term, "utf8").toString("hex");

/** A chunk's row in the full-text index: each term repeated by its frequency, so BM25 sees the same counts. */
export function documentSearchText(terms: Array<{ term: string; frequency: number }>) {
  return terms.flatMap(({ term, frequency }) => Array.from({ length: Math.max(1, frequency) }, () => searchToken(term))).join(" ");
}

export function documentEmbeddingText(chunk: { text: string; heading?: string | null }, document: { filename: string; collection?: string | null }) {
  return [document.filename, document.collection, chunk.heading, chunk.text].filter(Boolean).join("\n");
}
