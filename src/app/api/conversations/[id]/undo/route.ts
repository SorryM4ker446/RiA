import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getChat } from "@/lib/chat/store";
import { applyRedo, applyUndo, previewRedo, previewUndo, undoStates } from "@/lib/checkpoints/undo";
import { t } from "@/lib/locale";

const undoSchema = z.strictObject({
  runIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).min(1).max(100),
  // status: where each file's undo stands, from the records alone; preview / undo; redo-preview / redo.
  action: z.enum(["status", "preview", "undo", "redo-preview", "redo"]),
  // Only these files; every file the runs changed when absent.
  files: z.array(z.strictObject({ grantId: z.string().min(1).max(200), path: z.string().min(1).max(4000) })).min(1).max(10_000).optional(),
});

type Params = { params: Promise<{ id: string }> };

/**
 * Undo, or redo, the file changes of an answer's runs: each file back as it
 * was before them, if it is still as they left it, and back again on redo.
 * The previews make the same checks without changing anything; status reads
 * the records only, for showing each file's state.
 */
async function POSTHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("fileUndoStatus");
    const { id } = await context.params;
    if (!await getChat(id)) throw new ApiError({ code: "NOT_FOUND", message: t("server.conversation.notFound") });
    const parsed = undoSchema.safeParse(await readJsonBody(req, 4 * 1024 * 1024));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.undo.invalid"), details: parsed.error.flatten() });
    const runIds = [...new Set(parsed.data.runIds)];
    const selection = parsed.data.files;
    const action = parsed.data.action;
    if (action !== "status") enforceRateLimit("fileUndo");
    const files = action === "status" ? await undoStates(id, runIds)
      : action === "preview" ? await previewUndo(id, runIds, selection)
      : action === "undo" ? await applyUndo(id, runIds, selection)
      : action === "redo-preview" ? await previewRedo(id, runIds, selection)
      : await applyRedo(id, runIds, selection);
    return Response.json({ data: { files } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("/api/conversations/[id]/undo POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to undo the file changes");
  }
}

export const POST = protectDataOperation(POSTHandler);
