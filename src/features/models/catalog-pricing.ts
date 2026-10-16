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

const billables: Record<string, string> = {
  input_text: "文本输入", input_image: "图像输入", output_image: "图像输出",
  input_video: "参考视频输入", output_video: "视频输出", input_reference: "参考素材",
  input_font: "字体输入", generation: "单次生成",
};
const mediaUnits: Record<string, string> = {
  image: "张", second: "秒", megapixel: "MP", megapixel_second: "MP·秒",
  request: "次", character: "字符",
};

export function formatPriceVariant(variant: string | undefined) {
  if (!variant) return "默认规格";
  return variant.replace(/text_to_video/g, "文生视频").replace(/image_to_video/g, "图生视频")
    .replace(/without_audio/g, "无音频").replace(/with_audio/g, "含音频")
    .replace(/with_video_input/g, "含视频输入").replace(/high_resolution/g, "高分辨率")
    .replace(/continuation/g, "视频续接").replace(/precise/g, "精确模式").replace(/creative/g, "创意模式")
    .replace(/(^|_)low(?=_|$)/g, "$1低质量").replace(/(^|_)medium(?=_|$)/g, "$1中质量").replace(/(^|_)high(?=_|$)/g, "$1高质量")
    .replace(/(\d+(?:\.\d+)?)k(?=_|$)/gi, "$1K").split("_").filter(Boolean).join(" · ");
}

export function formatMediaPrice(rate: CatalogPrice) {
  const label = Object.hasOwn(billables, rate.billable) ? billables[rate.billable] : rate.billable;
  const tokenUnit = rate.unit === "token" ? rate.billable.includes("image") ? "M image tokens" : rate.billable.includes("video") ? "M video tokens" : "M tokens" : null;
  const unit = tokenUnit ?? (Object.hasOwn(mediaUnits, rate.unit) ? mediaUnits[rate.unit] : null);
  const value = numericPrice(rate.costUsd);
  const converted = value === null ? null : value * (tokenUnit ? 1_000_000 : 1);
  const amount = !unit ? `计费单位待确认${value === null ? "" : `（原始值 ${rate.costUsd}）`}`
    : converted === null || !Number.isFinite(converted) ? "价格未提供"
    : `${rate.minimum ? "最低 " : ""}$${dollars.format(converted)}/${unit}`;
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
      if (!Number.isFinite(converted)) return `${unit}: 价格未提供`;
      return `$${dollars.format(converted)}/${tokenUnit ? "M " : ""}${unit}`;
    });
}

