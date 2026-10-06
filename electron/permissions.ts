/**
 * The permissions the renderer may hold in the desktop session.
 *
 * Kept apart from the session wiring so it can be asserted without an Electron
 * runtime, and stated as one list because the session's default is deny: an
 * entry here is the whole of what the interface is allowed to ask for.
 *
 * `clipboard-sanitized-write` is the narrowest permission that covers the two
 * copy controls. It allows writing plain text and grants no access to what the
 * clipboard already holds, which is why reading is absent: nothing in this
 * application reads it.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "clipboard-write",
]);

/** Whether the renderer may be granted `permission`. Everything else is denied. */
export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}
