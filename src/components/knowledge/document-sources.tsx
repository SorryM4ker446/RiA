import Link from "next/link";
import { documentSourceUrl, type DocumentSource } from "@/lib/documents/types";
import { t } from "@/lib/locale";

export function DocumentSources({ sources }: { sources: DocumentSource[] }) {
  if (!sources.length) return null;
  return <details className="mt-3 rounded-lg bg-muted text-xs" open>
    <summary className="cursor-pointer px-3 py-2 font-medium tracking-label">{t("documents.sourcesTitle")}{t("documents.countOpen")}{sources.length}{t("documents.countClose")}</summary>
    <p className="px-3 text-muted-foreground">{t("documents.sourcesNote")}</p>
    <ol className="space-y-3 p-3">
      {sources.map(source => <li key={source.chunkId}>
        <Link className="font-medium tracking-label underline underline-offset-4 hover:no-underline" href={documentSourceUrl(source)}>{source.filename} · {source.pageNumber ? `${t("documents.pageLabel")} ${source.pageNumber} ${t("documents.pageUnit")}` : `${t("documents.chunkLabel")} ${source.ordinal + 1}`}</Link>
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">{source.snippet}</p>
      </li>)}
    </ol>
  </details>;
}
