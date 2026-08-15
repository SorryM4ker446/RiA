import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { listPublicToolCatalog, type ToolMode } from "@/tools/catalog";

function resolveMode(value: string | null): ToolMode | undefined {
  if (!value) return undefined;
  if (value === "chat" || value === "image" || value === "video") {
    return value;
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  try {
    await requireRequestUser(req);

    const url = new URL(req.url);
    const mode = resolveMode(url.searchParams.get("mode"));

    const tools = listPublicToolCatalog(mode ?? "chat");

    return Response.json({
      data: tools,
    });
  } catch (error) {
    console.error("/api/tools GET error", error);
    return createApiErrorResponse(error, "Failed to fetch tool catalog");
  }
}
