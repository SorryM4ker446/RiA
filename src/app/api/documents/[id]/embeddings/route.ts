import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { documentIdSchema } from "@/lib/documents/types";
import { modelRefSchema } from "@/lib/models/preferences-schema";
import { indexDocumentEmbeddings } from "@/lib/documents/semantic";

import { t } from "@/lib/locale";
const schema = z.strictObject({ confirm: z.literal(true), contentHash: z.string().regex(/^[a-f0-9]{64}$/), modelRef: modelRefSchema });
async function POSTHandler(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("documentEmbeddings");
    const id = documentIdSchema.parse((await context.params).id);
    const input = schema.parse(await readJsonBody(req));
    return Response.json({ data: await indexDocumentEmbeddings(id, input.contentHash, input.modelRef, req.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.embeddings")); }
}
export const POST = protectDataOperation(POSTHandler);
