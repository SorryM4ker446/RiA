import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { getModelPreferences } from "@/lib/models/preferences";
import { dataRequestContext } from "@/lib/server/data-operations";
import type { ModelPreferences } from "@/lib/models/preferences-schema";

type Mode = "chat" | "image" | "video" | "embedding";
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
export function modelErrorCode(error: unknown) {
  if (object(error).statusCode === 404) return "MODEL_UNAVAILABLE";
  if (object(error).name === "AbortError") return "ABORTED";
  const code = normalizeApiError(error).code;
  return code === "INTERNAL_ERROR" ? "UPSTREAM_FAILED" : code;
}
export function canFallback(error: unknown, signal?: AbortSignal) {
  if (error instanceof ApiError && !["UPSTREAM_FAILED", "SERVICE_UNAVAILABLE", "RATE_LIMITED"].includes(error.code)) return false;
  if (signal?.aborted || object(error).name === "AbortError" || object(error).name === "TimeoutError") return false;
  const status = finite(object(error).statusCode);
  return status === null || status === 404 || status === 429 || status >= 500;
}
export function usageCost(mode: Mode, usage: unknown, metadata: unknown, rate?: ModelPreferences["rates"][string]) {
  const values = object(usage);
  const inputTokens = finite(typeof values.inputTokens === "number" ? values.inputTokens : object(values.inputTokens).total ?? values.tokens);
  const outputTokens = finite(typeof values.outputTokens === "number" ? values.outputTokens : object(values.outputTokens).total);
  const provider = object(object(metadata).openrouter);
  const upstream = finite(provider.cost ?? object(provider.usage).cost);
  if (upstream !== null) return { inputTokens, outputTokens, costUsd: upstream, costSource: "provider" };
  let cost: number | null = null;
  if (rate && (mode === "image" || mode === "video") && rate.perRequest !== null) cost = rate.perRequest;
  else if (rate && inputTokens !== null && rate.inputPerMillion !== null && (mode === "embedding" || outputTokens !== null && rate.outputPerMillion !== null)) cost = (inputTokens * rate.inputPerMillion + (outputTokens ?? 0) * (rate.outputPerMillion ?? 0)) / 1_000_000;
  return { inputTokens, outputTokens, costUsd: cost, costSource: cost === null ? "unknown" : "configured" };
}
export async function recordModelAttempt(input: { userId: string; requestId?: string; mode: Mode; modelId: string; started: number; usage?: unknown; metadata?: unknown; error?: unknown; fallback?: boolean; rate?: ModelPreferences["rates"][string] }) {
  const errorCode = input.error === undefined ? null : modelErrorCode(input.error);
  const measured = usageCost(input.mode, input.usage, input.metadata, input.rate);
  // A failed or interrupted request may still have been billed. Never present
  // a configured per-request price as an observed charge for that failure.
  if (errorCode && measured.costSource === "configured") { measured.costUsd = null; measured.costSource = "unknown"; }
  try {
    await db.modelRequest.create({ data: {
      userId: input.userId, requestId: input.requestId ?? dataRequestContext()?.requestId ?? randomUUID(), mode: input.mode, modelId: input.modelId,
      status: errorCode === "ABORTED" ? "aborted" : errorCode ? "error" : "success", errorCode, durationMs: Math.min(2_147_483_647, Math.max(0, Math.round(Date.now() - input.started))),
      ...measured, inputTokens: measured.inputTokens === null ? null : Math.min(2_147_483_647, Math.round(measured.inputTokens)), outputTokens: measured.outputTokens === null ? null : Math.min(2_147_483_647, Math.round(measured.outputTokens)), fallback: input.fallback ?? false,
    } });
    await db.modelRequest.deleteMany({ where: { userId: input.userId, createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
    const boundary = await db.modelRequest.findMany({ where: { userId: input.userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: 5000, take: 1, select: { id: true, createdAt: true } });
    if (boundary[0]) await db.modelRequest.deleteMany({ where: { userId: input.userId, OR: [{ createdAt: { lt: boundary[0].createdAt } }, { createdAt: boundary[0].createdAt, id: { lte: boundary[0].id } }] } });
  } catch { console.error("model.usage.write_failed"); }
}
export async function usageSummary(userId: string) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const where = { userId, createdAt: { gte: since } };
  const [recent, totals, unknown] = await Promise.all([
    db.modelRequest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, requestId: true, mode: true, modelId: true, status: true, durationMs: true, inputTokens: true, outputTokens: true, costUsd: true, costSource: true, errorCode: true, fallback: true, createdAt: true } }),
    db.modelRequest.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }),
    db.modelRequest.count({ where: { ...where, costUsd: null } }),
  ]);
  return { recent, totals: { requests: totals._count, inputTokens: totals._sum.inputTokens, outputTokens: totals._sum.outputTokens, costUsd: totals._sum.costUsd, unknownCostRequests: unknown }, days: 30 };
}
export async function requestPricing(userId?: string) { return userId ? (await getModelPreferences(userId)).rates : {}; }
