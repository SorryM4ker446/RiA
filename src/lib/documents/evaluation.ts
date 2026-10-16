import { z } from "zod";
import { generateText } from "ai";
import { getChatModel } from "@/lib/ai/client";
import { preferredModel } from "@/lib/models/preferences";
import { withModelCallSource } from "@/lib/models/call-context";
import { resolveAssistant } from "@/lib/assistants/store";
import { assistantIdSchema, formatAssistantInstructions, retrievalPolicySchema } from "@/lib/assistants/schema";
import { documentSourceSchema, documentSourceUrl } from "./types";
import { documentDiagnosticsSchema } from "./diagnostics";
import { markDocumentCitations } from "./references";
import { retrieveDocuments, formatDocumentContext } from "./retrieval";
import { normalizeApiError } from "@/lib/server/api-error";
import { modelRefSchema } from "@/lib/models/preferences-schema";
import { expectationSchema, qualityCheckSchema, qualityCriteria, qualityJudgeSystem, validateQualityOutput } from "./quality";

export const evaluationRequestSchema = z.strictObject({
  confirm: z.literal(true),
  generateAnswers: z.boolean().default(false),
  judgeAnswers: z.boolean().default(false),
  judgeModel: modelRefSchema.optional(),
  assistantTemplateId: assistantIdSchema.optional(),
  policy: retrievalPolicySchema.optional(),
  cases: z.array(z.strictObject({
    question: z.string().trim().min(1).max(2000),
    collections: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    expectedFilenames: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
    requiredFacts: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    expectations: z.array(expectationSchema).max(12).default([]),
    answerable: z.boolean().default(true),
  }).refine(item => item.answerable || (!item.expectedFilenames.length && !item.requiredFacts.length && !item.expectations.length), "Unanswerable cases cannot specify expected documents or facts")).min(1).max(12),
}).refine(input => !input.assistantTemplateId || !input.policy, "A template owns its retrieval policy")
  .refine(input => !input.judgeAnswers || input.generateAnswers, "Answer judging requires answer generation")
  .refine(input => !input.judgeModel || input.judgeAnswers, "A judge model requires answer judging");

const nullableMetric = z.number().min(0).max(1).nullable();
export const evaluationReportSchema = z.object({
  createdAt: z.string(), generatedAnswers: z.boolean(), durationMs: z.number(),
  model: z.object({ providerId: z.string(), modelId: z.string() }).nullable(),
  judgedAnswers: z.boolean(), judgeModel: modelRefSchema.nullable(),
  template: z.object({ id: z.string(), revision: z.number(), name: z.string() }).nullable(),
  cases: z.array(z.object({
    question: z.string(), answerable: z.boolean(), status: z.enum(["success", "failed"]), errorCode: z.string().nullable(),
    sources: z.array(documentSourceSchema), diagnostics: documentDiagnosticsSchema.nullable(),
    documentRecall: nullableMetric, evidenceFactCoverage: nullableMetric, answerFactCoverage: nullableMetric,
    unexpectedEvidence: z.boolean(), citedSources: z.number(), unknownCitations: z.array(z.string()),
    answer: z.string().nullable(), responseModelId: z.string().nullable(), durationMs: z.number(),
    quality: z.object({ status: z.enum(["complete", "failed"]), responseModelId: z.string().nullable(), errorCode: z.string().nullable(),
      checks: z.array(qualityCheckSchema), criteria: z.array(z.object({ id: z.string(), kind: z.string(), statement: z.string() })), durationMs: z.number() }).nullable(),
  })),
});
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
const coverage = (expected: string[], text: string) => expected.length ? expected.filter(fact => text.includes(fact)).length / expected.length : null;

/** Expectations are scoring data and never reach the answer-generation prompt. */
export async function evaluateDocuments(input: z.infer<typeof evaluationRequestSchema>, signal: AbortSignal): Promise<EvaluationReport> {
  signal.throwIfAborted();
  const started = performance.now();
  const assistant = input.assistantTemplateId ? await resolveAssistant(input.assistantTemplateId) : null;
  const model = input.generateAnswers ? await preferredModel("chat", assistant?.model ?? undefined) : null;
  const judgeModel = input.judgeAnswers ? await preferredModel("chat", input.judgeModel ?? model ?? undefined) : null;
  const policy = assistant?.retrieval ?? input.policy;
  const cases: EvaluationReport["cases"] = [];
  for (const item of input.cases) {
    signal.throwIfAborted();
    const caseStarted = performance.now();
    const row: EvaluationReport["cases"][number] = { question: item.question, answerable: item.answerable, status: "success", errorCode: null, sources: [], diagnostics: null,
      documentRecall: null, evidenceFactCoverage: null, answerFactCoverage: null, unexpectedEvidence: false, citedSources: 0, unknownCitations: [], answer: null, responseModelId: null, quality: null, durationMs: 0 };
    try {
      const result = await retrieveDocuments(item.question, 8, item.collections ?? assistant?.collections, signal, policy);
      row.sources = result.sources.map(source => documentSourceSchema.parse(source)); row.diagnostics = result.diagnostics;
      const filenames = new Set(row.sources.map(source => source.filename));
      row.documentRecall = item.expectedFilenames.length ? item.expectedFilenames.filter(filename => filenames.has(filename)).length / item.expectedFilenames.length : null;
      row.evidenceFactCoverage = coverage(item.requiredFacts, row.sources.map(source => source.snippet).join("\n"));
      row.unexpectedEvidence = !item.answerable && row.sources.length > 0;
      if (model) {
        const answer = await withModelCallSource("tool", () => generateText({
          model: getChatModel(model), maxRetries: 0, maxOutputTokens: 1500,
          system: "Answer using the provided knowledge evidence. Explicitly disclose insufficient or conflicting evidence. Do not invent sources. This evaluation has no tools or long-term memory." + formatAssistantInstructions(assistant) + formatDocumentContext(row.sources),
          prompt: item.question, abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        }));
        signal.throwIfAborted(); row.answer = answer.text; row.responseModelId = answer.response.modelId;
        row.sources = markDocumentCitations(row.sources, answer.text);
        row.citedSources = row.sources.filter(source => source.citationStatus === "cited").length;
        const actualUrls = new Set(row.sources.map(documentSourceUrl));
        row.unknownCitations = [...new Set([...answer.text.matchAll(/\[[^\]]+\]\((\/knowledge\/documents\/[^\s)]+)\)/gu)].map(match => match[1]).filter(url => !actualUrls.has(url)))];
        row.answerFactCoverage = coverage(item.requiredFacts, answer.text);
        if (judgeModel) {
          signal.throwIfAborted();
          const judgeStarted = performance.now();
          const criteria = qualityCriteria(item);
          row.quality = { status: "failed", responseModelId: null, errorCode: null, checks: [], criteria, durationMs: 0 };
          try {
            const judged = await withModelCallSource("tool", () => generateText({
              model: getChatModel(judgeModel), maxRetries: 0, maxOutputTokens: 6000,
              system: qualityJudgeSystem,
              prompt: JSON.stringify({ question: item.question, answerable: item.answerable, answer: answer.text, criteria,
                sources: row.sources.map(source => ({ chunkId: source.chunkId, filename: source.filename, excerpt: source.snippet, url: documentSourceUrl(source) })) }),
              abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            }));
            signal.throwIfAborted();
            row.quality.responseModelId = judged.response.modelId;
            row.quality.checks = validateQualityOutput(judged.text, criteria, answer.text, row.sources);
            row.quality.status = "complete";
          } catch (error) {
            signal.throwIfAborted(); row.quality.errorCode = normalizeApiError(error).code;
          }
          row.quality.durationMs = performance.now() - judgeStarted;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      row.status = "failed"; row.errorCode = normalizeApiError(error).code;
    }
    row.durationMs = performance.now() - caseStarted; cases.push(row);
  }
  return { createdAt: new Date().toISOString(), generatedAnswers: input.generateAnswers, judgedAnswers: input.judgeAnswers, judgeModel, durationMs: performance.now() - started, model,
    template: assistant ? { id: assistant.templateId, revision: assistant.templateRevision, name: assistant.name } : null, cases };
}
