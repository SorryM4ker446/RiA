import { dropRuntimeImageCache } from "./scripts/desktop-package-hooks.mjs";
import { windowsInstallerConfig } from "./scripts/windows-installer-config.mjs";

import type { ForgeConfig } from "@electron-forge/shared-types";

const allowedAppFiles = ["/package.json", "/electron-dist", "/assets"];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: false,
    icon: "assets/desktop-icon.ico",
    // The tray icon is loaded from `resources/assets` at run time, so it has to
    // be a loose file there rather than a copy sealed inside app.asar. Without
    // this the tray is built from a path that does not exist in an installation,
    // which leaves the process resident with an empty notification-area slot.
    extraResource: [".desktop-runtime", "assets"],
    afterCopyExtraResources: [dropRuntimeImageCache],
    ignore: (path) => {
      const normalized = path.replaceAll("\\", "/");
      if (!normalized) return false;
      return !allowedAppFiles.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`));
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-wix",
      platforms: ["win32"],
      config: windowsInstallerConfig,
    },
  ],
};

export default config;
