/**
 * The Windows application ID of an installed copy. The installer gives its Start
 * menu shortcut the same ID (scripts/windows-installer-config.mjs), and Windows
 * takes a notification's name and icon from that shortcut.
 */
export const INSTALLED_APP_USER_MODEL_ID = "com.ria.RiA";

/** Development and test runs, which are electron.exe, keep away from the installed copy's ID. */
export const DEVELOPMENT_APP_USER_MODEL_ID = "RiA.Development";
