import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { readJsonBody } from "@/lib/server/request-body";
import { embedTextWithModel } from "@/lib/ai/embedding";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { requireLocalWorkspace } from "@/lib/local/workspace";

type Params = {
  params: Promise<{ id: string }>;
};

// An inferred memory is editable and deletable like any other: it is on screen
// waiting to be accepted, and a candidate that cannot be removed is just noise
// the user has to live with.
async function getScopedKnowledgeEntry(id: string) {
  return db.memory.findFirst({ where: { id } });
}

const updateSchema = z.strictObject({
  value: z.string().trim().min(1).max(4000).optional(),
  confirmed: z.boolean().optional(),
});

/**
 * Editing an entry is how a wrong memory is corrected, so it re-embeds the new
 * text: a vector taken from the old wording would keep matching what the user
 * just replaced.
 */
async function PATCHHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    const existing = await getScopedKnowledgeEntry(id);
    if (!existing) {
      throw new ApiError({ code: "NOT_FOUND", message: "Knowledge entry not found" });
    }
    const parsed = updateSchema.safeParse(await readJsonBody(req, 16 * 1024));
    if (!parsed.success || (parsed.data.value === undefined && parsed.data.confirmed === undefined)) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid knowledge update", details: parsed.success ? undefined : parsed.error.flatten() });
    }

    const nextValue = parsed.data.value ?? existing.value;
    const { embedding, modelRef } = parsed.data.value === undefined
      ? { embedding: undefined, modelRef: undefined }
      : await embedTextWithModel(`${existing.key} ${nextValue}`);

    const updated = await db.memory.update({
      where: { id },
      data: {
        ...(parsed.data.value === undefined ? {} : {
          value: nextValue,
          embedding: embedding ?? Prisma.DbNull,
          embeddingModelId: embedding ? modelRef?.modelId : null,
          embeddingModelProvider: embedding ? modelRef?.providerId : null,
        }),
        // Writing the text by hand is an implicit acceptance.
        ...(parsed.data.confirmed === undefined ? (parsed.data.value === undefined ? {} : { confirmed: true }) : { confirmed: parsed.data.confirmed }),
      },
    });
    return Response.json({ data: updated }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("/api/knowledge/[id] PATCH error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to update knowledge entry");
  }
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

export const PATCH = protectDataOperation(PATCHHandler);
