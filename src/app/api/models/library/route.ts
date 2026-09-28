import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { addModel, removeModel } from "@/lib/models/preferences";
import { modelRefSchema } from "@/lib/models/preferences-schema";
import { t } from "@/lib/locale";

const action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add"), model: modelRefSchema }),
  z.strictObject({ action: z.literal("remove"), model: modelRefSchema }),
]);

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("modelSettings");
    const input = action.parse(await readJsonBody(req, 4096));
    if (input.action === "add") return Response.json(await addModel(input.model), { headers: { "Cache-Control": "no-store" } });
    return Response.json({ data: await removeModel(input.model) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.models.libraryUpdateFailed")); }
});
