import assert from "node:assert/strict";
import { test } from "node:test";
import { runMediaGeneration } from "@/features/chat/use-media-generation";
import { mapStoredMessagesToUI } from "@/features/chat/page-utils";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const message = (id, text = id) => ({ id, role: "user", parts: [{ type: "text", text }] });
const json = (body) => Response.json(body);

function setup(t, kind, { initialChatId = "A", ensure } = {}) {
  let version = 0;
  const originVersion = version;
  const state = { messages: [message("A-history")], assets: {}, attachments: ["A-reference"], error: null, generating: false };
  let view;
  function switchView(chatId, messages, ready = true) {
    version += 1;
    state.messages = messages;
    state.assets = {};
    state.attachments = [`${chatId}-reference`];
    state.error = `${chatId}-error`;
    view = {
      chatId, ready,
      setMessages(update) { state.messages = typeof update === "function" ? update(state.messages) : update; },
      async reloadMessages(id) {
        assert.equal(id, view.chatId);
        const stored = persisted.filter((row) => row.chatId === id).map((row, index) => ({ ...row, id: `db-${index}`, createdAt: new Date().toISOString() }));
        const mapped = mapStoredMessagesToUI(stored);
        state.messages = mapped.uiMessages;
        state.assets = kind === "image" ? mapped.imageMap : mapped.videoMap;
        view.ready = true;
        reloaded.push(id);
      },
    };
  }
  const persisted = [];
  const reloaded = [];
  switchView(initialChatId, initialChatId ? state.messages : [], Boolean(initialChatId));
  version = originVersion;
  const mediaStarted = deferred();
  const mediaResult = deferred();
  const refreshStarted = deferred();
  let refreshResult = null;
  const refreshOptions = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === `/api/${kind}`) {
      mediaStarted.resolve(JSON.parse(options.body));
      return await mediaResult.promise;
    }
    assert.match(String(url), /^\/api\/conversations\/A\/messages$/);
    persisted.push({ ...JSON.parse(options.body), chatId: "A" });
    return json({ data: {} });
  });
  const options = {
    kind, content: "draw the sea", modelId: "test-model", uploadParts: [],
    getView: () => view,
    isOriginView: () => originVersion === version,
    ensureActiveChatId: ensure ?? (async () => "A"),
    async loadChats(options) {
      refreshOptions.push(options);
      refreshStarted.resolve();
      if (refreshResult) await refreshResult.promise;
    },
    setPageError(error) { state.error = error; },
    setAsset(id, url) { state.assets[id] = url; },
    clearAttachments() { state.attachments = []; },
    setGenerating(value) { state.generating = value; },
  };
  return {
    state, options, persisted, reloaded, switchView, mediaStarted, mediaResult, refreshStarted, refreshOptions,
    holdRefresh() { refreshResult = deferred(); return refreshResult; },
    succeed() { mediaResult.resolve(json({ asset: { assetId: "asset-A", relativePath: "A/result.png", mediaType: kind === "image" ? "image/png" : "video/mp4", url: "/api/media/asset-A" }, modelId: "test-model" })); },
    fail() { mediaResult.reject(new Error("provider A failed")); },
  };
}

for (const kind of ["image", "video"]) {
  for (const outcome of ["success", "failure"]) {
    test(`${kind} ${outcome} persists to A without modifying B's messages, assets, attachments or error`, async (t) => {
      const run = setup(t, kind);
      const pending = runMediaGeneration(run.options);
      assert.equal(run.state.generating, true);
      assert.equal((await run.mediaStarted.promise).chatId, "A");
      run.switchView("B", [message("B-history"), message("B-draft")]);
      const before = structuredClone(run.state);
      if (outcome === "success") run.succeed(); else run.fail();
      await pending;
      assert.deepEqual(run.state, { ...before, generating: false });
      assert.equal(run.persisted.length, 2);
      assert.ok(run.persisted.every((row) => row.chatId === "A"));
      assert.equal(run.persisted[1].status, outcome === "success" ? "success" : "error");
      assert.deepEqual(run.refreshOptions, [{ silent: true }]);
    });

    test(`${kind} ${outcome} merges the result after A history reload removed the placeholder`, async (t) => {
      const run = setup(t, kind);
      const pending = runMediaGeneration(run.options);
      await run.mediaStarted.promise;
      const user = structuredClone(run.state.messages[1]);
      run.switchView("B", [message("B-history")]);
      run.switchView("A", [message("newly-loaded-history"), user, message("new-message")]);
      if (outcome === "success") run.succeed(); else run.fail();
      await pending;
      assert.deepEqual(run.state.messages.slice(0, 3).map(({ id }) => id), ["newly-loaded-history", user.id, "new-message"]);
      assert.equal(run.state.messages.length, 4);
      assert.equal(run.state.messages[3].id, run.persisted[1].clientMessageId);
      assert.match(run.state.messages[3].parts[0].text, outcome === "success" ? /生成完成/ : /生成失败/);
      assert.deepEqual(run.state.attachments, ["A-reference"]);
      assert.equal(run.state.error, "A-error");
      assert.equal(Object.keys(run.state.assets).length, outcome === "success" ? 1 : 0);
    });
  }

  test(`${kind} completion preserves messages added after submission and replaces only its placeholder`, async (t) => {
    const run = setup(t, kind);
    const pending = runMediaGeneration(run.options);
    await run.mediaStarted.promise;
    const assistantId = run.state.messages[2].id;
    run.state.messages.push(message("later-message"));
    run.succeed();
    await pending;
    assert.deepEqual(run.state.messages.map(({ id }) => id), ["A-history", run.persisted[0].clientMessageId, assistantId, "later-message"]);
    assert.equal(run.state.assets[assistantId], "/api/media/asset-A");
    assert.deepEqual(run.state.attachments, []);
  });

  test(`${kind} cannot clear B attachments after a deferred conversation-list refresh`, async (t) => {
    const run = setup(t, kind);
    const refresh = run.holdRefresh();
    const pending = runMediaGeneration(run.options);
    await run.mediaStarted.promise;
    run.succeed();
    await run.refreshStarted.promise;
    run.switchView("B", [message("B-history")]);
    refresh.resolve();
    await pending;
    assert.deepEqual(run.state.attachments, ["B-reference"]);
    assert.equal(run.state.error, "B-error");
    assert.deepEqual(run.state.messages, [message("B-history")]);
  });

  test(`${kind} waits for ensureActiveChatId without using the old draft setter`, async (t) => {
    const ensured = deferred();
    let shouldActivate;
    const run = setup(t, kind, { initialChatId: null, ensure: async (_title, guard) => { shouldActivate = guard; return await ensured.promise; } });
    const pending = runMediaGeneration(run.options);
    assert.equal(run.state.generating, true);
    assert.equal(shouldActivate(), true);
    run.switchView("B", [message("B-history")]);
    assert.equal(shouldActivate(), false);
    ensured.resolve("A");
    await run.mediaStarted.promise;
    run.succeed();
    await pending;
    assert.deepEqual(run.state.messages, [message("B-history")]);
    assert.equal(run.persisted.length, 2);
    assert.ok(run.persisted.every(({ chatId }) => chatId === "A"));
  });

  test(`${kind} new-chat completion reloads in-flight initial history after persistence`, async (t) => {
    const ensured = deferred();
    const run = setup(t, kind, { initialChatId: null, ensure: async () => await ensured.promise });
    const pending = runMediaGeneration(run.options);
    run.switchView("A", [], false);
    ensured.resolve("A");
    await run.mediaStarted.promise;
    assert.deepEqual(run.state.messages, []);
    run.succeed();
    await pending;
    assert.deepEqual(run.reloaded, ["A"]);
    assert.equal(run.state.messages.length, 2);
    assert.match(run.state.messages[1].parts[0].text, /生成完成/);
  });
}

test("ensureActiveChatId failure after switching does not overwrite B's error", async (t) => {
  const ensured = deferred();
  const run = setup(t, "image", { initialChatId: null, ensure: () => ensured.promise });
  const pending = runMediaGeneration(run.options);
  run.switchView("B", [message("B-history")]);
  ensured.reject(new Error("create A failed"));
  await pending;
  assert.equal(run.state.error, "B-error");
  assert.equal(run.state.generating, false);
  assert.deepEqual(run.persisted, []);
});
