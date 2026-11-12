import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { saveInterfaceLocale } from "@/lib/scheduler/task-wording";

const input = z.strictObject({ locale: z.enum(["zh-CN", "en-US"]) });

/** The language the user chose for the interface, which work that runs unattended is worded in too. */
export const PUT = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("modelSettings");
    const parsed = input.safeParse(await readJsonBody(req, 1024));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid language" });
    await saveInterfaceLocale(parsed.data.locale);
    return Response.json({ data: parsed.data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to save the interface language");
  }
});
