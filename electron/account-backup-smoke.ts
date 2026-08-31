import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrowserWindow, DownloadItem, Event, WebContents } from "electron";

export async function prepareAccountSettingsSmoke(origin: string, cookie: string) {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Account check requires smoke mode");
  const response = await fetch(`${origin}/api/models`, { headers: { Cookie: cookie } });
  const { data } = await response.json() as { data: Record<string, unknown> };
  const saved = await fetch(`${origin}/api/models`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ...data, defaultMode: "image", backupRetentionDays: 7 }) });
  if (!saved.ok) throw new Error("Desktop model preferences were not saved");
  await saved.json();
}

export async function verifyAccountBackupSmoke(window: BrowserWindow, origin: string, cookie: string, dataDirectory: string, restart: () => Promise<string>) {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Account check requires smoke mode");
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  async function data(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Desktop account check failed: ${path} ${response.status}`);
    return (await response.json()).data;
  }
  if ((await data("/api/models")).defaultMode !== "image") throw new Error("Desktop model preferences did not survive restart");
  if ((await fetch(`${origin}/api/backups`)).status !== 403 || (await fetch(`${origin}/api/usage`)).status !== 403) throw new Error("Desktop account data allowed anonymous access");
  if ((await fetch(`${origin}/api/backups`, { method: "POST", headers: { ...headers, Origin: "https://outside.invalid" } })).status !== 403) throw new Error("Desktop backup allowed foreign Origin");
  await window.loadURL(`${origin}/backups`);
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent === '创建备份' && !button.disabled);
      if (button) { button.click(); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Desktop backup page did not render');
  })()`);
  const id = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const article = document.querySelector('article[aria-label^="备份 "]');
      if (article) return article.getAttribute('aria-label').slice(3);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Desktop backup was not created');
  })()`) as string;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid backup smoke ID");
  const folder = resolve(dataDirectory, "smoke-backup-downloads"), destination = resolve(folder, `${id}.paib`);
  if (dirname(destination) !== folder) throw new Error("Unexpected backup download path");
  mkdirSync(folder, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (event: Event, item: DownloadItem, contents: WebContents) => void = () => {};
  const download = new Promise<void>((resolveDownload, reject) => {
    timer = setTimeout(() => reject(new Error("Desktop backup download timed out")), 15000);
    listener = (_event, item, contents) => {
      if (contents !== window.webContents) return;
      if (item.getFilename() !== `${id}.paib` || item.getURL() !== `${origin}/api/backups/${id}?download=1`) { item.cancel(); reject(new Error("Unexpected backup download")); return; }
      item.setSavePath(destination); item.once("done", (_event, state) => state === "completed" ? resolveDownload() : reject(new Error(`Backup download ${state}`)));
    };
    window.webContents.session.on("will-download", listener);
  });
  try {
    await Promise.all([download, window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent === '下载备份' && !button.disabled);
      if (!button) throw new Error('Desktop backup download unavailable'); button.click();
    })()`)]);
    if (readFileSync(destination).subarray(0, 8).toString() !== "PAIB0001") throw new Error("Desktop backup download is invalid");
  } finally { clearTimeout(timer); window.webContents.session.removeListener("will-download", listener); }
  const original = await data(`/api/backups/${id}`);
  const unconfirmed = await fetch(`${origin}/api/backups/${id}`, { method: "POST", headers, body: JSON.stringify({ confirm: false }) });
  if (unconfirmed.status !== 400) throw new Error("Desktop restore did not require confirmation");
  await unconfirmed.json();
  const restored = await data(`/api/backups/${id}`, "POST", { confirm: true });
  if (!restored.safetyBackupId) throw new Error("Desktop restore omitted the safety backup");
  origin = await restart();
  if ((await data("/api/models")).backupRetentionDays !== 7 || (await data(`/api/backups/${id}`)).counts.assets !== original.counts.assets) throw new Error("Desktop restored data did not survive restart");
  if ((await data("/api/tasks")).some((task: { reminderEnabled: boolean }) => task.reminderEnabled)) throw new Error("Desktop restore replayed task reminders");
  const media = await data("/api/media/library");
  for (const asset of media) {
    const response = await fetch(`${origin}${asset.url}`, { headers });
    if (!response.ok || (await response.arrayBuffer()).byteLength !== asset.byteSize) throw new Error("Desktop restored media is unavailable");
  }
  await window.loadURL(`${origin}/models`);
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (document.querySelector('select[aria-label="新会话默认模式"]')?.value === 'image') return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Desktop restored model settings did not render');
  })()`);
}
