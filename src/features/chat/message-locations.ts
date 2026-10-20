import { getLocale, t, type Locale } from "@/lib/locale";
import type { UIMessage } from "ai";

export type MessageLocation = { id: string; title: string; response: string };

function excerpt(message: UIMessage, locale: Locale) {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text.slice(0, 240 - text.length);
    if (text.length >= 240) break;
  }
  return text.replace(/\s+/g, " ").trim()
    || message.parts.flatMap(part => part.type === "file" ? [part.filename || t("chat.messages.attachmentFallback", locale)] : []).join(locale === "en-US" ? ", " : "、").slice(0, 240)
    || (message.parts.some(part => part.type.startsWith("tool-")) ? t("ui.chat.message-locations.toolAction", locale) : "");
}

export function messageLocations(messages: readonly UIMessage[], locale: Locale = getLocale()): MessageLocation[] {
  const locations: MessageLocation[] = [];
  let current: MessageLocation | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      current = { id: message.id, title: excerpt(message, locale) || t("ui.chat.message-locations.attachmentMessage", locale), response: "" };
      locations.push(current);
    } else if (message.role === "assistant" && current) {
      current.response = [current.response, excerpt(message, locale)].filter(Boolean).join(" ").slice(0, 240);
    }
  }
  return locations;
}
