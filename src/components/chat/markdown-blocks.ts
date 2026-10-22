/*
 * Constructs whose meaning reaches across blank lines: link reference
 * definitions and footnotes are resolved document-wide, and these raw HTML
 * blocks may contain blank lines. Text containing any of them stays whole.
 */
const DOCUMENT_WIDE = /^ {0,3}\[[^\]\n]+\]:|\[\^|<(?:pre|script|style|textarea)\b|<!--|<\?|<![A-Za-z]|<!\[CDATA\[/im;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * Splits markdown into top-level blocks that render on their own exactly as
 * they do within the whole text, so a reply that is still growing only has its
 * last block parsed again.
 *
 * A boundary is a blank line outside a code fence that is followed by a line
 * starting at the margin which is not a list item. Lists, indented
 * continuations and indented code therefore stay with what precedes them.
 * When in doubt the text is kept together: merging blocks is always safe,
 * splitting inside one is not.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (DOCUMENT_WIDE.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let afterBlank = false;
  let fence: { marker: string; length: number; indent: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceLine = FENCE.exec(line);
    if (fence) {
      // A closing fence uses the same character, is at least as long and carries no info string.
      if (fenceLine && fenceLine[2][0] === fence.marker && fenceLine[2].length >= fence.length
        && fenceLine[3].trim() === "" && fenceLine[1].length <= fence.indent + 3) fence = null;
      continue;
    }
    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }
    if (afterBlank && index > start && !/^[ \t]/.test(line) && !LIST_MARKER.test(line)) {
      blocks.push(lines.slice(start, index).join("\n"));
      start = index;
    }
    afterBlank = false;
    // A backtick fence's info string cannot contain a backtick; such a line is inline code.
    if (fenceLine && !(fenceLine[2][0] === "`" && fenceLine[3].includes("`"))) {
      fence = { marker: fenceLine[2][0], length: fenceLine[2].length, indent: fenceLine[1].length };
    }
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
