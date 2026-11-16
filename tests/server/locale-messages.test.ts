import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * What the service tells a person comes from the locale files, so it follows the
 * interface language. These checks keep a hard-coded sentence from coming back
 * in the places errors are made.
 *
 * Left in English on purpose, and listed here: messages only the model reads
 * (tool budgets, search and history tools, a knowledge entry to propose again),
 * and checks of the service's own environment that a person never meets.
 */
const ROOTS = ["src/lib", "src/app/api", "src/tools", "src/proxy.ts"];
const MODEL_OR_ENVIRONMENT = new Set([
  "src/tools/execution.ts", "src/tools/definitions/provider-search.ts", "src/tools/definitions/web-search.ts", "src/tools/builtins.ts",
  "src/lib/chat/history-lookup.ts", "src/tools/definitions/create-task.ts", "src/lib/knowledge/entries.ts", "src/lib/knowledge/entry-approval.ts",
  "src/tools/registry.ts", "src/lib/server/request-security.ts", "src/lib/local/data-directory.ts", "src/lib/models/providers/deepseek-chat.ts", "src/lib/media/storage.ts",
]);

function files(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) return path.startsWith("src/lib/locale") ? [] : files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const sources = ROOTS.flatMap(files).map(path => ({ path, lines: readFileSync(path, "utf8").split("\n") }));
const cjkLiteral = /(["'`])[^"'`\n]*[一-鿿][^"'`\n]*\1/;
const errorSite = /message:|new ApiError\(|refuse\(|createApiErrorResponse\(|new Error\(|addIssue\(/;

test("no error the service makes carries a hard-coded Chinese sentence", () => {
  const found = sources.flatMap(({ path, lines }) => lines.flatMap((line, index) => {
    const code = line.trimStart().startsWith("*") || line.trimStart().startsWith("//") ? "" : line;
    return errorSite.test(code) && cjkLiteral.test(code) ? [`${path}:${index + 1}`] : [];
  }));
  assert.deepEqual(found, [], "move these to src/lib/locale (parts/server.ts and en-US.ts) and use t()");
});

test("an error message is a locale key, except where only the model or the service's environment reads it", () => {
  const literal = /message:\s*(["'])(?:\\.|(?!\1).)*\1|message:\s*`(?![^`]*\bt\()/;
  const found = sources.flatMap(({ path, lines }) => MODEL_OR_ENVIRONMENT.has(path) ? [] : lines.flatMap((line, index) => literal.test(line) ? [`${path}:${index + 1}`] : []));
  assert.deepEqual(found, [], "use t() or tf() with a key in src/lib/locale, or add the file to the list above if only the model reads it");
});
