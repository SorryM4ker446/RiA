"use client";

import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, FileCode2, FileText, Files, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { collectEditedFiles, type EditedFile } from "@/lib/terminal/file-change-summary";

const labels = { created: "新增", modified: "修改", deleted: "删除" } as const;
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
function describe(file: EditedFile) {
  if (!file.after) return file.before?.lines === undefined ? "文件已删除" : `原 ${file.before.lines} 行`;
  if (!file.before) return file.after.lines === undefined ? bytes(file.after.bytes) : `${file.after.lines} 行`;
  if (file.before.lines !== undefined && file.after.lines !== undefined) return `${file.before.lines} → ${file.after.lines} 行`;
  return `${bytes(file.before.bytes)} → ${bytes(file.after.bytes)}`;
}

export function EditedFiles({ parts }: { parts: readonly unknown[] }) {
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
      if (!response.ok) throw new Error(payload.error?.message ?? "无法打开文件。");
      if (!(await bridge.openFile(payload.data.absolutePath)).opened) throw new Error("系统未能打开此文件，请检查默认应用或文件是否仍然存在。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法打开文件。"); }
    finally { opening.current = false; setBusy(null); }
  }

  return <Card className="mt-5" role="region" aria-label="最近编辑的文件">
    <CardHeader className="gap-0 px-3 pb-1 pt-3">
      <CardTitle className="flex items-center gap-2"><Files aria-hidden="true" className="size-4 text-muted-foreground" />最近编辑的文件<Badge variant="secondary">{files.length}</Badge></CardTitle>
      <CardDescription className="sr-only">{["created", "modified", "deleted"].flatMap(kind => {
        const count = files.filter(file => file.kind === kind).length;
        return count ? [`${labels[kind as keyof typeof labels]} ${count} 个`] : [];
      }).join(" · ") || "文件变更检测未完成"}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-0 px-1.5 pb-1.5">
      <ul className="flex min-w-0 flex-col gap-1">
        {visible.map(file => {
          const key = `${file.grantId}:${file.cwd}:${file.path}`;
          const filename = file.path.split("/").at(-1)!;
          const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
          const Icon = /\.(md|txt|csv|json)$/i.test(filename) ? FileText : FileCode2;
          return <li key={key}>
            <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-2" disabled={!canOpen || !file.after || busy !== null} aria-label={`打开文件 ${file.path}`} title={`${file.cwd}/${file.path} · ${canOpen ? "以默认应用打开" : "在桌面应用中打开"}`} onClick={() => void open(file)}>
              <Icon data-icon="inline-start" />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                <span className="flex w-full min-w-0 items-center gap-2"><span className="truncate font-medium">{filename}</span><Badge variant={file.kind === "created" ? "success" : file.kind === "deleted" ? "danger" : "outline"}>{labels[file.kind]}</Badge></span>
                <span className="max-w-full truncate text-xs font-normal text-muted-foreground">{directory ? `${directory} · ` : ""}{describe(file)}</span>
              </span>
              {busy === `${file.grantId}:${file.path}` ? <Loader2 data-icon="inline-end" className="animate-spin" /> : file.after && canOpen ? <ExternalLink data-icon="inline-end" /> : null}
            </Button>
          </li>;
        })}
      </ul>
      {files.length > 3 ? <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}{expanded ? "收起" : `展开其余 ${files.length - 3} 个文件`}</Button> : null}
      {!complete || !canOpen ? <p className="px-2 py-1 text-xs text-muted-foreground">{!complete ? "部分文件未能统计" : "请在桌面应用中打开文件"}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>;
}
