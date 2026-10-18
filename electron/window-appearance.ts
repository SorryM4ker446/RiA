import type { BrowserWindowConstructorOptions } from "electron";

/** CSS clips rounded corners and supplies readable translucent workspace surfaces. */
export function windowAppearance(platform: string): BrowserWindowConstructorOptions {
  if (platform === "win32") {
    return {
      frame: false,
      roundedCorners: true,
      transparent: true,
      backgroundColor: "#00000000",
      backgroundMaterial: "none",
    };
  }
  return {
    backgroundColor: "#fafafa",
  };
}
