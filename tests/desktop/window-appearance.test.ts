import assert from "node:assert/strict";
import { test } from "node:test";
import { windowAppearance } from "../../electron/window-appearance";

test("Windows exposes a transparent native canvas with custom controls", () => {
  assert.deepEqual(windowAppearance("win32", "10.0.19045"), {
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
  });
});

test("Windows 11 22H2 and newer use native frosted material", () => {
  assert.equal(windowAppearance("win32", "10.0.22621").backgroundMaterial, "acrylic");
  assert.equal(windowAppearance("win32", "10.0.26100").backgroundMaterial, "acrylic");
  assert.equal(windowAppearance("win32", "10.0.22000").backgroundMaterial, undefined);
});

test("other platforms retain their opaque native window", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(windowAppearance(platform), {
      backgroundColor: "#fafafa",
    });
  }
});
