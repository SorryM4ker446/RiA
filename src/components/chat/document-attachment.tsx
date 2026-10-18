import { Download, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DocumentAttachment({ url, filename, mediaType, onRemove }: {
  url: string; filename?: string; mediaType: string; onRemove?: () => void;
}) {
  const name = filename || "文档附件";
  return (
    <div className="chat-document-attachment flex min-w-0 max-w-full items-center gap-2 rounded-lg border bg-background/40 p-2 text-sm">
      <FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs font-medium" title={name}>{name}</span>
        <span className="text-[11px] text-muted-foreground">{mediaType === "application/pdf" ? "PDF" : "Word"} · 文档附件</span>
      </div>
      {onRemove ? (
        <Button aria-label={`移除附件 ${name}`} onClick={onRemove} size="icon-sm" variant="ghost"><X aria-hidden="true" /></Button>
      ) : (
        <Button aria-label={`下载附件 ${name}`} asChild size="icon-sm" variant="ghost">
          <a href={`${url}?download=1`} download={name}><Download aria-hidden="true" /></a>
        </Button>
      )}
    </div>
  );
}
