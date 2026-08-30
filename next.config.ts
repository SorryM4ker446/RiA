import type { NextConfig } from "next";
import { MEDIA_LIMITS } from "./src/lib/media/limits";
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
  reactStrictMode: true,
  serverExternalPackages: ["pdfjs-dist", "mammoth", "jszip"],
  outputFileTracingIncludes: {
    "/api/documents": documentRuntimeFiles(),
  },
  // Leave room for handlers to detect overflow before Proxy truncates a network chunk.
  experimental: { proxyClientMaxBodySize: MEDIA_LIMITS.uploadBodyBytes + 1024 * 1024 },
};

export default nextConfig;
