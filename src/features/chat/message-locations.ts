import type { UIMessage } from "ai";

export type MessageLocation = { id: string; title: string; response: string };

function excerpt(message: UIMessage) {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text.slice(0, 240 - text.length);
    if (text.length >= 240) break;
  }
  return text.replace(/\s+/g, " ").trim()
    || message.parts.flatMap(part => part.type === "file" ? [part.filename || "附件"] : []).join("、").slice(0, 240)
    || (message.parts.some(part => part.type.startsWith("tool-")) ? "工具操作" : "");
}

export function messageLocations(messages: readonly UIMessage[]): MessageLocation[] {
  const locations: MessageLocation[] = [];
  let current: MessageLocation | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      current = { id: message.id, title: excerpt(message) || "附件消息", response: "" };
      locations.push(current);
    } else if (message.role === "assistant" && current) {
      current.response = [current.response, excerpt(message)].filter(Boolean).join(" ").slice(0, 240);
    }
  }
  return locations;
}
