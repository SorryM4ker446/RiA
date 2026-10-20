"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, FileCode2, FileText, Files, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { collectEditedFiles, type EditedFile } from "@/lib/terminal/file-change-summary";

const labels = () => ({ created: t("ui.chat.edited-files.added"), modified: t("ui.chat.edited-files.modified"), deleted: t("documents.delete") } as const);
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
function describe(file: EditedFile) {
  if (!file.after) return file.before?.lines === undefined ? t("ui.chat.edited-files.fileDeleted") : tf("ui.chat.edited-files.previouslyLines", { v0: file.before.lines });
  if (!file.before) return file.after.lines === undefined ? bytes(file.after.bytes) : tf("ui.chat.edited-files.lines", { v0: file.after.lines });
  if (file.before.lines !== undefined && file.after.lines !== undefined) return tf("ui.chat.edited-files.lines2", { v0: file.before.lines, v1: file.after.lines });
  return `${bytes(file.before.bytes)} → ${bytes(file.after.bytes)}`;
}

export function EditedFiles({ parts }: { parts: readonly unknown[] }) {
  useLocale();
  const { files, complete } = collectEditedFiles(parts);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const opening = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (!files.length && complete) return null;
  const visible = expanded ? files : files.slice(0, 3);
  const canOpen = typeof window !== "undefined" && !!window.privateAiDesktop?.openFile;

  async function open(file: EditedFile) {
    const bridge = window.privateAiDesktop;
    if (!bridge?.openFile || opening.current) return;
    opening.current = true;
    setBusy(`${file.grantId}:${file.path}`);
    setError(null);
    try {
      const response = await fetch("/api/terminal/files/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grantId: file.grantId, path: file.path }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("ui.chat.edited-files.couldNotOpenFile"));
      if (!(await bridge.openFile(payload.data.absolutePath)).opened) throw new Error(t("ui.chat.edited-files.theSystemCouldNotOpenThis"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("ui.chat.edited-files.couldNotOpenFile")); }
    finally { opening.current = false; setBusy(null); }
  }

  return <Card className="mt-5" role="region" aria-label={t("ui.chat.edited-files.recentlyEditedFiles")}>
    <CardHeader className="gap-0 px-3 pb-1 pt-3">
      <CardTitle className="flex items-center gap-2"><Files aria-hidden="true" className="size-4 text-muted-foreground" />{t("ui.chat.edited-files.recentlyEditedFiles")}<Badge variant="secondary">{files.length}</Badge></CardTitle>
      <CardDescription className="sr-only">{["created", "modified", "deleted"].flatMap(kind => {
        const count = files.filter(file => file.kind === kind).length;
        return count ? [tf("ui.chat.edited-files.items", { v0: labels()[kind as keyof typeof labels], v1: count })] : [];
      }).join(" · ") || t("ui.chat.edited-files.fileChangeDetectionIncomplete")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-0 px-1.5 pb-1.5">
      <ul className="flex min-w-0 flex-col gap-1">
        {visible.map(file => {
          const key = `${file.grantId}:${file.cwd}:${file.path}`;
          const filename = file.path.split("/").at(-1)!;
          const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
          const Icon = /\.(md|txt|csv|json)$/i.test(filename) ? FileText : FileCode2;
          return <li key={key}>
            <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-2" disabled={!canOpen || !file.after || busy !== null} aria-label={tf("ui.chat.edited-files.openFile", { v0: file.path })} title={`${file.cwd}/${file.path} · ${canOpen ? t("ui.chat.edited-files.openInDefaultApplication") : t("ui.chat.edited-files.openInDesktopApp")}`} onClick={() => void open(file)}>
              <Icon data-icon="inline-start" />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                <span className="flex w-full min-w-0 items-center gap-2"><span className="truncate font-medium">{filename}</span><Badge variant={file.kind === "created" ? "success" : file.kind === "deleted" ? "danger" : "outline"}>{labels()[file.kind]}</Badge></span>
                <span className="max-w-full truncate text-xs font-normal text-muted-foreground">{directory ? `${directory} · ` : ""}{describe(file)}</span>
              </span>
              {busy === `${file.grantId}:${file.path}` ? <Loader2 data-icon="inline-end" className="animate-spin" /> : file.after && canOpen ? <ExternalLink data-icon="inline-end" /> : null}
            </Button>
          </li>;
        })}
      </ul>
      {files.length > 3 ? <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}{expanded ? t("ui.chat.edited-files.collapse") : tf("ui.chat.edited-files.showMoreFiles", { v0: files.length - 3 })}</Button> : null}
      {!complete || !canOpen ? <p className="px-2 py-1 text-xs text-muted-foreground">{!complete ? t("ui.chat.edited-files.someFilesCouldNotBeCounted") : t("ui.chat.edited-files.openFilesInTheDesktopApp")}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>;
}
