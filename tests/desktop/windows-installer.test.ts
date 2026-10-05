import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { MSICreator } from "electron-wix-msi";
import { tmpdir } from "node:os";
import { windowsInstallerConfig } from "../../scripts/windows-installer-config.mjs";

test("Windows installer exposes directory selection and preserves files outside its manifest", { skip: process.platform !== "win32" }, async () => {
  const parent = resolve(".desktop-data/test");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "installer-"));
  let supportBinaries: string[] = [];
  try {
    const app = join(root, "app");
    const output = join(root, "output");
    mkdirSync(app); mkdirSync(output);
    copyFileSync(resolve("node_modules/electron-wix-msi/vendor/StubExecutable.exe"), join(app, "RiA.exe"));
    const creator = new MSICreator({
      ...windowsInstallerConfig,
      appDirectory: app,
      outputDirectory: output,
      exe: "RiA",
      description: "RiA installer fixture",
      version: "1.2.3",
    });
    windowsInstallerConfig.beforeCreate!(creator);
    const created = await creator.create();
    supportBinaries = created.supportBinaries;
    const { wxsFile } = created;
    const xml = readFileSync(wxsFile, "utf8");
    assert.match(xml, /ConfigurableDirectory="APPLICATIONROOTDIRECTORY"/);
    assert.match(xml, /UpgradeCode="918C97A2-902B-42D0-9B52-F979309DAC68"/);
    assert.match(xml, /InstallScope="perUser"/);
    assert.match(xml, /com\.squirrel\.RiA\.RiA/);
    assert.doesNotMatch(xml, /<util:RemoveFolderEx/);
    assert.doesNotMatch(xml, /Feature Id="AutoUpdate|Feature Id="AutoLaunch/);
    assert.throws(() => windowsInstallerConfig.beforeCreate!({ wixTemplate: "changed upstream template" } as MSICreator), /Review/);
  } finally {
    for (const binary of supportBinaries) {
      const folder = dirname(binary);
      assert.equal(dirname(folder), resolve(process.env.TEMP || tmpdir()));
      assert.match(folder.split(/[\\/]/).pop()!, /^RiA/);
      rmSync(folder, { recursive: true, force: true });
    }
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  }
});
