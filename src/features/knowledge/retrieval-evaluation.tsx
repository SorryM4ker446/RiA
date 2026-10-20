"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { EvaluationReport } from "@/lib/documents/evaluation";
import { chatApi } from "@/features/chat/api-client";
import type { AssistantTemplate } from "@/lib/assistants/schema";
import { QualityAssessment } from "./quality-assessment";

const example = () => (JSON.stringify([{ question: t("ui.knowledge.retrieval-evaluation.howCanIGetReimbursedFor"), expectedFilenames: [t("ui.knowledge.retrieval-evaluation.travelPolicyMd")], requiredFacts: [t("ui.knowledge.retrieval-evaluation.tenBusinessDays"), t("ui.knowledge.retrieval-evaluation.writtenExplanation")], expectations: [{ kind: "condition", statement: t("ui.knowledge.retrieval-evaluation.taxReceiptsMustBeRetainedWhen") }, { kind: "quantity", statement: t("ui.knowledge.retrieval-evaluation.theDeadlineIsTenBusinessDays") }, { kind: "exception", statement: t("ui.knowledge.retrieval-evaluation.lateSubmissionsRequireAWrittenExplanation") }], answerable: true }, { question: t("ui.knowledge.retrieval-evaluation.doesTheKnowledgeBaseDescribeThe"), answerable: false }], null, 2));
const metric = (value: number | null) => value == null ? t("ui.knowledge.retrieval-evaluation.notConfiguredNotRun") : `${Math.round(value * 100)}%`;

export function RetrievalEvaluation() {
  useLocale();
  const [editedCases, setCases] = useState<string | null>(null);
  const cases = editedCases ?? example();
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
      .catch(() => { if (!controller.signal.aborted) setTemplateError(t("ui.knowledge.retrieval-evaluation.couldNotLoadAssistantTemplatesRetry")); })
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
    try { parsed = JSON.parse(cases); if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12) throw new Error(t("ui.knowledge.retrieval-evaluation.enter112EvaluationQuestions")); }
    catch (error) { setError(error instanceof Error ? error.message : t("ui.knowledge.retrieval-evaluation.invalidEvaluationQuestionFormat")); return; }
    if (!window.confirm(judge ? t("ui.knowledge.retrieval-evaluation.evaluationSendsQueriesDocumentExcerptsAnd") : generate ? t("ui.knowledge.retrieval-evaluation.evaluationSendsQueriesDocumentExcerptsAnd2") : t("ui.knowledge.retrieval-evaluation.retrievalEvaluationMaySendQueriesTo"))) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(""); setReport(null);
    try {
      const response = await fetch("/api/documents/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, generateAnswers: generate, judgeAnswers: judge, ...(templateId ? { assistantTemplateId: templateId } : {}), cases: parsed }), signal: controller.signal });
      const payload = await response.json(); if (!response.ok) throw new Error(getApiErrorMessage(payload, t("ui.knowledge.retrieval-evaluation.evaluationFailed")));
      if (!controller.signal.aborted) setReport(payload.data);
    } catch (error) { setError(controller.signal.aborted ? t("ui.knowledge.retrieval-evaluation.evaluationCancelledModelRequestsAlreadySent") : error instanceof Error ? error.message : t("ui.knowledge.retrieval-evaluation.evaluationFailed")); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  return <details className="settings-disclosure knowledge-disclosure group"><summary className="settings-disclosure-trigger py-2"><ClipboardCheck className="size-4 text-muted-foreground" aria-hidden="true" /><span>{t("ui.knowledge.retrieval-evaluation.retrievalQualityEvaluation")}</span><ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-[--dur-fast] group-open:rotate-90" aria-hidden="true" /></summary><div className="flex min-w-0 flex-col gap-4 py-3">
    <p className="max-w-3xl text-xs leading-6 text-muted-foreground">{t("ui.knowledge.retrieval-evaluation.replaceExamplesWithYourOwnFilenames")}</p>
    <p className="max-w-3xl text-xs leading-6 text-muted-foreground">{t("ui.knowledge.retrieval-evaluation.expectationsAcceptsKindFactConditionException")}</p>
    <FieldGroup><Field><FieldLabel htmlFor="knowledge-evaluation-cases">{t("ui.knowledge.retrieval-evaluation.evaluationQuestionsJSONUpTo12")}</FieldLabel><Textarea id="knowledge-evaluation-cases" aria-label={t("ui.knowledge.retrieval-evaluation.evaluationQuestionsJSONUpTo12")} rows={7} className="font-mono text-xs" disabled={busy} value={cases} onChange={event => setCases(event.target.value)} /></Field>
    <Field><FieldLabel htmlFor="knowledge-evaluation-template">{t("ui.knowledge.retrieval-evaluation.evaluationAssistantTemplate")}</FieldLabel><SelectField id="knowledge-evaluation-template" disabled={busy || templatesLoading} value={templateId} onValueChange={value => setTemplateId(value)}><SelectOption value="">{t("ui.knowledge.retrieval-evaluation.defaultRetrievalAndChatModel")}</SelectOption>{templates.map(template => <SelectOption key={template.id} value={template.id}>{template.builtin ? localizeMessage(template.config.name) : template.config.name}</SelectOption>)}</SelectField></Field></FieldGroup>
    {templateError ? <div className="flex flex-col gap-1 text-xs"><p role="alert">{templateError}</p><Button variant="outline" disabled={busy || templatesLoading} onClick={() => setTemplateAttempt(value => value + 1)}>{t("ui.knowledge.retrieval-evaluation.retryLoadingTemplates")}</Button></div> : null}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={generate} onChange={event => { setGenerate(event.target.checked); if (!event.target.checked) setJudge(false); }} />{t("ui.knowledge.retrieval-evaluation.alsoGenerateAnswersCallsConfiguredChat")}</label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || !generate} checked={judge} onChange={event => setJudge(event.target.checked)} />{t("ui.knowledge.retrieval-evaluation.modelSemanticReviewExtraChatModel")}</label>
    {judge ? <p className="max-w-3xl text-xs leading-6 text-muted-foreground">{t("ui.knowledge.retrieval-evaluation.theAnswerModelReviewsItsOwn")}</p> : null}
    <div className="flex flex-wrap gap-3"><Button disabled={busy || (!!templateId && (templatesLoading || !!templateError))} onClick={() => void run()}>{t("ui.knowledge.retrieval-evaluation.runEvaluation")}</Button>{busy ? <Button variant="outline" onClick={() => request.current?.abort()}>{t("ui.knowledge.retrieval-evaluation.cancelEvaluation")}</Button> : null}{report && download ? <a className="text-sm underline" href={download} download="knowledge-evaluation.json">{t("ui.knowledge.retrieval-evaluation.downloadEvaluationReport")}</a> : null}</div>
    {busy ? <p role="status" className="text-sm">{t("ui.knowledge.retrieval-evaluation.evaluatingQuestionsUpToTwoMinutes")}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{localizeMessage(error)}</p> : null}
    {report ? <div className="flex flex-col gap-4">
      <p role="status" className="text-sm">{t("ui.knowledge.retrieval-evaluation.evaluationComplete")}{report.cases.filter(item => item.status === "success").length}/{report.cases.length} {t("ui.knowledge.retrieval-evaluation.questionsSucceeded")}{Math.round(report.durationMs)} ms{report.model ? ` · ${report.model.modelId}` : t("ui.knowledge.retrieval-evaluation.noAnswerGenerated")}</p>
      {report.judgedAnswers ? <p className="text-sm">{t("ui.knowledge.retrieval-evaluation.semanticReviewComplete")}{report.cases.filter(item => item.quality?.status === "complete").length}/{report.cases.length} {t("ui.knowledge.retrieval-evaluation.failed")}{report.cases.filter(item => item.quality?.status === "failed").length} {t("ui.knowledge.retrieval-evaluation.notRun")}{report.cases.filter(item => !item.quality).length}</p> : null}
      {report.cases.map((item, index) => <article key={index} className="management-row flex min-w-0 flex-col gap-3 rounded-xl p-4">
        <h4 className="text-sm font-medium">{index + 1}. {item.question}</h4>
        <p className="text-xs">{t("ui.knowledge.retrieval-evaluation.documentRecall")}{metric(item.documentRecall)} {t("ui.knowledge.retrieval-evaluation.evidenceFactCoverageLiteral")}{metric(item.evidenceFactCoverage)} {t("ui.knowledge.retrieval-evaluation.answerFactCoverageLiteral")}{metric(item.answerFactCoverage)} {t("ui.knowledge.retrieval-evaluation.actualCitations")}{item.citedSources} {t("ui.knowledge.retrieval-evaluation.unknownCitations")}{item.unknownCitations.length}</p>
        {item.status === "failed" ? <p className="text-sm text-destructive">{t("ui.knowledge.retrieval-evaluation.questionFailed")}{item.errorCode}</p> : null}
        {item.unexpectedEvidence ? <p className="max-w-3xl text-xs leading-6 text-muted-foreground">{t("ui.knowledge.retrieval-evaluation.materialWasRetrievedForAnExpected")}</p> : null}
        {!item.answerable && item.answer ? <p className="text-xs">{t("ui.knowledge.retrieval-evaluation.thisQuestionIsExpectedToBe")}</p> : null}
        <QualityAssessment value={item.quality} /><RetrievalDiagnostics value={item.diagnostics} />
        {item.answer ? <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{item.answer}</pre> : null}
        <DocumentSources sources={item.sources} />
      </article>)}
    </div> : null}
  </div></details>;
}
