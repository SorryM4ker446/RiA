import { z } from "zod";

export const webSearchInput = z.object({
  query: z.string().min(1),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;

export async function runWebSearch(input: WebSearchInput) {
  return {
    query: input.query,
    results: [],
  };
}
