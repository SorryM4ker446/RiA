"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ExternalLink, Maximize, Minus, Plus, Scan, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

/*
 * One picture, as large as the window allows: RiA's viewer for images in a
 * conversation and in the media library. It opens fitted to the window, keeping
 * the picture's proportions; it can be zoomed in and out, shown at its own size
 * and fitted again, and dragged around once it is larger than the window.
 * Closing (Esc, the close button) hands focus back to where the viewer was
 * opened from, without moving the page.
 */

const STEP = 1.25;
const MAX_SCALE = 8;

export type ViewedImage = {
  src: string;
  alt: string;
  /** Where its media detail is, for a picture opened from somewhere else. */
  detailHref?: string;
};

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type View = { mode: "fit" } | { mode: "scale"; scale: number; offset: Point };
const CENTER: Point = { x: 0, y: 0 };

function panRoom(natural: Size, stage: Size, scale: number): Point {
  return {
    x: Math.max(0, (natural.width * scale - stage.width) / 2),
    y: Math.max(0, (natural.height * scale - stage.height) / 2),
  };
}

function clampOffset(offset: Point, room: Point): Point {
  return {
    x: Math.max(-room.x, Math.min(room.x, offset.x)),
    y: Math.max(-room.y, Math.min(room.y, offset.y)),
  };
}

export function ImageViewer({ image, onClose, returnFocus }: {
  image: ViewedImage | null;
  onClose: () => void;
  /** The control the viewer was opened with, or stands for (a double-clicked picture's open button). */
  returnFocus?: () => HTMLElement | null;
}) {
  useLocale();
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>({ mode: "fit" });
  const drag = useRef<{ pointer: number; x: number; y: number; from: Point } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Where focus goes back to: kept from while it was open, since whoever opened it may forget it on closing.
  const returnTo = useRef(returnFocus);
  useEffect(() => { if (image && returnFocus) returnTo.current = returnFocus; }, [image, returnFocus]);
  const [shown, setShown] = useState<string | null>(null);

  // Each picture opens fitted, in the middle.
  const src = image?.src ?? null;
  if (src !== shown) {
    setShown(src);
    setNatural(null);
    setFailed(false);
    setView({ mode: "fit" });
    setDragging(false);
  }

  // Watched from the moment the stage exists: the dialog puts it on the page a moment after it opens, so an
  // effect run when the picture changes would find nothing yet and never see the window resized.
  useLayoutEffect(() => {
    if (!stage) return;
    const read = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(stage);
    return () => {
      observer.disconnect();
      drag.current = null;
    };
  }, [stage]);

  const fitScale = natural && stageSize && stageSize.width > 0 && stageSize.height > 0
    ? Math.min(1, stageSize.width / natural.width, stageSize.height / natural.height)
    : 1;
  const minScale = Math.min(fitScale, 0.1);
  const scale = view.mode === "fit" ? fitScale : view.scale;
  const shownSize = natural ? { width: natural.width * scale, height: natural.height * scale } : null;
  // How far the picture can be moved before an edge would come away from the window's.
  const room = natural && stageSize ? panRoom(natural, stageSize, scale) : CENTER;
  const shownOffset = view.mode === "fit" ? CENTER : clampOffset(view.offset, room);
  const movable = room.x > 0 || room.y > 0;

  function zoom(change: (scale: number) => number, anchor = CENTER) {
    if (!natural || !stageSize) return;
    setView(current => {
      const previous = current.mode === "fit" ? fitScale : current.scale;
      const next = Math.max(minScale, Math.min(MAX_SCALE, change(previous)));
      if (next === previous && current.mode === "scale") return current;
      const offset = current.mode === "fit" ? CENTER : clampOffset(current.offset, panRoom(natural, stageSize, previous));
      const ratio = next / previous;
      return {
        mode: "scale",
        scale: next,
        offset: clampOffset({
          x: anchor.x + (offset.x - anchor.x) * ratio,
          y: anchor.y + (offset.y - anchor.y) * ratio,
        }, panRoom(natural, stageSize, next)),
      };
    });
  }
  const fit = () => setView({ mode: "fit" });
  const pan = (move: (offset: Point) => Point) => setView(current => current.mode === "scale"
    ? { ...current, offset: clampOffset(move(clampOffset(current.offset, room)), room) }
    : current);

  const zoomWithWheel = useEffectEvent((event: WheelEvent, node: HTMLDivElement) => {
    event.preventDefault();
    if (!event.deltaY || drag.current) return;
    const bounds = node.getBoundingClientRect();
    const pixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? bounds.height : 1);
    zoom(previous => previous * 2 ** (-pixels / 400), {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    });
  });
  useEffect(() => {
    if (!stage) return;
    // Cancel native scrolling and browser zoom while the pointer is over the picture stage.
    const onWheel = (event: WheelEvent) => zoomWithWheel(event, stage);
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stage]);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (!natural || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof HTMLElement && event.target.closest("button, a") && (event.key === " " || event.key === "Enter")) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(previous => previous * STEP); }
    else if (event.key === "-") { event.preventDefault(); zoom(previous => previous / STEP); }
    else if (event.key === "0") { event.preventDefault(); fit(); }
    else if (event.key === "1") { event.preventDefault(); zoom(() => 1); }
    else if (movable && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const step = 40;
      pan(current => ({ x: current.x + (event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0), y: current.y + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0) }));
    }
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!movable || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: shownOffset };
    setDragging(true);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const { clientX, clientY } = event;
    pan(() => ({ x: current.from.x + clientX - current.x, y: current.from.y + clientY - current.y }));
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDragging(false); } };

  const percent = Math.round(scale * 100);
  return (
    <DialogPrimitive.Root open={image !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="image-viewer-overlay desktop-titlebar-interactive" />
        <DialogPrimitive.Content
          className="image-viewer desktop-titlebar-interactive"
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onCloseAutoFocus={event => {
            const target = returnTo.current?.();
            if (target?.isConnected) { event.preventDefault(); target.focus({ preventScroll: true }); }
          }}
        >
          <DialogPrimitive.Title className="sr-only">{image?.alt || t("viewer.title")}</DialogPrimitive.Title>
          <div className="image-viewer-toolbar" role="toolbar" aria-label={t("viewer.title")}>
            <Button size="icon-sm" variant="ghost" aria-label={t("viewer.zoomOut")} title={t("viewer.zoomOut")} disabled={!natural || scale <= minScale} onClick={() => zoom(previous => previous / STEP)}><Minus aria-hidden="true" /></Button>
            <output className="image-viewer-scale" aria-live="polite">{natural ? `${percent}%` : ""}</output>
            <Button size="icon-sm" variant="ghost" aria-label={t("viewer.zoomIn")} title={t("viewer.zoomIn")} disabled={!natural || scale >= MAX_SCALE} onClick={() => zoom(previous => previous * STEP)}><Plus aria-hidden="true" /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={t("viewer.actualSize")} title={t("viewer.actualSize")} aria-pressed={view.mode === "scale" && view.scale === 1} disabled={!natural} onClick={() => zoom(() => 1)}><Scan aria-hidden="true" /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={t("viewer.fit")} title={t("viewer.fit")} aria-pressed={view.mode === "fit"} disabled={!natural} onClick={fit}><Maximize aria-hidden="true" /></Button>
            {image?.detailHref ? <Button asChild size="sm" variant="ghost"><Link href={image.detailHref} onClick={onClose}><ExternalLink data-icon="inline-start" aria-hidden="true" />{t("viewer.openDetail")}</Link></Button> : null}
            <DialogPrimitive.Close asChild><Button size="icon-sm" variant="ghost" aria-label={t("window.close")} title={t("window.close")}><X aria-hidden="true" /></Button></DialogPrimitive.Close>
          </div>
          <div
            ref={setStage}
            className="image-viewer-stage"
            data-movable={movable || undefined}
            data-dragging={dragging || undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={() => { if (natural) { if (view.mode === "fit") zoom(() => Math.max(1, fitScale * 2)); else fit(); } }}
          >
            {!natural ? <div className="grid h-full place-items-center text-sm text-white">
              {failed ? <p role="alert">{t("viewer.loadFailed")}</p> : <p className="flex items-center gap-2" role="status"><Spinner aria-hidden="true" />{t("viewer.loading")}</p>}
            </div> : null}
            {image ? (
              // Private media keeps its authenticated URL and never enters an image optimizer cache.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="image-viewer-picture"
                src={image.src}
                alt={image.alt}
                draggable={false}
                data-scale={percent}
                onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => setFailed(true)}
                style={shownSize ? { width: shownSize.width, height: shownSize.height, transform: `translate(-50%, -50%) translate(${shownOffset.x}px, ${shownOffset.y}px)` } : { visibility: "hidden" }}
              />
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
