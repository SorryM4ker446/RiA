import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { testExtension } from "@/lib/extensions/store";
import { extensionIdSchema } from "@/lib/extensions/schema";

export const POST = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = extensionIdSchema.parse((await context.params).id);
    const { revision } = z.strictObject({ revision: z.number().int().positive() }).parse(await readJsonBody(req, 1024));
    return Response.json({ data: await testExtension(id, revision, req.signal) });
  } catch (error) { return createApiErrorResponse(error, "无法检测扩展连接。"); }
});
