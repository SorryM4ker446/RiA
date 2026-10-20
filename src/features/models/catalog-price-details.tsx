"use client";
import { useLocale } from "@/lib/locale/client";

import { formatDateTime, t, tf } from "@/lib/locale";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CatalogPriceInfo } from "@/lib/models/catalog-prices";
import { formatCatalogPrices, formatMediaPrice } from "@/features/models/catalog-pricing";
export function CatalogPriceDetails({ name, pricing, info }: { name: string; pricing: Record<string, string>; info?: CatalogPriceInfo }) {
  useLocale();
  if (!info) return <div aria-label={t("ui.models.catalog-price-details.modelPrice")} className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
    {Object.keys(pricing).length ? formatCatalogPrices(pricing).map((price, index) => <span key={index}>{price}</span>) : <span>{t("ui.models.catalog-price-details.priceNotProvided")}</span>}
  </div>;
  const priority = (billable: string) => billable.startsWith("output_") ? 0 : 1;
  const rates = [...info.rates].sort((a, b) => priority(a.billable) - priority(b.billable)).map(formatMediaPrice);
  return <div aria-label={t("ui.models.catalog-price-details.modelPrice")} className="flex flex-col gap-1 text-xs tabular-nums text-muted-foreground">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {rates.length ? rates.slice(0, 2).map((rate, index) => <span className="break-words" key={index}>{rate.label}{rate.spec !== t("ui.models.catalog-price-details.defaultConfiguration") ? ` · ${rate.spec}` : ""} {rate.amount}</span>) : <span>{info.error ? t("ui.models.catalog-price-details.quoteUnavailableRefreshTheCatalogAnd") : t("ui.models.catalog-price-details.providerHasNotProvidedAQuote")}</span>}
      {rates.length > 0 && <Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" className="h-6 px-2" aria-label={tf("ui.models.catalog-price-details.allQuotesFor", { v0: name })}>{t("media.filter.all")}{rates.length} {t("ui.models.catalog-price-details.quotes")}</Button></PopoverTrigger>
        <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))]" aria-label={tf("ui.models.catalog-price-details.priceDetailsFor", { v0: name })}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1"><h3 className="font-medium">{t("ui.models.catalog-price-details.priceDetails")}</h3><p className="break-words text-xs text-muted-foreground">{name} · USD{info.updatedAt ? ` · ${formatDateTime(info.updatedAt)}` : ""}</p></div>
            <ul className="flex max-h-72 flex-col gap-3 overflow-y-auto overscroll-contain" aria-label={t("ui.models.catalog-price-details.allBillingConfigurations")}>
              {rates.map((rate, index) => <li key={index} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 rounded-md bg-muted/40 p-2.5">
                <div className="min-w-0 flex-1"><p className="break-words text-sm">{rate.label}</p><p className="mt-1 break-words text-xs text-muted-foreground">{rate.spec}{rate.provider ? ` · ${rate.provider}` : ""}</p></div>
                <span className="break-words text-sm tabular-nums">{rate.amount}</span>
              </li>)}
            </ul>
            <p className="text-xs text-muted-foreground">{t("ui.models.catalog-price-details.eachItemIsBilledByActual")}</p>
          </div>
        </PopoverContent>
      </Popover>}
    </div>
    {info.error && rates.length > 0 && <p>{t("ui.models.catalog-price-details.quoteRefreshWasIncompleteShowingRetained")}</p>}
  </div>;
}
