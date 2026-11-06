"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import { describeDocumentDiagnostics, documentDiagnosticsSchema } from "@/lib/documents/diagnostics";
import { ChevronRight } from "lucide-react";

export function RetrievalDiagnostics({ value, compact = false, inline = false }: { value: unknown; compact?: boolean; inline?: boolean }) {
  useLocale();
  const result = documentDiagnosticsSchema.safeParse(value);
  if (!result.success) return null;
  const data = result.data;
  const counts = <p>{t("ui.knowledge.retrieval-diagnostics.inScope")}{data.corpusChunks} {t("ui.knowledge.retrieval-diagnostics.chunksKeywordCandidates")}{data.lexicalCandidates} {t("ui.knowledge.retrieval-diagnostics.semanticCandidates")}{data.semanticCandidates} {t("ui.knowledge.retrieval-diagnostics.vectorsScanned")}{data.scannedVectors}/{data.compatibleVectors} {t("ui.knowledge.retrieval-diagnostics.staleVectors")}{data.staleVectors} {t("ui.knowledge.retrieval-diagnostics.invalidOrMismatchedDimensions")}{data.invalidVectors}</p>;
  const policy = <p>{t("ui.knowledge.retrieval-diagnostics.upTo")}{data.policy.maxSources} {t("ui.knowledge.retrieval-diagnostics.sourcesEvidenceBudget")}{data.policy.contextChars} {t("ui.knowledge.retrieval-diagnostics.charactersThisDescribesRetrievedEvidenceVerify")}</p>;
  if (inline) return <div className="flex max-w-3xl flex-col gap-1 text-xs leading-6 text-muted-foreground"><p>{describeDocumentDiagnostics(data)}</p>{counts}{policy}</div>;
  if (compact) return <details className="execution-disclosure text-xs text-muted-foreground">
    <summary><ChevronRight aria-hidden="true" />{t("ui.knowledge.retrieval-diagnostics.retrievalDiagnostics")}</summary>
    <div className="flex flex-col gap-2 pb-2 pl-5 leading-5">
      <p>{describeDocumentDiagnostics(data)}</p>
      <p>{t("ui.knowledge.retrieval-diagnostics.inScope")}{data.corpusChunks} {t("ui.knowledge.retrieval-diagnostics.chunksKeywordCandidates")}{data.lexicalCandidates} {t("ui.knowledge.retrieval-diagnostics.semanticCandidates")}{data.semanticCandidates} {t("ui.knowledge.retrieval-diagnostics.vectorsScanned")}{data.scannedVectors}/{data.compatibleVectors} {t("ui.knowledge.retrieval-diagnostics.staleVectors")}{data.staleVectors} {t("ui.knowledge.retrieval-diagnostics.invalidOrMismatchedDimensions")}{data.invalidVectors}</p>
      <p>{t("ui.knowledge.retrieval-diagnostics.upTo")}{data.policy.maxSources} {t("ui.knowledge.retrieval-diagnostics.sourcesEvidenceBudget")}{data.policy.contextChars} {t("ui.knowledge.retrieval-diagnostics.charactersThisDescribesRetrievedEvidenceVerify")}</p>
    </div>
  </details>;
  return <details className="rounded-md border p-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("ui.knowledge.retrieval-diagnostics.retrievalDiagnostics2")}{describeDocumentDiagnostics(data)}</summary><p className="mt-2">{t("ui.knowledge.retrieval-diagnostics.inScope")}{data.corpusChunks} {t("ui.knowledge.retrieval-diagnostics.chunksKeywordCandidates")}{data.lexicalCandidates} {t("ui.knowledge.retrieval-diagnostics.semanticCandidates")}{data.semanticCandidates} {t("ui.knowledge.retrieval-diagnostics.vectorsScanned")}{data.scannedVectors}/{data.compatibleVectors} {t("ui.knowledge.retrieval-diagnostics.staleVectors")}{data.staleVectors} {t("ui.knowledge.retrieval-diagnostics.invalidOrMismatchedDimensions")}{data.invalidVectors}</p><p>{t("ui.knowledge.retrieval-diagnostics.upTo")}{data.policy.maxSources} {t("ui.knowledge.retrieval-diagnostics.sourcesEvidenceBudget")}{data.policy.contextChars} {t("ui.knowledge.retrieval-diagnostics.charactersThisDescribesRetrievedEvidenceVerify")}</p></details>;
}
