import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { attachmentMediaType, attachmentValidationError, CHAT_DOCUMENT_CHARACTERS, isDocumentAttachment, MEDIA_LIMITS } from "@/lib/media/limits";
import { parseChatDocument, validateChatDocumentFile } from "@/lib/media/document-attachments";
import { createMediaAsset, toMediaReference, validateMediaBytes } from "@/lib/media/storage";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readLimitedBody } from "@/lib/server/request-body";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("upload");
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be multipart/form-data" });
    const bytes = await readLimitedBody(req, MEDIA_LIMITS.uploadBodyBytes);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData(); }
    catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "Expected multipart attachments" }); }
    if ([...form.keys()].some((key) => key !== "files")) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected upload field" });
    const entries = form.getAll("files");
    if (!entries.length || entries.some((file) => !(file instanceof File))) throw new ApiError({ code: "VALIDATION_ERROR", message: "files is required" });
    const files = entries as File[];
    const validation = attachmentValidationError(files, true);
    if (validation) throw new ApiError({ code: "VALIDATION_ERROR", message: validation });
    const inputs = await Promise.all(files.map(async (file) => {
      const mediaType = attachmentMediaType(file);
      const filename = isDocumentAttachment(mediaType) ? validateChatDocumentFile(file, mediaType) : file.name;
      return { bytes: new Uint8Array(await file.arrayBuffer()), filename, mediaType };
    }));
    // Validate the entire batch before writing any asset.
    let characters = 0;
    for (const input of inputs) {
      validateMediaBytes(input.bytes, input.mediaType, MEDIA_LIMITS.attachmentBytes);
      if (isDocumentAttachment(input.mediaType)) {
        characters += (await parseChatDocument(input.bytes, input.mediaType, req.signal)).length;
        if (characters > CHAT_DOCUMENT_CHARACTERS) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "本次文档正文合计超过 100,000 字符，请减少附件。" });
      }
    }
    req.signal.throwIfAborted();
    const data = [];
    for (const input of inputs) {
      const asset = await createMediaAsset({ bytes: input.bytes, mediaType: input.mediaType, kind: "attachment", description: input.filename });
      data.push({ ...toMediaReference(asset), filename: input.filename.slice(0, 255) });
    }
    return Response.json({ data }, { status: 201 });
  } catch (error) { return createApiErrorResponse(error, "Failed to upload or parse attachments"); }
}

export const POST = protectDataOperation(POSTHandler);
