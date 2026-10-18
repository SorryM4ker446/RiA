import { NextRequest } from "next/server";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getSkill, searchSkills } from "@/lib/plugins/skill-marketplace";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("skillMarketplace");
    const params = req.nextUrl.searchParams;
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "技能查询参数不能重复。" });
    const input = Object.fromEntries(params);
    const data = params.has("q") ? await searchSkills(input, req.signal) : await getSkill(input, req.signal);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取 Skill 市场。" ); }
});
