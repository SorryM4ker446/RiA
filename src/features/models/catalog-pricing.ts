import { t, tf } from "@/lib/locale";
import { numericPrice, type CatalogPrice } from "@/lib/models/catalog-prices";

const tokenUnits: Record<string, string> = {
  prompt: "input tokens",
  completion: "output tokens",
  input_cache_read: "cache read tokens",
  input_cache_write: "cache write tokens",
  input_cache_write_1h: "cache write tokens (1h)",
  internal_reasoning: "reasoning tokens",
  image_token: "image tokens",
  audio: "audio input tokens",
  audio_output: "audio output tokens",
  input_audio_cache: "cached audio tokens",
};

const otherUnits: Record<string, string> = {
  request: "request",
  image: "input image",
  image_output: "output image",
  web_search: "search",
  duration_seconds: "second",
};

const dollars = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8, useGrouping: false });

const billables = (): Record<string, string> => ({
  input_text: t("ui.models.catalog-pricing.textInput"), input_image: t("ui.models.catalog-pricing.imageInput"), output_image: t("ui.models.catalog-pricing.imageOutput"),
  input_video: t("ui.models.catalog-pricing.referenceVideoInput"), output_video: t("ui.models.catalog-pricing.videoOutput"), input_reference: t("ui.models.catalog-pricing.referenceMedia"),
  input_font: t("ui.models.catalog-pricing.fontInput"), generation: t("ui.models.catalog-pricing.perGeneration"),
});
const mediaUnits = (): Record<string, string> => ({
  image: t("asset.imageUnit"), second: t("asset.seconds"), megapixel: "MP", megapixel_second: t("ui.models.catalog-pricing.mPSeconds"),
  request: t("models.usage.times"), character: t("documents.characterUnit"),
});

export function formatPriceVariant(variant: string | undefined) {
  if (!variant) return t("ui.models.catalog-price-details.defaultConfiguration");
  return variant.replace(/text_to_video/g, t("ui.models.catalog-pricing.textToVideo")).replace(/image_to_video/g, t("ui.models.catalog-pricing.imageToVideo"))
    .replace(/without_audio/g, t("ui.models.catalog-pricing.withoutAudio")).replace(/with_audio/g, t("ui.models.catalog-pricing.withAudio"))
    .replace(/with_video_input/g, t("ui.models.catalog-pricing.withVideoInput")).replace(/high_resolution/g, t("ui.models.catalog-pricing.highResolution"))
    .replace(/continuation/g, t("ui.models.catalog-pricing.videoContinuation")).replace(/precise/g, t("ui.models.catalog-pricing.preciseMode")).replace(/creative/g, t("ui.models.catalog-pricing.creativeMode"))
    .replace(/(^|_)low(?=_|$)/g, t("ui.models.catalog-pricing.1LowQuality")).replace(/(^|_)medium(?=_|$)/g, t("ui.models.catalog-pricing.1MediumQuality")).replace(/(^|_)high(?=_|$)/g, t("ui.models.catalog-pricing.1HighQuality"))
    .replace(/(\d+(?:\.\d+)?)k(?=_|$)/gi, "$1K").split("_").filter(Boolean).join(" · ");
}

export function formatMediaPrice(rate: CatalogPrice) {
  const label = Object.hasOwn(billables(), rate.billable) ? billables()[rate.billable] : rate.billable;
  const tokenUnit = rate.unit === "token" ? rate.billable.includes("image") ? "M image tokens" : rate.billable.includes("video") ? "M video tokens" : "M tokens" : null;
  const unit = tokenUnit ?? (Object.hasOwn(mediaUnits(), rate.unit) ? mediaUnits()[rate.unit] : null);
  const value = numericPrice(rate.costUsd);
  const converted = value === null ? null : value * (tokenUnit ? 1_000_000 : 1);
  const amount = !unit ? tf("ui.models.catalog-pricing.billingUnitUnconfirmed", { v0: value === null ? "" : tf("ui.pricing.rawValue", { v0: rate.costUsd }) })
    : converted === null || !Number.isFinite(converted) ? t("ui.models.catalog-pricing.priceNotProvided")
    : `${rate.minimum ? t("ui.models.catalog-pricing.from") : ""}$${dollars.format(converted)}/${unit}`;
  return { label, amount, spec: formatPriceVariant(rate.variant), provider: rate.provider };
}

/** Catalog token rates are USD/token; display conversion never changes stored rates. */
export function formatCatalogPrices(pricing: Record<string, string>): string[] {
  const priority = (key: string) => key === "prompt" ? 0 : key === "completion" ? 1 : 2;
  return Object.entries(pricing)
    .sort(([left], [right]) => priority(left) - priority(right))
    .map(([key, raw]) => {
      const tokenUnit = Object.hasOwn(tokenUnits, key) ? tokenUnits[key] : undefined;
      const unit = tokenUnit ?? (Object.hasOwn(otherUnits, key) ? otherUnits[key] : undefined);
      // Retain unrecognized provider fields without guessing their billing unit.
      if (!unit) return `${key}: ${raw}`;
      const value = numericPrice(raw);
      const converted = value === null ? NaN : value * (tokenUnit ? 1_000_000 : 1);
      if (!Number.isFinite(converted)) return tf("ui.models.catalog-pricing.priceNotProvided2", { v0: unit });
      return `$${dollars.format(converted)}/${tokenUnit ? "M " : ""}${unit}`;
    });
}

