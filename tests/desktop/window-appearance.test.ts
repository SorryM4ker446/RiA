import assert from "node:assert/strict";
import { test } from "node:test";
import { windowAppearance } from "../../electron/window-appearance";

test("all Windows versions use the same transparent canvas without native frosted material", () => {
  assert.deepEqual(windowAppearance("win32"), {
    frame: false,
    roundedCorners: true,
    transparent: true,
    backgroundColor: "#00000000",
    backgroundMaterial: "none",
  });
});

test("other platforms retain their opaque native window", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(windowAppearance(platform), {
      backgroundColor: "#fafafa",
    });
  }
});
