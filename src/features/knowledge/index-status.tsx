"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import type { DocumentSummary } from "./document-client";
import type { IndexProgress } from "./index-maintenance";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Loader2, Settings2 } from "lucide-react";

export function IndexStatus({ documents, progress, busy, start, cancel }: { documents: DocumentSummary[]; progress: IndexProgress[]; busy: boolean; start: () => void; cancel: () => void }) {
  useLocale();
  const pending = documents.filter(document => document.semantic?.modelRef && document.semantic.indexed < document.semantic.total);
  const old = documents.filter(document => document.semantic?.lexicalCurrent === false);
  const indexing = busy && progress.some(item => item.status === "indexing");
  return <details className="settings-disclosure knowledge-disclosure group" data-testid="index-maintenance">
    <summary className="settings-disclosure-trigger flex flex-wrap gap-2 py-2"><Settings2 className="size-4 text-muted-foreground" aria-hidden="true" /><span>{t("ui.knowledge.index-status.indexMaintenance")}</span>{pending.length > 0 && <Badge variant="secondary">{t("ui.knowledge.index-status.pendingBuild")}{pending.length}</Badge>}{old.length > 0 && <Badge variant="warning">{t("ui.knowledge.index-status.needsUpdating")}{old.length}</Badge>}{indexing && <Badge variant="secondary"><Loader2 className="size-3 animate-spin" aria-hidden="true" />{t("ui.knowledge.index-status.building")}</Badge>}<ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-[--dur-fast] group-open:rotate-90" aria-hidden="true" /></summary>
    <div className="flex flex-col gap-3 py-3">
    <div className="flex flex-wrap gap-2"><Badge variant="outline">{t("ui.knowledge.index-status.pendingBuild")}{pending.length} {t("ui.knowledge.index-status.documents")}</Badge><Badge variant="outline">{t("ui.knowledge.document-library.localIndexNeedsUpdating")}{old.length} {t("conversations.counts.loadedUnit")}</Badge><Badge variant="outline">{t("ui.knowledge.index-status.staleVectors")}{documents.reduce((sum, document) => sum + (document.semantic?.stale ?? 0), 0)}</Badge><Badge variant="outline">{t("ui.knowledge.index-status.modelMismatch")}{documents.reduce((sum, document) => sum + (document.semantic?.differentModel ?? 0), 0)}</Badge><Badge variant="outline">{t("ui.knowledge.index-status.invalidVectors")}{documents.reduce((sum, document) => sum + (document.semantic?.invalid ?? 0), 0)}</Badge></div>
    <p className="max-w-3xl text-xs leading-6 text-muted-foreground">{t("ui.knowledge.index-status.selectAnEmbeddingModelInModels")}</p>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy || !pending.length} onClick={start}>{t("ui.knowledge.index-status.buildOrResumeInBulk")}</Button>{busy && progress.some(item => item.status === "indexing") ? <Button type="button" size="sm" variant="outline" onClick={cancel}>{t("ui.knowledge.index-status.cancelIndexing")}</Button> : null}</div>
    {progress.length ? <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">{t("ui.knowledge.index-status.latestBuildOnThisPage")}</p><ul className="chat-list-scroll flex max-h-56 flex-col gap-2 overflow-y-auto text-xs leading-6">{progress.map(item => <li className="break-words" key={item.id}>{item.filename}：{{ waiting: t("ui.knowledge.index-status.waiting"), indexing: t("ui.knowledge.index-status.building"), complete: t("chat.tasks.statusDone"), failed: t("models.statusFailed"), paused: t("ui.knowledge.index-status.readyToResume"), cancelled: t("models.statusAborted") }[item.status]} · {item.indexed}/{item.total}{item.error ? ` · ${item.error}` : ""}</li>)}</ul></div> : null}
    </div>
  </details>;
}
