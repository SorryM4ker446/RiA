import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exclusiveDataOperation, protectDataOperation } from "@/lib/server/data-operations";
import { inspectAccountBackup } from "@/lib/backups/archive";
import { openBackup, removeBackupFile } from "@/lib/backups/files";
import { restoreAccountBackup } from "@/lib/backups/restore";
type Context = { params: Promise<{ id: string }> };
export const GET = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    const user = await requireRequestUser(req), { id } = await context.params;
    if (req.nextUrl.searchParams.getAll("download").length > 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate query parameter" });
    z.strictObject({ download: z.literal("1").optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
    if (!req.nextUrl.searchParams.has("download")) return Response.json({ data: await inspectAccountBackup(user.id, id) }, { headers: { "Cache-Control": "private, no-store" } });
    const file = await openBackup(user.id, id);
    return new Response(Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${id}.paib"`, "Content-Length": String((await file.stat()).size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return createApiErrorResponse(error, "读取备份失败。"); }
});
export async function POST(req: NextRequest, context: Context) {
  try {
    const user = await requireRequestUser(req); enforceRateLimit("backups", user.id);
    z.strictObject({ confirm: z.literal(true) }).parse(await readJsonBody(req, 16 * 1024));
    return Response.json({ data: await exclusiveDataOperation(() => context.params.then(({ id }) => restoreAccountBackup(user.id, id))) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "恢复失败，原有数据已保留。"); }
}
export async function DELETE(req: NextRequest, context: Context) {
  try { const user = await requireRequestUser(req); enforceRateLimit("backups", user.id); await exclusiveDataOperation(() => context.params.then(({ id }) => removeBackupFile(user.id, id))); return Response.json({ data: { deleted: true } }); }
  catch (error) { return createApiErrorResponse(error, "删除备份失败。"); }
}
