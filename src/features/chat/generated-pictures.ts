import type { UIMessage } from "ai";
import { ASSET_ID_PATTERN, mediaUrl } from "@/lib/media/message-codec";

type PartLike = { type: string; toolCallId?: string; state?: string; output?: unknown; input?: unknown };
export type GeneratedPicture = { callId: string; mediaId: string; url: string; prompt?: string };

function pictureOf(part: PartLike): GeneratedPicture | null {
  if (part.type !== "tool-generateImage" || part.state !== "output-available") return null;
  const id = (part.output as { mediaId?: unknown } | null)?.mediaId;
  if (typeof id !== "string" || !ASSET_ID_PATTERN.test(id)) return null;
  const prompt = (part.input as { prompt?: unknown } | null)?.prompt;
  return { callId: part.toolCallId ?? id, mediaId: id, url: mediaUrl(id), prompt: typeof prompt === "string" ? prompt : undefined };
}

/** The pictures an answer's generateImage calls made, in the order it made them. */
export function generatedPictures(parts: readonly PartLike[]): GeneratedPicture[] {
  return parts.flatMap(part => { const picture = pictureOf(part); return picture ? [picture] : []; });
}

/**
 * One place in an answer that makes pictures: text it wrote, or a picture call
 * (still being made, or made). Other calls show elsewhere and do not split the text.
 */
export type AnswerPiece =
  | { kind: "text"; text: string }
  | { kind: "picture"; callId: string; picture: GeneratedPicture | null; state: string };

/**
 * An answer that made pictures, in the order the turn went: the text written
 * before a picture, the picture where it was made, and the text after it.
 * While the answer streams the parts are in that order already; a saved one
 * is read back with all its text first, so the order comes from the steps it
 * recorded. Null when there is no picture call, or the order cannot be known:
 * the answer then shows as one text, as before.
 */
export function answerPieces(message: Pick<UIMessage, "parts" | "metadata">): AnswerPiece[] | null {
  const parts = message.parts as readonly PartLike[];
  const calls = new Map(parts.filter(part => part.type === "tool-generateImage" && part.toolCallId).map(part => [part.toolCallId!, part]));
  if (!calls.size) return null;
  const pieces: AnswerPiece[] = [];
  const addText = (text: string | undefined) => {
    if (!text) return;
    const last = pieces.at(-1);
    if (last?.kind === "text") last.text += text; else pieces.push({ kind: "text", text });
  };
  const addCall = (callId: string) => {
    const part = calls.get(callId);
    if (part) pieces.push({ kind: "picture", callId, picture: pictureOf(part), state: part.state ?? "" });
  };
  const steps = (message.metadata as { steps?: { text?: string; calls: string[] }[] } | undefined)?.steps;
  if (parts.some(part => part.type === "step-start")) {
    for (const part of parts) {
      if (part.type === "text") addText((part as { text?: string }).text);
      else if (part.toolCallId && calls.has(part.toolCallId)) addCall(part.toolCallId);
    }
  } else if (Array.isArray(steps) && steps.some(step => step.calls.some(id => calls.has(id)))) {
    // A step writes before it calls; what follows a call is the next step's.
    for (const step of steps) { addText(step.text); for (const id of step.calls) addCall(id); }
  } else return null;
  // Every picture call has its place, whatever the record said.
  for (const id of calls.keys()) if (!pieces.some(piece => piece.kind === "picture" && piece.callId === id)) addCall(id);
  // Whitespace at the edges of the answer is not text of its own.
  const first = pieces[0], last = pieces.at(-1);
  if (first?.kind === "text") first.text = first.text.trimStart();
  if (last?.kind === "text") last.text = last.text.trimEnd();
  return pieces.filter(piece => piece.kind !== "text" || piece.text.trim());
}
