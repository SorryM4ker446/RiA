import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { CHECKPOINT_LIMIT_CHOICES_MB, saveStoreLimit, storeLimit, storeUsage } from "@/lib/checkpoints/store";
import { pruneCheckpoints } from "@/lib/checkpoints/prune";
import { t } from "@/lib/locale";

const input = z.strictObject({ limitMb: z.number().int().refine(value => (CHECKPOINT_LIMIT_CHOICES_MB as readonly number[]).includes(value)) });

const view = async () => ({ limitMb: Math.round(await storeLimit() / (1024 * 1024)), usedBytes: await storeUsage(), choicesMb: CHECKPOINT_LIMIT_CHOICES_MB });

/** How much the undo store may hold, and how much it holds now. */
export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await view() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to read the undo storage limit");
  }
});

/** Changes the limit; a lower one is applied at once, dropping the content least needed first. */
export const PUT = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("directoryGrants");
    const parsed = input.safeParse(await readJsonBody(req, 1024));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.checkpoints.invalidLimit") });
    await saveStoreLimit(parsed.data.limitMb);
    await pruneCheckpoints();
    return Response.json({ data: await view() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to save the undo storage limit");
  }
});
