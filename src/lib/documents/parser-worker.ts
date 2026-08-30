// A separate worker prevents malformed documents from blocking the HTTP event loop.
export const DOCUMENT_PARSER_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { dirname, join } = require('node:path');
globalThis.fetch = async () => { throw new Error('Network access is disabled during document import'); };
const { bytes, format, limits, pdfPath, pdfWorkerPath, mammothPath, zipPath } = workerData;
const fail = (message, code = 'VALIDATION_ERROR') => { throw Object.assign(new Error(message), { code }); };
const tooLarge = () => fail('文档展开后过大，请拆分后导入。', 'PAYLOAD_TOO_LARGE');
const normalize = text => text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
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
    if (!zip.file('word/document.xml') || !zip.file('[Content_Types].xml')) fail('文件不是有效的 Word .docx 文档。');
    let expandedBytes = 0;
    for (const file of entries) {
      if (file.name.toLowerCase().endsWith('vbaproject.bin')) fail('不支持含宏的 Word 文档。');
      // Count actual streamed output, not attacker-controlled ZIP size metadata.
      await new Promise((resolve, reject) => {
        const stream = file.nodeStream();
        stream.on('data', chunk => {
          expandedBytes += chunk.length;
          if (expandedBytes > 12 * 1024 * 1024) {
            stream.pause();
            stream.destroy();
            reject(Object.assign(new Error('文档展开后过大，请拆分后导入。'), { code: 'PAYLOAD_TOO_LARGE' }));
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    }
    const result = await require(mammothPath).extractRawText({ buffer: Buffer.from(bytes) });
    pages = [{ pageNumber: null, text: normalize(result.value) }];
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('文本文件必须使用 UTF-8 编码。'); }
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) fail('文件含二进制内容，不能作为文本导入。');
    pages = [{ pageNumber: null, text: normalize(text) }];
  }
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > limits.characters) tooLarge();
  if (!pages.some(page => page.text.trim())) fail('文档没有可检索的文本；扫描 PDF 请先进行 OCR。');
  return pages;
}
parse().then(pages => parentPort.postMessage({ pages }), error => parentPort.postMessage({
  code: ['PAYLOAD_TOO_LARGE', 'VALIDATION_ERROR'].includes(error.code) ? error.code : 'VALIDATION_ERROR',
  message: ['PAYLOAD_TOO_LARGE', 'VALIDATION_ERROR'].includes(error.code) ? error.message :
    error.name === 'PasswordException' ? '不支持加密 PDF，请先解密。' : '文档损坏或格式不受支持。'
}));
`;
