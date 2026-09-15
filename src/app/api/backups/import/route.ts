import { NextRequest } from "next/server";
import { z } from "zod";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exclusiveDataOperation } from "@/lib/server/data-operations";
import { beginBackupImport } from "@/lib/backups/imports";
import { BACKUP_LIMITS } from "@/lib/backups/schema";
export async function POST(req: NextRequest) {
  try { await requireLocalWorkspace(req); enforceRateLimit("backups"); const body = z.strictObject({ bytes: z.number().int().min(12).max(BACKUP_LIMITS.bytes) }).parse(await readJsonBody(req, 16 * 1024)); return Response.json({ data: await exclusiveDataOperation(() => beginBackupImport(body.bytes)) }, { status: 201 }); }
  catch (error) { return createApiErrorResponse(error, "开始导入失败。"); }
}
