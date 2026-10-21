import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { parseDocument } from "@/lib/documents/parser";
import { textPdf } from "../helpers/document-fixtures";

test("PDF text extraction does not enumerate system or user font directories", async t => {
  const threads = process.getBuiltinModule("worker_threads");
  const OriginalWorker = threads.Worker;
  // Observe the real canvas import, before its index can enumerate host fonts.
  // Sending an unexpected result makes the public parser reject the operation.
  const fontGuard = String.raw`(() => {
    const { parentPort, workerData } = require('node:worker_threads');
    const localRequire = require('node:module').createRequire(workerData.pdfPath);
    const { GlobalFonts } = localRequire('@napi-rs/canvas/js-binding.js');
    for (const method of ['loadSystemFonts', 'loadFontsFromDir']) {
      GlobalFonts[method] = () => parentPort.postMessage({ unexpectedFontAccess: method });
    }
  })();`;
  const mocked = t.mock.method(threads, "Worker", function(source, options) {
    assert.equal(typeof source, "string");
    return new OriginalWorker(fontGuard + source, options);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await parseDocument(textPdf(), "pdf"), [
      { pageNumber: 1, text: "Aurora support hours are 09:00 to 18:00." },
    ]);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
