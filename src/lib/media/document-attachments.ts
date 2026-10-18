import { parseDocument, validateDocumentFile } from "@/lib/documents/parser";
import { DOCUMENT_ATTACHMENT_TYPES, isDocumentAttachment } from "@/lib/media/limits";
import { ApiError } from "@/lib/server/api-error";

export async function parseChatDocument(bytes: Uint8Array, mediaType: string, signal?: AbortSignal) {
  if (!isDocumentAttachment(mediaType)) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unsupported document attachment" });
  const pages = await parseDocument(bytes, mediaType === DOCUMENT_ATTACHMENT_TYPES[0] ? "pdf" : "docx", signal);
  return pages.map(page => `${page.pageNumber ? `[Page ${page.pageNumber}]\n` : ""}${page.text}`).join("\n\n");
}

export function validateChatDocumentFile(file: File, mediaType: string) {
  const { format, filename } = validateDocumentFile(file);
  if (mediaType !== (format === "pdf" ? DOCUMENT_ATTACHMENT_TYPES[0] : format === "docx" ? DOCUMENT_ATTACHMENT_TYPES[1] : "")) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "文档类型与扩展名不符，请选择 PDF 或 Word（.docx）文件。" });
  }
  return filename;
}
