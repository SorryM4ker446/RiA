import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserWindow, DownloadItem, Event, WebContents } from "electron";

export function seedMediaLibrarySmoke(databaseFile: string, mediaDirectory: string, inputId: string, chatId: string) {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Media fixture requires desktop smoke mode");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const input = db.prepare("SELECT userId,relativePath,byteSize FROM media_assets WHERE id=?").get(inputId);
    if (!input || typeof input.relativePath !== "string" || !/^[a-f0-9]{64}\/[a-f0-9-]{36}\.png$/.test(input.relativePath)) throw new Error("Invalid media smoke source");
    const id = randomUUID();
    const relativePath = `${input.relativePath.split("/")[0]}/${id}.png`;
    const destination = resolve(mediaDirectory, relativePath);
    if (!destination.startsWith(`${resolve(mediaDirectory)}${sep}`)) throw new Error("Invalid media fixture path");
    copyFileSync(resolve(mediaDirectory, input.relativePath), destination);
    const recipe = { version: 1, type: "image", modelId: "google/gemini-2.5-flash-image", prompt: "Desktop library fixture", inputImages: [{ assetId: inputId, mediaType: "image/png" }] };
    db.prepare("INSERT INTO media_assets (id,userId,relativePath,byteSize,mediaType,kind,modelId,description,generation,sourceChatId) VALUES (?,?,?,?,'image/png','generated-image',?,?,?,?)").run(id, input.userId, relativePath, input.byteSize, recipe.modelId, recipe.prompt, JSON.stringify(recipe), chatId);
    db.prepare("INSERT INTO media_generation_inputs (assetId,inputAssetId) VALUES (?,?)").run(id, inputId);
    return id;
  } finally { db.close(); }
}

export async function verifyMediaLibrarySmoke(window: BrowserWindow, origin: string, cookie: string, id: string, inputId: string, expected: Buffer, dataDirectory: string) {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Media check requires desktop smoke mode");
  const headers = { Cookie: cookie };
  const details = await fetch(`${origin}/api/media/${id}/details`, { headers });
  const payload = await details.json() as { data?: { generation?: { prompt: string }; sourceChat?: { id: string } } };
  if (!details.ok || payload.data?.generation?.prompt !== "Desktop library fixture" || !payload.data.sourceChat?.id) throw new Error("Desktop media provenance did not survive restart");
  if ((await fetch(`${origin}/api/media/${id}/details`)).status !== 403) throw new Error("Desktop media details allowed anonymous access");
  const rejected = await fetch(`${origin}/api/media/${id}/regenerate`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: false }) });
  if (rejected.status !== 400) throw new Error("Desktop regeneration did not require explicit confirmation");
  await window.loadURL(`${origin}/media`);
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const row = document.querySelector('article[aria-label="媒体 ${id}"]');
      const button = row && [...row.querySelectorAll('button')].find(button => button.textContent === '查看详情' && !button.disabled);
      if (button) { button.click(); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Desktop media library did not render');
  })()`);
  const folder = resolve(dataDirectory, "smoke-media-downloads");
  mkdirSync(folder, { recursive: true });
  const destination = resolve(folder, `${id}.png`);
  if (dirname(destination) !== folder) throw new Error("Unexpected smoke download path");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (event: Event, item: DownloadItem, contents: WebContents) => void = () => {};
  const download = new Promise<void>((resolveDownload, reject) => {
    timer = setTimeout(() => reject(new Error("Desktop media download timed out")), 15_000);
    listener = (_event, item, contents) => {
      if (contents !== window.webContents) return;
      if (item.getFilename() !== `${id}.png` || item.getURL() !== `${origin}/api/media/${id}?download=1`) { item.cancel(); reject(new Error("Unexpected media download")); return; }
      item.setSavePath(destination);
      item.once("done", (_event, state) => state === "completed" ? resolveDownload() : reject(new Error(`Media download ${state}`)));
    };
    window.webContents.session.on("will-download", listener);
  });
  try {
    await Promise.all([download, window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const button = [...document.querySelectorAll('button')].find(button => button.textContent === '下载原文件' && !button.disabled);
        if (button) { button.click(); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Desktop media download button unavailable');
    })()`)]);
    if (!readFileSync(destination).equals(expected)) throw new Error("Desktop downloaded media bytes changed");
  } finally { clearTimeout(timer); window.webContents.session.removeListener("will-download", listener); }
  const removed = await fetch(`${origin}/api/media/${id}`, { method: "DELETE", headers });
  if (!removed.ok) throw new Error("Desktop unreferenced result could not be deleted");
  const input = await fetch(`${origin}/api/media/${inputId}`, { headers });
  if (!input.ok || !Buffer.from(await input.arrayBuffer()).equals(expected)) throw new Error("Desktop deletion damaged the source image");
}
