import type { Page } from "@playwright/test";

type ChatStreamWindow = Window & { chatStreamDone?: Promise<void>; continuationHeld?: boolean; releaseContinuation?: () => void };

export async function trackChatStreams(page: Page, holdContinuation = false) {
  await page.evaluate(hold => {
    const original = window.fetch.bind(window);
    const state = window as ChatStreamWindow;
    let chatRequests = 0;
    const gate = new Promise<void>(resolve => { state.releaseContinuation = resolve; });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const chat = new URL(url, location.href).pathname === "/api/chat" && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST";
      if (!chat) return original(input, init);
      const request = ++chatRequests;
      let finish!: () => void;
      state.chatStreamDone = new Promise<void>(resolve => { finish = resolve; });
      const response = await original(input, init);
      if (!response.body) { finish(); return response; }
      return new Response(response.body.pipeThrough(new TransformStream({
        async flush() {
          if (hold && request === 2) {
            state.continuationHeld = true;
            await gate;
          }
          finish();
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }, holdContinuation);
}

export async function waitForChatStream(page: Page) {
  // Chromium does not reliably report loadingFinished for an SSE response.
  await page.evaluate(() => {
    const done = (window as ChatStreamWindow).chatStreamDone;
    if (!done) throw new Error("Chat stream was not tracked");
    return done;
  });
}

export async function isContinuationHeld(page: Page) {
  return page.evaluate(() => (window as ChatStreamWindow).continuationHeld === true);
}

export async function releaseContinuation(page: Page) {
  await page.evaluate(() => (window as ChatStreamWindow).releaseContinuation?.());
}
