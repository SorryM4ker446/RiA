import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { attachmentValidationError, MEDIA_LIMITS } from "@/lib/media/limits";
import { createMediaAsset, toMediaReference, validateMediaBytes } from "@/lib/media/storage";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readLimitedBody } from "@/lib/server/request-body";

async function POSTHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("upload", user.id);
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be multipart/form-data" });
    const bytes = await readLimitedBody(req, MEDIA_LIMITS.uploadBodyBytes);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData(); }
    catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "Expected multipart image attachments" }); }
    if ([...form.keys()].some((key) => key !== "files")) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected upload field" });
    const entries = form.getAll("files");
    if (!entries.length || entries.some((file) => !(file instanceof File))) throw new ApiError({ code: "VALIDATION_ERROR", message: "files is required" });
    const files = entries as File[];
    const validation = attachmentValidationError(files);
    if (validation) throw new ApiError({ code: "VALIDATION_ERROR", message: validation });
    const inputs = await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), file })));
    // Validate the entire batch before writing any asset.
    for (const input of inputs) validateMediaBytes(input.bytes, input.file.type, MEDIA_LIMITS.attachmentBytes);
    const data = [];
    for (const input of inputs) {
      const asset = await createMediaAsset({ userId: user.id, bytes: input.bytes, mediaType: input.file.type, kind: "attachment", description: input.file.name });
      data.push({ ...toMediaReference(asset), filename: input.file.name.slice(0, 255) });
    }
    return Response.json({ data }, { status: 201 });
  } catch (error) { return createApiErrorResponse(error, "Failed to store image attachments"); }
}

export const POST = protectDataOperation(POSTHandler);
