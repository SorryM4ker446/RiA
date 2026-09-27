"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { assetKind, formatBytes, type AssetDetail, type SourceChat } from "@/features/media/api-client";
import { formatDateTime, t } from "@/lib/locale";

export function AssetDetailPanel({ asset, busy, close, download, remove, regenerate, openChat, inspect }: {
  asset: AssetDetail; busy: boolean; close: () => void; download: () => void; remove: () => void; regenerate: () => void;
  openChat: (chat: SourceChat) => void; inspect: (id: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const recipe = asset.generation;
  const chats = [...new Map([...(asset.sourceChat ? [asset.sourceChat] : []), ...asset.references.map(ref => ref.chat)].map(chat => [chat.id, chat])).values()];
  return <section aria-label={t("asset.detailTitle")} className="space-y-4 rounded-lg bg-card p-5 shadow-card sm:p-6">
    <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold tracking-title">{t("asset.detailTitle")}</h2><Button disabled={busy} variant="ghost" onClick={close}>{t("asset.closeDetail")}</Button></div>
    {failed ? <p role="alert">{t("asset.previewFailed")}</p> : asset.mediaType.startsWith("video/")
      ? <video className="max-h-96 w-full rounded-lg bg-black shadow-hairline" controls preload="metadata" src={asset.url} onError={() => setFailed(true)} />
      // Private media must retain the authenticated URL and must not enter an image optimizer cache.
      // eslint-disable-next-line @next/next/no-img-element
      : <img className="max-h-96 w-full rounded-lg object-contain shadow-hairline" src={asset.url} alt={asset.description || t("asset.previewAlt")} onError={() => setFailed(true)} />}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">{t("asset.typeAndSize")}</dt><dd>{assetKind(asset.kind)} · {asset.mediaType} · {formatBytes(asset.byteSize)}</dd>
      <dt className="text-muted-foreground">{t("asset.createdAt")}</dt><dd>{formatDateTime(asset.createdAt)}</dd>
      <dt className="text-muted-foreground">{t("asset.model")}</dt><dd className="break-words font-mono text-[13px]">{asset.modelId || t("asset.unrecorded")}</dd>
      <dt className="text-muted-foreground">{t("asset.resourceId")}</dt><dd className="break-all font-mono text-[13px]">{asset.id}</dd>
      <dt className="text-muted-foreground">{t("asset.references")}</dt><dd>{asset.messageReferenceCount} {t("asset.messageUnit")} · {asset.generationReferenceCount} {t("asset.generationUnit")}</dd>
    </dl>
    <div className="space-y-2"><h3 className="text-sm font-medium tracking-label">{recipe ? t("asset.originalPrompt") : t("asset.savedDescription")}</h3><p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm leading-6">{recipe?.prompt || asset.description || t("asset.unrecordedText")}</p></div>
    {recipe ? <div className="space-y-2 text-sm"><h3 className="font-medium tracking-label">{t("asset.generationParams")}</h3>
      <p>{t("asset.quantity")}{recipe.type === "video" ? ` · ${t("asset.aspectRatio")}${recipe.aspectRatio} · ${t("asset.duration")}${recipe.duration === undefined ? t("asset.modelDefault") : `${recipe.duration} ${t("asset.seconds")}`} · ${t("asset.fps")}${recipe.fps ?? t("asset.modelDefault")}` : ` · ${t("asset.otherOptions")}`}</p>
      <p className="text-xs text-muted-foreground">{t("asset.recipeNote")}</p>
      <p>{t("asset.referenceImages")}{recipe.inputImages.length} {t("asset.imageUnit")}</p>
      {recipe.inputImages.map((input, index) => <Button key={`${input.assetId}-${index}`} variant="outline" size="sm" disabled={busy} onClick={() => inspect(input.assetId)}>{t("asset.viewReference")} {index + 1}</Button>)}
    </div> : <p className="text-sm text-muted-foreground">{t("asset.noRecipe")}</p>}
    <div className="space-y-2 text-sm"><h3 className="font-medium tracking-label">{t("asset.sourceChats")}</h3>
      {chats.length ? chats.map(chat => <div key={chat.id} className="flex flex-wrap items-center gap-2"><span className="break-words text-sm">{chat.title}{chat.id === asset.sourceChat?.id ? t("asset.generationSource") : ""}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => openChat(chat)}>{chat.archived ? t("asset.reopenChat") : t("asset.openChat")}</Button></div>) : <p className="text-muted-foreground">{t("asset.noSource")}</p>}
      {asset.messageReferenceCount > 10 && <p>{t("asset.chatMessageLimit")}</p>}
      {asset.usedByGenerations.length > 0 && <div className="flex flex-wrap gap-2">{asset.usedByGenerations.map((id, index) => <Button key={id} disabled={busy} variant="outline" size="sm" onClick={() => inspect(id)}>{t("asset.viewDependency")} {index + 1}</Button>)}</div>}
      {asset.generationReferenceCount > 10 && <p>{t("asset.dependencyLimit")}</p>}
    </div>
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={download}>{t("asset.download")}</Button>
      <Button disabled={busy || Boolean(asset.regenerationUnavailable)} variant="outline" onClick={regenerate}>{t("asset.regenerate")}</Button>
      <Button disabled={busy || asset.messageReferenceCount + asset.generationReferenceCount > 0} variant="destructive" onClick={remove}>{t("asset.delete")}</Button></div>
    {asset.regenerationUnavailable && <p className="text-xs text-warning">{asset.regenerationUnavailable}</p>}
    {asset.messageReferenceCount + asset.generationReferenceCount > 0 && <p className="text-xs text-muted-foreground">{t("asset.stillReferenced")}</p>}
  </section>;
}
