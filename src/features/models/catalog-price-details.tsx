"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CatalogPriceInfo } from "@/lib/models/catalog-prices";
import { formatCatalogPrices, formatMediaPrice } from "@/features/models/catalog-pricing";
import { formatDateTime } from "@/lib/locale";

export function CatalogPriceDetails({ name, pricing, info }: { name: string; pricing: Record<string, string>; info?: CatalogPriceInfo }) {
  if (!info) return <div aria-label="模型价格" className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
    {Object.keys(pricing).length ? formatCatalogPrices(pricing).map((price, index) => <span key={index}>{price}</span>) : <span>价格暂未提供</span>}
  </div>;
  const priority = (billable: string) => billable.startsWith("output_") ? 0 : 1;
  const rates = [...info.rates].sort((a, b) => priority(a.billable) - priority(b.billable)).map(formatMediaPrice);
  return <div aria-label="模型价格" className="flex flex-col gap-1 text-xs tabular-nums text-muted-foreground">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {rates.length ? rates.slice(0, 2).map((rate, index) => <span className="break-words" key={index}>{rate.label}{rate.spec !== "默认规格" ? ` · ${rate.spec}` : ""} {rate.amount}</span>) : <span>{info.error ? "报价暂不可用，请刷新目录重试" : "服务商暂未提供报价"}</span>}
      {rates.length > 0 && <Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" className="h-6 px-2" aria-label={`${name}的全部报价`}>全部 {rates.length} 项报价</Button></PopoverTrigger>
        <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))]" aria-label={`${name}的价格明细`}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1"><h3 className="font-medium">价格明细</h3><p className="break-words text-xs text-muted-foreground">{name} · USD{info.updatedAt ? ` · ${formatDateTime(info.updatedAt)}` : ""}</p></div>
            <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto overscroll-contain" aria-label="全部计费规格">
              {rates.map((rate, index) => <li key={index} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 rounded-md bg-muted/40 p-2.5">
                <div className="min-w-0 flex-1"><p className="break-words text-sm">{rate.label}</p><p className="mt-1 break-words text-xs text-muted-foreground">{rate.spec}{rate.provider ? ` · ${rate.provider}` : ""}</p></div>
                <span className="break-words text-sm tabular-nums">{rate.amount}</span>
              </li>)}
            </ul>
            <p className="text-xs text-muted-foreground">各项按实际用量计费；默认规格未细分的参数以服务商账单为准。MP 为百万像素。</p>
          </div>
        </PopoverContent>
      </Popover>}
    </div>
    {info.error && rates.length > 0 && <p>报价刷新不完整，当前展示保留报价；请刷新目录重试。</p>}
  </div>;
}
