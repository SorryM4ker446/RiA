"use client";

import { FormEvent, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import { Button } from "@/components/ui/button";

function readText(message: UIMessage): string {
  const text = message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (text.length > 0) return text;

  const legacyContent = (message as { content?: unknown }).content;
  return typeof legacyContent === "string" ? legacyContent : "";
}

export function ChatShell() {
  const [conversationId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState("");

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { conversationId },
      }),
    [conversationId],
  );

  const { messages, sendMessage, status, error, clearError } = useChat({
    id: conversationId,
    transport,
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content) return;

    setInput("");
    await sendMessage({ text: content });
  }

  const isPending = status === "submitted" || status === "streaming";

  return (
    <div className="flex min-h-[80vh] flex-col gap-4 rounded-xl border p-4">
      <div className="flex-1 space-y-3 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Start your first message.</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="rounded-md border p-3">
              <p className="mb-1 text-xs uppercase text-muted-foreground">{message.role}</p>
              <p className="whitespace-pre-wrap text-sm">{readText(message)}</p>
            </div>
          ))
        )}
      </div>

      {error ? (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error.message}</p>
          <Button className="h-8 px-3 text-xs" onClick={clearError} type="button">
            Dismiss
          </Button>
        </div>
      ) : null}

      <form className="flex gap-2" onSubmit={onSubmit}>
        <input
          className="h-10 flex-1 rounded-md border px-3"
          name="message"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask anything..."
          value={input}
        />
        <Button disabled={isPending || !input.trim()} type="submit">
          {isPending ? "Thinking..." : "Send"}
        </Button>
      </form>
    </div>
  );
}
