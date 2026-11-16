import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { registryDetailQuerySchema, getRegistryServer } from "@/lib/extensions/registry";

import { t } from "@/lib/locale";
export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensionRegistry");
    const params = req.nextUrl.searchParams;
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new ApiError({ code: "VALIDATION_ERROR", message: t("errors.directoryParametersMustNotBeRepeated") });
    const input = registryDetailQuerySchema.parse(Object.fromEntries(params));
    return Response.json({ data: await getRegistryServer(input, req.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("ui.extensions.extension-discovery.couldNotLoadExtensionDetails") ); }
});
