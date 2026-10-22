import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { resolveInstalledElectron } from "../../scripts/resolve-installed-electron.mjs";

test("a real desktop window presents its first frame once and preload reloads cannot replay startup", { skip: process.platform !== "win32", timeout: 25_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "ria-startup-window-"));
  const resultFile = join(root, "result.json"), script = join(root, "check.cjs");
  const moduleFile = resolve("electron-dist/startup-presentation.js"), preload = resolve("electron-dist/preload.js");
  try {
    writeFileSync(script, `
      const {app,BrowserWindow,ipcMain}=require('electron');
      const {writeFileSync}=require('node:fs');
      const {once}=require('node:events');
      const {createStartupPresentation}=require(${JSON.stringify(moduleFile)});
      app.setPath('userData', ${JSON.stringify(join(root, "profile"))});
      const finish=(value)=>{writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(value));app.exit(value.ok?0:1);};
      setTimeout(()=>finish({ok:false,error:'Startup window did not settle'}),15000).unref();
      app.whenReady().then(async()=>{
        const window=new BrowserWindow({show:false,width:480,height:320,frame:false,webPreferences:{preload:${JSON.stringify(preload)},nodeIntegration:false,contextIsolation:true,sandbox:true}});
        const presentation=createStartupPresentation(window,{enabled:true,show:true,onError:error=>{throw error;}});
        ipcMain.handle('desktop:startup:claim',()=>presentation.claim());
        ipcMain.handle('desktop:startup:present',(_event,token)=>presentation.present(token));
        await window.loadURL('data:text/html,<meta charset=utf-8><title>RiA startup check</title><body style="background:%231a1b1e;color:white">RiA</body>');
        const hiddenBefore= !window.isVisible();
        const shown=once(window,'show');
        const tokens=await window.webContents.executeJavaScript('Promise.all([window.riaDesktop.startup.claim(),window.riaDesktop.startup.claim()])');
        if(!tokens[0]||tokens[0]!==tokens[1]) throw Error('Preload did not share one document claim');
        const presented=await window.webContents.executeJavaScript('window.riaDesktop.startup.present('+JSON.stringify(tokens[0])+')');
        await shown;
        const visible=window.isVisible();
        const loaded=once(window.webContents,'did-finish-load');window.reload();await loaded;
        const replay=await window.webContents.executeJavaScript('window.riaDesktop.startup.claim()');
        if(!hiddenBefore||!presented||!visible||replay!==null) throw Error('Startup visibility or replay contract failed: '+JSON.stringify({hiddenBefore,presented,visible,replay}));
        window.destroy();finish({ok:true,hiddenBefore,presented,visible,replay});
      }).catch(error=>finish({ok:false,error:error.message}));
    `);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    // This checks real visibility; STARTF_USESHOWWINDOW/SW_HIDE would override
    // the application's first ShowWindow call on Windows.
    const result = spawnSync(resolveInstalledElectron(), [script], { env, windowsHide: false, encoding: "utf8", timeout: 20_000 });
    assert.ifError(result.error);
    const report = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(report.ok, true, report.error);
    assert.equal(result.status, 0);
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("ria-startup-window-")) throw new Error("Unexpected startup test directory");
    rmSync(root, { recursive: true, force: true });
  }
});
