"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { executionGuidance } from "@/lib/execution-messages";
import { t } from "@/lib/locale";
import type { ScheduledRunView } from "@/lib/scheduler/history";

const statusLabel = (status: string) => ({ running: "执行中", succeeded: "已完成", failed: "失败", interrupted: "进程中断" })[status] ?? "未知状态";

export function ScheduleHistory({ refreshKey, onExecuted }: { refreshKey: number; onExecuted: () => Promise<void> }) {
  const [runs, setRuns] = useState<ScheduledRunView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const latestRequest = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestRequest.current;
    try {
      const response = await fetch("/api/schedules/runs", { cache: "no-store", signal });
      if (!response.ok) throw new Error(response.status === 503 ? "工作区暂不可用，恢复期间不会认领新的定时任务，请稍后刷新。" : "无法读取执行历史。");
      const payload = await response.json();
      if (signal?.aborted || request !== latestRequest.current) return;
      setRuns(payload.data);
      setAutomatic(payload.automaticExecution);
      setError(null);
    } catch (failure) {
      if (!signal?.aborted && request === latestRequest.current) setError(failure instanceof Error ? failure.message : "无法读取执行历史。");
    } finally { if (!signal?.aborted && request === latestRequest.current) setLoading(false); }
  }, []);
  const running = runs.some(run => run.status === "running");
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = running || busy ? setInterval(() => void load(controller.signal), 5000) : null;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [load, refreshKey, running, busy]);

  async function retry(run: ScheduledRunView) {
    if (busy || !run.jobId) return;
    setBusy(true);
    setRetryError(null);
    try {
      const response = await fetch(`/api/schedules/${encodeURIComponent(run.jobId)}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "无法发起新的执行。");
    } catch (failure) { setRetryError(failure instanceof Error ? failure.message : "无法发起新的执行。"); }
    finally {
      await Promise.all([load(), onExecuted()]);
      setBusy(false);
    }
  }

  return (
    <section aria-label="定时执行历史" className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">最近执行</h3>
        <div className="flex gap-2">
          <Button onClick={() => void load()} size="sm" type="button" variant="outline">刷新记录</Button>
          <a className="text-xs underline underline-offset-4 self-center" href="/api/diagnostics" download>导出脱敏诊断</a>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">执行记录保留 90 天、最多 1,000 条，展示最近 50 条。提醒已读或删除计划不删除执行记录。诊断仅含时间、状态和错误类别，不含提示词、文件正文、路径或凭证。</p>
      {!automatic ? <p className="text-xs text-warning">当前为浏览器开发服务，自动调度未启动。定时任务只在桌面应用运行时自动执行。</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {retryError ? <p role="alert" className="text-xs text-destructive">{retryError}</p> : null}
      {loading ? <p className="text-xs text-muted-foreground">正在读取执行历史…</p> : runs.length === 0 ? <p className="text-xs text-muted-foreground">暂无执行记录。旧版本的上次状态不会补造成历史。</p> : (
        <ul className="space-y-2">
          {runs.map(run => (
            <li key={run.id} className="space-y-1 rounded-md border p-3 text-xs">
              <p className="flex flex-wrap justify-between gap-2"><span>{["backupReminder", "scheduledBackup", "dailyBrief", "weeklySummary"].includes(run.kind) ? t(`settings.schedules.kind.${run.kind}` as never) : "不支持的任务类型"}</span><span>{statusLabel(run.status)} · {run.trigger === "manual" ? "手动重试" : "定时执行"}</span></p>
              <p className="text-muted-foreground">开始：{new Date(run.startedAt).toLocaleString()} · 结束：{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "尚未结束"}</p>
              {run.errorCode ? <p>{run.status === "succeeded" ? "本地结果已保存，模型整理未完成。" : ""}{run.errorCode} · {executionGuidance(run.errorCode)}</p> : null}
              {!run.jobId ? <p className="text-muted-foreground">原计划已删除，执行证据仍保留。</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                {run.chatId ? <Link className="underline" href={`/chat?conversationId=${encodeURIComponent(run.chatId)}`}>打开生成的会话</Link> : null}
                {run.backupId ? <Link className="underline" href="/backups">查看备份</Link> : null}
                {run.canRetry ? <Button disabled={busy} onClick={() => void retry(run)} size="sm" type="button" variant="outline">{busy ? "正在执行…" : "重新执行一次"}</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">重新执行会创建新记录，模型任务可能再次计费。仅当前已启用计划的最近失败可重试；中断或已有产物的执行需先人工核对，不自动重放工具写入。</p>
    </section>
  );
}
