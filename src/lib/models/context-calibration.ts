import { db } from "@/db";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";
import { MIN_CALIBRATION } from "./context-budget";

/** Recent turns per model; old samples age out so one outlier cannot shrink capacity forever. */
export const CALIBRATION_SAMPLES = 20;

function parseSamples(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0) : [];
  } catch { return []; }
}

/**
 * Scale applied to the local estimate before any provider usage is seen in a
 * request: the largest recent provider/estimate ratio, so the heaviest recent
 * content sets it, and never below MIN_CALIBRATION. It falls below one once
 * providers report less input than the deliberately high local estimate.
 * Without samples, or with unreadable data, the uncalibrated estimate is used.
 */
export async function contextCalibration(ref: ModelRef): Promise<number> {
  try {
    const row = await db.modelContextCalibration.findUnique({ where: { modelKey: modelRefKey(ref) } });
    const samples = row ? parseSamples(row.samples) : [];
    return samples.length ? Math.max(MIN_CALIBRATION, ...samples) : 1;
  } catch { return 1; }
}

/**
 * Record a turn's largest provider/estimate ratio, including ratios below one so
 * the scale can recover. Concurrent turns may drop one another's sample; that
 * only delays calibration and cannot corrupt authoritative state.
 */
export async function recordContextCalibration(ref: ModelRef, ratio: number | null) {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return;
  const modelKey = modelRefKey(ref);
  const row = await db.modelContextCalibration.findUnique({ where: { modelKey } });
  const samples = JSON.stringify([...(row ? parseSamples(row.samples) : []), Math.round(ratio * 1000) / 1000].slice(-CALIBRATION_SAMPLES));
  await db.modelContextCalibration.upsert({ where: { modelKey }, create: { modelKey, samples }, update: { samples } });
}
