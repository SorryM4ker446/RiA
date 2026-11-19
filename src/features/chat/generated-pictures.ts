import { ASSET_ID_PATTERN, mediaUrl } from "@/lib/media/message-codec";

/** The pictures an answer's generateImage calls made, in the order it made them. */
export function generatedPictures(parts: readonly { type: string; toolCallId?: string; state?: string; output?: unknown; input?: unknown }[]) {
  return parts.flatMap(part => {
    if (part.type !== "tool-generateImage" || part.state !== "output-available") return [];
    const id = (part.output as { mediaId?: unknown } | null)?.mediaId;
    if (typeof id !== "string" || !ASSET_ID_PATTERN.test(id)) return [];
    const prompt = (part.input as { prompt?: unknown } | null)?.prompt;
    return [{ callId: part.toolCallId ?? id, mediaId: id, url: mediaUrl(id), prompt: typeof prompt === "string" ? prompt : undefined }];
  });
}
