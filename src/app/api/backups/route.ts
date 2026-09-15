import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readEmptyBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exclusiveDataOperation, protectDataOperation } from "@/lib/server/data-operations";
import { createAccountBackup } from "@/lib/backups/archive";
import { listBackupFiles } from "@/lib/backups/files";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try { await requireLocalWorkspace(req); return Response.json({ data: (await listBackupFiles()).filter(file => file.extension === "paib") }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "读取备份失败。"); }
});
export async function POST(req: NextRequest) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("backups"); await readEmptyBody(req);
    return Response.json({ data: await exclusiveDataOperation(() => createAccountBackup()) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "创建备份失败，现有数据未改变。"); }
}
