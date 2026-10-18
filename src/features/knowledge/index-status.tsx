import type { DocumentSummary } from "./document-client";
import type { IndexProgress } from "./index-maintenance";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Loader2, Settings2 } from "lucide-react";

export function IndexStatus({ documents, progress, busy, start, cancel }: { documents: DocumentSummary[]; progress: IndexProgress[]; busy: boolean; start: () => void; cancel: () => void }) {
  const pending = documents.filter(document => document.semantic?.modelRef && document.semantic.indexed < document.semantic.total);
  const old = documents.filter(document => document.semantic?.lexicalCurrent === false);
  const indexing = busy && progress.some(item => item.status === "indexing");
  return <details className="settings-disclosure knowledge-disclosure group" data-testid="index-maintenance">
    <summary className="settings-disclosure-trigger flex flex-wrap gap-2 py-2"><Settings2 className="size-4 text-muted-foreground" aria-hidden="true" /><span>索引维护</span>{pending.length > 0 && <Badge variant="secondary">待构建 {pending.length}</Badge>}{old.length > 0 && <Badge variant="warning">待更新 {old.length}</Badge>}{indexing && <Badge variant="secondary"><Loader2 className="size-3 animate-spin" aria-hidden="true" />构建中</Badge>}<ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-[--dur-fast] group-open:rotate-90" aria-hidden="true" /></summary>
    <div className="flex flex-col gap-3 py-3">
    <div className="flex flex-wrap gap-2"><Badge variant="outline">待构建 {pending.length} 个文档</Badge><Badge variant="outline">本地索引待更新 {old.length} 个</Badge><Badge variant="outline">过期向量 {documents.reduce((sum, document) => sum + (document.semantic?.stale ?? 0), 0)}</Badge><Badge variant="outline">模型不匹配 {documents.reduce((sum, document) => sum + (document.semantic?.differentModel ?? 0), 0)}</Badge><Badge variant="outline">异常向量 {documents.reduce((sum, document) => sum + (document.semantic?.invalid ?? 0), 0)}</Badge></div>
    <p className="max-w-3xl text-xs leading-6 text-muted-foreground">语义索引需先在“模型与用量”中选择 embedding 模型。每轮最多 12 次请求，已完成批次保存在本机。达到限额、失败或取消后可继续；本地索引待更新的文档请先“重新索引”。</p>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy || !pending.length} onClick={start}>批量构建或继续</Button>{busy && progress.some(item => item.status === "indexing") ? <Button type="button" size="sm" variant="outline" onClick={cancel}>取消索引构建</Button> : null}</div>
    {progress.length ? <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">本页最近一次构建</p><ul className="chat-list-scroll flex max-h-56 flex-col gap-2 overflow-y-auto text-xs leading-6">{progress.map(item => <li className="break-words" key={item.id}>{item.filename}：{{ waiting: "等待", indexing: "构建中", complete: "已完成", failed: "失败", paused: "待继续", cancelled: "已取消" }[item.status]} · {item.indexed}/{item.total}{item.error ? ` · ${item.error}` : ""}</li>)}</ul></div> : null}
    </div>
  </details>;
}
