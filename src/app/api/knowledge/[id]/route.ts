import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { requireLocalWorkspace } from "@/lib/local/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

async function getScopedKnowledgeEntry(id: string) {
  return db.memory.findFirst({
    where: {
      id,
      NOT: [{ key: { startsWith: "tool:" } }],
    },
  });
}

async function DELETEHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    const existing = await getScopedKnowledgeEntry(id);

    if (!existing) {
      throw new ApiError({
        code: "NOT_FOUND",
        message: "Knowledge entry not found",
      });
    }

    await db.memory.delete({
      where: { id },
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/knowledge/[id] DELETE error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to delete knowledge entry");
  }
}

export const DELETE = protectDataOperation(DELETEHandler);
