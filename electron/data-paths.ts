import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where local data lives for each runtime. Browser development and tests keep
 * everything inside the checkout; the installed application uses the Electron
 * user-data directory, so an installation upgrade can never write into the
 * build output.
 */

export const APP_RUNTIME = {
  web: "web",
  desktop: "desktop",
  test: "test",
} as const;

export type AppRuntime = (typeof APP_RUNTIME)[keyof typeof APP_RUNTIME];

export const DESKTOP_APP_DIRECTORY_NAME = "Private AI Assistant";

export function resolveAppRuntime(environment: NodeJS.ProcessEnv = process.env): AppRuntime {
  const configured = environment.APP_RUNTIME?.trim();
  if (configured === APP_RUNTIME.desktop) return APP_RUNTIME.desktop;
  if (configured === APP_RUNTIME.test) return APP_RUNTIME.test;
  return APP_RUNTIME.web;
}

/**
 * Electron derives its user-data directory from the operating-system
 * convention. `app.getPath("userData")` on Windows is
 * `%APPDATA%/<productName>`, with the roaming application-data folder coming
 * from `APPDATA` (falling back to the profile directory).
 */
export function resolveElectronUserDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const appData = environment.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, DESKTOP_APP_DIRECTORY_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", DESKTOP_APP_DIRECTORY_NAME);
  }
  const configHome = environment.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, DESKTOP_APP_DIRECTORY_NAME);
}

export function resolveCheckoutRoot(scriptFile: string): string {
  // scripts/ -> repository root
  return resolve(scriptFile, "..", "..");
}

function absoluteOrResolved(value: string, base: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

export type LocalDataPaths = {
  runtime: AppRuntime;
  databaseFile: string;
  mediaDirectory: string;
  backupsDirectory: string;
  logsDirectory: string;
};

/**
 * Resolves every local data location for one runtime. Explicit environment
 * overrides win, which is what tests and operators use.
 */
export function resolveLocalDataPaths(
  runtime: AppRuntime,
  checkoutRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): LocalDataPaths {
  const desktopUserData = environment.DESKTOP_USER_DATA_DIR?.trim()
    ? absoluteOrResolved(environment.DESKTOP_USER_DATA_DIR.trim(), checkoutRoot)
    : resolveElectronUserDataDirectory(environment);

  const defaultBase =
    runtime === APP_RUNTIME.desktop
      ? join(desktopUserData, "data")
      : runtime === APP_RUNTIME.test
        ? join(checkoutRoot, ".desktop-data", "test", "local-workspace")
        : join(checkoutRoot, ".desktop-data", "dev");

  const databaseFile = environment.LOCAL_DATABASE_FILE?.trim()
    ? absoluteOrResolved(environment.LOCAL_DATABASE_FILE.trim(), checkoutRoot)
    : join(defaultBase, "app.db");

  // Media sits beside the database unless a runtime pins an absolute location.
  const mediaDirectory = environment.LOCAL_MEDIA_DIRECTORY?.trim()
    ? absoluteOrResolved(environment.LOCAL_MEDIA_DIRECTORY.trim(), checkoutRoot)
    : join(defaultBase, "media");

  const backupsDirectory = environment.LOCAL_BACKUPS_DIRECTORY?.trim()
    ? absoluteOrResolved(environment.LOCAL_BACKUPS_DIRECTORY.trim(), checkoutRoot)
    : join(defaultBase, "backups");

  const logsDirectory = environment.LOCAL_LOGS_DIRECTORY?.trim()
    ? absoluteOrResolved(environment.LOCAL_LOGS_DIRECTORY.trim(), checkoutRoot)
    : join(defaultBase, "logs");

  return { runtime, databaseFile, mediaDirectory, backupsDirectory, logsDirectory };
}

/**
 * Every database the desktop application may have used for personal data.
 * More than one existing file is a user-facing decision, never a silent merge.
 */
export function listKnownLocalDatabases(checkoutRoot: string, environment: NodeJS.ProcessEnv = process.env): string[] {
  const runtime = resolveAppRuntime(environment);
  const candidates = new Set<string>();
  const add = (candidate: string) => {
    if (!candidates.has(candidate)) candidates.add(candidate);
  };

  for (const candidateRuntime of [runtime, APP_RUNTIME.desktop, APP_RUNTIME.web] as const) {
    add(resolveLocalDataPaths(candidateRuntime, checkoutRoot, environment).databaseFile);
  }

  return [...candidates];
}
