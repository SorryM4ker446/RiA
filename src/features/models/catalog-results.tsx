"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatNumber } from "@/lib/locale";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { modelRefKey } from "@/lib/models/preferences-schema";
import type { CatalogModel } from "@/lib/models/providers/types";
import { CatalogPriceDetails } from "@/features/models/catalog-price-details";

const BATCH_SIZE = 8;

export function CatalogResults({ models, added, busy, onAdd }: {
  models: CatalogModel[]; added: Set<string>; busy: boolean; onAdd: (model: CatalogModel) => void;
}) {
  useLocale();
  const [limit, setLimit] = useState(BATCH_SIZE);
  const previousTop = useRef(0);
  const count = Math.min(limit, models.length);
  if (!models.length) return <Empty><EmptyHeader><EmptyTitle>{t("ui.models.catalog-results.noMatchingModels")}</EmptyTitle><EmptyDescription>{t("ui.models.catalog-results.tryOtherKeywordsOrChangeProvider")}</EmptyDescription></EmptyHeader></Empty>;
  return <div className="flex min-h-0 flex-col gap-2">
    <div className="catalog-scroll" role="region" aria-label={t("ui.models.catalog-results.modelCatalogResults")} tabIndex={0} onScroll={event => {
      const node = event.currentTarget;
      const movingDown = node.scrollTop > previousTop.current;
      previousTop.current = node.scrollTop;
      if (movingDown && node.scrollTop + node.clientHeight >= node.scrollHeight - 80) {
        setLimit(current => Math.min(current + BATCH_SIZE, models.length));
      }
    }}>
      <ul className="flex flex-col">{models.slice(0, count).map(item => <li key={modelRefKey(item)} className="catalog-row flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="break-words font-medium tracking-label">{item.name}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{`${item.modelId}${item.contextLength ? ` · ${tf("models.catalog.contextLength", { tokens: formatNumber(item.contextLength) })}` : ""}${item.supportsImageInput ? ` · ${t("models.catalog.imageInput")}` : ""}${item.supportsTools ? ` · ${t("models.catalog.toolCall")}` : ""}`}</p>
          <CatalogPriceDetails name={item.name} pricing={item.pricing} info={item.priceInfo} />
        </div>
        <Button size="sm" variant={added.has(modelRefKey(item)) ? "outline" : "default"} disabled={busy || added.has(modelRefKey(item))} onClick={() => onAdd(item)}>{added.has(modelRefKey(item)) ? t("models.alreadyAdded") : t("models.add")}</Button>
      </li>)}</ul>
      {/* The count below already says when everything is shown; the hint only points at more. */}
      {count < models.length && <p className="catalog-scroll-hint">{t("ui.models.catalog-results.scrollDownToShowMoreModels")}</p>}
    </div>
    <p className="text-xs text-muted-foreground" aria-live="polite">{t("ui.extensions.extension-discovery.showing")}{count} / {models.length} {t("ui.models.catalog-results.matchingModels")}</p>
  </div>;
}
