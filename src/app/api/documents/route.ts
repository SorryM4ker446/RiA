import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireRequestUser } from "@/lib/auth/request-user";
import { parseDocument, validateDocumentFile } from "@/lib/documents/parser";
import { documentSummarySelect, indexDocument } from "@/lib/documents/store";
import { DOCUMENT_LIMITS } from "@/lib/documents/types";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readLimitedBody } from "@/lib/server/request-body";

async function GETHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    const data = await db.knowledgeDocument.findMany({ where: { userId: user.id }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: DOCUMENT_LIMITS.documentsPerUser, select: documentSummarySelect });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "读取文档列表失败。"); }
}

async function POSTHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("documents", user.id);
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be multipart/form-data" });
    const bytes = await readLimitedBody(req, DOCUMENT_LIMITS.bodyBytes);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "无效的文档上传请求。" }); }
    const file = form.get("file");
    if ([...form.keys()].length !== 1 || !(file instanceof File)) throw new ApiError({ code: "VALIDATION_ERROR", message: "每次只能上传一个 file 文件字段。" });
    const { filename, format } = validateDocumentFile(file);
    const pages = await parseDocument(new Uint8Array(await file.arrayBuffer()), format, req.signal);
    if (req.signal.aborted) throw new ApiError({ code: "VALIDATION_ERROR", message: "文档导入已取消。" });
    const data = await indexDocument(user.id, { filename, format, byteSize: file.size, pages });
    return Response.json({ data }, { status: data.change === "created" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "文档导入失败，原有索引保持不变。"); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
