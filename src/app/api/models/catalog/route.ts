import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { libraryModes } from "@/lib/models/preferences-schema";
import { getOpenRouterCatalog, getOpenRouterCatalogs } from "@/lib/models/catalog";
import { z } from "zod";
import { t } from "@/lib/locale";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("modelCatalog");
    const mode = req.nextUrl.searchParams.get("mode");
    const catalogs = mode ? { [mode]: await getOpenRouterCatalog(z.enum(libraryModes).parse(mode)) } : await getOpenRouterCatalogs();
    return Response.json({ catalogs }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.catalogReadFailed")); }
});

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("modelCatalog");
    const body = z.strictObject({ mode: z.enum(libraryModes).optional() }).parse(await readJsonBody(req, 1024));
    const catalogs = body.mode ? { [body.mode]: await getOpenRouterCatalog(body.mode, true) } : await getOpenRouterCatalogs(true);
    return Response.json({ catalogs }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.catalogRefreshFailed")); }
});
