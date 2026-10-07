import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const acceptanceScenarios = [
  "clean-install", "offline-startup", "upgrade", "directory-change", "migration-failure",
  "proxy", "native-notification", "sleep-resume", "uninstall-reinstall", "cancel-install",
];
const artifactSchema = z.strictObject({
  filename: z.string().min(1).max(200).refine(value => !/[\\/:]/.test(value) && value.endsWith(".msi")),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const releaseSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/), platform: z.literal("win32"), arch: z.literal("x64"),
  artifacts: z.array(artifactSchema).length(1),
});
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), release: releaseSchema,
  environment: z.strictObject({
    windowsBuild: z.string().max(200), vm: z.string().max(200),
    installationType: z.string().max(200), tester: z.string().max(200), previousVersion: z.string().max(50),
  }),
  scenarios: z.array(z.strictObject({
    id: z.enum(acceptanceScenarios), result: z.enum(["not-run", "pass", "fail"]),
    testedAt: z.iso.datetime().nullable(), evidence: z.array(z.string().trim().min(1).max(2000)).max(20),
  })).length(acceptanceScenarios.length),
});

async function readJson(path) {
  if ((await stat(path)).size > 1024 * 1024) throw new Error("Acceptance metadata exceeds 1 MiB");
  return JSON.parse(await readFile(path, "utf8"));
}
function parse(schema, input, label) {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`Invalid ${label} structure`);
  return result.data;
}
async function digest(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error("Acceptance files must be nonempty regular files");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: metadata.size, sha256: hash.digest("hex") };
}
async function verifiedRelease(manifestPath) {
  const manifest = await readJson(manifestPath);
  const release = parse(releaseSchema, {
    version: manifest.version, platform: manifest.platform, arch: manifest.arch, artifacts: manifest.artifacts,
  }, "release manifest");
  for (const artifact of release.artifacts) {
    if (!artifact.filename.endsWith(`-${release.version}-x64.msi`)) throw new Error("Installer filename does not match its release version");
    const current = await digest(join(dirname(manifestPath), artifact.filename));
    if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) {
      throw new Error("Installer bytes do not match the release manifest; rebuild its checksum record");
    }
  }
  return release;
}

export async function initializeAcceptance(manifestPath, recordPath) {
  const release = await verifiedRelease(manifestPath);
  const record = {
    schemaVersion: 1, release,
    environment: { windowsBuild: "", vm: "", installationType: "", tester: "", previousVersion: "" },
    scenarios: acceptanceScenarios.map(id => ({ id, result: "not-run", testedAt: null, evidence: [] })),
  };
  // A new build must never overwrite the tester's existing acceptance evidence.
  await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return record;
}

export async function checkAcceptance(manifestPath, recordPath) {
  const release = await verifiedRelease(manifestPath);
  const record = parse(recordSchema, await readJson(recordPath), "acceptance record");
  if (JSON.stringify(record.release) !== JSON.stringify(release)) {
    throw new Error("Acceptance belongs to a different installer version or checksum");
  }
  if (new Set(record.scenarios.map(item => item.id)).size !== acceptanceScenarios.length) {
    throw new Error("Acceptance scenarios are duplicated or missing");
  }
  const incomplete = record.scenarios.filter(item => item.result !== "pass").map(item => item.id);
  if (incomplete.length) throw new Error(`Manual acceptance is incomplete: ${incomplete.join(", ")}`);
  for (const field of ["windowsBuild", "vm", "installationType", "tester"]) {
    if (!record.environment[field].trim()) throw new Error(`Acceptance environment is missing ${field}`);
  }
  const previous = record.environment.previousVersion.split(".").map(Number);
  const current = release.version.split(".").map(Number);
  const difference = previous.findIndex((part, index) => part !== current[index]);
  if (!/^\d+\.\d+\.\d+$/.test(record.environment.previousVersion) || previous.some(part => !Number.isSafeInteger(part)) ||
      difference < 0 || previous[difference] >= current[difference]) {
    throw new Error("Upgrade acceptance requires a lower preceding release version");
  }
  const scenarios = [];
  const reserved = new Set([resolve(manifestPath), resolve(recordPath), ...release.artifacts.map(item => resolve(dirname(manifestPath), item.filename))]);
  for (const scenario of record.scenarios) {
    if (!scenario.testedAt || Date.parse(scenario.testedAt) > Date.now() || !scenario.evidence.length) {
      throw new Error(`Acceptance time or evidence is missing/invalid: ${scenario.id}`);
    }
    const evidence = [];
    for (const path of scenario.evidence) {
      const absolute = resolve(dirname(recordPath), path);
      if (reserved.has(absolute)) throw new Error(`Installer metadata is not scenario evidence: ${scenario.id}`);
      evidence.push({ path, ...await digest(absolute) });
    }
    scenarios.push({ ...scenario, evidence });
  }
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), manualAcceptance: "pass", release,
    environment: record.environment, record: { filename: basename(recordPath), ...await digest(recordPath) }, scenarios };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--init", "--check", "--manifest", "--record", "--output"].includes(key) || key in options) throw new Error("Invalid or duplicate acceptance option");
    if (key === "--init" || key === "--check") options[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Acceptance option requires a path");
      options[key] = value;
    }
  }
  if (Boolean(options["--init"]) === Boolean(options["--check"]) || (options["--init"] && options["--output"])) {
    throw new Error("Choose --init or --check; --output is only available with --check");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = resolve(options["--manifest"] ?? join(root, "out/make/wix/x64/verification.json"));
  const recordPath = resolve(options["--record"] ?? join(dirname(manifestPath), "acceptance.json"));
  if (options["--init"]) {
    const record = await initializeAcceptance(manifestPath, recordPath);
    console.log(`Created unverified manual acceptance for ${record.release.version}: ${recordPath}`);
  } else {
    const result = await checkAcceptance(manifestPath, recordPath);
    const json = JSON.stringify(result, null, 2) + "\n";
    if (options["--output"]) await writeFile(resolve(options["--output"]), json, { flag: "wx" });
    else process.stdout.write(json);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Do not print record bodies, evidence contents or provider credentials.
    console.error(error instanceof z.ZodError ? "Invalid acceptance metadata" : error.message);
    process.exitCode = 1;
  });
}
