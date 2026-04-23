import { NextRequest } from "next/server";
import { listPublicToolCatalog, type ToolMode } from "@/tools/catalog";

function resolveMode(value: string | null): ToolMode | undefined {
  if (!value) return undefined;
  if (value === "chat" || value === "image" || value === "video") {
    return value;
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = resolveMode(url.searchParams.get("mode"));

  const tools = listPublicToolCatalog(mode ?? "chat");

  return Response.json({
    data: tools,
  });
}
