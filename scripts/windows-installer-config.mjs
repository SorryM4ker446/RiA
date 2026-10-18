import { fileURLToPath } from "node:url";

export const windowsInstallerConfig = {
  name: "RiA",
  manufacturer: "RiA",
  arch: "x64",
  icon: fileURLToPath(new URL("../assets/desktop-icon.ico", import.meta.url)),
  // Keep this identity stable across versions so MSI recognizes upgrades.
  upgradeCode: "918C97A2-902B-42D0-9B52-F979309DAC68",
  appUserModelId: "com.squirrel.RiA.RiA",
  shortcutFolderName: "RiA",
  shortcutName: "RiA",
  programFilesFolderName: "RiA",
  defaultInstallMode: "perUser",
  language: 2052,
  cultures: "zh-CN",
  features: { autoUpdate: false, autoLaunch: false },
  ui: { chooseDirectory: true },
  beforeCreate(creator) {
    // Uninstall only MSI-owned files; a chosen folder may contain personal files.
    const purge = '<util:RemoveFolderEx On="uninstall" Property="INSTALLPATH" />';
    if (!creator.wixTemplate.includes(purge)) {
      throw new Error("Review the changed MSI uninstall template before packaging");
    }
    creator.wixTemplate = creator.wixTemplate.replace(purge, "");
    // Keep rollback enabled and record failures even when launched by double-click.
    const loggingAnchor = '<Property Id="REINSTALLMODE" Value="emus" />';
    if (!creator.wixTemplate.includes(loggingAnchor) || creator.wixTemplate.includes('Id="MsiLogging"')) {
      throw new Error("Review the changed MSI logging template before packaging");
    }
    creator.wixTemplate = creator.wixTemplate.replace(loggingAnchor, `${loggingAnchor}\n    <Property Id="MsiLogging" Value="voicewarmup" />`);
  },
};
