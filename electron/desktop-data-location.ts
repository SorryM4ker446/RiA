import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { existsSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import type { DesktopLogger } from "./logger";
import { DATABASE_FILE_NAME } from "./paths";
import {
  acknowledgeResult, assertUpdateSettled, availableDataCopies, DataLocationError, deleteDataCopy, folderSize, forgetDataCopy,
  inspectDataRoot, loadDataLocationState, readDataLocationState, recordLowSpaceHint, requestCacheMove, requestDataMove,
  resolveCacheRoot, runPendingCacheMove, runPendingDataMove, samePath, startEmptyWorkspace, switchToDataFolder, validateCacheTarget,
  validateMoveTarget, webCacheDirectory, CACHE_ENTRIES, WEB_CACHE_ENTRY,
  type DataLocationErrorCode, type DataLocationState, type MoveProgress, type MoveResult, type UnavailableReason,
} from "./data-location";

/*
 * The desktop side of the data and cache locations: running a requested move
 * at start-up, before anything opens the data, with a window that shows how far
 * it has got and can cancel it; asking what to do when the data cannot be found,
 * instead of starting an empty workspace in its place; and what the settings
 * page reads and asks for.
 *
 * Nothing in the data folder may be open while a move runs, the desktop log
 * included, so what happens before the folder is settled is collected and
 * written to the log once it exists.
 */

type Note = { level: "info" | "warn" | "error"; message: string; details?: unknown };
/** The data volume's free space below which the settings suggest moving the data, once. */
export const LOW_SPACE_BYTES = 5 * 1024 ** 3;

const chinese = () => app.getLocale().toLowerCase().startsWith("zh");
const say = (zh: string, en: string) => chinese() ? zh : en;
function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// --- the progress window ---------------------------------------------------

const PHASES: Record<MoveProgress["phase"] | "cancelling" | "starting", [string, string]> = {
  starting: ["正在准备", "Preparing"],
  database: ["正在复制数据库", "Copying the database"],
  files: ["正在复制文件", "Copying files"],
  verifying: ["正在校验", "Checking the copy"],
  switching: ["正在切换到新位置", "Switching to the new folder"],
  cancelling: ["正在取消…", "Cancelling…"],
};
const phaseText = (phase: keyof typeof PHASES) => PHASES[phase][chinese() ? 0 : 1];

function progressPage(title: string, from: string, to: string) {
  const dark = nativeTheme.shouldUseDarkColors;
  const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  return `<!doctype html><html lang="${chinese() ? "zh-CN" : "en"}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escape(title)}</title><style>
:root{color-scheme:${dark ? "dark" : "light"};--bg:${dark ? "#161616" : "#ffffff"};--fg:${dark ? "#ededed" : "#171717"};--muted:${dark ? "#a1a1a1" : "#666666"};--track:${dark ? "#2e2e2e" : "#ebebeb"};--fill:${dark ? "#ededed" : "#171717"};--line:${dark ? "#2e2e2e" : "#e5e5e5"}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;-webkit-user-select:none;user-select:none}
body{display:flex;flex-direction:column;padding:22px 24px 18px;border:1px solid var(--line);-webkit-app-region:drag}
h1{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.route{margin:6px 0 0;color:var(--muted);font-size:12px;word-break:break-all;line-height:1.45}
.route b{font-weight:500;color:var(--fg)}
.bar{margin-top:18px;height:4px;border-radius:999px;background:var(--track);overflow:hidden}
.fill{height:100%;width:0;border-radius:inherit;background:var(--fill);transition:width .2s ease-out}
.bar.indeterminate .fill{width:30%;animation:slide 1.2s ease-in-out infinite}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
.row{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.hint{margin:auto 0 0;font-size:12px;color:var(--muted)}
.actions{display:flex;justify-content:flex-end;margin-top:12px}
button{-webkit-app-region:no-drag;font:inherit;font-size:12.5px;padding:5px 14px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button:hover{background:var(--track)}button:disabled{opacity:.5;cursor:default}
@media (prefers-reduced-motion:reduce){.fill{transition:none}.bar.indeterminate .fill{animation:none;width:100%;opacity:.4}}
</style></head><body>
<h1>${escape(title)}</h1>
<p class="route">${escape(say("从", "From"))} <b>${escape(from)}</b><br>${escape(say("到", "To"))} <b>${escape(to)}</b></p>
<div class="bar indeterminate" id="bar"><div class="fill" id="fill"></div></div>
<div class="row"><span id="phase">${escape(phaseText("starting"))}</span><span id="amount"></span></div>
<p class="hint">${escape(say("完成前请不要关机或拔出磁盘。取消后数据留在原来的位置。", "Keep the computer on and the drive connected until this finishes. Cancelling leaves the data where it was."))}</p>
<div class="actions"><button id="cancel" type="button">${escape(say("取消", "Cancel"))}</button></div>
<script>
document.getElementById("cancel").addEventListener("click", () => window.close());
window.showProgress = (phase, amount, percent, cancellable) => {
  document.getElementById("phase").textContent = phase;
  document.getElementById("cancel").disabled = !cancellable;
  document.getElementById("amount").textContent = amount;
  const bar = document.getElementById("bar");
  bar.classList.toggle("indeterminate", percent === null);
  if (percent !== null) document.getElementById("fill").style.width = percent + "%";
};
window.showCancelling = (phase) => { document.getElementById("phase").textContent = phase; document.getElementById("cancel").disabled = true; };
</script></body></html>`;
}

/**
 * A small window for a move that copies, shown before the main window exists.
 * Closing it, or its Cancel button, cancels the copy; the switch itself is quick
 * and is not interrupted.
 */
function openProgressWindow(input: { title: string; from: string; to: string; controller: AbortController }) {
  const window = new BrowserWindow({
    width: 460, height: 236, resizable: false, maximizable: false, fullscreenable: false, frame: false,
    show: false, title: input.title, backgroundColor: nativeTheme.shouldUseDarkColors ? "#161616" : "#ffffff", center: true,
    // Its own in-memory session: it shows progress only, and must not open the profile's caches while the data moves.
    webPreferences: { partition: "ria-data-move", sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: false },
  });
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let finished = false, switching = false;
  window.on("close", event => {
    if (finished) return;
    event.preventDefault();
    // Once everything is copied the switch takes a moment and is not interrupted.
    if (!switching && !input.controller.signal.aborted) {
      input.controller.abort();
      void window.webContents.executeJavaScript(`window.showCancelling(${JSON.stringify(phaseText("cancelling"))})`).catch(() => {});
    }
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressPage(input.title, input.from, input.to))}`);
  return {
    update(progress: MoveProgress) {
      if (window.isDestroyed() || input.controller.signal.aborted) return;
      switching ||= progress.phase === "switching";
      const measured = progress.totalBytes > 0 && progress.phase !== "switching";
      const percent = measured ? Math.round(progress.doneBytes / progress.totalBytes * 100) : null;
      const amount = measured ? `${formatBytes(progress.doneBytes)} / ${formatBytes(progress.totalBytes)}` : "";
      void window.webContents.executeJavaScript(`window.showProgress(${JSON.stringify(phaseText(progress.phase))}, ${JSON.stringify(amount)}, ${JSON.stringify(percent)}, ${JSON.stringify(!switching)})`).catch(() => {});
    },
    close() { finished = true; if (!window.isDestroyed()) window.destroy(); },
  };
}

// --- start-up --------------------------------------------------------------

const unavailableText = (expected: string | null, reason: UnavailableReason) => {
  const where = expected ?? say("原来的位置", "its usual place");
  switch (reason) {
    case "not-ria-data": return say(`RiA 的数据应该在 ${where}，但那里现在不是 RiA 的数据。`, `RiA's data should be in ${where}, but that folder no longer holds RiA data.`);
    case "junction-missing": return say(`RiA 的数据在 ${where}，但指向它的链接不见了。`, `RiA's data is in ${where}, but the link to it is gone.`);
    case "uncertain": return expected
      ? say(`上次移动数据没有完成，RiA 无法确定数据现在在哪里（应在 ${where}）。`, `The last data move did not finish, and RiA cannot tell where the data is now (it should be in ${where}).`)
      : say("RiA 找不到它的数据，但看起来数据并没有被删除，只是不在原来的位置。", "RiA cannot find its data, though it does not look deleted, only not where it should be.");
    default: return say(`RiA 的数据在 ${where}，但现在找不到这个文件夹。`, `RiA's data is in ${where}, but that folder cannot be found.`);
  }
};

/** Why a folder chosen in the start-up dialog was refused, as one sentence. */
function refusalText(code: DataLocationErrorCode | string) {
  const texts: Partial<Record<DataLocationErrorCode, [string, string]>> = {
    "not-ria-data": ["这个文件夹里没有 RiA 的数据。", "That folder does not hold RiA data."],
    "not-directory": ["找不到这个文件夹。", "That folder cannot be found."],
    "network-path": ["网络位置不能存放数据，请选择本机磁盘上的文件夹。", "A network location cannot hold the data; choose a folder on a local drive."],
    nested: ["请选择 RiA 数据路径以外的文件夹。", "Choose a folder outside RiA's own data path."],
    "in-use": ["有其他程序正在使用这个文件夹，关闭后再试。", "Another program is using that folder; close it and try again."],
  };
  const text = texts[code as DataLocationErrorCode];
  return text ? say(text[0], text[1]) : say("无法使用这个文件夹。", "That folder cannot be used.");
}

/**
 * Settles the data folder for this start: finishes any requested or interrupted
 * move, then makes sure the fixed path leads to RiA data, asking the person when
 * it does not; then runs a requested cache move. Returns the cache folder for
 * this start and what happened, for the log.
 */
export async function settleDataLocation(input: { dataRoot: string; interactive: boolean; webCacheInUse: string }): Promise<{ notes: Note[]; cacheDirectory: string; cacheUnavailable: string | null }> {
  const notes: Note[] = [];
  let recordLost: string | null = null;
  try {
    recordLost = loadDataLocationState(input.dataRoot).recordLost;
  } catch (error) {
    if (error instanceof DataLocationError && error.code === "state-newer") {
      throw new Error(say(
        `数据位置记录（${String(error.details.file ?? "")}）是较新版本的 RiA 写的，这个版本无法确定数据是否已经移动完成。请安装较新版本的 RiA。`,
        `The data location record (${String(error.details.file ?? "")}) was written by a newer version of RiA, so this version cannot tell whether a data move finished. Install the newer version of RiA.`,
      ));
    }
    throw error;
  }
  if (recordLost) notes.push({ level: "warn", message: "The data location record was damaged and was set aside", details: { kept: recordLost } });

  const runDataMove = async () => {
    const state = readDataLocationState(input.dataRoot);
    const pending = state.pending;
    if (!pending) return;
    const controller = new AbortController();
    const window = pending.phase === "requested" && pending.mode === "copy"
      ? openProgressWindow({ title: say("正在移动 RiA 的数据", "Moving RiA's data"), from: currentDataPath(input.dataRoot, state), to: pending.target, controller })
      : null;
    try {
      const result = await runPendingDataMove(input.dataRoot, { databaseFileName: DATABASE_FILE_NAME, signal: controller.signal, onProgress: progress => window?.update(progress) });
      if (result) notes.push({ level: result.outcome === "moved" ? "info" : "warn", message: "Data folder move finished", details: result });
    } catch (error) {
      if (!(error instanceof DataLocationError) || error.code !== "unrecoverable") throw error;
      notes.push({ level: "error", message: "Data folder move could not be finished or undone", details: error.details });
    } finally { window?.close(); }
  };
  await runDataMove();

  for (;;) {
    const state = readDataLocationState(input.dataRoot);
    const inspection = inspectDataRoot(input.dataRoot, state, { recordLost: Boolean(recordLost) });
    if (inspection.kind !== "unavailable") {
      if (inspection.kind === "junction") notes.push({ level: "info", message: "Data folder is linked", details: { target: inspection.target } });
      break;
    }
    notes.push({ level: "warn", message: "Data folder is not available", details: inspection });
    if (!input.interactive) throw new Error(unavailableText(inspection.expected, inspection.reason));
    const choice = await askWhereTheDataIs(input.dataRoot, state, inspection.expected, inspection.reason);
    try {
      if (choice.kind === "retry") await runDataMove();
      else if (choice.kind === "folder") { switchToDataFolder(input.dataRoot, choice.path, DATABASE_FILE_NAME); recordLost = null; notes.push({ level: "warn", message: "Data folder pointed at a chosen folder", details: { folder: choice.path } }); }
      else { startEmptyWorkspace(input.dataRoot); recordLost = null; notes.push({ level: "warn", message: "Started an empty workspace; the missing data folder stays on the list of copies", details: { expected: inspection.expected } }); }
    } catch (error) {
      await dialog.showMessageBox({ type: "warning", title: "RiA", message: refusalText(error instanceof DataLocationError ? error.code : ""), buttons: [say("好", "OK")], noLink: true });
    }
  }

  const state = readDataLocationState(input.dataRoot);
  const pendingCache = state.pendingCache;
  const controller = new AbortController();
  const window = pendingCache
    ? openProgressWindow({ title: say("正在移动 RiA 的缓存", "Moving RiA's cache"), from: resolveCacheRoot(input.dataRoot, state).path, to: pendingCache.target ?? input.dataRoot, controller })
    : null;
  try {
    // Also removes old cache parts a finished move left behind, if a crash came first.
    const result = await runPendingCacheMove(input.dataRoot, { signal: controller.signal, onProgress: progress => window?.update(progress), webCacheInUse: input.webCacheInUse });
    if (result) notes.push({ level: result.outcome === "moved" ? "info" : "warn", message: "Cache folder move finished", details: result });
  } finally { window?.close(); }
  const cache = resolveCacheRoot(input.dataRoot, readDataLocationState(input.dataRoot));
  if (cache.unavailable) notes.push({ level: "warn", message: "Cache folder is not available; using the data folder for this run", details: { cache: cache.unavailable } });
  return { notes, cacheDirectory: cache.path, cacheUnavailable: cache.unavailable };
}

function currentDataPath(dataRoot: string, state: DataLocationState) {
  const inspection = inspectDataRoot(dataRoot, state);
  return inspection.kind === "directory" || inspection.kind === "junction" ? inspection.realPath : dataRoot;
}

type Choice = { kind: "retry" } | { kind: "folder"; path: string } | { kind: "empty" };
/**
 * The question asked when the data cannot be found. Each way out is offered
 * with what it does; quitting is always one of them, and starting empty is
 * confirmed separately because it is the one that does not bring the data back.
 */
async function askWhereTheDataIs(dataRoot: string, state: DataLocationState, expected: string | null, reason: UnavailableReason): Promise<Choice> {
  const copy = availableDataCopies(dataRoot, state, DATABASE_FILE_NAME).find(entry => !expected || !samePath(entry.path, expected));
  const when = (at: string) => new Date(at).toLocaleString(app.getLocale(), { dateStyle: "medium", timeStyle: "short" });
  const options: Array<{ label: string; detail: string; act: () => Promise<Choice | null> | Choice | null }> = [
    { label: say("重试", "Try again"), detail: say("接上移动硬盘或改回盘符后再试。", "After reconnecting the drive or restoring its letter."), act: () => ({ kind: "retry" }) },
    { label: say("选择数据文件夹…", "Choose the data folder…"), detail: say("数据换了位置（例如盘符变了）时，指到它现在的位置。", "When the data is somewhere else now, for example under another drive letter."), act: async () => {
      const picked = await dialog.showOpenDialog({ title: say("选择 RiA 的数据文件夹", "Choose RiA's data folder"), properties: ["openDirectory", "dontAddToRecent"] });
      return picked.canceled || !picked.filePaths[0] ? null : { kind: "folder", path: picked.filePaths[0] };
    } },
    ...(copy ? [{
      label: copy.source === "interrupted" ? say(`改用 ${copy.path}`, `Use ${copy.path}`) : say(`改用较早的一份数据（${copy.path}）`, `Use an earlier copy (${copy.path})`),
      detail: copy.source === "interrupted"
        ? say("这是移动之前的数据，那次移动没有完成。", "This is the data from before the move, which did not finish.")
        : say(`这份数据保存于 ${when(copy.at)}，不包含之后的改动。`, `This copy is from ${when(copy.at)} and does not include later changes.`),
      act: (): Choice => ({ kind: "folder", path: copy.path }),
    }] : []),
    { label: say("新建空的工作区…", "Start an empty workspace…"), detail: say("不删除任何东西；原来的位置会记在 设置 › 存储 里，找回后可以切换回去。", "Nothing is deleted; the old location stays listed under Settings › Storage so you can switch back."), act: async () => {
      const { response } = await dialog.showMessageBox({
        type: "warning", title: "RiA", message: say("新建一个空的工作区？", "Start an empty workspace?"),
        detail: say(
          `RiA 会在默认位置新建一个空的工作区，看不到原来的对话、知识库和设置。${expected ? `原来的位置（${expected}）` : "原来的数据"}不会被删除，找回后可以在 设置 › 存储 里切换回去。`,
          `RiA will start an empty workspace in its default location, without your conversations, knowledge or settings. ${expected ? `The old location (${expected})` : "The old data"} is not deleted, and you can switch back from Settings › Storage once it turns up.`,
        ),
        buttons: [say("新建空的工作区", "Start empty"), say("返回", "Back")], defaultId: 1, cancelId: 1, noLink: true,
      });
      return response === 0 ? { kind: "empty" } : null;
    } },
    // Quitting here ends the process before anything else starts; the start never continues.
    { label: say("退出", "Quit"), detail: say("什么都不改，下次启动时再问。", "Change nothing and ask again next time."), act: () => { app.exit(0); return null; } },
  ];
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: "warning", title: "RiA", message: say("找不到 RiA 的数据", "RiA's data cannot be found"),
      detail: `${unavailableText(expected, reason)}\n${say("除非你选择这样做，RiA 不会在这里新建空的工作区。", "RiA will not start an empty workspace in its place unless you choose to.")}\n\n${options.map(option => `${option.label}${say("：", ": ")}${option.detail}`).join("\n")}`,
      buttons: options.map(option => option.label), defaultId: 0, cancelId: options.length - 1, noLink: false,
    });
    const choice = await options[response]?.act();
    if (choice) return choice;
  }
}

export function writeNotes(logger: DesktopLogger, notes: Note[]) {
  for (const note of notes) logger[note.level](note.message, note.details);
}

/** The web cache folder Chromium is pointed at for this run, read before the app is ready. */
export function webCacheForThisRun(dataRoot: string) {
  let state: DataLocationState;
  try { state = readDataLocationState(dataRoot); } catch { return join(dataRoot, WEB_CACHE_ENTRY); }
  return webCacheDirectory(dataRoot, state);
}

/** Chromium's own HTTP cache from before the web cache moved; it is rebuilt where it now lives. */
export function removeLegacyWebCache(userDataPath: string, logger: DesktopLogger) {
  const legacy = join(userDataPath, "Cache");
  if (!existsSync(legacy)) return;
  try { rmSync(legacy, { recursive: true, force: true }); logger.info("Removed the old web cache", { folder: legacy }); }
  catch (error) { logger.warn("Could not remove the old web cache", error); }
}

// --- what the settings page reads and asks for -----------------------------

/** Set once a move is recorded, until the restart that runs it; an update may not start in between. */
let moveRequested = false;
export const dataMoveRequested = () => moveRequested;

export type DataLocationView = {
  defaultPath: string;
  data: { path: string; moved: boolean };
  cache: { path: string; custom: boolean; unavailable: string | null };
  copies: Array<{ path: string; at: string; exists: boolean }>;
  pending: boolean;
  result: MoveResult | null;
  lowSpace: { freeBytes: number } | null;
};
export type DataLocationSizes = { dataBytes: number | null; cacheBytes: number | null; freeBytes: number | null; copies: Record<string, number | null> };

async function freeSpace(path: string) {
  try { const stats = await statfs(parse(resolve(path)).root); return Number(stats.bavail) * Number(stats.bsize); } catch { return null; }
}

export async function dataLocationView(dataRoot: string, cacheInUse: { path: string; unavailable: string | null }): Promise<DataLocationView> {
  const state = readDataLocationState(dataRoot);
  const data = currentDataPath(dataRoot, state);
  const free = await freeSpace(data);
  return {
    defaultPath: dataRoot,
    data: { path: data, moved: !samePath(data, dataRoot) },
    cache: { path: cacheInUse.path, custom: Boolean(state.cache) && !cacheInUse.unavailable, unavailable: cacheInUse.unavailable },
    copies: [...state.previousCopies].reverse().map(copy => ({ ...copy, exists: existsSync(copy.path) })),
    pending: Boolean(state.pending || state.pendingCache),
    result: state.lastResult,
    lowSpace: free !== null && free < LOW_SPACE_BYTES && !state.lowSpaceHintAt ? { freeBytes: free } : null,
  };
}

export async function dataLocationSizes(dataRoot: string, cachePath: string): Promise<DataLocationSizes> {
  const state = readDataLocationState(dataRoot);
  const data = currentDataPath(dataRoot, state);
  const copies: Record<string, number | null> = {};
  for (const copy of state.previousCopies) copies[copy.path] = existsSync(copy.path) ? await folderSize(copy.path) : null;
  let cacheBytes = 0;
  for (const entry of [...CACHE_ENTRIES, WEB_CACHE_ENTRY]) cacheBytes += (await folderSize(join(cachePath, entry))) ?? 0;
  return { dataBytes: await folderSize(data), cacheBytes, freeBytes: await freeSpace(data), copies };
}

export type LocationKind = "data" | "cache";
type Refusal = { ok: false; code: DataLocationErrorCode | "unknown"; details?: Record<string, unknown> };
export type CheckOutcome =
  | { ok: true; kind: LocationKind; target: string | null; mode: "copy" | "adopt"; copyBytes: number; requiredBytes: number; availableBytes: number | null }
  | Refusal;

function refusal(error: unknown): Refusal {
  if (error instanceof DataLocationError) return { ok: false, code: error.code, details: error.details };
  return { ok: false, code: "unknown" };
}

export async function checkLocation(dataRoot: string, kind: LocationKind, target: string | null, updatePhase: string | null): Promise<CheckOutcome> {
  try {
    assertUpdateSettled(updatePhase);
    if (kind === "data") {
      if (target === null) throw new DataLocationError("not-absolute", "Choose a folder");
      const checked = await validateMoveTarget({ dataRoot, target, databaseFileName: DATABASE_FILE_NAME });
      return { ok: true, kind, target: checked.target, mode: checked.mode, copyBytes: checked.mode === "adopt" ? 0 : checked.dataBytes, requiredBytes: checked.requiredBytes, availableBytes: checked.availableBytes };
    }
    const checked = await validateCacheTarget({ dataRoot, target });
    return { ok: true, kind, target: checked.target, mode: "copy", copyBytes: checked.cacheBytes, requiredBytes: checked.requiredBytes, availableBytes: checked.availableBytes };
  } catch (error) { return refusal(error); }
}

/**
 * Records a move for the next start and restarts into it. Refused while an
 * update is downloading, downloaded or installing: the installer restarts the
 * application itself, and the two must not race for the start-up.
 */
export async function moveLocation(input: { dataRoot: string; kind: LocationKind; target: string | null; updatePhase: string | null; restart: () => void }): Promise<{ ok: true } | Refusal> {
  try {
    assertUpdateSettled(input.updatePhase);
    if (input.kind === "data") {
      if (input.target === null) throw new DataLocationError("not-absolute", "Choose a folder");
      await requestDataMove({ dataRoot: input.dataRoot, target: input.target, databaseFileName: DATABASE_FILE_NAME });
    } else {
      await requestCacheMove({ dataRoot: input.dataRoot, target: input.target });
    }
    moveRequested = true;
    // The reply reaches the page before the window goes.
    setTimeout(input.restart, 300);
    return { ok: true };
  } catch (error) { return refusal(error); }
}

export async function deleteCopy(dataRoot: string, path: string): Promise<{ ok: true } | Refusal> {
  try { await deleteDataCopy(dataRoot, path); return { ok: true }; } catch (error) { return refusal(error); }
}
export function forgetCopy(dataRoot: string, path: string): { ok: true } | Refusal {
  try { forgetDataCopy(dataRoot, path); return { ok: true }; } catch (error) { return refusal(error); }
}
export function acknowledge(dataRoot: string, id: string) { acknowledgeResult(dataRoot, id); }
export function dismissLowSpace(dataRoot: string) { recordLowSpaceHint(dataRoot, new Date()); }

/** Opens a folder the settings page lists, and only those. */
export async function openListedFolder(dataRoot: string, cachePath: string, path: string) {
  const state = readDataLocationState(dataRoot);
  const listed = [currentDataPath(dataRoot, state), cachePath, ...state.previousCopies.map(copy => copy.path)];
  if (!listed.some(entry => samePath(entry, path)) || !existsSync(path)) return { opened: false };
  return { opened: (await shell.openPath(path)) === "" };
}

export async function chooseLocationFolder(parent: BrowserWindow, kind: LocationKind) {
  const result = await dialog.showOpenDialog(parent, {
    title: kind === "data" ? say("选择新的数据位置", "Choose a new data location") : say("选择缓存位置", "Choose a cache location"),
    buttonLabel: say("选择这个文件夹", "Choose this folder"),
    properties: ["openDirectory", "createDirectory", "promptToCreate", "dontAddToRecent"],
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}
