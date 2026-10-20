import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { openLocalFile } from "../../electron/open-local-file";

test("native file opening accepts existing files and reports default-application failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ria-open-file-"));
  try {
    const file = join(root, "示例 file.ts");
    await writeFile(file, "export const value = 1;");
    const opened: string[] = [];
    assert.deepEqual(await openLocalFile(file, async target => { opened.push(target); return ""; }), { opened: true });
    assert.deepEqual(opened, [file]);
    assert.deepEqual(await openLocalFile(file, async () => "No application"), { opened: false });
    assert.deepEqual(await openLocalFile(file, async () => { throw new Error("Unavailable"); }), { opened: false });
    for (const invalid of [null, {}, "relative.txt", "https://example.invalid", root, join(root, "deleted.txt")]) {
      assert.deepEqual(await openLocalFile(invalid, async () => { assert.fail("Must not invoke the shell"); }), { opened: false });
    }
  } finally {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith("ria-open-file-")) throw new Error("Unexpected file-open test directory");
    await rm(root, { recursive: true, force: true });
  }
});
