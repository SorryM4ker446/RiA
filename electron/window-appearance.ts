import type { BrowserWindowConstructorOptions } from "electron";
import { release } from "node:os";

/** CSS clips rounded corners and supplies readable translucent workspace surfaces. */
export function windowAppearance(
  platform: string,
  osRelease = release(),
): BrowserWindowConstructorOptions {
  if (platform === "win32") {
    const build = Number(osRelease.split(".")[2]);
    return {
      frame: false,
      roundedCorners: true,
      transparent: true,
      backgroundColor: "#00000000",
      ...(build >= 22621 ? { backgroundMaterial: "acrylic" as const } : {}),
    };
  }
  return {
    backgroundColor: "#fafafa",
  };
}
