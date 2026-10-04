import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_PERMISSIONS, isPermissionAllowed } from "../../electron/permissions";

/**
 * The permission a copy control asks for when it writes text, and the one it
 * must never hold: reading what the clipboard already holds.
 */
const WRITE = "clipboard-sanitized-write";
const READ = "clipboard-read";

test("a copy control is granted the write it asks for", () => {
  assert.equal(isPermissionAllowed(WRITE), true);
  assert.equal(ALLOWED_PERMISSIONS.has(WRITE), true);
});

test("reading the clipboard stays refused", () => {
  assert.equal(isPermissionAllowed(READ), false);
});

test("every other permission is still refused", () => {
  for (const permission of ["media", "geolocation", "notifications", "openExternal", "fullscreen", "pointerLock", "midi", "hid"]) {
    assert.equal(isPermissionAllowed(permission), false, `${permission} must stay denied`);
  }
});

test("the allowlist holds nothing beyond clipboard writing", () => {
  for (const permission of ALLOWED_PERMISSIONS) {
    assert.match(permission, /^clipboard-(sanitized-)?write$/, `${permission} is not a clipboard write`);
  }
});
