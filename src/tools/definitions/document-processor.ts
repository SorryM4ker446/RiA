import type { AnyToolDescriptor } from "@/tools/types";
import { documentReadSchema, documentConvertSchema, exportFilename, formatLabels, conversionNotes } from "@/lib/document-processor/schema";
import { loadProcessorDocument } from "@/lib/document-processor/service";

const manual = { enabled: true, label: "文档操作", placeholder: "选择知识库文档", submitLabel: "处理文档", primaryFieldKey: "documentId", primaryFieldLabel: "知识库文档", fields: [] };
export const documentProcessorTools: Record<string, AnyToolDescriptor> = {
  readDocument: {
    id: "readDocument", displayName: "读取文档", description: "按字符范围读取知识库文档的提取文本，保留页码并标明后续内容。",
    modelDescription: "Read extracted document text from the user's knowledge library. Find documentId using searchKnowledge first. Offset and limit are UTF-16 character positions over pages joined by two newlines. Returns a bounded excerpt and nextOffset when there is more. Never use it to read arbitrary OS paths or claim to inspect the original layout or images.",
    modeSupport: ["chat"], manual: { ...manual, label: "读取文档", submitLabel: "读取文档" }, inputSchema: documentReadSchema,
    execute: async ({ input, signal, documentCollections }) => {
      const parsed = documentReadSchema.parse(input); signal?.throwIfAborted();
      const document = await loadProcessorDocument(parsed.documentId, { collections: documentCollections }); signal?.throwIfAborted();
      const end = Math.min(document.content.length, parsed.offset + parsed.limit);
      let position = 0;
      const pages = document.pages.flatMap(page => { const start = position; position += page.text.length + 2; return start < end && start + page.text.length > parsed.offset ? [{ pageNumber: page.pageNumber, text: page.text.slice(Math.max(0, parsed.offset - start), Math.max(0, end - start)) }] : []; });
      return { documentId: parsed.documentId, filename: document.filename, contentHash: document.source.contentHash, characterCount: document.content.length, offset: parsed.offset, text: document.content.slice(parsed.offset, end), pages, nextOffset: end < document.content.length ? end : null, notes: conversionNotes };
    },
    buildAssistantText: ({ output }) => `${output.filename}\n\n${output.text}${output.nextOffset !== null ? `\n\n后续内容从字符 ${output.nextOffset} 继续。` : ""}`,
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
  convertDocument: {
    id: "convertDocument", displayName: "转换并导出文档", description: "将知识库文档转换为 Markdown、TXT、HTML 或 Word 下载副本。",
    modelDescription: "Prepare a version-bound download for a document in the user's knowledge library. Find documentId via searchKnowledge. Choose md, txt, html or docx. Returns a downloadUrl for the user to click; it does not write to folders, upload content or modify the original. Conversion uses extracted text structure, not original layout, images or OCR. Do not claim the file was saved to the user's computer until the user downloads it.",
    modeSupport: ["chat"], manual: { ...manual, label: "转换并导出文档", submitLabel: "转换并导出文档", fields: [{ key: "format", label: "导出格式", type: "select", required: true, defaultValue: "docx", options: Object.entries(formatLabels).map(([value, label]) => ({ value, label })) }] }, inputSchema: documentConvertSchema,
    execute: async ({ input, signal, documentCollections }) => {
      const parsed = documentConvertSchema.parse(input); signal?.throwIfAborted();
      const document = await loadProcessorDocument(parsed.documentId, { collections: documentCollections }); signal?.throwIfAborted();
      return { documentId: parsed.documentId, contentHash: document.source.contentHash, filename: exportFilename(document.filename, parsed.format), format: parsed.format, downloadUrl: `/api/documents/${encodeURIComponent(parsed.documentId)}/export?format=${parsed.format}&version=${document.source.contentHash}`, notes: conversionNotes };
    },
    buildAssistantText: ({ output }) => `已准备 ${output.filename} 的下载副本。点击下载按钮保存。\n\n${conversionNotes[0]}`,
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
};
