import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { isSameOrInside } from "@/lib/local-files/safe-path";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { terminalGrant } from "@/lib/terminal/runtime";

import { t } from "@/lib/locale";
const inputSchema = z.strictObject({ grantId: z.string().min(1).max(200), path: z.string().min(1).max(4000) });

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    const input = inputSchema.parse(await readJsonBody(req, 16 * 1024));
    const relative = input.path.replaceAll("\\", "/");
    if (relative.includes("\0") || relative.includes(":") || relative.startsWith("/") || relative.split("/").some(segment => !segment || segment === "." || segment === "..")) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: t("errors.chooseAFileWithinTheWorkingDirectory") });
    }
    const grant = await terminalGrant(input.grantId);
    let target: string;
    try { target = await realpath(path.join(grant.realPath, relative)); }
    catch { throw new ApiError({ code: "NOT_FOUND", message: t("errors.fileMovedOrWasDeletedAndCannotBe") }); }
    if (!isSameOrInside(target, grant.realPath)) throw new ApiError({ code: "FORBIDDEN", message: t("errors.fileMovedOutsideTheAuthorizedDirectoryAndCannot") });
    if (!(await stat(target)).isFile()) throw new ApiError({ code: "VALIDATION_ERROR", message: t("errors.thisLocationIsNoLongerAFile") });
    return Response.json({ data: { absolutePath: target } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.openFile")); }
}

export const POST = protectDataOperation(POSTHandler);
