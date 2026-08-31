"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { assetKind, formatBytes, type AssetDetail, type SourceChat } from "@/features/media/api-client";

export function AssetDetailPanel({ asset, busy, close, download, remove, regenerate, openChat, inspect }: {
  asset: AssetDetail; busy: boolean; close: () => void; download: () => void; remove: () => void; regenerate: () => void;
  openChat: (chat: SourceChat) => void; inspect: (id: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const recipe = asset.generation;
  const chats = [...new Map([...(asset.sourceChat ? [asset.sourceChat] : []), ...asset.references.map(ref => ref.chat)].map(chat => [chat.id, chat])).values()];
  return <section aria-label="媒体详情" className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
    <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">媒体详情</h2><Button disabled={busy} variant="ghost" onClick={close}>关闭详情</Button></div>
    {failed ? <p role="alert">无法预览此文件。文件可能已丢失，或当前浏览器不支持其编码；可以尝试下载。</p> : asset.mediaType.startsWith("video/")
      ? <video className="max-h-96 w-full rounded-lg bg-black" controls preload="metadata" src={asset.url} onError={() => setFailed(true)} />
      // Private media must retain the authenticated URL and must not enter an image optimizer cache.
      // eslint-disable-next-line @next/next/no-img-element
      : <img className="max-h-96 w-full rounded-lg object-contain" src={asset.url} alt={asset.description || "媒体预览"} onError={() => setFailed(true)} />}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt>类型 / 大小</dt><dd>{assetKind(asset.kind)} · {asset.mediaType} · {formatBytes(asset.byteSize)}</dd>
      <dt>创建时间</dt><dd>{new Date(asset.createdAt).toLocaleString()}</dd>
      <dt>模型</dt><dd className="break-words">{asset.modelId || "未记录"}</dd>
      <dt>资源编号</dt><dd className="break-all">{asset.id}</dd>
      <dt>引用</dt><dd>{asset.messageReferenceCount} 条消息 · {asset.generationReferenceCount} 个生成结果</dd>
    </dl>
    <div className="space-y-2"><h3 className="text-sm font-medium">{recipe ? "原始提示词" : "已保存的描述"}</h3><p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm">{recipe?.prompt || asset.description || "未记录文本"}</p></div>
    {recipe ? <div className="space-y-2 text-sm"><h3 className="font-medium">生成参数</h3>
      <p>数量：1{recipe.type === "video" ? ` · 比例：${recipe.aspectRatio} · 时长：${recipe.duration === undefined ? "模型默认" : `${recipe.duration} 秒`} · 帧率：${recipe.fps ?? "模型默认"}` : " · 其他选项：模型默认"}</p>
      <p className="text-xs text-muted-foreground">这里记录提交的请求参数；服务商支持情况和模型默认值可能变化，不保证输出完全相同。</p>
      <p>参考图：{recipe.inputImages.length} 张</p>
      {recipe.inputImages.map((input, index) => <Button key={`${input.assetId}-${index}`} variant="outline" size="sm" disabled={busy} onClick={() => inspect(input.assetId)}>查看参考图 {index + 1}</Button>)}
    </div> : <p className="text-sm text-muted-foreground">没有完整生成参数；上传附件和早期资源仍可预览、下载及安全删除。</p>}
    <div className="space-y-2 text-sm"><h3 className="font-medium">来源与关联会话</h3>
      {chats.length ? chats.map(chat => <div key={chat.id} className="flex flex-wrap items-center gap-2"><span className="break-words">{chat.title}{chat.id === asset.sourceChat?.id ? "（生成来源）" : ""}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => openChat(chat)}>{chat.archived ? "恢复并打开会话" : "打开会话"}</Button></div>) : <p className="text-muted-foreground">未记录来源，或相关会话已删除。</p>}
      {asset.messageReferenceCount > 10 && <p>这里只显示前 10 条消息的关联会话。</p>}
      {asset.usedByGenerations.length > 0 && <div className="flex flex-wrap gap-2">{asset.usedByGenerations.map((id, index) => <Button key={id} disabled={busy} variant="outline" size="sm" onClick={() => inspect(id)}>查看依赖结果 {index + 1}</Button>)}</div>}
      {asset.generationReferenceCount > 10 && <p>这里只显示前 10 个依赖结果。</p>}
    </div>
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={download}>下载原文件</Button>
      <Button disabled={busy || Boolean(asset.regenerationUnavailable)} variant="outline" onClick={regenerate}>重新生成</Button>
      <Button disabled={busy || asset.messageReferenceCount + asset.generationReferenceCount > 0} variant="destructive" onClick={remove}>删除资源</Button></div>
    {asset.regenerationUnavailable && <p className="text-xs text-muted-foreground">{asset.regenerationUnavailable}</p>}
    {asset.messageReferenceCount + asset.generationReferenceCount > 0 && <p className="text-xs text-muted-foreground">此资源仍被引用。先移除相关消息或依赖结果，才能删除文件。</p>}
  </section>;
}
