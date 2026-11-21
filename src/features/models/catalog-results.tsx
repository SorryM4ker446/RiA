"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatNumber } from "@/lib/locale";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { modelRefKey } from "@/lib/models/preferences-schema";
import type { CatalogModel } from "@/lib/models/providers/types";
import { CatalogPriceDetails } from "@/features/models/catalog-price-details";

const BATCH_SIZE = 8;

/**
 * pending: models being added now; only their own button waits. loading: the
 * catalog has not been read yet.
 *
 * One frame shows the results whatever state they are in. While the catalog is
 * read it holds its full height, so the list that arrives fills room already
 * there instead of pushing the page down. After that it fits what it shows (up
 * to the same height, then it scrolls), easing to each new size as the catalog
 * arrives or a search narrows it, so a short list leaves no empty space and the
 * page below glides rather than jumps. A new search starts at the top.
 */
export function CatalogResults({ models, added, busy, pending, loading = false, onAdd }: {
  models: CatalogModel[]; added: Set<string>; busy: boolean; pending: ReadonlySet<string>; loading?: boolean; onAdd: (model: CatalogModel) => void;
}) {
  useLocale();
  const [limit, setLimit] = useState(BATCH_SIZE);
  // Another list (a search, the catalog read again): its first rows, from the top.
  const [listed, setListed] = useState(models);
  if (models !== listed) { setListed(models); setLimit(BATCH_SIZE); }
  const frame = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // What the frame holds is a new element with each state (loading, empty, list); each one is measured as it comes.
  const observer = useRef<ResizeObserver | null>(null);
  const content = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const read = () => setContentHeight(node.offsetHeight);
    read();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(read);
    observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => { if (frame.current) { frame.current.scrollTop = 0; previousTop.current = 0; } }, [models]);
  const count = Math.min(limit, models.length);
  const showing = !loading && models.length > 0;
  // The frame's border adds two pixels to what it holds.
  const height = loading ? "var(--catalog-frame-max)" : contentHeight === null ? undefined : `min(${contentHeight + 2}px, var(--catalog-frame-max))`;

  return <div className="flex min-h-0 flex-col gap-2">
    <div ref={frame} className="catalog-scroll" data-state={loading ? "loading" : showing ? "list" : "empty"} style={{ height }}
      {...(showing ? { role: "region", "aria-label": t("ui.models.catalog-results.modelCatalogResults"), tabIndex: 0 } : {})}
      onScroll={event => {
        if (!showing) return;
        const node = event.currentTarget;
        const movingDown = node.scrollTop > previousTop.current;
        previousTop.current = node.scrollTop;
        if (movingDown && node.scrollTop + node.clientHeight >= node.scrollHeight - 80) setLimit(current => Math.min(current + BATCH_SIZE, models.length));
      }}>
      <div ref={content} className="catalog-scroll-content" key={loading ? "loading" : showing ? "list" : "empty"}>
        {loading ? <p className="catalog-scroll-state flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner aria-hidden="true" className="size-4" />{t("ui.models.catalog-results.loading")}</p>
          : !showing ? <div className="catalog-scroll-state"><Empty><EmptyHeader><EmptyTitle>{t("ui.models.catalog-results.noMatchingModels")}</EmptyTitle><EmptyDescription>{t("ui.models.catalog-results.tryOtherKeywordsOrChangeProvider")}</EmptyDescription></EmptyHeader></Empty></div>
          : <>
            <ul className="flex flex-col">{models.slice(0, count).map(item => <li key={modelRefKey(item)} className="catalog-row flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="break-words font-medium tracking-label">{item.name}</p>
                <p className="break-all font-mono text-xs text-muted-foreground">{`${item.modelId}${item.contextLength ? ` · ${tf("models.catalog.contextLength", { tokens: formatNumber(item.contextLength) })}` : ""}${item.supportsImageInput ? ` · ${t("models.catalog.imageInput")}` : ""}${item.supportsTools ? ` · ${t("models.catalog.toolCall")}` : ""}`}</p>
                <CatalogPriceDetails name={item.name} pricing={item.pricing} info={item.priceInfo} />
              </div>
              <Button size="sm" variant={added.has(modelRefKey(item)) ? "outline" : "default"} disabled={busy || added.has(modelRefKey(item)) || pending.has(modelRefKey(item))} aria-busy={pending.has(modelRefKey(item)) || undefined} onClick={() => onAdd(item)}>{added.has(modelRefKey(item)) ? t("models.alreadyAdded") : t("models.add")}</Button>
            </li>)}</ul>
            {/* The count below already says when everything is shown; the hint only points at more. */}
            {count < models.length && <p className="catalog-scroll-hint">{t("ui.models.catalog-results.scrollDownToShowMoreModels")}</p>}
          </>}
      </div>
    </div>
    {/* Kept in its line while loading, so the count arriving moves nothing. */}
    <p className={loading ? "invisible text-xs" : "text-xs text-muted-foreground"} aria-live={loading ? undefined : "polite"} aria-hidden={loading || undefined}>{loading ? "0" : `${t("ui.extensions.extension-discovery.showing")}${count} / ${models.length} ${t("ui.models.catalog-results.matchingModels")}`}</p>
  </div>;
}
