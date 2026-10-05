import type { BrowserWindowConstructorOptions } from "electron";
import { release } from "node:os";

/** Keep the sidebar opaque in CSS while the main canvas exposes the desktop. */
export function windowAppearance(
  platform: string,
  osRelease = release(),
): BrowserWindowConstructorOptions {
  if (platform === "win32") {
    const build = Number(osRelease.split(".")[2]);
    return {
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      ...(build >= 22621 ? { backgroundMaterial: "acrylic" as const } : {}),
    };
  }
  return {
    backgroundColor: "#fafafa",
  };
}
