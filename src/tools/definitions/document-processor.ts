import { t } from "@/lib/locale";
import type { AnyToolDescriptor } from "@/tools/types";
import { documentReadSchema, documentConvertSchema, exportFilename, conversionNotes } from "@/lib/document-processor/schema";
import { loadAttachmentDocument, loadProcessorDocument } from "@/lib/document-processor/service";

export const documentProcessorTools: Record<string, AnyToolDescriptor> = {
  readDocument: {
    id: "readDocument", displayName: "读取文档", description: "打开知识库里的文档，读需要的那部分。",
    modelDescription: "Read extracted document text from the user's knowledge library. Find documentId using searchKnowledge first. Offset and limit are UTF-16 character positions over pages joined by two newlines. Returns a bounded excerpt and nextOffset when there is more. Never use it to read arbitrary OS paths or claim to inspect the original layout or images.",
    modeSupport: ["chat"],
    surface: { category: "knowledge", user: { run: "model", hint: t("tools.readDocument.hint") }, template: "selectable" },
    inputSchema: documentReadSchema,
    execute: async ({ input, signal, documentCollections }) => {
      const parsed = documentReadSchema.parse(input); signal?.throwIfAborted();
      const document = await loadProcessorDocument(parsed.documentId, { collections: documentCollections }); signal?.throwIfAborted();
      const end = Math.min(document.content.length, parsed.offset + parsed.limit);
      let position = 0;
      const pages = document.pages.flatMap(page => { const start = position; position += page.text.length + 2; return start < end && start + page.text.length > parsed.offset ? [{ pageNumber: page.pageNumber, text: page.text.slice(Math.max(0, parsed.offset - start), Math.max(0, end - start)) }] : []; });
      return { documentId: parsed.documentId, filename: document.filename, contentHash: document.source.contentHash, characterCount: document.content.length, offset: parsed.offset, text: document.content.slice(parsed.offset, end), pages, nextOffset: end < document.content.length ? end : null, notes: conversionNotes };
    },
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
  convertDocument: {
    id: "convertDocument", displayName: "转换并导出文档", description: "把文档或附件转成 Markdown、TXT、HTML 或 Word。",
    modelDescription: "Prepare a version-bound download of a document in the user's knowledge library (documentId, found via searchKnowledge) or of a document attached to the conversation (attachmentId, given with the attachment). Pass exactly one of them. Choose md, txt, html or docx. Returns a downloadUrl for the user to click; it does not write to folders, upload content or modify the original. Conversion uses extracted text structure, not original layout, images or OCR. Do not claim the file was saved to the user's computer until the user downloads it.",
    modeSupport: ["chat"],
    surface: { category: "knowledge", user: { run: "direct", hint: t("tools.convertDocument.hint") }, template: "selectable" },
    inputSchema: documentConvertSchema,
    execute: async ({ input, signal, documentCollections }) => {
      const parsed = documentConvertSchema.parse(input); signal?.throwIfAborted();
      if (parsed.attachmentId) {
        const document = await loadAttachmentDocument(parsed.attachmentId, signal); signal?.throwIfAborted();
        return { attachmentId: parsed.attachmentId, filename: exportFilename(document.filename, parsed.format), format: parsed.format, downloadUrl: `/api/media/${encodeURIComponent(parsed.attachmentId)}/export?format=${parsed.format}`, notes: conversionNotes };
      }
      const document = await loadProcessorDocument(parsed.documentId!, { collections: documentCollections }); signal?.throwIfAborted();
      return { documentId: parsed.documentId, contentHash: document.source.contentHash, filename: exportFilename(document.filename, parsed.format), format: parsed.format, downloadUrl: `/api/documents/${encodeURIComponent(parsed.documentId!)}/export?format=${parsed.format}&version=${document.source.contentHash}`, notes: conversionNotes };
    },
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
};
