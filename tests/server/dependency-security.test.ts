import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const braces = require("braces");
const { sprintf, vsprintf } = require("sprintf-js");

test("installed brace parser rejects excessive nesting before recursive processing", () => {
  const nested = "{".repeat(3000) + "a,b" + "}".repeat(3000);
  const parentheses = "(".repeat(3000) + "a" + ")".repeat(3000);
  for (const pattern of [nested, parentheses]) {
    for (const operation of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(pattern), { name: "SyntaxError", message: /nesting/ });
    }
  }
});

test("installed brace walkers guard caller-provided deep, cyclic and shared ASTs", () => {
  let deep: object = { type: "text", value: "x" };
  for (let i = 0; i < 5000; i++) deep = { type: "root", nodes: [deep] };
  const cyclic: { type: string; nodes: unknown[] } = { type: "root", nodes: [] };
  cyclic.nodes.push(cyclic);
  let shared: object = { type: "text", value: "x" };
  for (let i = 0; i < 20; i++) shared = { type: "root", nodes: [shared, shared] };
  for (const ast of [deep, cyclic, shared]) {
    for (const operation of [braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(ast), { name: "SyntaxError" });
    }
  }
});

test("brace patterns retain normal expansion, compilation and consumer matching", () => {
  assert.deepEqual(braces.expand("src/{app,lib}/file-{1..3}.ts"), [
    "src/app/file-1.ts", "src/app/file-2.ts", "src/app/file-3.ts",
    "src/lib/file-1.ts", "src/lib/file-2.ts", "src/lib/file-3.ts",
  ]);
  assert.equal(braces.stringify(braces.parse("a/{b,c}/d")), "a/{b,c}/d");
  assert.equal(braces.compile("a/{b,c}/d"), "a/(b|c)/d");
  const micromatch = require("micromatch");
  assert.deepEqual(micromatch(["src/app/a.ts", "src/lib/b.ts", "src/other/c.ts"], "src/{app,lib}/*.ts"), ["src/app/a.ts", "src/lib/b.ts"]);
  assert.throws(() => braces.expand("{1..10001}"), /range limit/);
});

test("numeric formatting bounds unsupported precision without native exceptions", () => {
  for (const type of ["e", "f", "g"]) {
    for (const precision of ["101", "999999999999999999999999999999999999999999"]) {
      const output = sprintf(`%.${precision}${type}`, 1.234);
      assert.equal(output, sprintf(`%.100${type}`, 1.234));
      assert.ok(output.length <= 110);
    }
  }
  assert.equal(sprintf("%.0g", 1.234), sprintf("%.1g", 1.234));
});

test("formatting retains supported precision, argument selection and consumers", () => {
  assert.equal(sprintf("%.2f / %.2e / %.3g", 1.234, 1.234, 1.234), "1.23 / 1.23e+0 / 1.23");
  assert.equal(sprintf("%2$s %1$04d", 7, "item"), "item 0007");
  assert.equal(vsprintf("%s: %d", ["count", 3]), "count: 3");
  assert.equal(sprintf("%(user.name)s", { user: { name: "RiA" } }), "RiA");
  const mammothRequire = createRequire(require.resolve("mammoth/package.json"));
  const consumer = mammothRequire("sprintf-js");
  assert.equal(consumer.sprintf("%.999999f", 1.25), sprintf("%.100f", 1.25));
  const argparseRequire = createRequire(require.resolve("argparse/package.json"));
  assert.equal(argparseRequire("sprintf-js").sprintf("%s", "help"), "help");
});
