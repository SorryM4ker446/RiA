import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { deleteDocument, getDocument, reindexDocument } from "@/lib/documents/store";
import { documentIdSchema } from "@/lib/documents/types";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readEmptyBody } from "@/lib/server/request-body";

type Context = { params: Promise<{ id: string }> };
async function GETHandler(req: NextRequest, context: Context) {
  try {
    const user = await requireRequestUser(req);
    const id = documentIdSchema.parse((await context.params).id);
    return Response.json({ data: await getDocument(user.id, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "读取文档失败。"); }
}
async function POSTHandler(req: NextRequest, context: Context) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("documents", user.id);
    const id = documentIdSchema.parse((await context.params).id);
    await readEmptyBody(req);
    return Response.json({ data: await reindexDocument(user.id, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "重新索引失败，原有索引保持不变。"); }
}
async function DELETEHandler(req: NextRequest, context: Context) {
  try {
    const user = await requireRequestUser(req);
    const id = documentIdSchema.parse((await context.params).id);
    await readEmptyBody(req);
    await deleteDocument(user.id, id);
    return Response.json({ data: { id } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "删除文档失败。"); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
export const DELETE = protectDataOperation(DELETEHandler);
