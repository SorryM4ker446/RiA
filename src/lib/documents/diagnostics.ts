import { z } from "zod";
import { retrievalPolicySchema } from "@/lib/assistants/schema";

export const documentDiagnosticsSchema = z.strictObject({
  outcome: z.enum(["empty-query", "empty-library", "no-hits", "hits"]),
  semantic: z.enum(["not-run", "not-configured", "unindexed", "ready", "failed"]),
  corpusChunks: z.number().int().nonnegative(),
  compatibleVectors: z.number().int().nonnegative(),
  scannedVectors: z.number().int().nonnegative(),
  staleVectors: z.number().int().nonnegative(),
  invalidVectors: z.number().int().nonnegative().default(0),
  lexicalCandidates: z.number().int().nonnegative(),
  semanticCandidates: z.number().int().nonnegative(),
  selectedSources: z.number().int().nonnegative().max(8),
  contextChars: z.number().int().nonnegative().max(9600),
  durationMs: z.number().nonnegative(),
  policy: retrievalPolicySchema,
});
export type DocumentDiagnostics = z.infer<typeof documentDiagnosticsSchema>;
export function describeDocumentDiagnostics(value: DocumentDiagnostics) {
  const outcome = { "empty-query": "查询为空", "empty-library": "所选范围没有资料", "no-hits": "未找到支持此问题的片段", hits: `已取得 ${value.selectedSources} 个证据片段` }[value.outcome];
  const semantic = { "not-run": "本次未执行语义检索", "not-configured": "未配置语义模型，使用关键词检索", unindexed: "当前模型尚无兼容向量，使用关键词检索", ready: "混合检索已运行", failed: "语义模型调用失败，已回退关键词检索" }[value.semantic];
  return `${outcome}；${semantic}。证据 ${value.contextChars} 字符，耗时 ${Math.round(value.durationMs)} ms。`;
}
