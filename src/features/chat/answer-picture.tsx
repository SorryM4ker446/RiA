"use client";

import { Maximize2 } from "lucide-react";
import Image from "next/image";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ViewedImage } from "@/components/media/image-viewer";
import { assetIdFromUrl } from "@/lib/media/message-codec";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

/** What the viewer needs for a picture shown in a conversation; the media detail it came from, when it is a stored asset. */
export function viewedImage(src: string, alt: string): ViewedImage {
  const id = assetIdFromUrl(src);
  return { src, alt, ...(id ? { detailHref: `/media?asset=${encodeURIComponent(id)}` } : {}) };
}

/**
 * A picture in a conversation, with a way to look at it closely: double-click
 * it, or use its own button (which is where focus comes back to). `url` absent:
 * it is still being made, and its place already holds the room it will take,
 * so the picture arriving does not move what is around it.
 */
export function ChatPicture({ url, alt, testId, open, children }: {
  url: string | null;
  alt: string;
  testId: string;
  open: (image: ViewedImage, returnTo: () => HTMLElement | null) => void;
  /** Further actions beside the open button. */
  children?: React.ReactNode;
}) {
  useLocale();
  const actions = useRef<HTMLDivElement>(null);
  // Focus comes back to the open button, the first of the picture's actions.
  const show = () => { if (url) open(viewedImage(url, alt), () => actions.current?.querySelector("button") ?? null); };
  return (
    <figure className="chat-picture mt-3 space-y-2" data-testid={url ? testId : "generating-picture"}>
      {url ? (
        <>
          <Image alt={alt} className="chat-picture-image max-h-[420px] w-full rounded-lg object-contain" src={url} unoptimized width={1024} height={1024} onDoubleClick={show} />
          <div ref={actions} className="flex flex-wrap items-center gap-2">
            <Button size="sm" type="button" variant="secondary" onClick={show}><Maximize2 data-icon="inline-start" aria-hidden="true" />{t("asset.openViewer")}</Button>
            {children}
          </div>
        </>
      ) : (
        <>
          <div className="chat-picture-pending" role="status"><Spinner aria-hidden="true" className="size-4" />{t("chat.messages.generatingImage")}</div>
          {/* The actions' row, kept free so they take their place without pushing what follows. */}
          <div aria-hidden="true" className="chat-picture-actions-space" />
        </>
      )}
    </figure>
  );
}
