import type { NextRequest } from "next/server";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { identifierSchema } from "@/lib/server/request-schemas";
import { getEventSource } from "@/lib/activity/events";
import { t } from "@/lib/locale";
export const GET = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req);
    const id = identifierSchema.parse((await context.params).id);
    const data = await getEventSource(id);
    if (!data) throw new ApiError({ code: "NOT_FOUND", message: t("errors.eventDoesNotExistOrItsRetentionPeriod") });
    return Response.json({ data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.eventSource")); }
});
