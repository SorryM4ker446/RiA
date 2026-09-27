import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { getModelPreferences, saveModelPreferences } from "@/lib/models/preferences";
import { db } from "@/db";
import { t } from "@/lib/locale";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    const [settings, recentFailures] = await Promise.all([
      getModelPreferences(),
      db.modelRequest.findMany({ where: { errorCode: "MODEL_UNAVAILABLE", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 20, select: { modelId: true, mode: true, createdAt: true } }),
    ]);
    return Response.json({ data: settings, recentFailures }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.settingsReadFailed")); }
});

export const PUT = protectDataOperation(async (req: NextRequest) => {
  try { await requireLocalWorkspace(req); enforceRateLimit("modelSettings"); return Response.json({ data: await saveModelPreferences(await readJsonBody(req, 128 * 1024)) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return createApiErrorResponse(error, t("api.models.settingsSaveFailed")); }
});
