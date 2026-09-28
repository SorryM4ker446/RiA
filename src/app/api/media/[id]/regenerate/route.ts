import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { getMediaDetail } from "@/lib/media/library";
import { generateStoredMedia } from "@/lib/media/generation";
import { mediaUrl } from "@/lib/media/message-codec";
import { recipeModelRef } from "@/lib/media/generation-recipe";
import { t } from "@/lib/locale";
async function POSTHandler(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("mediaRegeneration");
    z.strictObject({ confirm: z.literal(true) }).parse(await readJsonBody(req, 16 * 1024));
    const detail = await getMediaDetail((await context.params).id);
    if (detail.regenerationUnavailable || !detail.generation) throw new ApiError({ code: "CONFLICT", message: detail.regenerationUnavailable ?? t("api.media.regenerationParamsUnavailable") });
    const recipe = detail.generation;
    enforceRateLimit(recipe.type);
    const inputs = recipe.inputImages.map(image => ({ url: mediaUrl(image.assetId), mediaType: image.mediaType }));
    // The recorded recipe is the authority here: regeneration always uses the
    // model that produced the original, addressed by provider as well as id, so
    // a recipe written before references were provider-qualified still resolves
    // to the provider it was actually generated through.
    const body = { prompt: recipe.prompt, model: recipeModelRef(recipe), ...(detail.sourceChat ? { chatId: detail.sourceChat.id } : {}),
      ...(recipe.type === "image" ? { inputImages: inputs } : { inputImage: inputs[0], aspectRatio: recipe.aspectRatio, duration: recipe.duration, fps: recipe.fps }) };
    return Response.json(await generateStoredMedia(recipe.type, body, req.signal, false), { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.media.regenerateFailed")); }
}

export const POST = protectDataOperation(POSTHandler);
