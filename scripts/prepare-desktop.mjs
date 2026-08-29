import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDirectory = join(repositoryRoot, ".next", "standalone");
const runtimeDirectory = join(repositoryRoot, ".desktop-runtime");
const expectedRuntimeDirectory = resolve(repositoryRoot, ".desktop-runtime");

if (!existsSync(join(standaloneDirectory, "server.js"))) {
  throw new Error("Next.js standalone output is missing. Run the desktop build first.");
}
if (resolve(runtimeDirectory) !== expectedRuntimeDirectory || dirname(runtimeDirectory) !== repositoryRoot) {
  throw new Error(`Refusing to replace unexpected runtime directory: ${runtimeDirectory}`);
}

rmSync(runtimeDirectory, { recursive: true, force: true });
mkdirSync(runtimeDirectory, { recursive: true });
cpSync(standaloneDirectory, runtimeDirectory, {
  recursive: true,
  filter: (source) => !/^\.env(?:\.|$)/i.test(basename(source)),
});

const publicDirectory = join(repositoryRoot, "public");
if (existsSync(publicDirectory)) {
  cpSync(publicDirectory, join(runtimeDirectory, "public"), { recursive: true });
}

const staticDirectory = join(repositoryRoot, ".next", "static");
cpSync(staticDirectory, join(runtimeDirectory, ".next", "static"), { recursive: true });

const prismaRuntimeDirectory = join(runtimeDirectory, "prisma");
mkdirSync(prismaRuntimeDirectory, { recursive: true });
cpSync(join(repositoryRoot, "src", "db", "migrations"), join(prismaRuntimeDirectory, "migrations"), {
  recursive: true,
});
cpSync(join(repositoryRoot, "src", "db", "schema.prisma"), join(prismaRuntimeDirectory, "schema.prisma"));

for (const prismaDirectory of [".prisma/client", "@prisma/client"]) {
  const source = join(repositoryRoot, "node_modules", ...prismaDirectory.split("/"));
  const target = join(runtimeDirectory, "node_modules", ...prismaDirectory.split("/"));
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const migrations = readdirSync(join(prismaRuntimeDirectory, "migrations"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
writeFileSync(
  join(runtimeDirectory, "desktop-runtime.json"),
  `${JSON.stringify(
    {
      productName: packageJson.productName,
      version: packageJson.version,
      generatedAt: new Date().toISOString(),
      migrations,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Prepared desktop runtime: ${relative(repositoryRoot, runtimeDirectory)}`);
