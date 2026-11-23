"use client";

import { AlertCircle, Check, Copy, Maximize2 } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ViewedImage } from "@/components/media/image-viewer";
import { assetIdFromUrl } from "@/lib/media/message-codec";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { copyChatImage } from "./clipboard-content";

/** What the viewer needs for a picture shown in a conversation; the media detail it came from, when it is a stored asset. */
export function viewedImage(src: string, alt: string): ViewedImage {
  const id = assetIdFromUrl(src);
  return { src, alt, ...(id ? { detailHref: `/media?asset=${encodeURIComponent(id)}` } : {}) };
}

/**
 * A picture in a conversation. Click it or use the corner toolbar to open the
 * viewer, copy the image, or reuse it. Focus returns to the zoom control when
 * the viewer closes. `url` absent: it is still being made, and its place
 * already holds the room it will take, so arriving never shifts layout.
 */
export function ChatPicture({ url, alt, testId, open, children }: {
  url: string | null;
  alt: string;
  testId: string;
  open: (image: ViewedImage, returnTo: () => HTMLElement | null) => void;
  /** Further compact actions beside zoom and copy inside the corner toolbar. */
  children?: React.ReactNode;
}) {
  useLocale();
  const viewButton = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const copyTimer = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "refused">("idle");
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const show = () => { if (url) open(viewedImage(url, alt), () => viewButton.current); };
  async function copy() {
    const img = imageRef.current;
    if (!img) return;
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
    try {
      await copyChatImage(img);
      setCopyState("copied");
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopyState(current => (current === "copied" ? "idle" : current));
      }, 2000);
    } catch {
      setCopyState("refused");
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopyState(current => (current === "refused" ? "idle" : current));
      }, 2000);
    }
  }
  return (
    <figure className="chat-picture mt-3 flex flex-col items-center" data-chat-copy-ignore={!url || undefined} data-testid={url ? testId : "generating-picture"}>
      {url ? (
        <div className="chat-picture-frame">
          <button type="button" className="block w-full cursor-zoom-in select-text" tabIndex={-1} data-chat-image-preview aria-label={`${t("asset.openViewer")} · ${alt}`} onClick={() => {
            if (!window.getSelection()?.toString()) show();
          }}>
            <Image ref={imageRef} alt={alt} className="chat-picture-image block max-h-[420px] w-full rounded-lg object-contain" src={url} unoptimized width={1024} height={1024} draggable={false} />
          </button>
          <div className="chat-picture-actions" data-chat-copy-ignore>
            <Button asChild size="icon-sm" variant="ghost" className="chat-picture-action">
              <button ref={viewButton} type="button" aria-label={t("asset.openViewer")} title={t("asset.openViewer")} onClick={show}>
                <Maximize2 aria-hidden="true" />
              </button>
            </Button>
            <Button size="icon-sm" variant="ghost" className="chat-picture-action" aria-label={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : t("chat.contextMenu.copyImage")} title={copyState === "refused" ? t("chat.messages.copyAnswerRefused") : copyState === "copied" ? t("chat.code.copied") : t("chat.contextMenu.copyImage")} onClick={() => void copy()}>
              {copyState === "copied" ? <Check aria-hidden="true" className="copy-confirm-icon text-success" /> : copyState === "refused" ? <AlertCircle aria-hidden="true" className="text-destructive" /> : <Copy aria-hidden="true" />}
            </Button>
            {children}
          </div>
        </div>
      ) : (
        <div className="chat-picture-pending" role="status"><Spinner aria-hidden="true" className="size-4" />{t("chat.messages.generatingImage")}</div>
      )}
    </figure>
  );
}
