import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type DesktopPaths = {
  projectRoot: string;
  runtimeDirectory: string;
  serverEntry: string;
  migrationsDirectory: string;
  databaseFile: string;
  mediaDirectory: string;
  /** Undo copies and terminal output: the data folder, or the folder the person chose for the cache. */
  cacheDirectory: string;
  backupsDirectory: string;
  logsDirectory: string;
  logFile: string;
  settingsFile: string;
  preloadFile: string;
};

type ResolveDesktopPathsInput = {
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
  compiledDirectory: string;
  projectRootOverride?: string;
  runtimeDirectoryOverride?: string;
  dataDirectoryOverride?: string;
  cacheDirectory?: string;
};

/** The database's file name inside the data folder. */
export const DATABASE_FILE_NAME = "app.db";

/**
 * The fixed path the data is opened at. It may be a directory junction to
 * another drive (see data-location.ts); nothing else needs to know.
 */
export function resolveDataRoot(input: Pick<ResolveDesktopPathsInput, "isPackaged" | "userDataPath" | "compiledDirectory" | "projectRootOverride" | "dataDirectoryOverride">): string {
  const projectRoot = resolve(input.projectRootOverride || join(input.compiledDirectory, ".."));
  return input.dataDirectoryOverride
    ? resolve(input.dataDirectoryOverride)
    : input.isPackaged
      ? join(input.userDataPath, "data")
      : join(projectRoot, ".desktop-data", "dev");
}

export function resolveDesktopPaths(input: ResolveDesktopPathsInput): DesktopPaths {
  const projectRoot = resolve(input.projectRootOverride || join(input.compiledDirectory, ".."));
  const runtimeDirectory = input.runtimeDirectoryOverride
    ? resolve(input.runtimeDirectoryOverride)
    : input.isPackaged
      ? join(input.resourcesPath, ".desktop-runtime")
      : join(projectRoot, ".desktop-runtime");
  const dataRoot = resolveDataRoot(input);
  const logsDirectory = join(dataRoot, "logs");
  const backupsDirectory = join(dataRoot, "backups");
  const configDirectory = join(dataRoot, "config");
  const mediaDirectory = join(dataRoot, "media");

  for (const directory of [dataRoot, logsDirectory, backupsDirectory, configDirectory, mediaDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    projectRoot,
    runtimeDirectory,
    serverEntry: join(runtimeDirectory, "server.js"),
    migrationsDirectory: input.isPackaged
      ? join(runtimeDirectory, "prisma", "migrations")
      : join(projectRoot, "src", "db", "migrations"),
    databaseFile: join(dataRoot, DATABASE_FILE_NAME),
    mediaDirectory,
    cacheDirectory: input.cacheDirectory ? resolve(input.cacheDirectory) : dataRoot,
    backupsDirectory,
    logsDirectory,
    logFile: join(logsDirectory, "desktop.log"),
    settingsFile: join(configDirectory, "settings.json"),
    preloadFile: join(input.compiledDirectory, "preload.js"),
  };
}

export function toSqliteUrl(databaseFile: string): string {
  const absolutePath = isAbsolute(databaseFile) ? databaseFile : resolve(databaseFile);
  return `file:${absolutePath.replaceAll("\\", "/")}`;
}
