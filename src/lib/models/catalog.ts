import { z } from "zod";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { libraryModes, openRouterModelIdSchema, type LibraryMode } from "@/lib/models/preferences-schema";

const providerId = "openrouter";
const urls: Record<LibraryMode, string> = {
  chat: "https://openrouter.ai/api/v1/models?output_modalities=text",
  image: "https://openrouter.ai/api/v1/images/models",
  video: "https://openrouter.ai/api/v1/videos/models",
  embedding: "https://openrouter.ai/api/v1/embeddings/models",
};
const rawModel = z.object({
  id: z.string().min(1).max(200), name: z.string().max(240).nullable().optional(), description: z.string().max(2000).nullable().optional(),
  context_length: z.number().int().positive().nullable().optional(),
  architecture: z.object({ modality: z.string().optional(), input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() }).passthrough().nullable().optional(),
  supported_parameters: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).nullable().optional(),
  supported_frame_images: z.array(z.string()).nullable().optional(),
  supported_durations: z.array(z.unknown()).nullable().optional(),
  supported_resolutions: z.array(z.unknown()).nullable().optional(),
  supported_aspect_ratios: z.array(z.unknown()).nullable().optional(),
  pricing: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullable().optional(),
  pricing_skus: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullable().optional(),
}).passthrough();

function hasPositiveReferenceLimit(value: unknown) {
  if (value === true) return true;
  if (!value || typeof value !== "object") return false;
  const max = (value as { max?: unknown }).max;
  return typeof max === "number" && max > 0;
}
const envelope = z.object({ data: z.array(z.unknown()).max(20_000) }).passthrough();
const modelId = openRouterModelIdSchema;
const maxBodyBytes = 8 * 1024 * 1024;
const cacheDurationMs = 24 * 60 * 60_000;
const inFlight = new Map<LibraryMode, Promise<CatalogState>>();
const failures = new Map<LibraryMode, { at: number; message: string }>();
// These names reach the models page as the catalog warning, so they follow the
// interface language; the `mode` key itself stays a stored enum value.
const modeNames: Record<LibraryMode, string> = { chat: t("lib.models.catalogMode.chat"), image: t("lib.models.catalogMode.image"), video: t("lib.models.catalogMode.video"), embedding: t("lib.models.catalogMode.embedding") };

export type CatalogModel = {
  providerId: "openrouter"; modelId: string; name: string; description: string; modes: LibraryMode[];
  supportsImageInput: boolean; endpointImageInput: boolean | null; supportsTools: boolean; contextLength: number | null; pricing: Record<string, string>;
};
export type CatalogState = { mode: LibraryMode; models: CatalogModel[]; fetchedAt: string | null; stale: boolean; source: "live" | "cache" | "empty"; error: string | null; skipped: number };

function normalize(value: unknown, mode: LibraryMode): CatalogModel | null {
  const parsed = rawModel.safeParse(value);
  if (!parsed.success || !modelId.safeParse(parsed.data.id).success) return null;
  const row = parsed.data;
  const modality = row.architecture?.modality?.toLowerCase().split("->");
  const inputs = (row.architecture?.input_modalities ?? modality?.[0]?.split("+") ?? []).map(value => value.toLowerCase());
  const outputs = (row.architecture?.output_modalities ?? modality?.at(-1)?.split("+") ?? []).map(value => value.toLowerCase());
  const parameters = row.supported_parameters ?? [];
  const parameterNames = Array.isArray(parameters) ? parameters : Object.keys(parameters);
  const frameImages = row.supported_frame_images ?? [];
  const out: LibraryMode[] = [mode];
  if (mode === "chat" && !outputs.includes("text")) return null;
  return {
    providerId, modelId: row.id,
    name: row.name?.trim() || row.id,
    description: row.description?.slice(0, 2000) ?? "",
    modes: out,
    supportsImageInput: mode === "video"
      ? frameImages.length > 0
      : inputs.includes("image") || parameterNames.some(x => ["image", "input_image", "frame_images", "input_references"].includes(x)),
    endpointImageInput: null,
    supportsTools: mode === "chat" && parameterNames.some(x => ["tools", "tool_choice"].includes(x)),
    contextLength: row.context_length ?? null,
    pricing: Object.fromEntries(Object.entries(row.pricing ?? row.pricing_skus ?? {}).filter(([, v]) => ["string", "number"].includes(typeof v)).slice(0, 12).map(([k, v]) => [k, String(v)])),
  };
}

async function parseResponse(response: Response, mode: LibraryMode): Promise<{ models: CatalogModel[]; invalidRows: number }> {
  if (!response.ok) throw new Error(`${t("lib.models.catalogProvider")} ${modeNames[mode]}${t("lib.models.catalogHttpStatus")} ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBodyBytes) throw new Error(t("lib.models.catalogResponseTooLarge"));
  if (!response.body) throw new Error(t("lib.models.catalogResponseEmpty"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) { await reader.cancel(); throw new Error(t("lib.models.catalogResponseTooLarge")); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(t("lib.models.catalogNotJson")); }
  const envelopeResult = envelope.safeParse(decoded);
  if (!envelopeResult.success) throw new Error(t("lib.models.catalogInvalidShape"));
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  let invalidRows = 0;
  for (const value of envelopeResult.data.data) {
    const item = normalize(value, mode);
    if (!item) { invalidRows++; continue; }
    if (seen.has(item.modelId)) { invalidRows++; continue; }
    seen.add(item.modelId);
    models.push(item);
  }
  // A handful of malformed or duplicated rows is normal for a live third-party
  // feed and says nothing about the rows that parsed cleanly. Throwing here
  // discarded the WHOLE catalog over a few bad entries, so the page reported
  // "目录暂不可用" with zero models even though the rest were perfectly usable.
  // The skipped count travels back as a warning; only a catalog that yields
  // nothing at all is a real failure.
  if (models.length === 0) throw new Error(`${t("lib.models.catalogProvider")} ${modeNames[mode]}${invalidRows > 0 ? `${t("lib.models.catalogInvalidRowsPrefix")}${invalidRows}${t("lib.models.catalogInvalidRowsSuffix")}` : t("lib.models.catalogEmptySuffix")}`);
  return { models, invalidRows };
}

async function cached(mode: LibraryMode): Promise<{ models: CatalogModel[]; fetchedAt: Date } | null> {
  const snapshot = await db.modelCatalogSnapshot.findUnique({ where: { providerId_mode: { providerId, mode } } });
  if (!snapshot || !Array.isArray(snapshot.models)) return null;
  const models = snapshot.models.flatMap(value => { const parsed = z.object({ providerId: z.literal(providerId), modelId, name: z.string(), description: z.string(), modes: z.array(z.enum(libraryModes)), supportsImageInput: z.boolean(), endpointImageInput: z.boolean().nullable().optional(), supportsTools: z.boolean(), contextLength: z.number().int().positive().nullable(), pricing: z.record(z.string(), z.string()) }).safeParse(value); return parsed.success && parsed.data.modes.includes(mode) ? [{ ...parsed.data, endpointImageInput: parsed.data.endpointImageInput ?? null } as CatalogModel] : []; });
  return { models, fetchedAt: snapshot.fetchedAt };
}

async function refresh(mode: LibraryMode): Promise<CatalogState> {
  const old = await cached(mode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(urls[mode], { method: "GET", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { Accept: "application/json", ...(process.env.OPENROUTER_API_KEY?.trim() ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}` } : {}) } });
    const { models, invalidRows } = await parseResponse(response, mode);
    const fetchedAt = new Date();
    await db.modelCatalogSnapshot.upsert({ where: { providerId_mode: { providerId, mode } }, create: { providerId, mode, models: models as never, fetchedAt }, update: { models: models as never, fetchedAt } });
    failures.delete(mode);
    return { mode, models, fetchedAt: fetchedAt.toISOString(), stale: false, source: "live", error: null, skipped: invalidRows };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? t("lib.models.catalogTimeout") : error instanceof Error ? error.message : t("lib.models.catalogReadFailed");
    failures.set(mode, { at: Date.now(), message });
    return { mode, models: old?.models ?? [], fetchedAt: old?.fetchedAt.toISOString() ?? null, stale: Boolean(old), source: old ? "cache" : "empty", error: message, skipped: 0 };
  } finally { clearTimeout(timer); }
}

export async function getOpenRouterCatalog(mode: LibraryMode, force = false): Promise<CatalogState> {
  const old = await cached(mode);
  if (!force && old && Date.now() - old.fetchedAt.getTime() < cacheDurationMs) return { mode, models: old.models, fetchedAt: old.fetchedAt.toISOString(), stale: false, source: "cache", error: null, skipped: 0 };
  const failure = failures.get(mode);
  if (!force && failure && Date.now() - failure.at < 30_000) return { mode, models: old?.models ?? [], fetchedAt: old?.fetchedAt.toISOString() ?? null, stale: Boolean(old), source: old ? "cache" : "empty", error: failure.message, skipped: 0 };
  const existing = inFlight.get(mode);
  if (existing) return existing;
  const operation = refresh(mode).finally(() => inFlight.delete(mode));
  inFlight.set(mode, operation);
  return operation;
}

export async function getOpenRouterCatalogs(force = false) {
  const states = await Promise.all(libraryModes.map(mode => getOpenRouterCatalog(mode, force)));
  return Object.fromEntries(states.map(state => [state.mode, state])) as Record<LibraryMode, CatalogState>;
}

/** Queries the fixed official image endpoints route; never follows URLs supplied by catalog data. */
export async function getImageEndpointReferenceSupport(id: string): Promise<boolean | null> {
  const match = modelId.safeParse(id);
  if (!match.success) return null;
  const [author, slug] = id.split("/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/images/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`, {
      method: "GET", cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { Accept: "application/json", ...(process.env.OPENROUTER_API_KEY?.trim() ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}` } : {}) },
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); return null; } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = z.object({ endpoints: z.array(z.object({ supported_parameters: z.record(z.string(), z.unknown()).optional() }).passthrough()).max(500) }).safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success || !parsed.data.endpoints.length) return false;
    return parsed.data.endpoints.some(endpoint => hasPositiveReferenceLimit(endpoint.supported_parameters?.input_references));
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export function assertCatalogMode(value: unknown): LibraryMode {
  if (typeof value === "string" && libraryModes.includes(value as LibraryMode)) return value as LibraryMode;
  throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.models.catalogUnknownMode") });
}
