import { isTerminalOutputTool, terminalResultForModel } from "@/lib/terminal/model-output";
import { terminalLogReferenceSchema, type TerminalLogReference } from "@/lib/terminal/schema";

type Page = { totalLines: number; totalBytes: number; ranges: [number, number][] };
type Output = { id?: unknown; status?: unknown; log?: unknown; modelOutputOmitted?: boolean; stdout?: unknown; stderr?: unknown; newStdout?: unknown; newStderr?: unknown };
type TestCounts = { passed?: number; failed?: number };

function reportedOutcome(text: string): "passed" | "failed" | null {
  const summary = /^\s*Tests:\s*(\d+)\s+passed(?:,\s*(\d+)\s+failed)?\s*$/i.exec(text);
  if (summary) return Number(summary[2] ?? 0) > 0 ? "failed" : Number(summary[1]) > 0 ? "passed" : null;
  if (/^\s*BUILD (?:FAILED|FAILURE)\s*$/i.test(text)) return "failed";
  if (/^\s*BUILD SUCCESS\s*$/i.test(text)) return "passed";
  return null;
}

/** A definitive terminal summary can already be visible in the tail of the result. */
function terminalSummary(output: Output) {
  const text = [output.newStdout ?? output.stdout, output.newStderr ?? output.stderr].filter(value => typeof value === "string") as string[];
  const streams = text.map(value => value.trimEnd().split(/\r?\n/));
  if (streams.some(lines => lines.some(line => reportedOutcome(line) === "failed"))) return "failed";
  if (streams.some(lines => reportedOutcome(lines.at(-1) ?? "") === "passed")) return "passed";
  return null;
}

/** A search returns leads. Only complete, gap-free reads establish that all saved output was available for review. */
export function createTerminalEvidenceReview() {
  const completed = new Map<string, TerminalLogReference | null>();
  const pages = new Map<string, Page>();
  const matches = new Map<string, Set<string>>();
  const outcomes = new Map<string, "passed" | "failed">();
  const testCounts = new Map<string, TestCounts>();

  function observe(tool: string, output: unknown, visible = true) {
    if (!output || typeof output !== "object") return;
    if (isTerminalOutputTool(tool)) {
      const result = terminalResultForModel(output) as Output;
      if (typeof result.id !== "string" || result.status !== "completed") return;
      const summary = terminalSummary(result);
      // An explicit later verification can establish the task's outcome even after abbreviated inspection or build output.
      if (summary === "passed") { completed.clear(); return; }
      if (!result.modelOutputOmitted) return;
      const log = terminalLogReferenceSchema.safeParse(result.log);
      completed.set(result.id, log.success ? log.data : null);
      return;
    }
    if (tool !== "readTerminalLog") return;
    const result = output as { logId?: unknown; stream?: unknown; totalLines?: unknown; totalBytes?: unknown; complete?: unknown; search?: unknown; lines?: unknown };
    if (typeof result.logId !== "string" || (result.stream !== "stdout" && result.stream !== "stderr") ||
      typeof result.totalLines !== "number" || typeof result.totalBytes !== "number" || !Array.isArray(result.lines)) return;
    const lines = result.lines as { line: number; text: string; truncated?: boolean }[];
    // A retrieved summary can establish a failure. Passing still needs complete coverage of the finalized log.
    const key = `${result.logId}/${result.stream}`;
    for (const line of lines) {
      if (!line || !Number.isInteger(line.line) || typeof line.text !== "string") continue;
      const outcome = !line.truncated ? reportedOutcome(line.text) : null;
      const count = !line.truncated ? /^\s*(?:ℹ|#)\s+(pass|fail)\s+(\d+)\s*$/.exec(line.text) : null;
      if (visible && (outcome === "failed" || (outcome === "passed" && result.complete === true && outcomes.get(result.logId) !== "failed"))) outcomes.set(result.logId, outcome);
      if (visible && count) {
        const counts = testCounts.get(key) ?? {};
        const kind = count[1] === "pass" ? "passed" : "failed";
        const total = Math.max(counts[kind] ?? 0, Number(count[2]));
        counts[kind] = total;
        testCounts.set(key, counts);
        if (kind === "failed" && total > 0) outcomes.set(result.logId, "failed");
        else if (result.complete === true && counts.passed && counts.failed === 0 && outcomes.get(result.logId) !== "failed") outcomes.set(result.logId, "passed");
      }
      if (result.search || outcome || count) {
        const saved = matches.get(result.logId) ?? new Set<string>();
        if (saved.size < 4) saved.add(`${result.stream}:${line.line} ${line.text.slice(0, 240)}`);
        matches.set(result.logId, saved);
      }
    }
    if (!visible || result.search || result.complete !== true) return;
    const first = lines[0]?.line;
    if (!Number.isInteger(first) || first < 1 || lines.some((line, i) => !line || line.truncated || line.line !== first + i) || first + lines.length - 1 > result.totalLines) return;
    const previous = pages.get(key);
    const ranges: [number, number][] = previous?.totalBytes === result.totalBytes && previous.totalLines === result.totalLines ? previous.ranges : [];
    const next: [number, number] = [first, first + lines.length - 1];
    const merged: [number, number][] = [];
    for (const [start, end] of [...ranges, next].sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    pages.set(key, { totalLines: result.totalLines, totalBytes: result.totalBytes, ranges: merged });
  }

  function reviewed(log: TerminalLogReference | null) {
    return log?.complete === true && outcomes.get(log.id) === "passed" && (["stdout", "stderr"] as const).every(stream => {
      const bytes = log[`${stream}Bytes`];
      if (bytes === 0) return true;
      const page = pages.get(`${log.id}/${stream}`);
      return page?.totalBytes === bytes && page.ranges[0]?.[0] === 1 && page.ranges[0][1] === page.totalLines;
    });
  }

  const pending = () => {
    const results = [...completed.values()];
    const latest = results.at(-1);
    return latest && reviewed(latest) ? [] : results.filter(log => !reviewed(log));
  };
  function clearVisibleEvidence() { pages.clear(); outcomes.clear(); testCounts.clear(); }
  return { observe, pending, clearVisibleEvidence, hasCompleted: () => completed.size > 0, reportedFailure: () => pending().some(log => log && outcomes.get(log.id) === "failed"),
    matchedLines: () => pending().flatMap(log => log ? [...(matches.get(log.id) ?? [])] : []).slice(0, 4) };
}
