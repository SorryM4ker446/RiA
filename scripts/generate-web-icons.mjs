/**
 * Derive the web favicons from the desktop app icon.
 *
 * assets/desktop-icon.png is the single source of the brand mark. Electron picks
 * it up directly (BrowserWindow icon + forge installer), but the web build needs
 * its own copies, so they are generated here rather than checked in twice.
 *
 * The mark is monochrome, so an indexed palette keeps the pixels identical while
 * cutting the file from ~130 KB to a few tens of KB.
 *
 * Run: node scripts/generate-web-icons.mjs
 */

import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SRC = "assets/desktop-icon.png";
(async () => {
  // Monochrome mark -> indexed palette. Same pixels, a fraction of the bytes.
  const q = { compressionLevel: 9, palette: true, quality: 92, effort: 10 };
  await sharp(SRC).resize(512, 512, { fit: "cover" }).png(q).toFile("src/app/icon.png");
  await sharp(SRC).resize(180, 180, { fit: "cover" }).png(q).toFile("src/app/apple-icon.png");
  await sharp(SRC).resize(32, 32, { fit: "cover" }).png(q).toFile("public/favicon-32.png");
  fs.writeFileSync("public/favicon.ico", await sharp(SRC).resize(32,32,{fit:"cover"}).png(q).toBuffer());
  for (const f of ["src/app/icon.png","src/app/apple-icon.png","public/favicon-32.png","public/favicon.ico"]) {
    console.log(f, fs.statSync(f).size, "bytes");
  }
})();
