import { createHash } from "node:crypto";
import { LocalFileRefused } from "@/lib/local-files/limits";

/**
 * Text handling for project file tools: one decoded, line-ending-normalized
 * working copy per file, and an exact way back to the bytes on disk.
 */
export type Eol = "lf" | "crlf" | "mixed" | "none";
export type ProjectText = { text: string; eol: Eol; bom: boolean };

/** Short content version handed to the model and bound into approvals. */
export const contentHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

export function decodeProjectText(bytes: Buffer): ProjectText {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new LocalFileRefused("not-text", "UTF-16 files are not supported by file tools; use the terminal.");
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  if (body.subarray(0, 8192).includes(0)) throw new LocalFileRefused("not-text", "This looks like a binary file; use the terminal.");
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new LocalFileRefused("not-text", "This file is not valid UTF-8; use the terminal."); }
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  const eol: Eol = crlf + lf === 0 ? "none" : lf === 0 ? "crlf" : crlf === 0 ? "lf" : "mixed";
  // Consistent CRLF files are edited as LF and written back as CRLF. Mixed
  // files are edited exactly as stored.
  return { text: eol === "crlf" ? raw.replace(/\r\n/g, "\n") : raw, eol, bom };
}

/** Text the model supplies, in the working copy's line endings. */
export const toWorking = (value: string, eol: Eol) => eol === "mixed" ? value : value.replace(/\r\n/g, "\n");

export function encodeProjectText(file: ProjectText): Buffer {
  const text = file.eol === "crlf" ? file.text.replace(/\n/g, "\r\n") : file.text;
  return Buffer.concat([file.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
}

export const lineCount = (text: string) => text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

/** Zero-based line containing a character offset. */
export function lineAt(starts: number[], offset: number): number {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return low;
}
