"use client";
import { useLocale } from "@/lib/locale/client";
import { t, localizeMessage } from "@/lib/locale";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { SelectField, SelectOption } from "@/components/ui/select";
import { chatApi } from "@/features/chat/api-client";
import type { ToolDocumentSelection } from "@/features/chat/types";
import { decodeDocumentScope } from "@/lib/documents/scope";
import { exportFormats, formatLabels, type ExportFormat } from "@/lib/document-processor/schema";

/**
 * A document tool's controls, in the composer's control row like the others.
 * Attached files are the source when there are any, and show as attachments, so
 * the library list only appears when it is the source and has something in it.
 */
export function DocumentToolBar({ document, onDocumentChange, format, onFormatChange, showFormat, hasAttachments, scope = "", disabled }: {
  document: ToolDocumentSelection | null;
  onDocumentChange: (document: ToolDocumentSelection | null) => void;
  format: ExportFormat;
  onFormatChange: (format: ExportFormat) => void;
  showFormat: boolean;
  hasAttachments: boolean;
  scope?: string;
  disabled: boolean;
}) {
  useLocale();
  const [documents, setDocuments] = useState<Array<ToolDocumentSelection & { collection: string | null }> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void chatApi.listDocuments(controller.signal).then(({ data }) => {
      if (controller.signal.aborted) return;
      const collections = decodeDocumentScope(scope);
      setDocuments(data.filter(item => !collections.length || (item.collection !== null && collections.includes(item.collection))));
      setError("");
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setDocuments([]);
      setError(failure instanceof Error ? failure.message : t("ui.chat.api-client.couldNotLoadKnowledgeDocuments"));
    });
    return () => controller.abort();
  }, [scope]);
  const available = documents?.some(item => item.id === document?.id);
  const showSource = !hasAttachments && Boolean(documents?.length);
  return <>
    {error ? <span role="alert" className="min-w-0 truncate text-xs text-destructive">{localizeMessage(error)}</span> : null}
    {showSource ? <SelectField aria-label={t("ui.chat.document-tool-input.knowledgeDocuments")} size="sm" variant="ghost" fluid className="w-auto min-w-0 max-w-52" value={available ? document!.id : ""} disabled={disabled} onValueChange={id => onDocumentChange(documents?.find(item => item.id === id) ?? null)}>
      <SelectOption value="">{t("chat.document.choose")}</SelectOption>
      {documents?.map(item => <SelectOption key={item.id} value={item.id}>{item.filename}{item.collection ? ` · ${item.collection}` : ""}</SelectOption>)}
    </SelectField> : null}
    {showFormat ? <>
      {showSource ? <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      <SelectField aria-label={t("chat.document.format")} size="sm" variant="ghost" fluid className="w-auto shrink-0" value={format} disabled={disabled} onValueChange={value => onFormatChange(value as ExportFormat)}>
        {exportFormats.map(value => <SelectOption key={value} value={value}>{localizeMessage(formatLabels[value])}</SelectOption>)}
      </SelectField>
    </> : null}
  </>;
}
