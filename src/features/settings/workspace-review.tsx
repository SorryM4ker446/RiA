"use client";
import { SelectField, SelectOption } from "@/components/ui/select";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SettingsHelp, SettingsSection } from "@/features/settings/settings-section";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EVENT_KINDS, eventLabel, type ReviewFacts } from "@/lib/activity/types";
type Review = { timeZone: string; startAt: string; endAt: string; startDate: string; endDate: string; facts: ReviewFacts };
export function WorkspaceReviewPreview() {
  const [period, setPeriod] = useState<"daily" | "weekly">("daily");
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [query, setQuery] = useState(() => ({ period: "daily" as "daily" | "weekly", timeZone }));
  const [result, setResult] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/activity/review?${new URLSearchParams(query)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "无法读取回顾。");
      if (!controller.signal.aborted) setResult(payload.data);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取回顾。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query]);
  return <SettingsSection role="region" aria-label="工作区事实回顾" title="工作区事实回顾" description="查看已记录的任务与资料变化。只读取本地事件，不调用模型。"><div className="flex flex-col gap-4">
    <form className="settings-review-form" onSubmit={event => { event.preventDefault(); setLoading(true); setError(null); setResult(null); setQuery({ period, timeZone }); }}>
      <FieldGroup className="settings-review-fields"><Field><FieldLabel htmlFor="review-period" className="sr-only">回顾期间</FieldLabel><SelectField id="review-period" aria-label="回顾期间" value={period} onValueChange={value => setPeriod(value as "daily" | "weekly")}><SelectOption value="daily">上一个完整日</SelectOption><SelectOption value="weekly">上一个完整周</SelectOption></SelectField></Field>
      <Field><FieldLabel htmlFor="review-zone" className="sr-only">回顾时区</FieldLabel><Input id="review-zone" aria-label="回顾时区" value={timeZone} onChange={event => setTimeZone(event.target.value)} /></Field></FieldGroup>
      <Button disabled={loading} type="submit" variant="outline">查看事实回顾</Button>
    </form>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : loading ? <p className="text-sm">正在读取事件…</p> : result ? <>
      <p className="text-sm">{result.startDate} 至 {result.endDate}（结束日期不包含）· {result.timeZone}</p>
      <p className="text-xs text-muted-foreground">{result.facts.complete ? "本期间事件记录完整。" : `从记录启用后开始统计：${new Date(result.facts.coverageFrom).toLocaleString()}。期间记录不完整，不补造历史数量。`}</p>
      <ul className="settings-facts">{EVENT_KINDS.map(kind => <li key={kind}>{eventLabel(kind)}：{result.facts.counts[kind]} 次</li>)}</ul>
      <p className="text-xs text-muted-foreground">完成与重新打开分别计数，同一任务可发生多次变化。</p>
      {result.facts.sources.length ? <ol className="flex flex-col gap-2 text-sm">{result.facts.sources.map(source => <li key={source.id}><Link className="underline break-words" href={`/activity/events/${encodeURIComponent(source.id)}`}>{eventLabel(source.kind)} · {source.label}</Link></li>)}</ol> : <p className="text-sm">本期间没有已记录的变化。</p>}
      {result.facts.omitted ? <p className="text-xs">来源仅展示前 100 条，另 {result.facts.omitted} 条已计入统计。</p> : null}
    </> : null}
    <SettingsHelp title="统计范围与记录保留"><p>每日统计上一个完整本地日；每周统计上一个完整周一至周日。</p><p>事件保留 365 天、最多 10,000 条。记录名称是当时快照，来源页显示当前状态；来源已删除或记录已过期时会明确提示。</p></SettingsHelp>
  </div></SettingsSection>;
}
