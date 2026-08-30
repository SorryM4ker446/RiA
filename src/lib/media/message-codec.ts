export type MediaReference = {
  assetId: string;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  url: string;
};

export type StoredMediaMessage = {
  type: "image-result" | "video-result";
  modelId: string;
  text: string;
  assetId?: string;
  relativePath?: string;
  mediaType?: string;
  // Read compatibility only. New messages use assetId and never inline binary data.
  dataUrl?: string;
  videoUrl?: string;
};

export const IMAGE_MESSAGE_PREFIX = "__IMAGE_RESULT__:";
export const VIDEO_MESSAGE_PREFIX = "__VIDEO_RESULT__:";
export const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function mediaUrl(id: string) { return `/api/media/${id}`; }

export function assetIdFromUrl(url: string): string | null {
  const match = /^\/api\/media\/([^/?#]+)$/.exec(url);
  return match && ASSET_ID_PATTERN.test(match[1]) ? match[1] : null;
}

export function encodeMediaMessage(payload: StoredMediaMessage) {
  return `${payload.type === "image-result" ? IMAGE_MESSAGE_PREFIX : VIDEO_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

export function decodeMediaMessage(content: string): StoredMediaMessage | null {
  const prefix = content.startsWith(IMAGE_MESSAGE_PREFIX) ? IMAGE_MESSAGE_PREFIX : content.startsWith(VIDEO_MESSAGE_PREFIX) ? VIDEO_MESSAGE_PREFIX : null;
  if (!prefix) return null;
  try {
    const value = JSON.parse(content.slice(prefix.length));
    if (value?.type !== (prefix === IMAGE_MESSAGE_PREFIX ? "image-result" : "video-result") || typeof value.text !== "string" || typeof value.modelId !== "string") return null;
    if (typeof value.assetId !== "string" && typeof value.dataUrl !== "string" && typeof value.videoUrl !== "string") return null;
    return value as StoredMediaMessage;
  } catch { return null; }
}
