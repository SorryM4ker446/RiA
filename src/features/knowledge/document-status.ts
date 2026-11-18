import { t, tf } from "@/lib/locale";
import type { DocumentSummary } from "./document-client";

/**
 * What a document's index state means to someone using the library, in plain words. The
 * counts behind it (vectors, models, index versions) are shown only in the library's
 * search settings and diagnostics.
 */
export function documentReadiness(document: Pick<DocumentSummary, "semantic" | "_count" | "ocr">, indexingRunning: boolean): { label: string; tone: "success" | "neutral" | "warning"; detail?: string } | null {
  // Scanned pages come first: until they are read, the document is missing that text.
  if (document.ocr?.status === "failed") return { label: t("ui.knowledge.document-status.ocrFailed"), tone: "warning", ...(document.ocr.error ? { detail: document.ocr.error } : {}) };
  if (document.ocr && document.ocr.status !== "done") return { label: tf("ui.knowledge.document-status.ocrReading", { done: document.ocr.done, total: document.ocr.total }), tone: "neutral" };
  if (document.semantic?.lexicalCurrent === false) return { label: t("ui.knowledge.document-status.needsUpdate"), tone: "warning" };
  const semantic = document.semantic;
  if (!semantic?.modelRef) return null;
  if (semantic.indexed < semantic.total) return { label: tf(indexingRunning ? "ui.knowledge.document-status.processing" : "ui.knowledge.document-status.pending", { v0: semantic.indexed, v1: semantic.total }), tone: "neutral" };
  return { label: t("ui.knowledge.document-status.ready"), tone: "success" };
}
