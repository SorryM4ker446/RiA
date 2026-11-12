/*
 * What a turn has said so far, for a reader that joins it late.
 *
 * An answer arrives as thousands of small pieces: the service writes it out
 * word by word. A page that joins mid-answer (it came back to the
 * conversation, or opened it in another window) would otherwise go through
 * every one of them at once, and the chat client copies the whole message for
 * each, so a long answer stalls the page for as long as it took to catch up.
 * Joined pieces of the same text say the same thing in one: consecutive text
 * or reasoning deltas of one part become a single delta, and everything else
 * (starts, ends, tool calls, notices) is kept as it is, in order.
 *
 * Only whole events are merged. An event still being written at the end of
 * the backlog is passed on as the bytes it is, and the reader continues from
 * there with what follows.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MERGEABLE = new Set(["text-delta", "reasoning-delta"]);

type Delta = { type: string; id: string; delta: string };

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  return joined;
}

/** Where the last whole event ends: just after its blank line, or 0 when there is none. */
function endOfLastEvent(bytes: Uint8Array): number {
  for (let index = bytes.length - 1; index > 0; index--) {
    if (bytes[index] === 10 && bytes[index - 1] === 10) return index + 1;
  }
  return 0;
}

function asDelta(event: string): Delta | null {
  if (!event.startsWith("data: ")) return null;
  let value: unknown;
  try { value = JSON.parse(event.slice(6)); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { type, id, delta, ...rest } = value as Record<string, unknown>;
  // Anything beyond the text itself (provider metadata) is kept with its own piece.
  if (typeof type !== "string" || !MERGEABLE.has(type) || typeof id !== "string" || typeof delta !== "string" || Object.keys(rest).length) return null;
  return { type, id, delta };
}

/** The backlog as one chunk, with runs of deltas of one part merged. */
export function compactBacklog(chunks: Uint8Array[]): Uint8Array {
  const bytes = concat(chunks);
  const end = endOfLastEvent(bytes);
  if (!end) return bytes;
  const events = decoder.decode(bytes.subarray(0, end)).split("\n\n").filter(event => event.length > 0);
  const out: string[] = [];
  let open: Delta | null = null;
  const flush = () => { if (open) { out.push(`data: ${JSON.stringify(open)}`); open = null; } };
  for (const event of events) {
    const delta = asDelta(event);
    if (delta && open && open.type === delta.type && open.id === delta.id) { open.delta += delta.delta; continue; }
    flush();
    if (delta) open = delta; else out.push(event);
  }
  flush();
  const merged = encoder.encode(out.map(event => `${event}\n\n`).join(""));
  return end === bytes.length ? merged : concat([merged, bytes.subarray(end)]);
}
