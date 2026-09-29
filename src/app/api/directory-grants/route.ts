import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createGrant, listGrants } from "@/lib/local-files/grants";
import { LocalFileRefused } from "@/lib/local-files/limits";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

const createGrantSchema = z.strictObject({
  label: z.string().trim().max(200).optional(),
  path: z.string().min(1).max(4000)
});

/**
 * A refusal to open a location is a decision about the user's machine, not a
 * server fault. It is reported as a validation error carrying the reason, so
 * the settings page can say which of "network location", "not available" or
 * "does not exist" actually applied instead of a generic failure.
 */
function grantError(error: unknown): unknown {
  if (error instanceof LocalFileRefused) {
    return new ApiError({ code: "VALIDATION_ERROR", message: error.message, details: { reason: error.reason } });
  }
  return error;
}

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    const data = await listGrants({ includeRevoked: req.nextUrl.searchParams.get("includeRevoked") === "true" });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.directoryGrants.listFailed"));
  }
}

/**
 * Granting is an explicit act by the user, and this endpoint is the only way it
 * happens. There is deliberately no tool the assistant can call to add a grant,
 * so a model persuaded to "check another folder" has nothing to persuade.
 */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("directoryGrants");
    const parsed = createGrantSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "label and path are required" });
    const data = await createGrant(parsed.data);
    return Response.json({ data }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(grantError(error), t("api.directoryGrants.createFailed"));
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
