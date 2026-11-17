/*
 * Reads scanned PDF pages in a worker thread of its own, so a slow or hostile
 * file cannot hold up the service: each page is rendered with PDF.js onto a
 * canvas and read by Tesseract, and its text is posted back as soon as it is
 * read. Network access is switched off; the language data comes from a local
 * folder. Paths are passed in because the worker runs outside the bundler.
 */
export const DOCUMENT_OCR_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { dirname, join } = require('node:path');
globalThis.fetch = async () => { throw new Error('Network access is disabled during OCR'); };
const { bytes, pages, languages, pdfPath, pdfWorkerPath, canvasPath, tesseractPath, langPath, scale, maxPixels } = workerData;
async function run() {
  const pdf = await import(pathToFileURL(pdfPath).href);
  pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfWorkerPath).href;
  const root = join(dirname(pdfPath), '../..');
  const { createCanvas } = require(canvasPath);
  const { createWorker } = require(tesseractPath);
  const task = pdf.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWasm: false, isOffscreenCanvasSupported: false,
    cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(root, 'standard_fonts') + '/', verbosity: 0 });
  const document = await task.promise;
  const reader = await createWorker(languages, 1, { langPath, cacheMethod: 'none', gzip: true, logger: () => {}, errorHandler: () => {} });
  try {
    for (const number of pages) {
      const page = await document.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      // Fine enough for small print, bounded so an oversized page cannot exhaust memory.
      const factor = Math.min(scale, Math.sqrt(maxPixels / (natural.width * natural.height)));
      const viewport = page.getViewport({ scale: factor });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      const image = await canvas.encode('png');
      page.cleanup();
      const { data } = await reader.recognize(image);
      parentPort.postMessage({ page: number, text: String(data.text ?? ''), confidence: Number(data.confidence) || 0 });
    }
  } finally {
    await reader.terminate().catch(() => {});
    await task.destroy().catch(() => {});
  }
}
run().then(() => parentPort.postMessage({ done: true }), error => parentPort.postMessage({ error: String(error && error.message || error).slice(0, 300) }));
`;
