import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { cancelRun, listRuns } from "@/lib/agent/runs";
import { getChat } from "@/lib/chat/store";
import { t } from "@/lib/locale";

const stopSchema = z.strictObject({ action: z.literal("stop"), reason: z.string().trim().max(200).optional() });

type Params = { params: Promise<{ id: string }> };

async function GETHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    if (!await getChat(id)) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20));
    return Response.json({ data: await listRuns(id, limit) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("/api/conversations/[id]/runs GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to read execution records");
  }
}

/**
 * Stopping cancels the run and marks its unfinished steps. What already ran is
 * left alone: a task that was created stays created, and the record says so
 * rather than pretending the turn can be unwound.
 */
async function POSTHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("conversationExport");
    const { id } = await context.params;
    const parsed = stopSchema.safeParse(await readJsonBody(req, 4 * 1024));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid run action", details: parsed.error.flatten() });
    const runs = await listRuns(id, 50);
    const target = runs.find((run) => run.status === "running" || run.status === "waiting_approval");
    if (!target) throw new ApiError({ code: "NOT_FOUND", message: t("api.runs.nothingRunning") });
    const updated = await cancelRun(target.id, parsed.data.reason ?? t("api.runs.stoppedByUser"));
    return Response.json({ data: { ...updated, steps: [] } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("/api/conversations/[id]/runs POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to stop the run");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
