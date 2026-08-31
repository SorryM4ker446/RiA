import { createHash } from "node:crypto";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { decodePersistedAssistantToolMessage, decodePersistedUserMessage, ASSISTANT_TOOL_MESSAGE_PREFIX, USER_MESSAGE_PREFIX } from "@/lib/ai/ui-message";
import { decodeMediaMessage, IMAGE_MESSAGE_PREFIX, VIDEO_MESSAGE_PREFIX, mediaUrl } from "@/lib/media/message-codec";

export const CONVERSATION_EXPORT_LIMITS = { messages: 5000, sourceBytes: 32 * 1024 * 1024, outputBytes: 16 * 1024 * 1024 } as const;

function exportContent(content: string) {
  const user = decodePersistedUserMessage(content);
  if (user) return { text: user.text, hasMedia: user.files.length > 0 };
  const assistant = decodePersistedAssistantToolMessage(content);
  if (assistant) return {
    text: assistant.text, hasMedia: false,
    tools: assistant.tools.map(tool => ({ name: tool.toolName, state: tool.state })),
    documentSources: assistant.documentSources?.map(source => ({
      documentId: source.documentId, chunkId: source.chunkId, filename: source.filename,
      pageNumber: source.pageNumber, excerpt: source.snippet,
    })),
  };
  const media = decodeMediaMessage(content);
  if (media) return { text: media.text, hasMedia: true, modelId: media.modelId };
  if ([USER_MESSAGE_PREFIX, ASSISTANT_TOOL_MESSAGE_PREFIX, IMAGE_MESSAGE_PREFIX, VIDEO_MESSAGE_PREFIX].some(prefix => content.startsWith(prefix)) || /^data:/i.test(content)) {
    return { text: "[Unrecognized structured or embedded-media content omitted]", hasMedia: true };
  }
  return { text: content, hasMedia: false };
}

function literalBlock(value: string) {
  let length = 3;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}text\n${value}\n${fence}`;
}
function heading(value: string) {
  return value.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&");
}

export async function exportConversation(userId: string, id: string, format: "json" | "markdown") {
  const snapshot = await db.$transaction(async tx => {
    const chat = await tx.chat.findFirst({ where: { id, userId }, include: { tags: { orderBy: { label: "asc" } } } });
    if (!chat) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    const [size] = await tx.$queryRaw<Array<{ count: bigint; bytes: bigint }>>`
      SELECT count(*) AS count,coalesce(sum(length(cast(content AS blob))),0) AS bytes FROM messages WHERE chatId=${id}`;
    if (Number(size.count) > CONVERSATION_EXPORT_LIMITS.messages || Number(size.bytes) > CONVERSATION_EXPORT_LIMITS.sourceBytes) {
      throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "Conversation export exceeds 5,000 messages or 32 MiB of stored content; no partial export was created" });
    }
    const messages = await tx.message.findMany({
      where: { chatId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { media: { where: { asset: { userId, deletedAt: null } }, include: { asset: { select: { id: true, mediaType: true, byteSize: true } } } } },
    });
    return {
      formatVersion: 1, exportedAt: new Date().toISOString(),
      notice: "Text snapshot only; private media files and raw tool inputs/outputs are not included. This is not a restorable backup.",
      conversation: { id: chat.id, title: chat.title, pinned: chat.pinned, archived: chat.archived, tags: chat.tags.map(tag => tag.label), createdAt: chat.createdAt.toISOString(), lastMessageAt: chat.lastMessageAt.toISOString() },
      messages: messages.map(message => {
        const { hasMedia, ...content } = exportContent(message.content);
        return {
          id: message.id, role: message.role, status: message.status, createdAt: message.createdAt.toISOString(), ...content,
          attachments: message.media.map(({ asset }) => ({ assetId: asset.id, mediaType: asset.mediaType, byteSize: asset.byteSize, url: mediaUrl(asset.id) })),
          ...(hasMedia && !message.media.length ? { omittedMedia: true } : {}),
        };
      }),
    };
  });
  const text = format === "json" ? JSON.stringify(snapshot, null, 2) : [
    `# ${heading(snapshot.conversation.title)}`,
    `Exported: ${snapshot.exportedAt}`, snapshot.notice,
    `Tags: ${snapshot.conversation.tags.map(heading).join(", ") || "—"}`,
    `Pinned: ${snapshot.conversation.pinned} · Archived: ${snapshot.conversation.archived}`,
    ...snapshot.messages.map(message => [
      `## ${message.role} · ${message.createdAt} · ${message.status}`, literalBlock(message.text),
      ...message.attachments.map(asset => `Attachment: ${asset.mediaType} (${asset.byteSize} bytes), authenticated local reference: ${asset.url}`),
      ...("tools" in message && message.tools ? message.tools.map(tool => `Tool: ${heading(tool.name)} (${heading(tool.state)})`) : []),
      ...("documentSources" in message && message.documentSources ? message.documentSources.map(source => `Source: ${heading(source.filename)}${source.pageNumber ? ` · page ${source.pageNumber}` : ""}\n\n${literalBlock(source.excerpt)}`) : []),
      ...(message.omittedMedia ? ["Embedded or unavailable media omitted."] : []),
    ].join("\n\n")),
  ].join("\n\n");
  if (Buffer.byteLength(`${text}\n`, "utf8") > CONVERSATION_EXPORT_LIMITS.outputBytes) {
    throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "Export exceeds 16 MiB; no partial export was created" });
  }
  const filename = `conversation-${createHash("sha256").update(id).digest("hex").slice(0, 12)}.${format === "json" ? "json" : "md"}`;
  return { text: `${text}\n`, filename };
}
