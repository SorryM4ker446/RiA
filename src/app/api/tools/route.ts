import { protectDataOperation } from "@/lib/server/data-operations";
import { z } from "zod";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { listPublicToolCatalog } from "@/tools/catalog";
import { activeSkillPackages } from "@/lib/plugins/store";

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);

    const url = new URL(req.url);
    const mode = z.enum(["chat", "image", "video"]).optional().parse(url.searchParams.get("mode") ?? undefined);

    const tools = await listPublicToolCatalog(mode ?? "chat");

    // Skills sit beside tools wherever people choose what to use.
    const skills = (await activeSkillPackages()).flatMap(({ row, manifest }) => manifest.skills.map(skill => ({ packageId: row.packageId, skillId: skill.id, name: skill.name, description: skill.description, plugin: manifest.name })));
    return Response.json({
      data: tools,
      skills,
    });
  } catch (error) {
    console.error("/api/tools GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch tool catalog");
  }
}

export const GET = protectDataOperation(GETHandler);
