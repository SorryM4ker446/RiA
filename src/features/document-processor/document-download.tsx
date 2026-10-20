"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { documentDownload, formatLabels } from "@/lib/document-processor/schema";
import { downloadBlob } from "@/lib/download-blob";
import { getApiErrorMessage } from "@/lib/api-error-message";

export function DocumentDownload({ output }: { output: unknown }) {
  useLocale();
  const file = documentDownload(output);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => () => pending.current?.abort(), []);
  if (!file) return null;
  async function download() {
    if (!file || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
    try {
      const response = await fetch(file.downloadUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(getApiErrorMessage(await response.json(), t("ui.document-processor.document-download.documentDownloadFailed")));
      const blob = await response.blob(); if (!controller.signal.aborted) downloadBlob(blob, file.filename);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.document-processor.document-download.documentDownloadFailed")); }
    finally { if (!controller.signal.aborted) setBusy(false); pending.current = null; }
  }
  return <div className="mb-2 flex flex-col items-start gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void download()} className="max-w-full">{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}<span className="truncate">{t("ui.document-processor.document-download.download")}{formatLabels[file.format]} · {file.filename}</span></Button>{error && <p role="alert" className="text-xs text-destructive">{localizeMessage(error)}</p>}</div>;
}
