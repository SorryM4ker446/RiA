import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { getModelPreferences, saveModelPreferences } from "@/lib/models/preferences";
import { availableModel, catalogs, modelModes } from "@/lib/models/preferences-schema";
import { db } from "@/db";
export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    const user = await requireRequestUser(req), settings = await getModelPreferences(user.id);
    const unavailable = modelModes.flatMap(mode => [settings[mode].modelId, settings[mode].fallbackId].filter(id => id && !availableModel(mode, id)).map(id => ({ mode, modelId: id, reason: "不在当前模型目录中" })));
    const recentFailures = await db.modelRequest.findMany({ where: { userId: user.id, errorCode: "MODEL_UNAVAILABLE", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 20, select: { modelId: true, mode: true, createdAt: true } });
    return Response.json({ data: settings, catalogs, unavailable, recentFailures }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, "读取模型设置失败。"); }
});
export const PUT = protectDataOperation(async (req: NextRequest) => {
  try { const user = await requireRequestUser(req); enforceRateLimit("modelSettings", user.id); return Response.json({ data: await saveModelPreferences(user.id, await readJsonBody(req, 64 * 1024)) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "保存模型设置失败。"); }
});
