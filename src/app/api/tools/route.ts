import { z } from "zod";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { listPublicToolCatalog } from "@/tools/catalog";

export async function GET(req: NextRequest) {
  try {
    await requireRequestUser(req);

    const url = new URL(req.url);
    const mode = z.enum(["chat", "image", "video"]).optional().parse(url.searchParams.get("mode") ?? undefined);

    const tools = listPublicToolCatalog(mode ?? "chat");

    return Response.json({
      data: tools,
    });
  } catch (error) {
    console.error("/api/tools GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch tool catalog");
  }
}
