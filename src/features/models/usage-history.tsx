"use client";

import { useRef, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import { formatDateTime, t } from "@/lib/locale";

export type UsageRow = { id: string; source: string; estimatedUsd: number | null; modelId: string; modelProvider: string; mode: string; status: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costSource: string; fallback: boolean; errorCode: string | null; createdAt: string };
export const sourceNames: Record<string, string> = { chat: "聊天", summary: "历史摘要", scheduled: "定时回顾", tool: "工具综合", embedding: "嵌入", media: "媒体生成", unattributed: "来源未记录" };
const cost = (value: number | null) => value === null ? t("models.unknown") : `$${value.toFixed(6)}`;

function UsageList({ rows }: { rows: UsageRow[] }) {
  const [limit, setLimit] = useState(8);
  const previousTop = useRef(0);
  const count = Math.min(limit, rows.length);
  return <div className="usage-history-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5" role="region" aria-label="调用明细列表" tabIndex={0} onScroll={event => {
    const node = event.currentTarget;
    const movingDown = node.scrollTop > previousTop.current;
    previousTop.current = node.scrollTop;
    if (movingDown && node.scrollTop + node.clientHeight >= node.scrollHeight - 80) setLimit(current => Math.min(current + 8, rows.length));
  }}>
    <ul className="flex flex-col gap-2">{rows.slice(0, count).map(row => <li key={row.id} className="usage-history-row flex flex-col gap-3 rounded-xl bg-muted/40 p-4">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-all text-sm font-medium">{row.modelId}</p><p className="mt-1 break-words text-xs text-muted-foreground">{row.modelProvider} · {row.mode} · {sourceNames[row.source] ?? "来源未记录"}</p></div><span className="shrink-0 text-xs">{row.status === "pending" ? "进行中" : row.status === "interrupted" ? "进程中断" : row.status === "success" ? t("models.statusSuccess") : row.status === "aborted" ? t("models.statusAborted") : t("models.statusFailed")}{row.fallback ? t("models.statusFallback") : ""}</span></div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs tabular-nums"><div><dt className="text-muted-foreground">输入 / 输出 Token</dt><dd className="mt-1">{row.inputTokens ?? t("models.unknown")} / {row.outputTokens ?? t("models.unknown")}</dd></div><div><dt className="text-muted-foreground">费用 · {row.costSource === "provider" ? t("models.costSourceProvider") : row.costSource === "configured" ? t("models.costSourceConfigured") : t("models.costSourceUnknown")}</dt><dd className="mt-1">{cost(row.costUsd)}</dd></div></dl>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{formatDateTime(row.createdAt)}</span><span>{row.durationMs} ms</span>{row.estimatedUsd != null && <span>调用前预估 {cost(row.estimatedUsd)}</span>}{row.errorCode && <span className="break-all">{row.errorCode}</span>}</div>
    </li>)}</ul>
    <p className="py-4 text-center text-xs text-muted-foreground" aria-live="polite">{rows.length ? `已展示 ${count} / ${rows.length} 条${count < rows.length ? " · 继续下滚查看更多" : " · 已展示全部已载入记录"}` : t("models.usageEmpty")}</p>
  </div>;
}

export function UsageHistory({ rows, source, onSourceChange, error }: { rows: UsageRow[] | undefined; source: string; onSourceChange: (value: string) => void; error: string }) {
  return <Sheet><SheetTrigger asChild><Button variant="outline" size="sm"><History aria-hidden="true" />查看调用明细</Button></SheetTrigger>
    <SheetContent side="right" className="usage-history-sheet flex flex-col" closeLabel="关闭调用明细">
      <div className="flex shrink-0 flex-col gap-3 p-5 pr-14"><SheetTitle className="text-lg font-semibold">模型调用明细</SheetTitle><SheetDescription className="text-xs text-muted-foreground">最近 30 天 · 最多载入最近 100 条，向下滚动分批展示。</SheetDescription>
        <label className="flex flex-wrap items-center gap-3 text-sm">调用来源<SelectField aria-label="明细调用来源" value={source} onValueChange={onSourceChange}><SelectOption value="all">全部来源</SelectOption>{Object.entries(sourceNames).map(([value, label]) => <SelectOption key={value} value={value}>{label}</SelectOption>)}</SelectField></label>
      </div>
      {error ? <p role="alert" className="px-5 text-sm text-destructive">{error}</p> : rows ? <UsageList key={source} rows={rows} /> : <p role="status" className="px-5 text-sm text-muted-foreground">正在读取调用记录…</p>}
    </SheetContent>
  </Sheet>;
}
