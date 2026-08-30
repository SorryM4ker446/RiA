"use client";
import { getApiErrorMessage } from "@/lib/api-error-message";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type StorageStats = { assetCount: number; totalBytes: number; referencedCount: number; unreferencedCount: number; reclaimableCount: number; looseFileCount: number; graceHours: number };

export default function StoragePage() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/media", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, "无法读取存储信息"));
      setStats(payload.data);
    } catch (error) { setError(error instanceof Error ? error.message : "读取失败"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function cleanup() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/media/cleanup", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, "清理失败"));
      setMessage(`已清理 ${payload.data.removedCount} 个文件，释放 ${(payload.data.freedBytes / 1024 / 1024).toFixed(2)} MiB。${payload.data.failedCount ? ` ${payload.data.failedCount} 项暂未清理，可稍后重试。` : ""}`);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "清理失败"); }
    finally { setBusy(false); setConfirming(false); }
  }

  return <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6 pt-20">
    <Link className="text-sm underline" href="/chat">返回聊天</Link>
    <Card>
      <CardHeader><CardTitle>媒体存储</CardTitle><CardDescription>图片、视频和附件保存在本机数据目录，不随应用构建被替换。</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        {message ? <p role="status" className="text-sm">{message}</p> : null}
        {stats ? <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt>磁盘占用</dt><dd>{(stats.totalBytes / 1024 / 1024).toFixed(2)} MiB</dd>
          <dt>媒体资产</dt><dd>{stats.assetCount}</dd>
          <dt>被消息引用</dt><dd>{stats.referencedCount}</dd>
          <dt>未被引用</dt><dd>{stats.unreferencedCount}</dd>
          <dt>可清理文件</dt><dd>{stats.reclaimableCount}</dd>
        </dl> : <p className="text-sm">{busy ? "正在读取…" : "暂无存储信息"}</p>}
        <p className="text-sm text-muted-foreground">删除消息或会话只解除媒体引用。媒体至少保留 24 小时；清理仅移除不再被任何消息引用的过期文件，不会影响其他会话共用的图片。清理后文件无法恢复，请先备份需要保留的数据。</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void refresh()} variant="outline">刷新统计</Button>
          {confirming ? <><Button disabled={busy} onClick={() => void cleanup()} variant="destructive">确认清理过期文件</Button><Button disabled={busy} onClick={() => setConfirming(false)} variant="ghost">取消</Button></>
            : <Button disabled={busy || !stats?.reclaimableCount} onClick={() => setConfirming(true)} variant="secondary">清理未使用媒体</Button>}
        </div>
      </CardContent>
    </Card>
  </main>;
}
