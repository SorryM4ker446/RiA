import type { NextConfig } from "next";
import { MEDIA_LIMITS } from "./src/lib/media/limits-constants";
import { LEGACY_SETTINGS_PATHS, settingsHref } from "./src/lib/settings/sections";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

// Parser workers load native Node modules after deployment, outside the route bundle.
function documentRuntimeFiles() {
  const visited = new Set<string>();
  const files: string[] = [];
  function include(name: string, parent: string) {
    const manifestPath = createRequire(parent).resolve(`${name}/package.json`);
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const directory = relative(process.cwd(), dirname(manifestPath)).replaceAll("\\", "/");
    if (directory.startsWith("../")) throw new Error("Document parser dependencies must be installed inside this project");
    files.push(...(name === "pdfjs-dist" ? ["package.json", "legacy/build/*.mjs", "cmaps/**/*", "standard_fonts/**/*"] : ["**/*"]).map(pattern => `${directory}/${pattern}`));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) include(dependency, manifestPath);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { createRequire(manifestPath).resolve(`${dependency}/package.json`); }
      catch { continue; }
      include(dependency, manifestPath);
    }
  }
  for (const name of ["pdfjs-dist", "mammoth", "jszip"]) include(name, `${process.cwd()}/package.json`);
  return files;
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // These pages are now sections of the settings overlay, which opens over a
  // page as `?settings=<section>`. A direct visit to an old address (a
  // bookmark, a notice stored before the change) lands on chat with that
  // section open; its own query is carried along. Links followed inside the app
  // open the section in place and never reach this.
  async redirects() {
    return Object.entries(LEGACY_SETTINGS_PATHS).map(([source, section]) => ({ source, destination: settingsHref(section), permanent: false }));
  },
  reactStrictMode: true,
  // The printed development entry accepts every loopback spelling, and the dev
  // asset fence otherwise blocks resources for any host it did not initialize.
  allowedDevOrigins: ["127.0.0.1", "[::1]"],
  serverExternalPackages: ["pdfjs-dist", "mammoth", "jszip"],
  outputFileTracingIncludes: {
    "/api/documents": documentRuntimeFiles(),
  },
  // The local-file tools touch filesystem paths the user chooses at run time,
  // which the tracer cannot resolve and answers by globbing the entire
  // repository into the standalone output — every document, log, plan and build
  // artifact in the working tree, across all 696 entries. Because the tool
  // catalog is shared, that reached every route that builds a tool set, not
  // just the new ones.
  //
  // Nothing below can ever belong in a server bundle: they are development
  // instructions, tests, sources that are compiled into chunks, and artifacts of
  // other builds. `node_modules`, `package.json`, `public`, `src` and `.next`
  // are deliberately absent from this list because those *are* runtime inputs.
  // This bounds the trace rather than hiding a file the application needs, and
  // `verify-desktop-package` still fails the build if a required one is absent.
  outputFileTracingExcludes: {
    "*": [
      "AGENTS.md",
      "README.md",
      "assets/**",
      "components.json",
      "dev*.log",
      "docs/**",
      "electron/**",
      "electron-dist/**",
      "eslint.config.mjs",
      "forge.config.ts",
      "next.config.ts",
      "out/**",
      "package-lock.json",
      "playwright.config.ts",
      "playwright-report/**",
      "postcss.config.mjs",
      "scripts/**",
      "tailwind.config.ts",
      "tests/**",
      "test-results/**",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
      "**/*.tsbuildinfo",
    ],
  },
  // Leave room for handlers to detect overflow before Proxy truncates a network chunk.
  experimental: {
    proxyClientMaxBodySize: MEDIA_LIMITS.uploadBodyBytes + 1024 * 1024,
    // The desktop service runs from a per-machine installation directory that
    // standard users cannot write and that uninstall must leave empty. Keep the
    // response cache in memory; prerendered pages are still read from the build.
    isrFlushToDisk: false,
  },
};

export default nextConfig;
