import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { dataRequestContext } from "@/lib/server/data-operations";
import { getModelPreferences } from "@/lib/models/preferences";
import { modelRefKey, defaultModelPreferences, upgradeModelPreferences, type LibraryMode, type ModelRef } from "@/lib/models/preferences-schema";
import { modelCallSource, type CallSource } from "./call-context";

export function budgetDay(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}:${timeZone}`;
}
export function estimatedCallCost(prompt: unknown, maxOutputTokens: number | undefined, rate: Awaited<ReturnType<typeof getModelPreferences>>["rates"][string] | undefined): number | null {
  if (!rate || rate.inputPerMillion == null || rate.outputPerMillion == null || maxOutputTokens == null) return null;
  // UTF-8 bytes are an application estimate, not a provider tokenizer or bill.
  const input = Buffer.byteLength(JSON.stringify(prompt) ?? "", "utf8");
  return (input * Math.max(rate.inputPerMillion, rate.cacheReadPerMillion ?? 0, rate.cacheWritePerMillion ?? 0) + maxOutputTokens * rate.outputPerMillion) / 1_000_000;
}
export async function beginModelAttempt(input: { mode: LibraryMode; ref: ModelRef; prompt?: unknown; maxOutputTokens?: number; fallback?: boolean; source?: CallSource; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const source = input.source ?? modelCallSource();
  const background = source === "summary" || source === "scheduled";
  const now = new Date(), id = randomUUID();
  return db.$transaction(async tx => {
    // Acquire SQLite's writer before reading counters; concurrent admissions
    // cannot both observe the same available slot, including across processes.
    await tx.$executeRaw`INSERT OR IGNORE INTO model_call_days (day, calls, estimatedUsd) VALUES ('lock', 0, 0)`;
    await tx.$executeRaw`UPDATE model_call_days SET calls = calls WHERE day = 'lock'`;
    const stored = await tx.workspacePreference.findUnique({ where: { id: "local" } });
    const preferences = stored ? upgradeModelPreferences(stored.settings) : defaultModelPreferences();
    const limits = preferences.callLimits;
    const rate = preferences.rates[modelRefKey(input.ref)];
    const estimate = input.mode === "image" || input.mode === "video" ? rate?.perRequest ?? null : estimatedCallCost(input.prompt, input.maxOutputTokens, rate);
    if (await tx.modelRequest.count({ where: { status: "pending" } }) >= limits.maxConcurrent) {
      throw new ApiError({ code: "CONFLICT", message: "模型并发调用已达上限，请等待当前调用结束。" });
    }
    if (background) {
      if ((limits.backgroundMaxEstimatedUsd !== null || limits.backgroundDailyEstimatedUsd !== null) && estimate === null) {
        throw new ApiError({ code: "CONFIGURATION_ERROR", message: "后台费用上限已启用，请先配置模型输入和输出价格。未知费用不能按零领取额度。" });
      }
      if (limits.backgroundMaxEstimatedUsd !== null && estimate! > limits.backgroundMaxEstimatedUsd) {
        throw new ApiError({ code: "CONFLICT", message: "后台调用预估费用超过单次上限。" });
      }
      const day = budgetDay(now, limits.timeZone);
      const counter = await tx.modelCallDay.upsert({ where: { day }, create: { day }, update: {} });
      if (counter.calls >= limits.backgroundDailyCalls || limits.backgroundDailyEstimatedUsd !== null && counter.estimatedUsd + estimate! > limits.backgroundDailyEstimatedUsd) {
        throw new ApiError({ code: "CONFLICT", message: "后台调用已达到本地日期的次数或预估费用上限。" });
      }
      // Submitted attempts consume the daily allowance even on failure/abort.
      // Unknown billing must not allow a cancel-and-retry budget bypass.
      await tx.modelCallDay.update({ where: { day }, data: { calls: { increment: 1 }, estimatedUsd: { increment: estimate ?? 0 } } });
    }
    input.signal?.throwIfAborted();
    await tx.modelRequest.create({ data: { id, requestId: dataRequestContext()?.requestId ?? randomUUID(), source, mode: input.mode, modelId: input.ref.modelId, modelProvider: input.ref.providerId,
      status: "pending", durationMs: 0, costSource: "unknown", estimatedUsd: estimate, fallback: input.fallback ?? false, createdAt: now } });
    await tx.modelCallDay.deleteMany({ where: { day: { lt: new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10) } } });
    return { id, rate };
  });
}

/** Run once at service startup, before accepting requests. Never replay calls. */
export async function recoverModelAttempts() {
  return db.modelRequest.updateMany({ where: { status: "pending" }, data: { status: "interrupted", errorCode: "PROCESS_INTERRUPTED", costUsd: null, costSource: "unknown" } });
}
