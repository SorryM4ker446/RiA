import { describeDocumentDiagnostics, documentDiagnosticsSchema } from "@/lib/documents/diagnostics";

export function RetrievalDiagnostics({ value }: { value: unknown }) {
  const result = documentDiagnosticsSchema.safeParse(value);
  if (!result.success) return null;
  const data = result.data;
  return <details className="rounded-md border p-2 text-xs text-muted-foreground"><summary className="cursor-pointer">检索诊断：{describeDocumentDiagnostics(data)}</summary><p className="mt-2">范围内 {data.corpusChunks} 个分块 · 关键词候选 {data.lexicalCandidates} · 语义候选 {data.semanticCandidates} · 扫描向量 {data.scannedVectors}/{data.compatibleVectors} · 过期向量 {data.staleVectors} · 无效或维度不匹配 {data.invalidVectors}</p><p>语义阈值 {data.policy.semanticThreshold} · 最多 {data.policy.maxSources} 个来源 · 证据预算 {data.policy.contextChars} 字符。此状态说明取得了哪些证据，回答是否正确仍需核对原文。</p></details>;
}
