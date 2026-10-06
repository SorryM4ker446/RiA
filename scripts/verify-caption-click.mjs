import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printDesktopSmokeDiagnostics } from "./smoke-desktop-diagnostics.mjs";

/**
 * Verify that the drawn window controls answer a real click.
 *
 * The DOM cannot answer this. `elementFromPoint` and `element.click()` both
 * bypass Chromium's input pipeline, and that pipeline is what honours
 * -webkit-app-region. A set of buttons can be correctly sized, correctly
 * placed, clear of the scrollbar and still swallow every click into a window
 * drag — which is exactly how the caption shipped broken while the smoke test
 * passed, because the smoke test called the bridge directly instead of
 * clicking anything.
 *
 * So this launches the real application, finds the controls, and dispatches a
 * genuine trusted mouse press at the centre of one. The window has to change.
 */

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = require("electron");
const debugPort = 9400 + (process.pid % 400);
const CONTROL_SELECTORS = [
  'button[aria-label="最小化"]',
  'button[aria-label="最大化"], button[aria-label="向下还原"]',
  'button[aria-label="关闭"]',
];
const testParent = join(repositoryRoot, ".desktop-data", "test");
mkdirSync(testParent, { recursive: true });
const testRoot = mkdtempSync(join(testParent, "caption-click-"));

// The app is single-instance, so a window that is already open makes this one
// exit immediately and the debugging port never appears. Say so plainly rather
// than letting it look like a rendering timeout.
if (process.platform === "win32") {
  let running = false;
  try {
    const list = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq electron.exe", "/NH"], {
      encoding: "utf8", windowsHide: true, timeout: 20_000,
    });
    running = /electron\.exe/i.test(list);
  } catch {}
  if (running) {
    console.error("  close any open RiA window first: the app is single-instance,");
    console.error("  so this check cannot attach to a window that is already up.");
    process.exit(1);
  }
}

const child = spawn(
  electronExecutable,
  [join(repositoryRoot, "electron-dist", "main.js"), `--remote-debugging-port=${debugPort}`],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      APP_RUNTIME: "desktop",
      DESKTOP_FORCE_PACKAGED: "1",
      DESKTOP_PROJECT_ROOT: repositoryRoot,
      DESKTOP_RUNTIME_DIR: join(repositoryRoot, ".desktop-runtime"),
      DESKTOP_USER_DATA_DIR: testRoot,
      DESKTOP_DATA_DIR: join(testRoot, "data"),
      DESKTOP_NODE_EXECUTABLE: process.execPath,
    },
    stdio: "ignore",
    windowsHide: true,
  },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error("the renderer never appeared on the debugging port");
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  const ready = new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen);
    socket.addEventListener("error", () => rejectOpen(new Error("the CDP socket failed")));
  });
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((resolveCall, rejectCall) => {
        const callId = ++id;
        pending.set(callId, { resolve: resolveCall, reject: rejectCall });
        socket.send(JSON.stringify({ id: callId, method, params }));
      }),
    close: () => socket.close(),
  };
}

let failed = false;
let cdp;
try {
  const page = await findPage();
  cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;

  // Wait for the caption to mount on whichever header this width selects.
  async function readCaption() {
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const selectors = ${JSON.stringify(CONTROL_SELECTORS)};
          const nodes = selectors
            .map(selector => [...document.querySelectorAll(selector)]
              .find(node => node.getClientRects().length > 0));
          if (nodes.some(node => !node)) return null;
          return {
            maximized: (await window.privateAiDesktop.windowControls.state()).maximized,
            windowWidth: window.innerWidth,
            screenWidth: window.screen.availWidth,
            contentRight: document.documentElement.clientWidth,
            // The app-region is not inherited, so a control that only inherits
            // no-drag from a wrapper is still inside the drag region.
            regions: nodes.map(node => getComputedStyle(node).webkitAppRegion || "-"),
            boxes: nodes.map(node => {
              const box = node.getBoundingClientRect();
              return {
                label: node.getAttribute("aria-label"),
                x: Math.round(box.left + box.width / 2),
                y: Math.round(box.top + box.height / 2),
                width: Math.round(box.width),
                height: Math.round(box.height),
                barHeight: node.closest(".workspace-topbar")?.clientHeight ?? 0,
                right: Math.round(box.right),
              };
            })
          };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (probe.result.value) return probe.result.value;
      await sleep(1000);
    }
    throw new Error("the window controls never mounted");
  }

  // Exercise both verbs with trusted input, regardless of the starting state.
  for (let transition = 0; transition < 2; transition++) {
    const caption = await readCaption();

    if (caption.regions.some((region) => region !== "no-drag")) {
      throw new Error(`a window control sits inside a drag region: ${JSON.stringify(caption.regions)}`);
    }
    if (caption.boxes.some((box) => box.height < 32 || box.height !== box.barHeight || box.width < 24)) {
      throw new Error(`a window control is not a full-size target: ${JSON.stringify(caption.boxes)}`);
    }
    // The layout viewport excludes the document scrollbar, so a control ending at
    // contentRight is flush against the window and clear of the scrollbar.
    const gap = caption.contentRight - caption.boxes[2].right;
    if (gap !== 0) {
      throw new Error(`the close control is ${gap}px from the window edge instead of flush`);
    }

    const maximise = caption.boxes[1];
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: maximise.x,
        y: maximise.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    // Require both the native transition and its rendered label before the next click.
    let state;
    const deadline = Date.now() + 1500;
    do {
      state = await readCaption();
      const expectedLabel = state.maximized ? "向下还原" : "最大化";
      if (state.maximized !== caption.maximized && state.boxes[1].label === expectedLabel) break;
      await sleep(50);
    } while (Date.now() < deadline);
    if (state.maximized === caption.maximized || state.boxes[1].label !== (state.maximized ? "向下还原" : "最大化")) {
      throw new Error(`a real click did not update the native window and caption: ${JSON.stringify(state)}`);
    }

    console.log("  window controls answer a real click");
    console.log(`  ${caption.boxes.map((b) => b.label).join(" / ")} — flush to the window edge, 0px from the scrollbar`);
    console.log(`  real click on ${maximise.label} took the window ${caption.windowWidth}px -> ${state.windowWidth}px`);
  }
} catch (error) {
  failed = true;
  console.error("  window control check failed:", error instanceof Error ? error.message : String(error));
} finally {
  cdp?.close();
  child.kill();
  await sleep(500);
  if (failed) {
    console.error(`Caption-click diagnostics: ${testRoot}`);
    printDesktopSmokeDiagnostics(testRoot);
  }
}

process.exitCode = failed ? 1 : 0;
