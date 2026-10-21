import { ApiError } from "@/lib/server/api-error";
import { lineAt, lineStarts } from "./text";

export type FileEdit = { oldText: string; newText: string; replaceAll?: boolean };
/** A replaced span of the original working text and what replaces it. */
export type Region = { start: number; end: number; text: string };

const invalid = (message: string) => new ApiError({ code: "VALIDATION_ERROR", message });
const CONTEXT = 3;

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) found.push(index);
  return found;
}

function lineNumbers(starts: number[], offsets: number[]) {
  return [...new Set(offsets.map(offset => lineAt(starts, offset) + 1))].slice(0, 8).join(", ");
}

/** Where the model's text nearly matches, so it can re-read and copy it exactly. */
function notFoundHint(text: string, oldText: string): string {
  const first = oldText.split("\n").map(line => line.trim()).find(Boolean);
  if (!first) return "Re-read the file and copy the exact text to replace.";
  const lines = text.split("\n");
  const exact: number[] = [], partial: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === first) exact.push(index + 1);
    else if (first.length >= 8 && line.includes(first)) partial.push(index + 1);
  });
  const candidates = (exact.length ? exact : partial).slice(0, 8);
  return candidates.length
    ? `Lines containing its first line: ${candidates.join(", ")}. Re-read those lines with readProjectFile and copy the exact text, including indentation and line breaks.`
    : "No line contains its first line. Re-read the file with readProjectFile before editing.";
}

/**
 * Locate every edit in the original text, all at once: positions never depend
 * on the order edits are listed in, and overlapping edits are refused instead
 * of being applied to each other's output.
 */
export function applyEdits(text: string, edits: FileEdit[]): { text: string; regions: Region[] } {
  const starts = lineStarts(text);
  const regions: (Region & { edit: number })[] = [];
  edits.forEach((edit, index) => {
    if (!edit.oldText) throw invalid(`edits[${index}].oldText is empty. To create or rewrite a whole file, use content instead.`);
    const found = occurrences(text, edit.oldText);
    if (!found.length) throw invalid(`edits[${index}].oldText was not found. ${notFoundHint(text, edit.oldText)}`);
    if (found.length > 1 && !edit.replaceAll) {
      throw invalid(`edits[${index}].oldText matches ${found.length} places (lines ${lineNumbers(starts, found)}). Include more surrounding lines to make it unique, or set replaceAll.`);
    }
    for (const start of found) regions.push({ start, end: start + edit.oldText.length, text: edit.newText, edit: index });
  });
  regions.sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index++) {
    const previous = regions[index - 1], current = regions[index];
    if (current.start < previous.end) {
      throw invalid(`edits[${previous.edit}] and edits[${current.edit}] overlap at line ${lineAt(starts, current.start) + 1}. Combine them into one edit.`);
    }
  }
  let result = "", cursor = 0;
  for (const region of regions) { result += text.slice(cursor, region.start) + region.text; cursor = region.end; }
  return { text: result + text.slice(cursor), regions: regions.map(({ start, end, text: replacement }) => ({ start, end, text: replacement })) };
}

/** The smallest single region turning one text into another. */
export function replacementRegion(before: string, after: string): Region {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) };
}

const splitLines = (block: string) => {
  const lines = block.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/**
 * Unified diff of the replaced regions with three lines of context. Hunks come
 * from the regions themselves rather than a general diff, so cost stays linear
 * in the file size. Long diffs are cut at a line boundary and say so.
 */
export function unifiedDiff(path: string, before: string | null, after: string, regions: Region[], maxCharacters: number) {
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  let added = 0, removed = 0;
  if (before === null) {
    const lines = splitLines(after);
    out.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`));
    added = lines.length;
  } else {
    const starts = lineStarts(before);
    const lines = before.split("\n");
    const realLines = before.endsWith("\n") || before === "" ? lines.length - 1 : lines.length;
    type Group = { first: number; last: number; regions: Region[] };
    const groups: Group[] = [];
    for (const region of regions) {
      const first = lineAt(starts, region.start);
      let last = lineAt(starts, Math.max(region.start, region.end - 1));
      // Removing a line break after remaining text joins the next line into this
      // one; removing whole lines does not.
      const lead = before.slice(starts[first], region.start) + region.text;
      if (region.end > region.start && before[region.end - 1] === "\n" && lead !== "" && !lead.endsWith("\n") && last + 1 < realLines) last++;
      const group = groups.at(-1);
      if (group && first <= group.last) { group.last = Math.max(group.last, last); group.regions.push(region); }
      else groups.push({ first, last, regions: [region] });
    }
    const blocks = groups.map(group => {
      const blockStart = starts[group.first] ?? before.length;
      const blockEnd = group.last + 1 < starts.length ? starts[group.last + 1] : before.length;
      let replaced = "", cursor = blockStart;
      for (const region of group.regions) { replaced += before.slice(cursor, region.start) + region.text; cursor = region.end; }
      replaced += before.slice(cursor, blockEnd);
      return { ...group, oldLines: splitLines(before.slice(blockStart, blockEnd)), newLines: splitLines(replaced) };
    });
    let delta = 0;
    for (let index = 0; index < blocks.length;) {
      let end = index;
      while (end + 1 < blocks.length && blocks[end + 1].first - blocks[end].last - 1 <= 2 * CONTEXT) end++;
      const contextStart = Math.max(0, blocks[index].first - CONTEXT);
      const contextEnd = Math.min(realLines - 1, blocks[end].last + CONTEXT);
      const body: string[] = [];
      let oldCount = 0, newCount = 0, cursor = contextStart;
      const hunkDelta = delta;
      for (let item = index; item <= end; item++) {
        const block = blocks[item];
        for (; cursor < block.first && cursor <= contextEnd; cursor++) { body.push(` ${lines[cursor]}`); oldCount++; newCount++; }
        body.push(...block.oldLines.map(line => `-${line}`), ...block.newLines.map(line => `+${line}`));
        oldCount += block.oldLines.length; newCount += block.newLines.length;
        removed += block.oldLines.length; added += block.newLines.length;
        delta += block.newLines.length - block.oldLines.length;
        cursor = Math.max(cursor, block.last + 1);
      }
      for (; cursor <= contextEnd; cursor++) { body.push(` ${lines[cursor]}`); oldCount++; newCount++; }
      out.push(`@@ -${contextStart + 1},${oldCount} +${contextStart + 1 + hunkDelta},${newCount} @@`, ...body);
      index = end + 1;
    }
  }
  let diff = out.join("\n");
  if (diff.length > maxCharacters) {
    const cut = diff.lastIndexOf("\n", maxCharacters);
    const omitted = diff.slice(cut + 1).split("\n").length;
    diff = `${diff.slice(0, Math.max(0, cut))}\n… [diff truncated: ${omitted} more lines]`;
  }
  return { diff, added, removed };
}
