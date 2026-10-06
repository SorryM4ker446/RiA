/// <reference path="../../src/types/desktop.d.ts" />
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { UIMessage } from "ai";

/**
 * `next/image` and `next/link` are bundler specifiers: the package ships the file
 * behind each of them, and Node's ESM resolver needs to be told which one.
 * Registered here rather than in the shared loader because only this file pulls a
 * Next component in.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("next/") && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

/**
 * The transcript follows a streaming answer, and the settings screen is the only
 * place several desktop features can be reached.
 *
 * The chat page and the Electron main process cannot be driven from here: there
 * is no browser and no main process in this suite, so what is asserted is the
 * decision each of them makes, taken out of the component and the handler and
 * called directly. The one thing that cannot be taken out is the settings
 * screen's wiring, so that is read from the page source instead.
 */

function message(id: string, text: string, partCount = 1): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text, state: "done" },
      ...Array.from({ length: Math.max(0, partCount - 1) }, () => ({
        type: "reasoning" as const,
        text: "",
        state: "done" as const,
      })),
    ],
  } as unknown as UIMessage;
}

test("a streaming answer changes what the transcript reacts to", async () => {
  const { messageFollowSignature } = await import("@/features/chat/message-renderer");

  const streaming = [message("a", "Once upon")];
  const settled = [message("a", "Once upon a time")];

  // The AI SDK appends every text delta to the one text part it opened, so the
  // message count and the part count are identical for the whole answer. A
  // signature built from those two alone never changed while the answer was
  // being written, and the view stopped following it.
  assert.notEqual(messageFollowSignature(streaming), messageFollowSignature(settled));

  // A rerender that changes nothing must not look like new content.
  assert.equal(messageFollowSignature(settled), messageFollowSignature([message("a", "Once upon a time")]));

  // A new message, a new part and an empty transcript are all still changes.
  assert.notEqual(messageFollowSignature(settled), messageFollowSignature([...settled, message("b", "")]));
  assert.notEqual(messageFollowSignature(settled), messageFollowSignature([message("a", "Once upon a time", 2)]));
  assert.equal(messageFollowSignature([]), "0");
});

test("a conversation opens at its newest message, and only once", async () => {
  const { shouldOpenOnLayout } = await import("@/features/chat/message-renderer");

  const opening = { activeChatId: "chat-b", awaitingFirstHistoryLoad: false, messageCount: 4 };

  // The first conversation of a session, and any conversation opened after
  // another, has no position worth keeping.
  assert.equal(shouldOpenOnLayout({ ...opening, openedChatId: undefined }), true);
  assert.equal(shouldOpenOnLayout({ ...opening, openedChatId: "chat-a" }), true);

  // While the new transcript is still loading, what is on screen belongs to the
  // conversation being left: measuring the reader against it is what made a
  // switch land wherever the last conversation was read to.
  assert.equal(shouldOpenOnLayout({ ...opening, openedChatId: "chat-a", awaitingFirstHistoryLoad: true }), false);

  // The conversation already open, which is the case where the reader's position
  // decides and content arriving has to follow it.
  assert.equal(shouldOpenOnLayout({ ...opening, openedChatId: "chat-b" }), false);

  // An empty transcript has nothing to open; the history that arrives next does.
  assert.equal(shouldOpenOnLayout({ ...opening, messageCount: 0, openedChatId: undefined }), false);
  assert.equal(shouldOpenOnLayout({ ...opening, messageCount: 0, openedChatId: "chat-a" }), false);
});

test("the settings screen renders every control it imports", async () => {
  const page = await readFile("src/app/settings/page.tsx", "utf8");
  const imported = [...page.matchAll(/^import \{ (\w+) \} from "@\/features\/settings\/[\w-]+";$/gm)]
    .map((match) => match[1]);

  assert.ok(imported.length > 0, "the settings page is expected to compose the settings features");
  for (const name of imported) {
    // Each of these is the only way into its feature: the close behaviour and
    // the global shortcut are stored in the desktop shell and read from nowhere
    // else, so an imported card that is never rendered is a feature no user can
    // reach.
    assert.match(page, new RegExp(`<${name}[\\s/>]`), `${name} is imported but never rendered on the settings page`);
  }
});

test("a shortcut this app already holds is not asked for again", async () => {
  const main = await readFile("electron/main.ts", "utf8");
  const start = main.indexOf("function registerGlobalHotkey");
  assert.ok(start > 0, "registerGlobalHotkey is expected to exist");
  const body = main.slice(start, main.indexOf("async function applyDesktopPresence", start));

  const held = body.indexOf("activeAccelerator === wanted");
  const requested = body.indexOf("globalShortcut.register(wanted");

  assert.ok(held >= 0, "the combination already in force must be recognised before the system is asked for it");
  assert.ok(held < requested,
    "Electron refuses a second registration of an accelerator the app already holds, so re-applying the stored shortcut has to short-circuit before register() is called, or it is reported as a conflict with another program");
});
