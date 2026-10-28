import { fileURLToPath } from "node:url";

/*
 * Per-machine, elevated installation. A per-user (unelevated) installation on
 * a drive other than the system drive cannot be uninstalled cleanly: Windows
 * Installer backs every removed file up to that drive's protected Config.Msi
 * and then fails to secure each backup as the user (error 1926, system error
 * 5), showing one dialog per file. Disabling rollback does not avoid it.
 */
export const perUserInstallationMessage =
  "此电脑上已有仅为当前用户安装的 RiA。请先卸载该版本，再安装此版本。数据保存在 %APPDATA%\\RiA，卸载不会删除它们。";

export const windowsInstallerConfig = {
  name: "RiA",
  manufacturer: "RiA",
  arch: "x64",
  icon: fileURLToPath(new URL("../assets/desktop-icon.ico", import.meta.url)),
  // Keep this identity stable across versions so MSI recognizes upgrades.
  upgradeCode: "918C97A2-902B-42D0-9B52-F979309DAC68",
  appUserModelId: "com.ria.RiA",
  shortcutFolderName: "RiA",
  shortcutName: "RiA",
  programFilesFolderName: "RiA",
  defaultInstallMode: "perMachine",
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
    /*
     * Windows Installer cannot upgrade across installation contexts, so a
     * per-user copy would remain beside this one. Both contexts record the
     * installing account's shortcuts under HKCU\Software\Microsoft\RiA (ICE38
     * requires it), so that value without a per-machine product to upgrade
     * means a per-user copy. Repairs and per-machine upgrades are unaffected.
     */
    creator.wixTemplate = creator.wixTemplate.replace(loggingAnchor, [
      loggingAnchor,
      '    <Property Id="MsiLogging" Value="voicewarmup" />',
      '    <Property Id="PERUSERRIA">',
      '      <RegistrySearch Id="PerUserRiaMarker" Root="HKCU" Key="Software\\Microsoft\\RiA" Name="installed" Type="raw" />',
      "    </Property>",
      `    <Condition Message="${perUserInstallationMessage}"><![CDATA[Installed OR WIX_UPGRADE_DETECTED OR NOT PERUSERRIA]]></Condition>`,
    ].join("\n"));
  },
};
