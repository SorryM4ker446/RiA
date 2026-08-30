import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type DesktopPaths = {
  projectRoot: string;
  runtimeDirectory: string;
  serverEntry: string;
  migrationsDirectory: string;
  databaseFile: string;
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
};

export function resolveDesktopPaths(input: ResolveDesktopPathsInput): DesktopPaths {
  const projectRoot = resolve(input.projectRootOverride || join(input.compiledDirectory, ".."));
  const runtimeDirectory = input.runtimeDirectoryOverride
    ? resolve(input.runtimeDirectoryOverride)
    : input.isPackaged
      ? join(input.resourcesPath, ".desktop-runtime")
      : join(projectRoot, ".desktop-runtime");
  const dataRoot = input.dataDirectoryOverride
    ? resolve(input.dataDirectoryOverride)
    : input.isPackaged
      ? join(input.userDataPath, "data")
      : join(projectRoot, ".desktop-data", "dev");
  const logsDirectory = join(dataRoot, "logs");
  const backupsDirectory = join(dataRoot, "backups");
  const configDirectory = join(dataRoot, "config");

  for (const directory of [dataRoot, logsDirectory, backupsDirectory, configDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    projectRoot,
    runtimeDirectory,
    serverEntry: join(runtimeDirectory, "server.js"),
    migrationsDirectory: input.isPackaged
      ? join(runtimeDirectory, "prisma", "migrations")
      : join(projectRoot, "src", "db", "migrations"),
    databaseFile: join(dataRoot, "app.db"),
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
