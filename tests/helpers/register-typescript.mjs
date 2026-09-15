import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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
      if (process.env.PRIVATE_AI_TEST_RESOLVE_DEBUG === "1") {
        process.stderr.write(`unresolved alias ${specifier} from ${context.parentURL ?? "unknown"}\n`);
      }
    }
    // The Electron half is compiled by tsc with Node16 resolution, so its
    // sources import each other without a file extension. Node's ESM resolver
    // needs the extension, exactly like a compiled CommonJS build would.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : root;
      const base = resolve(parent, specifier);
      if (!extname(base) || extname(base) === ".js") {
        const file = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((candidate) => existsSync(candidate));
        if (file) return nextResolve(pathToFileURL(file).href, context);
      }
    }
    if (specifier === "next/server" || specifier === "next/headers") {
      // require.resolve() would restart this hook chain on newer Node.js releases.
      return nextResolve(`${specifier}.js`, context);
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
