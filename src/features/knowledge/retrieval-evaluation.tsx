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
import { QualityAssessment } from "./quality-assessment";

const example = JSON.stringify([{ question: "出门办事的钱怎样领回来", expectedFilenames: ["差旅规程.md"], requiredFacts: ["十个工作日", "书面说明"], expectations: [{ kind: "condition", statement: "提交核销申请需要保留税务票据。" }, { kind: "quantity", statement: "提交期限为回程后的十个工作日，不能改为十个自然日。" }, { kind: "exception", statement: "超过提交期限需要主管书面说明。" }], answerable: true }, { question: "知识库是否说明了火星的天气", answerable: false }], null, 2);
const metric = (value: number | null) => value == null ? "未设置/未运行" : `${Math.round(value * 100)}%`;

export function RetrievalEvaluation() {
  const [cases, setCases] = useState(example);
  const [generate, setGenerate] = useState(false);
  const [judge, setJudge] = useState(false);
  const [templates, setTemplates] = useState<AssistantTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [download, setDownload] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [templateAttempt, setTemplateAttempt] = useState(0);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setTemplatesLoading(true); setTemplateError("");
    void chatApi.listAssistants(controller.signal).then(payload => { if (!controller.signal.aborted) setTemplates(payload.data); })
      .catch(() => { if (!controller.signal.aborted) setTemplateError("无法加载助理模板。可重试，或选择默认模型继续评测。"); })
      .finally(() => { if (!controller.signal.aborted) setTemplatesLoading(false); });
    return () => controller.abort();
  }, [templateAttempt]);
  useEffect(() => () => request.current?.abort(), []);
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
    if (!window.confirm(judge ? "运行评测会发送查询、文档片段及助理指令生成回答，再将回答、证据和评判标准发送到同一聊天模型逐题评审。每题执行生成和评审，已配置的模型回退可能增加上游请求，可能产生 embedding、回答及评审费用。模型评审可能误判。继续？" : generate ? "运行评测会发送查询、文档片段及助理指令到已配置模型，可能产生 embedding 和回答生成费用。继续？" : "运行检索评测可能向已配置 embedding 模型发送查询并产生费用。继续？")) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(""); setReport(null);
    try {
      const response = await fetch("/api/documents/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, generateAnswers: generate, judgeAnswers: judge, ...(templateId ? { assistantTemplateId: templateId } : {}), cases: parsed }), signal: controller.signal });
      const payload = await response.json(); if (!response.ok) throw new Error(getApiErrorMessage(payload, "评测失败"));
      if (!controller.signal.aborted) setReport(payload.data);
    } catch (error) { setError(controller.signal.aborted ? "评测已取消。已经发出的模型请求仍可能产生费用。" : error instanceof Error ? error.message : "评测失败"); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  return <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">检索质量评测</summary><div className="mt-4 space-y-3">
    <p className="text-xs text-muted-foreground">把示例改为自己的资料文件名、问题和必须覆盖的事实。字面覆盖率和引用数不代表回答正确。可开启模型语义评审，检查事实、条件、例外、数值、冲突和拒答；评审结果需人工复核。报告含查询、片段、回答及评判标准，仅在主动下载时导出。</p>
    <p className="text-xs text-muted-foreground">expectations 可填写 kind（fact、condition、exception、quantity、conflict）与 statement（完整期望）。期望只进入评分与评审，不发送给回答生成模型。无答案题使用 answerable: false，留空期望事实和文档。</p>
    <label className="block space-y-1 text-sm"><span>评测问题 JSON（最多 12 个）</span><Textarea aria-label="评测问题 JSON（最多 12 个）" className="min-h-64 font-mono text-xs" disabled={busy} value={cases} onChange={event => setCases(event.target.value)} /></label>
    <label className="block space-y-1 text-sm"><span>评测助理模板</span><select disabled={busy || templatesLoading} className="max-w-full rounded border bg-background p-2" value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">默认检索与聊天模型</option>{templates.map(template => <option key={template.id} value={template.id}>{template.config.name}</option>)}</select></label>
    {templateError ? <div className="space-y-1 text-xs"><p role="alert">{templateError}</p><Button variant="outline" disabled={busy || templatesLoading} onClick={() => setTemplateAttempt(value => value + 1)}>重试加载模板</Button></div> : null}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={generate} onChange={event => { setGenerate(event.target.checked); if (!event.target.checked) setJudge(false); }} />同时生成回答（调用已配置聊天模型）</label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || !generate} checked={judge} onChange={event => setJudge(event.target.checked)} />模型语义评审（额外调用聊天模型）</label>
    {judge ? <p className="text-xs text-muted-foreground">界面使用回答模型评审自身回答，并非独立评审。每题增加一次评审请求，不确定、失败与不适用会分别显示。</p> : null}
    <div className="flex flex-wrap gap-3"><Button disabled={busy || (!!templateId && (templatesLoading || !!templateError))} onClick={() => void run()}>运行评测</Button>{busy ? <Button variant="outline" onClick={() => request.current?.abort()}>取消评测</Button> : null}{report && download ? <a className="text-sm underline" href={download} download="knowledge-evaluation.json">下载评测报告</a> : null}</div>
    {busy ? <p role="status" className="text-sm">正在逐题评测，最多运行两分钟…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {report ? <div className="space-y-4">
      <p role="status" className="text-sm">评测完成：{report.cases.filter(item => item.status === "success").length}/{report.cases.length} 题成功 · {Math.round(report.durationMs)} ms{report.model ? ` · ${report.model.modelId}` : " · 未生成回答"}</p>
      {report.judgedAnswers ? <p className="text-sm">语义评审完成 {report.cases.filter(item => item.quality?.status === "complete").length}/{report.cases.length} · 失败 {report.cases.filter(item => item.quality?.status === "failed").length} · 未运行 {report.cases.filter(item => !item.quality).length}</p> : null}
      {report.cases.map((item, index) => <article key={index} className="space-y-2 rounded border p-3">
        <h4 className="text-sm font-medium">{index + 1}. {item.question}</h4>
        <p className="text-xs">文档召回率：{metric(item.documentRecall)} · 证据事实覆盖（字面）：{metric(item.evidenceFactCoverage)} · 回答事实覆盖（字面）：{metric(item.answerFactCoverage)} · 实际引用 {item.citedSources} · 未知引用 {item.unknownCitations.length}</p>
        {item.status === "failed" ? <p className="text-sm text-destructive">此题失败：{item.errorCode}</p> : null}
        {item.unexpectedEvidence ? <p className="text-xs text-muted-foreground">预期无答案的问题召回了资料；这不等于拒答失败，请检查模型是否说明证据不足。</p> : null}
        {!item.answerable && item.answer ? <p className="text-xs">此题预期无答案，请人工确认模型明确说明证据不足。</p> : null}
        <QualityAssessment value={item.quality} /><RetrievalDiagnostics value={item.diagnostics} />
        {item.answer ? <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{item.answer}</pre> : null}
        <DocumentSources sources={item.sources} />
      </article>)}
    </div> : null}
  </div></details>;
}
