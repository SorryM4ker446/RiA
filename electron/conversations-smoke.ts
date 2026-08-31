import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrowserWindow, DownloadItem, Event, WebContents } from "electron";

function requireSmokeMode() {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Conversation fixtures require desktop smoke mode");
}
export async function prepareConversationSmoke(origin: string, cookie: string, id: string) {
  requireSmokeMode();
  const response = await fetch(`${origin}/api/conversations/${id}`, {
    method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ pinned: true, tags: ["Desktop", "验证"] }),
  });
  if (!response.ok) throw new Error("Desktop conversation metadata did not persist");
}

export async function verifyConversationSmoke(window: BrowserWindow, origin: string, cookie: string, id: string, dataDirectory: string) {
  requireSmokeMode();
  const headers = { Cookie: cookie };
  const response = await fetch(`${origin}/api/conversations?${new URLSearchParams({ q: "Smoke attachment", tag: "DESKTOP" })}`, { headers });
  const search = await response.json() as { data?: Array<{ id: string; pinned: boolean; tags: string[] }> };
  if (!response.ok || !search.data?.some(chat => chat.id === id && chat.pinned && chat.tags.includes("验证"))) throw new Error("Desktop conversation search or metadata did not survive restart");
  if ((await fetch(`${origin}/api/conversations/${id}/export`)).status !== 403) throw new Error("Desktop conversation export allowed unauthenticated access");
  const exportDirectory = resolve(dataDirectory, "smoke-exports");
  mkdirSync(exportDirectory, { recursive: true });
  await window.loadURL(`${origin}/conversations`);
  for (const format of ["JSON", "Markdown"]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (event: Event, item: DownloadItem, webContents: WebContents) => void = () => {};
    const downloaded = new Promise<string>((resolveDownload, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop conversation download timed out")), 15_000);
      listener = (_event, item, webContents) => {
        if (webContents !== window.webContents) return;
        const filename = item.getFilename();
        if (!/^conversation-[a-f0-9]{12}\.(json|md)$/.test(filename) || new URL(item.getURL()).origin !== origin) {
          item.cancel(); reject(new Error("Unexpected desktop export download")); return;
        }
        const destination = resolve(exportDirectory, filename);
        if (dirname(destination) !== exportDirectory) { item.cancel(); reject(new Error("Invalid smoke download path")); return; }
        item.setSavePath(destination);
        item.once("done", (_event, state) => state === "completed" ? resolveDownload(destination) : reject(new Error(`Desktop export download ${state}`)));
      };
      window.webContents.session.on("will-download", listener);
    });
    try {
      const click = window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const button = [...document.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(`导出 ${format}`)} && !button.disabled);
          if (button) { button.click(); return; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Desktop conversation export button unavailable');
      })()`);
      const [file] = await Promise.all([downloaded, click]);
      const contents = readFileSync(file, "utf8");
      if (!contents.includes("Smoke attachment") || !contents.includes("/api/media/") || contents.includes("relativePath") || contents.includes("data:image")) throw new Error("Desktop export content is incomplete or contains private file metadata");
      if (format === "JSON") {
        const snapshot = JSON.parse(contents);
        if (snapshot.conversation.id !== id || !snapshot.messages[0].attachments.length) throw new Error("Desktop JSON export is invalid");
      }
    } finally {
      clearTimeout(timer);
      window.webContents.session.removeListener("will-download", listener);
    }
  }
}
