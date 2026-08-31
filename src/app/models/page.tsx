"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settingsRequest, jsonRequest } from "@/features/settings/api-client";
import { catalogs, modelModes, type ModelPreferences, type GenerationMode } from "@/lib/models/preferences-schema";

type UsageRow = { id: string; modelId: string; mode: string; status: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costSource: string; fallback: boolean; errorCode: string | null; createdAt: string };
type Usage = { recent: UsageRow[]; totals: { requests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; unknownCostRequests: number } };
const names = { chat: "聊天", image: "图片", video: "视频" };
const cost = (value: number | null) => value === null ? "未知" : `$${value.toFixed(6)}`;
export default function ModelsPage() {
  const [settings, setSettings] = useState<ModelPreferences | null>(null), [usage, setUsage] = useState<Usage | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [preferences, history] = await Promise.all([
      settingsRequest<{ data: ModelPreferences; unavailable: { modelId: string; reason: string }[]; recentFailures: { modelId: string }[] }>("/api/models"), settingsRequest<{ data: Usage }>("/api/usage"),
    ]);
    setSettings(preferences.data); setUsage(history.data);
    setWarnings([...preferences.unavailable.map(item => `${item.modelId}：${item.reason}`), ...new Set(preferences.recentFailures.map(item => `${item.modelId}：最近请求收到模型不存在的响应，请核实可用性。`))]);
  }, []);
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "读取失败")); }, [load]);
  async function run(operation: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "模型设置操作失败。"); } finally { setBusy(false); } }
  function changeMode(mode: GenerationMode, field: "modelId" | "fallbackId", value: string) { if (settings) setSettings({ ...settings, [mode]: { ...settings[mode], [field]: value || null } }); }
  function changeRate(id: string, key: "inputPerMillion" | "outputPerMillion" | "perRequest", value: string) { if (settings) setSettings({ ...settings, rates: { ...settings.rates, [id]: { ...(settings.rates[id] ?? { inputPerMillion: null, outputPerMillion: null, perRequest: null }), [key]: value === "" ? null : Number(value) } } }); }
  const rateModels = settings ? [...new Set(modelModes.flatMap(mode => [settings[mode].modelId, settings[mode].fallbackId].filter((id): id is string => Boolean(id))))] : [];
  return <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
    <header className="flex flex-wrap justify-between gap-3"><h1 className="text-2xl font-semibold">模型与用量</h1><Link href="/chat" className="text-primary underline">返回聊天</Link></header>
    <p className="text-sm text-muted-foreground">保存账户默认模式及模型。新会话使用默认值，已有会话保留各自选择。模型目录是本地维护列表，并非实时可用性保证。</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}{warnings.length > 0 && <div role="alert" className="space-y-1 rounded-lg border p-3 text-sm">{warnings.map(warning => <p key={warning} className="break-words">{warning}</p>)}</div>}
    {settings && <section className="space-y-4 rounded-xl border p-4" aria-label="模型偏好"><label className="text-sm">新会话默认模式<select aria-label="新会话默认模式" className="ml-3 rounded border bg-background p-2" value={settings.defaultMode} disabled={busy} onChange={event => setSettings({ ...settings, defaultMode: event.target.value as GenerationMode })}>{modelModes.map(mode => <option key={mode} value={mode}>{names[mode]}</option>)}</select></label>
      <div className="grid gap-4 lg:grid-cols-3">{modelModes.map(mode => <fieldset key={mode} className="min-w-0 space-y-2 rounded-lg border p-3"><legend className="px-1 font-medium">{names[mode]}</legend>{(["modelId", "fallbackId"] as const).map(field => <label className="block text-sm" key={field}>{field === "modelId" ? "默认模型" : "失败时备用模型"}<select aria-label={`${names[mode]}${field === "modelId" ? "默认模型" : "备用模型"}`} className="mt-1 block w-full rounded border bg-background p-2" disabled={busy} value={settings[mode][field] ?? ""} onChange={event => changeMode(mode, field, event.target.value)}>{field === "fallbackId" && <option value="">关闭自动降级</option>}{settings[mode][field] && !catalogs[mode].some(item => item.id === settings[mode][field]) && <option value={settings[mode][field]!}>已失效：{settings[mode][field]}</option>}{catalogs[mode].map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>)}</fieldset>)}</div>
      <p className="text-sm text-muted-foreground">启用备用模型表示同意在失败时再调用一次，可能额外收费。聊天仅在输出开始前且没有工具参与时降级；取消、权限/参数错误及参考图不兼容时不降级。媒体资源库“按原参数重新生成”始终只用原模型。</p>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">配置估算费率（USD）</summary><p className="my-3 text-sm text-muted-foreground">没有实时价格同步。优先展示上游返回费用；否则使用你填写的费率。留空表示未知，0 表示明确的零费率。图片/视频优先使用每次调用费率。</p>{rateModels.map(id => <fieldset key={id} className="mb-3 grid gap-2 sm:grid-cols-3"><legend className="break-all text-sm">{id}</legend>{([["inputPerMillion", "输入 / 百万 Token"], ["outputPerMillion", "输出 / 百万 Token"], ["perRequest", "每次图片或视频调用"]] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<Input aria-label={`${id} ${label}`} type="number" step="any" min={0} value={settings.rates[id]?.[key] ?? ""} disabled={busy} onChange={event => changeRate(id, key, event.target.value)} /></label>)}</fieldset>)}</details>
      <div className="flex gap-3"><Button disabled={busy} onClick={() => void run(async () => { await settingsRequest("/api/models", jsonRequest("PUT", settings)); setNotice("模型偏好已保存，新会话将使用默认模型。"); })}>保存模型偏好</Button><Button variant="outline" disabled={busy} onClick={() => void run(load)}>重新加载设置和用量</Button></div>
    </section>}
    <section className="space-y-3" aria-label="模型用量"><h2 className="text-lg font-semibold">最近 30 天模型调用</h2><p className="text-sm">调用 {usage?.totals.requests ?? 0} 次 · 输入 {usage?.totals.inputTokens ?? "未知"} Token · 输出 {usage?.totals.outputTokens ?? "未知"} Token · 已知费用 {cost(usage?.totals.costUsd ?? null)} · 费用未知 {usage?.totals.unknownCostRequests ?? 0} 次</p><p className="text-xs text-muted-foreground">按每次模型尝试记录，包含聊天辅助调用和嵌入；备用调用单独计数。仅显示最近 100 条，最多保留 90 天 / 5,000 条。耗时是模型调用时间；未知费用不按零计算，失败或中断仍可能被计费。本页不是完整账单。</p>
      <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">时间 / 模型</th><th className="p-3">结果</th><th className="p-3">耗时</th><th className="p-3">输入 / 输出 Token</th><th className="p-3">费用</th></tr></thead><tbody>{usage?.recent.map(row => <tr key={row.id} className="border-b last:border-0"><td className="max-w-sm break-words p-3">{row.modelId}<br /><span className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()} · {row.mode}</span></td><td className="p-3">{row.status === "success" ? "成功" : row.status === "aborted" ? "已取消" : "失败"}{row.fallback ? "（备用）" : ""}<br /><span className="text-xs">{row.errorCode}</span></td><td className="whitespace-nowrap p-3">{row.durationMs} ms</td><td className="p-3">{row.inputTokens ?? "未知"} / {row.outputTokens ?? "未知"}</td><td className="whitespace-nowrap p-3">{cost(row.costUsd)}<br /><span className="text-xs text-muted-foreground">{row.costSource === "provider" ? "上游返回" : row.costSource === "configured" ? "配置估算" : "未报告 / 未配置"}</span></td></tr>)}</tbody></table>{!usage?.recent.length && <p className="p-4 text-sm text-muted-foreground">暂无模型调用记录。</p>}</div>
    </section>
  </main>;
}
