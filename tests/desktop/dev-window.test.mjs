import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveInstalledElectron } from "../../scripts/resolve-installed-electron.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("desktop development launcher allows the application window to become visible", {
  skip: process.platform !== "win32" && "Windows process startup visibility regression",
  timeout: 30_000,
}, () => {
  const electronExecutable = resolveInstalledElectron();
  const root = mkdtempSync(join(tmpdir(), "private-ai-dev-window-"));
  try {
    for (const directory of ["scripts", "electron-dist", "node_modules/electron", "user-data"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    copyFileSync(join(repositoryRoot, "scripts", "run-desktop-dev.mjs"), join(root, "scripts", "run-desktop-dev.mjs"));
    writeFileSync(join(root, "node_modules", "electron", "index.js"), `module.exports = ${JSON.stringify(electronExecutable)};`);
    writeFileSync(join(root, "electron-dist", "main.js"), `
      const { app, BrowserWindow } = require("electron");
      const { writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const root = join(__dirname, "..");
      app.setPath("userData", join(root, "user-data"));
      function finish(result) {
        writeFileSync(join(root, "window-result.json"), JSON.stringify(result));
        app.exit(result.visible ? 0 : 1);
      }
      setTimeout(() => finish({ visible: false, error: "Window startup timed out" }), 10_000);
      app.whenReady().then(() => {
        const window = new BrowserWindow({
          show: false, width: 320, height: 160,
          title: "Desktop startup regression check",
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        window.once("ready-to-show", () => {
          window.show();
          setTimeout(() => finish({ visible: window.isVisible() }), 250);
        });
        return window.loadURL("data:text/html,<title>Desktop startup regression check</title><p>Checking window visibility</p>");
      }).catch(() => finish({ visible: false, error: "Window initialization failed" }));
    `);
    const environment = { ...process.env, OPENROUTER_API_KEY: "", TAVILY_API_KEY: "" };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(process.execPath, [join(root, "scripts", "run-desktop-dev.mjs")], {
      cwd: root, env: environment, encoding: "utf8", windowsHide: true, timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.ok(existsSync(join(root, "window-result.json")), "Electron must report window visibility");
    const windowResult = JSON.parse(readFileSync(join(root, "window-result.json"), "utf8"));
    assert.equal(windowResult.visible, true, windowResult.error || "The desktop window remained hidden after show()");
    assert.equal(result.status, 0);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
