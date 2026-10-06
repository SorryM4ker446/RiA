import type { NextRequest } from "next/server";
import { z } from "zod";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { readJsonBody } from "@/lib/server/request-body";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { documentSourceSchema } from "@/lib/documents/types";
import { checkDocumentReferences } from "@/lib/documents/references";
const input = z.strictObject({ sources: z.array(documentSourceSchema).min(1).max(8) });
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("documentReferences");
    const { sources } = input.parse(await readJsonBody(req, 24 * 1024));
    return Response.json({ data: await checkDocumentReferences(sources) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法核对引用版本。"); }
});
