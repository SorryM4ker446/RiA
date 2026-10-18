import { z } from "zod";
import { DOCUMENT_LIMITS, documentIdSchema, type DocumentPage } from "@/lib/documents/types";

export const exportFormats = ["md", "txt", "html", "docx"] as const;
export type ExportFormat = typeof exportFormats[number];
export type ContentSyntax = "markdown" | "plain";
export const formatLabels: Record<ExportFormat, string> = { md: "Markdown", txt: "纯文本", html: "HTML", docx: "Word" };
export const contentTypes: Record<ExportFormat, string> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", html: "text/html; charset=utf-8", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
export const exportFormatSchema = z.enum(exportFormats);
export const processorTextSchema = z.string().min(1).max(DOCUMENT_LIMITS.characters).refine(value => !!value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff\ud800-\udfff]/u.test(value), "文档包含不支持的控制字符或无效文本。");
export const processorFilenameSchema = z.string().trim().min(1).max(180).refine(value => !/[/\\\x00-\x1f\x7f\ud800-\udfff]/u.test(value) && value !== "." && value !== "..", "文件名不能包含路径、控制字符或无效文本。");
export const exportRequestSchema = z.strictObject({ filename: processorFilenameSchema, content: processorTextSchema, syntax: z.enum(["markdown", "plain"]), format: exportFormatSchema });
export const documentReadSchema = z.strictObject({ documentId: documentIdSchema, offset: z.number().int().min(0).max(DOCUMENT_LIMITS.characters).default(0), limit: z.number().int().min(1).max(12_000).default(6000) });
export const documentConvertSchema = z.strictObject({ documentId: documentIdSchema, format: exportFormatSchema });
export function documentDownload(value: unknown) {
  const parsed = z.object({ documentId: documentIdSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/), filename: processorFilenameSchema, format: exportFormatSchema, downloadUrl: z.string() }).safeParse(value);
  if (!parsed.success) return null;
  const output = parsed.data;
  return output.downloadUrl === `/api/documents/${encodeURIComponent(output.documentId)}/export?format=${output.format}&version=${output.contentHash}` ? output : null;
}

export function exportFilename(filename: string, format: ExportFormat) {
  const clipped = filename.replace(/\.(pdf|docx|md|txt|html)$/i, "").replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/, "").slice(0, 170);
  const stem = clipped.replace(/[\ud800-\udbff]$/, "") || "document";
  return `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `_${stem}` : stem}.${format}`;
}
export const conversionNotes = ["按提取后的文本结构转换，原文排版、图片、页眉页脚和合并单元格不会完整保留。", "扫描 PDF 需要先做 OCR；远程图片和链接内容不会自动下载。"];
export type ProcessedDocument = { filename: string; format: string; syntax: ContentSyntax; pages: DocumentPage[]; content: string; characterCount: number; contentHash: string; notes: string[]; source?: { id: string; contentHash: string } };
