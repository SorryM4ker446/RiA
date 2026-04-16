import { UIMessage } from "ai";

export type PersistedFilePart = {
  url: string;
  mediaType: string;
  filename?: string;
};

export type PersistedUserMessagePayload = {
  type: "user-message";
  text: string;
  files: PersistedFilePart[];
};

export const USER_MESSAGE_PREFIX = "__USER_MESSAGE__:";

export function getTextFromUIMessage(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];

  const text = parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (text.length > 0) {
    return text;
  }

  const legacyContent = (message as { content?: unknown }).content;
  if (typeof legacyContent === "string") {
    return legacyContent.trim();
  }

  return "";
}

export function getLatestUserText(messages: UIMessage[]): { id?: string; text: string } | null {
  const latest = getLatestUserMessage(messages);
  if (!latest?.text) return null;
  return { id: latest.id, text: latest.text };
}

export function getLatestUserMessage(messages: UIMessage[]): {
  id?: string;
  text: string;
  files: PersistedFilePart[];
} | null {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages[userMessages.length - 1];
  if (!latest) return null;

  const text = getTextFromUIMessage(latest);
  const files = (latest.parts ?? [])
    .filter((part): part is Extract<(typeof latest.parts)[number], { type: "file" }> => part.type === "file")
    .map((part) => ({
      url: part.url,
      mediaType: part.mediaType,
      ...(part.filename ? { filename: part.filename } : {}),
    }));

  if (!text && files.length === 0) return null;
  return { id: latest.id, text, files };
}

export function encodePersistedUserMessage(payload: PersistedUserMessagePayload): string {
  return `${USER_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

export function decodePersistedUserMessage(content: string): PersistedUserMessagePayload | null {
  if (!content.startsWith(USER_MESSAGE_PREFIX)) return null;
  const raw = content.slice(USER_MESSAGE_PREFIX.length);

  try {
    const parsed = JSON.parse(raw) as PersistedUserMessagePayload;
    if (!parsed || parsed.type !== "user-message") return null;
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.files)) return null;

    const validFiles = parsed.files.filter(
      (file) =>
        file &&
        typeof file.url === "string" &&
        file.url.length > 0 &&
        typeof file.mediaType === "string" &&
        file.mediaType.length > 0,
    );

    return {
      type: "user-message",
      text: parsed.text,
      files: validFiles.map((file) => ({
        url: file.url,
        mediaType: file.mediaType,
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
      })),
    };
  } catch {
    return null;
  }
}

export function truncateTitle(input: string, maxLength = 60): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
