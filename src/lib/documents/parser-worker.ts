import { t } from "@/lib/locale";
import { serializeWordDocument } from "./word-structure";

/**
 * User-facing copy for the parser worker.
 *
 * The worker runs as an `eval`'d string with an empty environment, so it cannot
 * import this module. The parent resolves the strings and hands them over with
 * the job, which keeps the worker free of any locale lookup of its own.
 */
export function documentParserMessages() {
  return {
    expandedTooLarge: t("lib.documents.expandedTooLarge"),
    notValidDocx: t("lib.documents.notValidDocx"),
    macroDocx: t("lib.documents.macroDocx"),
    notUtf8: t("lib.documents.notUtf8"),
    binaryText: t("lib.documents.binaryText"),
    noSearchableText: t("lib.documents.noSearchableText"),
    encryptedPdf: t("lib.documents.encryptedPdf"),
    corrupt: t("lib.documents.corrupt"),
  } as const;
}

// A separate worker prevents malformed documents from blocking the HTTP event loop.
export const DOCUMENT_PARSER_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { dirname, join } = require('node:path');
globalThis.fetch = async () => { throw new Error('Network access is disabled during document import'); };
const { bytes, format, limits, messages, pdfPath, pdfWorkerPath, mammothPath, zipPath } = workerData;
const fail = (message, code = 'VALIDATION_ERROR') => { throw Object.assign(new Error(message), { code }); };
const tooLarge = () => fail(messages.expandedTooLarge, 'PAYLOAD_TOO_LARGE');
const normalize = text => text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
const serializeWordDocument = ${serializeWordDocument.toString()};
async function parse() {
  let pages;
  if (format === 'pdf') {
    const pdf = await import(pathToFileURL(pdfPath).href);
    pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfWorkerPath).href;
    const root = join(dirname(pdfPath), '../..');
    const task = pdf.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, useWasm: false, isImageDecoderSupported: false, isOffscreenCanvasSupported: false,
      cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(root, 'standard_fonts') + '/',
      stopAtErrors: true, verbosity: 0 });
    try {
      const document = await task.promise;
      if (document.numPages > limits.pages) tooLarge();
      pages = [];
      let characters = 0;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const reader = page.streamTextContent().getReader();
        let text = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const part = item.str + (item.hasEOL ? '\n' : ' ');
            characters += part.length;
            if (characters > limits.characters) tooLarge();
            text += part;
          }
        }
        pages.push({ pageNumber: number, text: normalize(text) });
        page.cleanup();
      }
    } finally { await task.destroy(); }
  } else if (format === 'docx') {
    const zip = await require(zipPath).loadAsync(bytes);
    const entries = Object.values(zip.files).filter(file => !file.dir);
    if (entries.length > 500) tooLarge();
    if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) fail(messages.notValidDocx);
    let expandedBytes = 0;
    for (const file of entries) {
      if (file.name.toLowerCase().endsWith('vbaproject.bin')) fail(messages.macroDocx);
      // Count actual streamed output, not attacker-controlled ZIP size metadata.
      await new Promise((resolve, reject) => {
        const stream = file.nodeStream();
        stream.on('data', chunk => {
          expandedBytes += chunk.length;
          if (expandedBytes > 12 * 1024 * 1024) {
            stream.pause();
            stream.destroy();
            reject(Object.assign(new Error(messages.expandedTooLarge), { code: 'PAYLOAD_TOO_LARGE' }));
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    }
    let structuredText = '';
    await require(mammothPath).convertToHtml({ buffer: Buffer.from(bytes) }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false,
      transformDocument: document => {
        structuredText = serializeWordDocument(document, limits.characters);
        return { ...document, children: [] };
      },
    });
    pages = [{ pageNumber: null, text: normalize(structuredText) }];
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(messages.notUtf8); }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) fail(messages.binaryText);
    pages = [{ pageNumber: null, text: normalize(text) }];
  }
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > limits.characters) tooLarge();
  if (!pages.some(page => page.text.trim())) fail(messages.noSearchableText);
  return pages;
}
parse().then(pages => parentPort.postMessage({ pages }), error => parentPort.postMessage({
  code: ['PAYLOAD_TOO_LARGE', 'VALIDATION_ERROR'].includes(error.code) ? error.code : 'VALIDATION_ERROR',
  message: ['PAYLOAD_TOO_LARGE', 'VALIDATION_ERROR'].includes(error.code) ? error.message :
    error.name === 'PasswordException' ? messages.encryptedPdf : messages.corrupt
}));
`;
