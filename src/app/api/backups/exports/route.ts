import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { exportBackupCopy, listBackupExports } from "@/lib/backups/exports";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

const exportSchema = z.strictObject({
  id: z.string().min(1).max(200),
  destination: z.string().min(1).max(4096)
});

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await listBackupExports() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.backups.readFailed"));
  }
});

/**
 * Write a copy where the user said.
 *
 * Without the desktop shell there is no save dialog, so the caller has nothing
 * to offer as a destination and the endpoint refuses rather than writing a copy
 * somewhere the application chose on the user's behalf.
 */
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("backups");
    const parsed = exportSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "id and destination are required" });
    const data = await exportBackupCopy(parsed.data.id, parsed.data.destination);
    return Response.json({ data }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.backups.createFailed"));
  }
});
