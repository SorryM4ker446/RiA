/**
 * Copying text to the system clipboard.
 *
 * Both copy controls — the one on a code block and the one on a whole answer —
 * fail the same way when the clipboard refuses them: `writeText` rejects, and a
 * control that swallows that leaves the reader with a button that did nothing
 * and no way to tell that from a control that is merely unresponsive. The
 * outcome is returned instead of thrown, because neither caller has anywhere to
 * report an exception to and both need the same three states.
 */
export type CopyOutcome = "copied" | "unavailable" | "refused";

/**
 * Writes `text`, reporting whether it was written rather than whether the call
 * returned. Callers decide how a failure is shown; this only decides what
 * happened.
 *
 * A clipboard the page was never given counts as `unavailable` and is not worth
 * interrupting an answer for — the text is still selectable, and a reader who
 * cannot select it has a different problem this cannot fix. A clipboard that
 * exists and then refuses the write is `refused`, which is a real failure with
 * a real cause and is worth surfacing.
 */
export async function writeToClipboard(text: string): Promise<CopyOutcome> {
  if (!text.trim()) return "unavailable";
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return "unavailable";
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "refused";
  }
}
