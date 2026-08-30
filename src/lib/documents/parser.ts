import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DOCUMENT_LIMITS, documentPagesSchema, type DocumentFormat, type DocumentPage } from "@/lib/documents/types";
import { DOCUMENT_PARSER_WORKER } from "@/lib/documents/parser-worker";
import { ApiError } from "@/lib/server/api-error";

// Workers run outside Turbopack; resolve with native Node, not bundled module IDs.
const runtimeRequire = process.getBuiltinModule("module").createRequire(join(/* turbopackIgnore: true */ process.cwd(), "package.json"));
const state = globalThis as typeof globalThis & { __documentParsers?: number };
const formats = new Set(["pdf", "docx", "md", "txt"]);

export function validateDocumentFile(file: File): { filename: string; format: DocumentFormat } {
  const filename = file.name.normalize("NFC").trim();
  if (!filename || filename.length > 180 || /[/\\\x00-\x1f\x7f]/u.test(filename) || filename === "." || filename === "..") {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "无效的文档文件名。" });
  }
  const format = filename.split(".").at(-1)?.toLowerCase() ?? "";
  if (!formats.has(format)) throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "仅支持 PDF、UTF-8 Markdown、TXT 和 Word .docx；旧版 .doc 请先转换。" });
  if (file.size > DOCUMENT_LIMITS.fileBytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "文档不能超过 8 MiB。" });
  if (!file.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "不能导入空文件。" });
  return { filename, format: format as DocumentFormat };
}

export async function parseDocument(bytes: Uint8Array, format: DocumentFormat, signal?: AbortSignal): Promise<DocumentPage[]> {
  if (!bytes.length || bytes.length > DOCUMENT_LIMITS.fileBytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "无效的文档大小。" });
  if ((format === "pdf" && Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") || (format === "docx" && (bytes[0] !== 0x50 || bytes[1] !== 0x4b))) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "文件内容与扩展名不符。" });
  }
  if (signal?.aborted) throw new ApiError({ code: "VALIDATION_ERROR", message: "文档导入已取消。" });
  if ((state.__documentParsers ?? 0) >= 2) throw new ApiError({ code: "SERVICE_UNAVAILABLE", message: "文档解析繁忙，请稍后重试。", headers: { "Retry-After": "2" } });
  state.__documentParsers = (state.__documentParsers ?? 0) + 1;
  let worker: Worker | undefined;
  try {
    worker = new Worker(DOCUMENT_PARSER_WORKER, {
      eval: true, execArgv: [], env: {}, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      workerData: { bytes, format, limits: DOCUMENT_LIMITS,
        pdfPath: runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
        pdfWorkerPath: runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
        mammothPath: runtimeRequire.resolve("mammoth"), zipPath: runtimeRequire.resolve("jszip"),
      },
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    const activeWorker = worker;
    return await new Promise<DocumentPage[]>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new ApiError({ code: "TIMEOUT", message: "文档解析超时，请拆分文件后重试。" })), DOCUMENT_LIMITS.parseTimeoutMs);
      const abort = () => finish(new ApiError({ code: "VALIDATION_ERROR", message: "文档导入已取消。" }));
      function finish(error?: Error, pages?: DocumentPage[]) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(pages!);
      }
      signal?.addEventListener("abort", abort, { once: true });
      activeWorker.once("error", () => finish(new ApiError({ code: "VALIDATION_ERROR", message: "文档解析失败或超过内存限制。" })));
      activeWorker.once("exit", () => finish(new ApiError({ code: "VALIDATION_ERROR", message: "文档解析进程已结束。" })));
      activeWorker.once("message", (result) => {
        if (result.code) finish(new ApiError({ code: result.code, message: result.message }));
        else {
          const parsed = documentPagesSchema.safeParse(result.pages);
          if (parsed.success) finish(undefined, parsed.data);
          else finish(new ApiError({ code: "VALIDATION_ERROR", message: "无效的文档文本。" }));
        }
      });
      if (signal?.aborted) abort();
    });
  } finally {
    await worker?.terminate();
    state.__documentParsers = Math.max(0, (state.__documentParsers ?? 1) - 1);
  }
}
