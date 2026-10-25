/**
 * A chat response body, followed by the answer text it streams joined back
 * together. The server releases text a word at a time, so a phrase in the
 * answer is spread over several `text-delta` events on the wire; matching
 * against this finds it either way.
 */
export async function wireText(response: Response) {
  const wire = await response.text();
  const joined: Record<string, string> = { "text-delta": "", "reasoning-delta": "" };
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6)) as { type?: string; delta?: unknown };
      if (event.type && event.type in joined && typeof event.delta === "string") joined[event.type] += event.delta;
    } catch { /* Not JSON: "[DONE]" and the like. */ }
  }
  return `${wire}\n${joined["reasoning-delta"]}\n${joined["text-delta"]}`;
}
