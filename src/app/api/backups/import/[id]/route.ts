import { NextRequest } from "next/server";
import { z } from "zod";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readEmptyBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exclusiveDataOperation } from "@/lib/server/data-operations";
import { appendBackupImport, cancelBackupImport, completeBackupImport } from "@/lib/backups/imports";
type Context = { params: Promise<{ id: string }> };
export async function PUT(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("backupChunks");
    if (req.nextUrl.searchParams.getAll("offset").length > 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate query parameter" });
    const query = z.strictObject({ offset: z.string().regex(/^(0|[1-9]\d{0,9})$/).transform(Number) }).parse(Object.fromEntries(req.nextUrl.searchParams));
    return Response.json({ data: await exclusiveDataOperation(() => context.params.then(({ id }) => appendBackupImport(id, query.offset, req))) });
  } catch (error) { return createApiErrorResponse(error, "分块上传失败。"); }
}
export async function POST(req: NextRequest, context: Context) {
  try { await requireLocalWorkspace(req); enforceRateLimit("backups"); await readEmptyBody(req); return Response.json({ data: await exclusiveDataOperation(() => context.params.then(({ id }) => completeBackupImport(id))) }, { status: 201 }); }
  catch (error) { return createApiErrorResponse(error, "备份校验失败，没有恢复数据。"); }
}
export async function DELETE(req: NextRequest, context: Context) {
  try { await requireLocalWorkspace(req);await exclusiveDataOperation(() => context.params.then(({ id }) => cancelBackupImport(id))); return Response.json({ data: { cancelled: true } }); }
  catch (error) { return createApiErrorResponse(error, "取消导入失败。"); }
}
