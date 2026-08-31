import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exportConversation } from "@/lib/conversations/export";

async function GETHandler(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("conversationExport", user.id);
    const params = req.nextUrl.searchParams;
    if (params.getAll("format").length > 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate format parameter" });
    const { format } = z.strictObject({ format: z.enum(["json", "markdown"]).default("markdown") }).parse(Object.fromEntries(params));
    const { id } = await context.params;
    const output = await exportConversation(user.id, id, format);
    return new Response(output.text, { headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${output.filename}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return createApiErrorResponse(error, "Failed to export conversation"); }
}

export const GET = protectDataOperation(GETHandler);
