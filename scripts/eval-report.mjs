// Turns the JSON lines written by tests/e2e/real-eval.spec.ts into a table:
// per scenario, how many runs passed, how often each check held, and what the
// scenario cost. Compare two files by running it on each.
//
//   node scripts/eval-report.mjs [.desktop-data/eval/latest.jsonl]
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? ".desktop-data/eval/latest.jsonl";
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
if (!rows.length) { console.error(`No results in ${file}`); process.exit(1); }

const scenarios = new Map();
for (const row of rows) {
  const entry = scenarios.get(row.scenario) ?? { runs: 0, passed: 0, costUsd: 0, requests: 0, checks: new Map() };
  entry.runs++; if (row.pass) entry.passed++;
  entry.costUsd += row.costUsd; entry.requests += row.requests;
  for (const [name, value] of Object.entries(row.checks)) {
    const check = entry.checks.get(name) ?? { true: 0, values: [] };
    if (value === true) check.true++;
    if (typeof value === "number") check.values.push(value);
    entry.checks.set(name, check);
  }
  scenarios.set(row.scenario, entry);
}

const describe = (entry, name, check) => typeof [...entry.checks.get(name).values][0] === "number"
  ? `${name} avg ${(check.values.reduce((a, b) => a + b, 0) / check.values.length).toFixed(1)} / max ${Math.max(...check.values)}`
  : `${name} ${check.true}/${entry.runs}`;
console.log(`| Scenario | Passed | Checks | Calls | Cost (USD) |\n| --- | --- | --- | --- | --- |`);
let total = 0;
for (const [name, entry] of scenarios) {
  total += entry.costUsd;
  const checks = [...entry.checks].map(([check, value]) => describe(entry, check, value)).join("; ");
  console.log(`| ${name} | ${entry.passed}/${entry.runs} | ${checks} | ${entry.requests} | ${entry.costUsd.toFixed(4)} |`);
}
console.log(`\nTotal ${rows.length} runs, $${total.toFixed(4)}.`);
