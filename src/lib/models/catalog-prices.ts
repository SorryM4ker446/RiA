import { z } from "zod";

/** Display quotes, separate from user-configured rates used to estimate calls. */
export const catalogPriceSchema = z.object({
  billable: z.string().min(1).max(160),
  unit: z.string().min(1).max(80),
  costUsd: z.string().max(80),
  variant: z.string().max(160).optional(),
  provider: z.string().max(160).optional(),
  minimum: z.boolean().optional(),
});
export type CatalogPrice = z.infer<typeof catalogPriceSchema>;

export const catalogPriceInfoSchema = z.object({
  rates: z.array(catalogPriceSchema).max(2000),
  updatedAt: z.iso.datetime().nullable(),
  error: z.boolean(),
});
export type CatalogPriceInfo = z.infer<typeof catalogPriceInfoSchema>;

export function numericPrice(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(raw).trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The video catalog uses USD SKUs alongside explicitly named cent-based SKUs. */
export function openRouterVideoPrices(skus: Record<string, unknown>): CatalogPrice[] {
  return Object.entries(skus).map(([key, raw]) => {
    let billable = key, unit = "unknown", variant = "", minimum = false;
    const duration = /^(?:(text_to_video|image_to_video|reference)_)?duration_seconds((?:_(?:with_audio|without_audio|\d+(?:\.\d+)?[pk]))*)$/.exec(key);
    const seconds = /^cents_per_(video_output_second|second_output|second_video_continuation)((?:_\d+(?:\.\d+)?[pk])?)$/.exec(key);
    const tokens = /^video_tokens((?:_(?:without_audio|with_audio|with_video_input|\d+(?:\.\d+)?[pk]))*)$/.exec(key);
    const megapixels = /^cents_per_megapixel_second_(precise|creative)$/.exec(key);
    if (duration) {
      billable = duration[1] === "reference" ? "input_video" : "output_video";
      unit = "second";
      variant = [duration[1] === "reference" ? "" : duration[1], duration[2]].filter(Boolean).join("_");
    } else if (seconds) {
      billable = "output_video"; unit = "second";
      variant = `${seconds[1] === "second_video_continuation" ? "continuation" : ""}${seconds[2]}`;
    } else if (tokens) {
      billable = "output_video"; unit = "token"; variant = tokens[1];
    } else if (megapixels) {
      billable = "output_video"; unit = "megapixel_second"; variant = megapixels[1];
    } else if (["cents_per_image_input", "reference_input_images", "reference_images"].includes(key)) {
      billable = "input_image"; unit = "image";
    } else if (key === "minimum_cents_per_generation") {
      billable = "generation"; unit = "request"; minimum = true;
    }
    const value = numericPrice(raw);
    // Unknown SKUs retain their value and unit warning instead of guessing.
    const divisor = (unit !== "unknown" && key.startsWith("cents_")) || minimum ? 100 : 1;
    const costUsd = value === null ? "" : String(value / divisor);
    return { billable, unit, costUsd, ...(variant ? { variant: variant.replace(/^_/, "") } : {}), ...(minimum ? { minimum } : {}) };
  });
}

const imagePrice = z.object({
  billable: z.string().min(1).max(160), unit: z.string().min(1).max(80),
  cost_usd: z.union([z.string().max(80), z.number()]),
  variant: z.string().max(160).optional(),
});

export function openRouterImagePrices(value: unknown): { rates: CatalogPrice[]; error: boolean } {
  const parsed = z.object({ endpoints: z.array(z.object({
    provider_name: z.string().max(160).optional(), pricing: z.array(z.unknown()).max(100).optional(),
  }).passthrough()).max(100) }).safeParse(value);
  if (!parsed.success) return { rates: [], error: true };
  let error = false;
  const unique = new Map<string, CatalogPrice>();
  for (const endpoint of parsed.data.endpoints) {
    for (const raw of endpoint.pricing ?? []) {
      const price = imagePrice.safeParse(raw);
      if (!price.success || numericPrice(price.data.cost_usd) === null) { error = true; continue; }
      const rate: CatalogPrice = {
        billable: price.data.billable, unit: price.data.unit, costUsd: String(price.data.cost_usd),
        ...(price.data.variant ? { variant: price.data.variant } : {}),
        ...(endpoint.provider_name ? { provider: endpoint.provider_name } : {}),
      };
      unique.set(JSON.stringify(rate), rate);
    }
  }
  if (unique.size > 2000) error = true;
  return { rates: [...unique.values()].slice(0, 2000), error };
}
