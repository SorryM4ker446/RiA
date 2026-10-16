"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { modelRefKey } from "@/lib/models/preferences-schema";
import type { CatalogModel } from "@/lib/models/providers/types";
import { t } from "@/lib/locale";
import { CatalogPriceDetails } from "@/features/models/catalog-price-details";

const BATCH_SIZE = 8;

export function CatalogResults({ models, added, busy, onAdd }: {
  models: CatalogModel[]; added: Set<string>; busy: boolean; onAdd: (model: CatalogModel) => void;
}) {
  const [limit, setLimit] = useState(BATCH_SIZE);
  const previousTop = useRef(0);
  const count = Math.min(limit, models.length);
  if (!models.length) return <Empty><EmptyHeader><EmptyTitle>没有匹配的模型</EmptyTitle><EmptyDescription>尝试其他关键词，或切换模型服务和模式。</EmptyDescription></EmptyHeader></Empty>;
  return <div className="flex min-h-0 flex-col gap-2">
    <div className="catalog-scroll" role="region" aria-label="模型目录结果" tabIndex={0} onScroll={event => {
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
          <p className="break-all font-mono text-xs text-muted-foreground">{`${item.modelId}${item.contextLength ? ` · ${item.contextLength.toLocaleString()} context` : ""}${item.supportsImageInput ? ` · ${t("models.catalog.imageInput")}` : ""}${item.supportsTools ? ` · ${t("models.catalog.toolCall")}` : ""}`}</p>
          <CatalogPriceDetails name={item.name} pricing={item.pricing} info={item.priceInfo} />
        </div>
        <Button size="sm" variant={added.has(modelRefKey(item)) ? "outline" : "default"} disabled={busy || added.has(modelRefKey(item))} onClick={() => onAdd(item)}>{added.has(modelRefKey(item)) ? t("models.alreadyAdded") : t("models.add")}</Button>
      </li>)}</ul>
      <p className="catalog-scroll-hint">{count < models.length ? "继续向下滚动，展示更多模型" : "已展示全部匹配模型"}</p>
    </div>
    <p className="text-xs text-muted-foreground" aria-live="polite">已展示 {count} / {models.length} 个匹配模型</p>
  </div>;
}
