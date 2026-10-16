import type { DocumentSummary } from "./document-client";
import type { IndexProgress } from "./index-maintenance";
import { Button } from "@/components/ui/button";

export function IndexStatus({ documents, progress, busy, start, cancel }: { documents: DocumentSummary[]; progress: IndexProgress[]; busy: boolean; start: () => void; cancel: () => void }) {
  const pending = documents.filter(document => document.semantic?.modelRef && document.semantic.indexed < document.semantic.total);
  const old = documents.filter(document => document.semantic?.lexicalCurrent === false);
  return <div className="space-y-2 rounded-lg border p-3" data-testid="index-maintenance">
    <h3 className="text-sm font-medium">索引维护</h3>
    <p className="text-xs text-muted-foreground">待构建 {pending.length} 个文档 · 本地索引待更新 {old.length} 个 · 过期向量 {documents.reduce((sum, document) => sum + (document.semantic?.stale ?? 0), 0)} · 模型不匹配 {documents.reduce((sum, document) => sum + (document.semantic?.differentModel ?? 0), 0)} · 异常向量 {documents.reduce((sum, document) => sum + (document.semantic?.invalid ?? 0), 0)}</p>
    <p className="text-xs text-muted-foreground">批量处理当前列表中未完成的文档，每轮最多 12 次请求。已完成批次保存在本机；达到限额、失败或取消后可主动继续。旧版索引请先点击文档的“重新索引”。</p>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy || !pending.length} onClick={start}>批量构建或继续</Button>{busy && progress.some(item => item.status === "indexing") ? <Button type="button" size="sm" variant="outline" onClick={cancel}>取消索引构建</Button> : null}</div>
    {progress.length ? <div><p className="mb-1 text-xs">本页最近一次构建</p><ul className="max-h-56 space-y-1 overflow-y-auto text-xs">{progress.map(item => <li className="break-words" key={item.id}>{item.filename}：{{ waiting: "等待", indexing: "构建中", complete: "已完成", failed: "失败", paused: "待继续", cancelled: "已取消" }[item.status]} · {item.indexed}/{item.total}{item.error ? ` · ${item.error}` : ""}</li>)}</ul></div> : null}
  </div>;
}
