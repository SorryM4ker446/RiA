import { UIMessage } from "ai";

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
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages[userMessages.length - 1];
  if (!latest) return null;

  const text = getTextFromUIMessage(latest);
  if (!text) return null;

  return { id: latest.id, text };
}

export function truncateTitle(input: string, maxLength = 60): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
