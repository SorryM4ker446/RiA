import { t, tf } from "@/lib/locale";
import type { DocumentSummary } from "./document-client";

/**
 * What a document's index state means to someone using the library, in plain words. The
 * counts behind it (vectors, models, index versions) are shown only in the library's
 * search settings and diagnostics.
 */
export function documentReadiness(document: Pick<DocumentSummary, "semantic" | "_count">, indexingRunning: boolean): { label: string; tone: "success" | "neutral" | "warning" } | null {
  if (document.semantic?.lexicalCurrent === false) return { label: t("ui.knowledge.document-status.needsUpdate"), tone: "warning" };
  const semantic = document.semantic;
  if (!semantic?.modelRef) return null;
  if (semantic.indexed < semantic.total) return { label: tf(indexingRunning ? "ui.knowledge.document-status.processing" : "ui.knowledge.document-status.pending", { v0: semantic.indexed, v1: semantic.total }), tone: "neutral" };
  return { label: t("ui.knowledge.document-status.ready"), tone: "success" };
}
