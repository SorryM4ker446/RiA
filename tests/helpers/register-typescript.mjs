import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Test-only loader: use the already-installed TypeScript compiler, without another runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/ai/client" && process.env.PRIVATE_AI_TEST_PROVIDER === "1") {
      return nextResolve(pathToFileURL(join(root, "tests/helpers/model-provider.mjs")).href, context);
    }
    if (specifier.startsWith("@/")) {
      const base = join(root, "src", specifier.slice(2));
      const file = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
        .find((candidate) => extname(candidate) && existsSync(candidate));
      if (file) return nextResolve(pathToFileURL(file).href, context);
    }
    if (specifier === "next/server" || specifier === "next/headers") {
      return nextResolve(pathToFileURL(require.resolve(specifier)).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.tsx?$/.test(new URL(url).pathname) && !url.includes("/node_modules/")) {
      const file = fileURLToPath(url);
      const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
