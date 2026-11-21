"use client";
import { useLocale } from "@/lib/locale/client";

import { useRef, useState } from "react";
import { Copy, Download, FolderOpen, Maximize2, MoreHorizontal, Trash2, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ImageViewer } from "@/components/media/image-viewer";
import { assetKind, formatBytes, type AssetDetail, type SourceChat } from "@/features/media/api-client";
import { formatDateTime, t, tf } from "@/lib/locale";

/**
 * showInFolder: selects the asset's own file in the file manager (in the desktop
 * app; elsewhere it says so). copyPrompt: copies the full prompt.
 */
export function AssetDetailPanel({ asset, busy, close, download, remove, showInFolder, copyPrompt, openChat, inspect }: {
  asset: AssetDetail; busy: boolean; close: () => void; download: () => void; remove: () => void; showInFolder: () => void;
  copyPrompt: (text: string) => void; openChat: (chat: SourceChat) => void; inspect: (id: string) => void;
}) {
  useLocale();
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);
  const openButton = useRef<HTMLDivElement>(null);
  const isImage = asset.mediaType.startsWith("image/");
  const promptText = asset.generation?.prompt || asset.description || "";
  const recipe = asset.generation;
  const previewAlt = recipe ? t("asset.previewAlt") : asset.description || t("asset.previewAlt");
  const chats = [...new Map([...(asset.sourceChat ? [asset.sourceChat] : []), ...asset.references.map(ref => ref.chat)].map(chat => [chat.id, chat])).values()];
  return <section aria-label={t("asset.detailTitle")} className="media-detail space-y-5">
    <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-base font-semibold tracking-title">{t("asset.detailTitle")}</h2>
      {/* One action in view; the rest wait in the menu, the permanent one last. */}
      <Button size="sm" variant="outline" disabled={busy} onClick={download}><Download data-icon="inline-start" aria-hidden="true" />{t("asset.download")}</Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" disabled={busy} aria-label={tf("ui.assistants.moreActionsFor", { v0: t("asset.detailTitle") })}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={showInFolder}><FolderOpen aria-hidden="true" />{t("asset.showInExplorer")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={asset.messageReferenceCount + asset.generationReferenceCount > 0} onSelect={remove}><Trash2 aria-hidden="true" />{t("asset.delete")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="icon-sm" variant="ghost" aria-label={t("asset.closeDetail")} title={t("asset.closeDetail")} disabled={busy} onClick={close}><X aria-hidden="true" /></Button></div>
    {asset.messageReferenceCount + asset.generationReferenceCount > 0 && <p className="-mt-3 text-xs text-muted-foreground">{t("asset.stillReferenced")}</p>}
    {failed ? <p role="alert">{t("asset.previewFailed")}</p> : asset.mediaType.startsWith("video/")
      ? <video className="aspect-video max-h-96 w-full rounded-lg bg-black shadow-hairline" controls preload="metadata" src={asset.url} onError={() => setFailed(true)} />
      : <>
        {/* Private media must retain the authenticated URL and must not enter an image optimizer cache. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="max-h-96 w-full rounded-lg object-contain shadow-hairline" src={asset.url} alt={previewAlt} onError={() => setFailed(true)} onDoubleClick={() => setViewing(true)} />
        {isImage ? <div ref={openButton} className="-mt-3"><Button size="sm" variant="ghost" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" aria-hidden="true" />{t("asset.openViewer")}</Button></div> : null}
      </>}
    {isImage ? <ImageViewer image={viewing ? { src: asset.url, alt: previewAlt } : null} returnFocus={() => openButton.current?.querySelector("button") ?? null} onClose={() => setViewing(false)} /> : null}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">{t("asset.typeAndSize")}</dt><dd>{assetKind(asset.kind)} · {asset.mediaType} · {formatBytes(asset.byteSize)}</dd>
      <dt className="text-muted-foreground">{t("asset.createdAt")}</dt><dd>{formatDateTime(asset.createdAt)}</dd>
      <dt className="text-muted-foreground">{t("asset.model")}</dt><dd className="break-words font-mono text-[13px]">{asset.modelId || t("asset.unrecorded")}</dd>
      <dt className="text-muted-foreground">{t("asset.resourceId")}</dt><dd className="break-all font-mono text-[13px]">{asset.id}</dd>
      <dt className="text-muted-foreground">{t("asset.references")}</dt><dd>{asset.messageReferenceCount} {t("asset.messageUnit")} · {asset.generationReferenceCount} {t("asset.generationUnit")}</dd>
    </dl>
    <div className="space-y-2"><div className="flex items-center gap-2"><h3 className="mr-auto text-sm font-medium tracking-label">{recipe ? t("asset.originalPrompt") : t("asset.savedDescription")}</h3>
      {promptText ? <Button size="sm" variant="ghost" onClick={() => copyPrompt(promptText)}><Copy data-icon="inline-start" aria-hidden="true" />{t("asset.copyPrompt")}</Button> : null}</div>
      {/* All of it, however long: this is the one place the prompt is shown. */}
      <p className="asset-prompt whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm leading-6" data-testid="asset-prompt">{promptText || t("asset.unrecordedText")}</p></div>
    {recipe ? <div className="space-y-2 text-sm"><h3 className="font-medium tracking-label">{t("asset.generationParams")}</h3>
      <p>{t("asset.quantity")}{recipe.type === "video" ? ` · ${t("asset.aspectRatio")}${recipe.aspectRatio} · ${t("asset.duration")}${recipe.duration === undefined ? t("asset.modelDefault") : `${recipe.duration} ${t("asset.seconds")}`} · ${t("asset.fps")}${recipe.fps ?? t("asset.modelDefault")}` : ` · ${t("asset.otherOptions")}`}</p>
      <p className="text-xs text-muted-foreground">{t("asset.recipeNote")}</p>
      <p>{t("asset.referenceImages")}{recipe.inputImages.length} {t("asset.imageUnit")}</p>
      {recipe.inputImages.map((input, index) => <Button key={`${input.assetId}-${index}`} variant="ghost" size="sm" disabled={busy} onClick={() => inspect(input.assetId)}>{t("asset.viewReference")} {index + 1}</Button>)}
    </div> : <p className="text-sm text-muted-foreground">{t("asset.noRecipe")}</p>}
    <div className="space-y-2 text-sm"><h3 className="font-medium tracking-label">{t("asset.sourceChats")}</h3>
      {chats.length ? chats.map(chat => <div key={chat.id} className="flex flex-wrap items-center gap-2"><span className="break-words text-sm">{chat.title}{chat.id === asset.sourceChat?.id ? t("asset.generationSource") : ""}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => openChat(chat)}>{chat.archived ? t("asset.reopenChat") : t("asset.openChat")}</Button></div>) : <p className="text-muted-foreground">{t("asset.noSource")}</p>}
      {asset.messageReferenceCount > 10 && <p>{t("asset.chatMessageLimit")}</p>}
      {asset.usedByGenerations.length > 0 && <div className="flex flex-wrap gap-2">{asset.usedByGenerations.map((id, index) => <Button key={id} disabled={busy} variant="ghost" size="sm" onClick={() => inspect(id)}>{t("asset.viewDependency")} {index + 1}</Button>)}</div>}
      {asset.generationReferenceCount > 10 && <p>{t("asset.dependencyLimit")}</p>}
    </div>
  </section>;
}
