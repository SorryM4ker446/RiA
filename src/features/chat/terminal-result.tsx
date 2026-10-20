"use client";

import { useEffect, useState } from "react";
import { Loader2, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { TerminalCommandResult, TerminalInput, TerminalSessionView } from "@/lib/terminal/schema";

const labels: Record<TerminalSessionView["status"], string> = { running: "正在执行", completed: "已完成", failed: "执行失败", stopped: "已停止", "timed-out": "已超时" };

export function TerminalResult({ input, output, active }: { input: unknown; output?: unknown; active: boolean }) {
  const proposal = input as Partial<TerminalInput> | undefined;
  const final = output && typeof output === "object" && "stdout" in output ? output as TerminalCommandResult : undefined;
  const sessionId = proposal?.binding?.sessionId;
  const [live, setLive] = useState<TerminalSessionView>();
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!active || !sessionId || final) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let absent = 0;
    async function poll() {
      try {
        const response = await fetch(`/api/terminal/sessions/${sessionId}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 404 && ++absent < 10) { timer = setTimeout(poll, 750); return; }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message ?? "无法读取终端输出。");
        if (controller.signal.aborted) return;
        setLive(payload.data);
        setError(undefined);
        if (payload.data.status === "running") timer = setTimeout(poll, 750);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取终端输出。");
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [active, sessionId, final, retry]);

  async function stop() {
    if (!sessionId) return;
    setStopping(true);
    try {
      const response = await fetch(`/api/terminal/sessions/${sessionId}`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "无法停止终端命令。");
      setLive(payload.data);
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法停止终端命令。"); }
    finally { setStopping(false); }
  }
  const result = final ?? live;
  return <section aria-label="终端命令" className="mt-2 flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <Terminal aria-hidden="true" className="size-4 text-muted-foreground" />
      <span className="text-muted-foreground">PowerShell</span>
      {result ? <Badge variant="outline">{labels[result.status]}</Badge> : null}
      {result?.status === "running" ? <Button size="sm" variant="outline" disabled={stopping} onClick={() => void stop()}>
        {stopping ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Square data-icon="inline-start" />}停止命令
      </Button> : null}
    </div>
    <p className="break-all text-muted-foreground">工作目录：{proposal?.binding?.cwd ?? "等待验证目录"}</p>
    <pre aria-label="PowerShell 命令" className="chat-list-scroll max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 font-mono text-xs">{proposal?.command}</pre>
    {result ? <>
      <pre aria-label="终端输出" aria-live="off" className="chat-list-scroll max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 font-mono text-xs">{result.stdout || (result.status === "running" ? "等待输出…" : "无标准输出")}</pre>
      {result.stderr ? <pre aria-label="终端错误输出" className="chat-list-scroll max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-xs text-destructive">{result.stderr}</pre> : null}
      <p className="text-muted-foreground">退出码：{result.exitCode ?? "—"}{result.truncated ? " · 输出已截断（最多 64 KiB）" : ""}</p>
    </> : null}
    {error && !final ? <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center gap-2">{error}<Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}>重试读取</Button></AlertDescription></Alert> : null}
  </section>;
}
