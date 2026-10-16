import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";
import { readLimitedBody } from "@/lib/server/request-body";
import { DOCUMENT_LIMITS, documentIdSchema } from "./types";
import { validateDocumentFile } from "./parser";

export const documentRevisionSchema = z.strictObject({ id: documentIdSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/), collection: z.string().max(40).nullable() });
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;

export async function readDocumentUpload(req: Request, preview = false) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be multipart/form-data" });
  const bytes = await readLimitedBody(req, DOCUMENT_LIMITS.bodyBytes);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "无效的文档上传。" }); }
  const allowed = preview ? ["file", "collection"] : ["file", "collection", "previewHash", "base"];
  if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1) || !(form.get("file") instanceof File)) throw new ApiError({ code: "VALIDATION_ERROR", message: "一次只可提交一个文档及其集合。" });
  const file = form.get("file") as File;
  const collection = z.string().trim().max(40).parse(form.get("collection") ?? "") || null;
  const { filename, format } = validateDocumentFile(file);
  let previewHash: string | undefined; let base: DocumentRevision | null | undefined;
  if (form.has("previewHash") || form.has("base")) {
    previewHash = z.string().regex(/^[a-f0-9]{64}$/).parse(form.get("previewHash"));
    try { base = documentRevisionSchema.nullable().parse(JSON.parse(String(form.get("base")))); }
    catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "文档预览版本无效，请重新预览。" }); }
  }
  return { file, filename, format, collection, previewHash, base };
}
