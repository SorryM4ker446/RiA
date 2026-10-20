import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { messageLocations } from "@/features/chat/message-locations";

const message = (id: string, role: UIMessage["role"], text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });

test("conversation locations include only user questions and omit assistant and system entries", () => {
  assert.deepEqual(messageLocations([
    message("old-reply", "assistant", "Earlier reply"), message("q1", "user", "First question"),
    message("a1", "assistant", "First reply"), message("a2", "assistant", "More detail"),
    message("q2", "user", "Next question"), message("system", "system", "Private context"),
  ]), [
    { id: "q1", title: "First question", response: "First reply More detail" },
    { id: "q2", title: "Next question", response: "" },
  ]);
});

test("location previews use attachment filenames, exclude reasoning and tool arguments, and bound long text", () => {
  const locations = messageLocations([
    { id: "file", role: "user", parts: [{ type: "file", filename: "Project.pdf", mediaType: "application/pdf", url: "/api/media/file" }] },
    { id: "long", role: "user", parts: [{ type: "text", text: "Visible question. ".repeat(2000) }] },
    { id: "answer", role: "assistant", parts: [{ type: "reasoning", text: "Private reasoning" }, { type: "text", text: "Visible answer" }] },
  ]);
  assert.equal(locations[0].title, "Project.pdf");
  assert.equal(locations[1].title, "Visible question. ".repeat(2000).slice(0, 240).trim());
  assert.equal(locations.length, 2);
  assert.equal(locations[1].response, "Visible answer");
  assert.deepEqual(messageLocations([]), []);
});
