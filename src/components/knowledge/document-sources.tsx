import Link from "next/link";
import { documentSourceUrl, type DocumentSource } from "@/lib/documents/types";

export function DocumentSources({ sources }: { sources: DocumentSource[] }) {
  if (!sources.length) return null;
  return <details className="mt-3 rounded-md border bg-muted/30 text-xs" open>
    <summary className="cursor-pointer px-3 py-2 font-medium">文档参考（{sources.length}）</summary>
    <p className="px-3 text-muted-foreground">检索到的参考片段，不代表回答已采用全部内容。</p>
    <ol className="space-y-3 p-3">
      {sources.map(source => <li key={source.chunkId}>
        <Link className="font-medium underline underline-offset-4" href={documentSourceUrl(source)}>{source.filename} · {source.pageNumber ? `第 ${source.pageNumber} 页` : `片段 ${source.ordinal + 1}`}</Link>
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">{source.snippet}</p>
      </li>)}
    </ol>
  </details>;
}
