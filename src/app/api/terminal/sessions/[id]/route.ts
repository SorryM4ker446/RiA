import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readEmptyBody } from "@/lib/server/request-body";
import { getTerminalSession, stopTerminalSession } from "@/lib/terminal/runtime";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
async function handle(req: NextRequest, context: Context, stop: boolean) {
  try {
    await requireLocalWorkspace(req);
    const parsed = z.uuid().safeParse((await context.params).id);
    if (!parsed.success || req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid terminal session" });
    if (stop) await readEmptyBody(req);
    const data = stop ? stopTerminalSession(parsed.data) : getTerminalSession(parsed.data);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取或停止终端命令。"); }
}
export const GET = protectDataOperation((req: NextRequest, context: Context) => handle(req, context, false));
export const POST = protectDataOperation((req: NextRequest, context: Context) => handle(req, context, true));
