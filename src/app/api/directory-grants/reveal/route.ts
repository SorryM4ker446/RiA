import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { requireActiveGrant } from "@/lib/local-files/grants";
import { LocalFileRefused } from "@/lib/local-files/limits";
import { resolveWithinGrant } from "@/lib/local-files/safe-path";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

const revealSchema = z.strictObject({
  grantId: z.string().min(1).max(200),
  path: z.string().min(1).max(2000)
});

/**
 * Turn a name inside a grant into the absolute path the desktop shell can
 * reveal.
 *
 * This resolves through exactly the same check every read does, which is what
 * keeps it from becoming a way to ask the service about paths outside a grant:
 * there is no branch here that skips containment, and a refused name is refused
 * identically. The absolute path is returned only because the caller needs it
 * to point a file manager at something the user already granted.
 */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("directoryGrants");
    const parsed = revealSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "grantId and path are required" });
    const grant = await requireActiveGrant(parsed.data.grantId);
    const target = await resolveWithinGrant(grant, parsed.data.path, "read");
    return Response.json(
      { data: { absolutePath: target.absolutePath, label: grant.label, path: target.relativePath } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const mapped =
      error instanceof LocalFileRefused
        ? new ApiError({ code: "VALIDATION_ERROR", message: error.message, details: { reason: error.reason } })
        : error;
    return createApiErrorResponse(mapped, t("api.directoryGrants.revealFailed"));
  }
}

export const POST = protectDataOperation(POSTHandler);
