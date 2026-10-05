import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { protectDataOperation } from "@/lib/server/data-operations";
import { callSources } from "@/lib/models/call-context";
import { usageSummary } from "@/lib/models/usage";
import { t } from "@/lib/locale";
export const GET = protectDataOperation(async (req: NextRequest) => {
  try { await requireLocalWorkspace(req); const query = z.strictObject({ source: z.enum(callSources).optional() }).parse(Object.fromEntries(req.nextUrl.searchParams)); if ([...req.nextUrl.searchParams.keys()].some(key => req.nextUrl.searchParams.getAll(key).length > 1)) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate query" }); return Response.json({ data: await usageSummary(query.source) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, t("api.usage.readFailed")); }
});
