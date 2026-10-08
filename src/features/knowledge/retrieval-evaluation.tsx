"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { EvaluationReport } from "@/lib/documents/evaluation";
import { chatApi } from "@/features/chat/api-client";
import type { AssistantTemplate } from "@/lib/assistants/schema";

const example = JSON.stringify([{ question: "出门办事的钱怎样领回来", expectedFilenames: ["差旅规程.md"], requiredFacts: ["十个工作日", "书面说明"], answerable: true }, { question: "知识库是否说明了火星的天气", answerable: false }], null, 2);
const metric = (value: number | null) => value == null ? "未设置/未运行" : `${Math.round(value * 100)}%`;

export function RetrievalEvaluation() {
  const [cases, setCases] = useState(example);
  const [generate, setGenerate] = useState(false);
  const [templates, setTemplates] = useState<AssistantTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [download, setDownload] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); void chatApi.listAssistants(controller.signal).then(payload => setTemplates(payload.data)).catch(() => {}); return () => { controller.abort(); request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    setDownload(url); return () => URL.revokeObjectURL(url);
  }, [report]);
  async function run() {
    if (request.current) return;
    let parsed: unknown;
    try { parsed = JSON.parse(cases); if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12) throw new Error("请输入 1–12 个评测问题。"); }
    catch (error) { setError(error instanceof Error ? error.message : "评测问题格式错误"); return; }
    if (!window.confirm(generate ? "运行评测会发送查询、文档片段及助理指令到已配置模型，可能产生 embedding 和回答生成费用。继续？" : "运行检索评测可能向已配置 embedding 模型发送查询并产生费用。继续？")) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(""); setReport(null);
    try {
      const response = await fetch("/api/documents/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, generateAnswers: generate, ...(templateId ? { assistantTemplateId: templateId } : {}), cases: parsed }), signal: controller.signal });
      const payload = await response.json(); if (!response.ok) throw new Error(getApiErrorMessage(payload, "评测失败"));
      if (!controller.signal.aborted) setReport(payload.data);
    } catch (error) { setError(controller.signal.aborted ? "评测已取消。已经发出的模型请求仍可能产生费用。" : error instanceof Error ? error.message : "评测失败"); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  return <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">检索质量评测</summary><div className="mt-4 space-y-3">
    <p className="text-xs text-muted-foreground">把示例改为自己的资料文件名、问题和必须覆盖的事实。覆盖率是文本匹配，引用数只检查链接对应实际证据；语义正确性、条件和拒答需人工审阅。报告含查询、片段和回答，仅在主动下载时导出。</p>
    <label className="block space-y-1 text-sm"><span>评测问题 JSON（最多 12 个）</span><Textarea aria-label="评测问题 JSON（最多 12 个）" className="min-h-64 font-mono text-xs" disabled={busy} value={cases} onChange={event => setCases(event.target.value)} /></label>
    <label className="block space-y-1 text-sm"><span>评测助理模板</span><select disabled={busy} className="max-w-full rounded border bg-background p-2" value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">默认检索与聊天模型</option>{templates.map(template => <option key={template.id} value={template.id}>{template.config.name}</option>)}</select></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={generate} onChange={event => setGenerate(event.target.checked)} />同时生成回答（调用已配置聊天模型）</label>
    <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void run()}>运行评测</Button>{busy ? <Button variant="outline" onClick={() => request.current?.abort()}>取消评测</Button> : null}{report && download ? <a className="text-sm underline" href={download} download="knowledge-evaluation.json">下载评测报告</a> : null}</div>
    {busy ? <p role="status" className="text-sm">正在逐题评测，最多运行两分钟…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {report ? <div className="space-y-4"><p role="status" className="text-sm">评测完成：{report.cases.filter(item => item.status === "success").length}/{report.cases.length} 题成功 · {Math.round(report.durationMs)} ms{report.model ? ` · ${report.model.modelId}` : " · 未生成回答"}</p>{report.cases.map((item, index) => <article key={index} className="space-y-2 rounded border p-3"><h4 className="text-sm font-medium">{index + 1}. {item.question}</h4><p className="text-xs">文档召回率：{metric(item.documentRecall)} · 证据事实覆盖：{metric(item.evidenceFactCoverage)} · 回答事实覆盖：{metric(item.answerFactCoverage)} · 实际引用 {item.citedSources} · 未知引用 {item.unknownCitations.length}</p>{item.status === "failed" ? <p className="text-sm text-destructive">此题失败：{item.errorCode}</p> : null}{item.unexpectedEvidence ? <p className="text-xs text-destructive">预期无答案的问题召回了资料，请检查是否存在无关证据。</p> : null}{!item.answerable && item.answer ? <p className="text-xs">此题预期无答案，请人工确认模型明确说明证据不足。</p> : null}<RetrievalDiagnostics value={item.diagnostics} />{item.answer ? <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{item.answer}</pre> : null}<DocumentSources sources={item.sources} /></article>)}</div> : null}
  </div></details>;
}
