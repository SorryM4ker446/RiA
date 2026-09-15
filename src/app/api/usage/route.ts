import { NextRequest } from "next/server";
import { z } from "zod";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { protectDataOperation } from "@/lib/server/data-operations";
import { usageSummary } from "@/lib/models/usage";
export const GET = protectDataOperation(async (req: NextRequest) => {
  try { await requireLocalWorkspace(req); z.strictObject({}).parse(Object.fromEntries(req.nextUrl.searchParams)); return Response.json({ data: await usageSummary() }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "读取用量失败。"); }
});
