import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { addKnowledgeFolder, listKnowledgeFolders, resumeKnowledgeFolders } from "@/lib/documents/folders/sync";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

const addSchema = z.strictObject({ path: z.string().trim().min(1).max(4000), collection: z.string().trim().max(40).nullable().optional() });

/** The synced folders and how each stands; files that lost their document since (a restore) are picked up again. */
async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.request.unexpectedQuery") });
    await resumeKnowledgeFolders();
    return Response.json({ data: await listKnowledgeFolders() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.knowledgeFolders.listFailed")); }
}

/** Adds a folder the user picked in the desktop folder dialog; it is only read, never granted to the assistant. */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("knowledgeFolders");
    const parsed = addSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.knowledgeFolders.invalidRequest") });
    return Response.json({ data: await addKnowledgeFolder(parsed.data) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.knowledgeFolders.addFailed")); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
