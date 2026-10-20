import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrowserWindow, DownloadItem, Event, WebContents } from "electron";

export async function verifyDocumentProcessorSmoke(window: BrowserWindow, origin: string, cookie: string, documentId: string, dataDirectory: string) {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Document processing fixtures require desktop smoke mode");
  const folder = resolve(dataDirectory, "smoke-document-exports"), destination = resolve(folder, "release.docx");
  if (dirname(destination) !== folder) throw new Error("Invalid document smoke download path");
  mkdirSync(folder, { recursive: true });
  await window.loadURL(`${origin}/knowledge/documents/${encodeURIComponent(documentId)}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (event: Event, item: DownloadItem, webContents: WebContents) => void = () => {};
  const downloaded = new Promise<void>((resolveDownload, reject) => {
    timer = setTimeout(() => reject(new Error("Desktop Word download timed out")), 15_000);
    listener = (_event, item, webContents) => {
      if (webContents !== window.webContents) return;
      if (item.getFilename() !== "release.docx" || !item.getURL().startsWith(`blob:${origin}/`)) { item.cancel(); reject(new Error("Unexpected document download")); return; }
      item.setSavePath(destination);
      item.once("done", (_event, state) => state === "completed" ? resolveDownload() : reject(new Error(`Desktop document download ${state}`)));
    };
    window.webContents.session.on("will-download", listener);
  });
  try {
    await Promise.all([downloaded, window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const item = document.querySelector('[data-document-export="docx"]');
        if (item) { item.click(); return; }
        const button = document.querySelector('button[aria-label="导出"]');
        if (button && !button.disabled && button.getAttribute('data-state') !== 'open') {
          button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Desktop document detail export did not become ready');
    })()`)]);
    const bytes = readFileSync(destination);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("Desktop export did not produce a Word document");
    const form = new FormData(); form.set("file", new Blob([bytes]), "round-trip.docx");
    const response = await fetch(`${origin}/api/document-processor/parse`, { method: "POST", headers: { Cookie: cookie }, body: form });
    const payload = await response.json() as { data?: { format: string; content: string } };
    if (!response.ok || payload.data?.format !== "docx" || !payload.data.content.includes("500") || !payload.data.content.includes("主管审批")) throw new Error("Desktop Word export could not be read back without losing table values");
  } finally {
    clearTimeout(timer); window.webContents.session.removeListener("will-download", listener);
  }
}
