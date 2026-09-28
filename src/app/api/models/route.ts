import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { getModelPreferences, saveModelPreferences } from "@/lib/models/preferences";
import { readCachedCatalogs } from "@/lib/models/catalog";
import { describeProviders, resolveLibraryAvailability } from "@/lib/models/availability";
import { db } from "@/db";
import { t } from "@/lib/locale";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    // Availability reads the stored snapshots only. A page load must not turn
    // into a live request to a provider: an unread category reports "not
    // checked", and the catalog endpoint is the one that fetches.
    const [settings, catalogs, recentFailures] = await Promise.all([
      getModelPreferences(),
      readCachedCatalogs(),
      db.modelRequest.findMany({ where: { errorCode: "MODEL_UNAVAILABLE", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 20, select: { modelId: true, modelProvider: true, mode: true, createdAt: true } }),
    ]);
    return Response.json({ data: settings, availability: resolveLibraryAvailability(settings, catalogs), providers: describeProviders(), recentFailures }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.settingsReadFailed")); }
});

export const PUT = protectDataOperation(async (req: NextRequest) => {
  try { await requireLocalWorkspace(req); enforceRateLimit("modelSettings"); return Response.json({ data: await saveModelPreferences(await readJsonBody(req, 128 * 1024)) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return createApiErrorResponse(error, t("api.models.settingsSaveFailed")); }
});
