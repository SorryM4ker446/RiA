// Runs one of the on-demand suites: `visual` (the screenshot baseline in
// .visual-baseline/, compared or, with --update-snapshots, recorded), `perf`
// (timings of everyday interactions, printed and attached to the report), or
// `real` (scenarios against a real model provider, which cost money).
// Extra arguments go to Playwright.
//
// `real` takes the provider and model to use and an API key for each run;
// nothing about a provider is kept in the repository:
//
//   npm run test:real -- --provider deepseek --model deepseek-flash [--max-usd 0.05] [playwright arguments]
//
// The key is read from RIA_REAL_API_KEY when it is set, and otherwise asked for
// without being shown. It is handed only to the isolated service each scenario
// starts, never printed or written anywhere.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const SUITES = ["visual", "perf", "real"];
const PROVIDERS = ["openrouter", "deepseek"];
const [suite, ...rest] = process.argv.slice(2);
if (!SUITES.includes(suite)) { console.error(`Usage: node scripts/on-demand.mjs ${SUITES.join("|")} [playwright arguments]`); process.exit(2); }

/** Takes `--name value` (or `--name=value`) out of the arguments. */
function takeOption(args, name) {
  const index = args.findIndex(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return undefined;
  const [flag] = args.splice(index, 1);
  return flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args.splice(index, 1)[0];
}

/** Reads a line from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) { reject(new Error("No terminal to ask for the key: set RIA_REAL_API_KEY instead.")); return; }
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = chunk => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          input.setRawMode(false); input.pause(); input.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
  });
}

const env = { ...process.env, RIA_ON_DEMAND: suite };
if (suite === "real") {
  const provider = takeOption(rest, "provider") ?? process.env.RIA_REAL_PROVIDER;
  const model = takeOption(rest, "model") ?? process.env.RIA_REAL_MODEL;
  const maxUsd = takeOption(rest, "max-usd") ?? process.env.RIA_REAL_MAX_USD ?? "0.05";
  if (!provider || !PROVIDERS.includes(provider) || !model) {
    console.error(`Usage: npm run test:real -- --provider ${PROVIDERS.join("|")} --model <model id> [--max-usd 0.05] [playwright arguments]`);
    process.exit(2);
  }
  if (!(Number(maxUsd) > 0)) { console.error("--max-usd must be a positive amount in US dollars."); process.exit(2); }
  const key = process.env.RIA_REAL_API_KEY?.trim() || (await askHidden(`API key for ${provider} (not shown, not saved): `)).trim();
  if (!key) { console.error("No API key given."); process.exit(2); }
  console.log(`Real-model scenarios with ${provider} / ${model}, stopping once more than $${maxUsd} is spent.`);
  Object.assign(env, { RIA_REAL_PROVIDER: provider, RIA_REAL_MODEL: model, RIA_REAL_MAX_USD: maxUsd, RIA_REAL_API_KEY: key });
  // One at a time: the spending cap is counted as the scenarios run.
  if (!rest.some(arg => arg.startsWith("--workers"))) rest.push("--workers=1");
}
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [cli, "test", ...rest], { stdio: "inherit", env });
process.exit(result.status ?? 1);
