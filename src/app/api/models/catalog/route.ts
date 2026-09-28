import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { getCatalog, getCatalogs, type CatalogState } from "@/lib/models/catalog";
import { getModelProvider } from "@/lib/models/providers";
import { describeProviders } from "@/lib/models/availability";
import { libraryModes, providerIdSchema, type ProviderId } from "@/lib/models/preferences-schema";
import { z } from "zod";
import { t } from "@/lib/locale";

const query = z.strictObject({ mode: z.enum(libraryModes).optional(), providerId: providerIdSchema.optional() });
const refreshBody = z.strictObject({ mode: z.enum(libraryModes).optional(), providerId: providerIdSchema.optional() });

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("modelCatalog");
    const params = query.parse(Object.fromEntries(req.nextUrl.searchParams));
    const catalogs = params.providerId
      ? { [params.providerId]: await providerCatalogs(params.providerId, params.mode) }
      : await getCatalogs();
    return Response.json({ catalogs, providers: describeProviders() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.catalogReadFailed")); }
});

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("modelCatalog");
    const body = refreshBody.parse(await readJsonBody(req, 1024));
    const catalogs = body.providerId
      ? { [body.providerId]: await providerCatalogs(body.providerId, body.mode, true) }
      : await getCatalogs(true);
    return Response.json({ catalogs, providers: describeProviders() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.catalogRefreshFailed")); }
});

async function providerCatalogs(providerId: ProviderId, mode?: (typeof libraryModes)[number], force = false) {
  getModelProvider(providerId);
  const modes = mode ? [mode] : libraryModes;
  const states = await Promise.all(modes.map(value => getCatalog(providerId, value, force)));
  return Object.fromEntries(states.map(state => [state.mode, state])) as Record<string, CatalogState>;
}
