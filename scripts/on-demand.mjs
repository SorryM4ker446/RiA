// Runs one of the on-demand suites: `visual` (the screenshot baseline in
// .visual-baseline/, compared or, with --update-snapshots, recorded) or `perf`
// (timings of everyday interactions, printed and attached to the report).
// Extra arguments go to Playwright.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const [suite, ...rest] = process.argv.slice(2);
if (suite !== "visual" && suite !== "perf") { console.error("Usage: node scripts/on-demand.mjs visual|perf [playwright arguments]"); process.exit(2); }
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [cli, "test", ...rest], { stdio: "inherit", env: { ...process.env, RIA_ON_DEMAND: suite } });
process.exit(result.status ?? 1);
