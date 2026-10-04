"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { eventLabel } from "@/lib/activity/types";
type Source = { event: { label: string; kind: string; occurredAt: string }; entity: Record<string, unknown> | null; documentHref: string | null };
export default function EventSourcePage() {
  const { id } = useParams<{ id: string }>();
  return <EventSourceContent key={id} id={id} />;
}
function EventSourceContent({ id }: { id: string }) {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/activity/events/${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "无法读取来源。");
      if (!controller.signal.aborted) setSource(payload.data);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取来源。"); });
    return () => controller.abort();
  }, [id]);
  return <main className="mx-auto max-w-3xl space-y-4 p-6">
    <Link className="underline" href="/settings">返回设置与回顾</Link>
    <h1 className="text-xl font-semibold">回顾事件来源</h1>
    {error ? <p role="alert">{error}</p> : source ? <>
      <p>{eventLabel(source.event.kind)} · {new Date(source.event.occurredAt).toLocaleString()}</p>
      <h2 className="text-lg font-medium break-words">{source.event.label}</h2>
      <p className="text-sm text-muted-foreground">名称来自事件发生时的记录；下方内容是来源的当前状态，不代表事件发生时的完整正文。</p>
      {source.entity ? <dl className="space-y-2">{Object.entries(source.entity).map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{({ title: "任务名称", details: "任务说明", status: "当前状态", filename: "文件名", collection: "集合", key: "记忆名称", value: "当前记忆内容", confirmed: "当前是否确认" })[key] ?? key}</dt><dd className="whitespace-pre-wrap break-words">{value === null ? "—" : String(value)}</dd></div>)}</dl> : <p>原任务、资料或记忆已删除，历史事件仍然保留。</p>}
      {source.documentHref ? <Link className="underline" href={source.documentHref}>打开当前文档</Link> : null}
    </> : <p>正在读取事件来源…</p>}
  </main>;
}
