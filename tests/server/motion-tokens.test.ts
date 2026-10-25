import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("every animation and transition timing comes from the motion tokens", () => {
  // The script exits non-zero and lists the offenders when one does not.
  const output = execFileSync(process.execPath, ["scripts/check-motion.mjs"], { encoding: "utf8" });
  assert.match(output, /All motion timings use the tokens/);
});
