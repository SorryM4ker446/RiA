import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { createUploadLock, runAttachmentUpload } from "@/features/chat/use-media-generation";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function png(name: string) {
  return new File(["image-bytes"], name, { type: "image/png" });
}

type Uploaded = Array<{ type: "file"; url: string; mediaType: string; filename: string }>;

/**
 * The upload bookkeeping, wired the way the composer wires it: a view version
 * that a conversation switch advances, and one lock shared by every batch.
 */
function harness() {
  const state = { locked: false, calls: [] as boolean[], committed: [] as string[], error: null as string | null };
  const version = { current: 0 };
  const lock = createUploadLock();
  return {
    state,
    version,
    options: {
      files: [png("one.png")],
      modelMode: "chat" as const,
      existingNames: [],
      upload: async (): Promise<Uploaded> => [{ type: "file", url: "/api/media/asset-1", mediaType: "image/png", filename: "one.png" }],
      setPageError: (error: string | null) => { state.error = error; },
      getVersion: () => version.current,
      commit: (uploaded: Array<{ url?: string }>) => { state.committed.push(...uploaded.map((part) => part.url ?? "")); },
      setUploading: (uploading: boolean) => { state.locked = uploading; state.calls.push(uploading); },
      lock
    }
  };
}

test("an upload that finishes after the conversation changed still releases the composer", async () => {
  const run = harness();
  const uploading = deferred<Uploaded>();

  const pending = runAttachmentUpload({ ...run.options, upload: () => uploading.promise });
  assert.equal(run.state.locked, true, "the composer locks while an upload is in flight");

  // The user clicks another conversation while the upload is still running, and
  // the layout effect advances the view version.
  run.version.current += 1;
  uploading.resolve([{ type: "file", url: "/api/media/asset-1", mediaType: "image/png", filename: "one.png" }]);
  await pending;

  assert.deepEqual(run.state.committed, [], "the reference belongs to the conversation that was left");
  assert.deepEqual(run.state.calls, [true, false],
    "the lock describes the composer, so a result the view discarded must still let the composer be used again");
  assert.equal(run.state.locked, false);
});

test("a second attachment keeps the composer locked until it has actually arrived", async () => {
  const run = harness();
  const first = deferred<Uploaded>();
  const second = deferred<Uploaded>();

  const firstRun = runAttachmentUpload({ ...run.options, upload: () => first.promise });
  const secondRun = runAttachmentUpload({
    ...run.options,
    files: [png("two.png")],
    upload: () => second.promise
  });

  first.resolve([{ type: "file", url: "/api/media/asset-1", mediaType: "image/png", filename: "one.png" }]);
  await firstRun;
  assert.equal(run.state.locked, true,
    "the first upload returning does not mean the second has arrived; releasing here would let a message be sent with an attachment still uploading");

  second.resolve([{ type: "file", url: "/api/media/asset-2", mediaType: "image/png", filename: "two.png" }]);
  await secondRun;
  assert.deepEqual(run.state.calls, [true, true, false],
    "one release for the last upload to arrive, not one per batch");
  assert.deepEqual(run.state.committed, ["/api/media/asset-1", "/api/media/asset-2"]);
});

test("an upload that fails releases the lock and reports the failure", async () => {
  const run = harness();
  await runAttachmentUpload({ ...run.options, upload: async () => { throw new Error("upload rejected"); } });
  assert.equal(run.state.error, "upload rejected");
  assert.equal(run.state.locked, false);
  assert.deepEqual(run.state.committed, []);
});

test("a refused attachment never locks the composer", async () => {
  const run = harness();
  await runAttachmentUpload({ ...run.options, files: [new File(["x"], "notes.txt", { type: "text/plain" })] });
  assert.ok(run.state.error, "an unsupported type is refused rather than uploaded");
  assert.equal(run.state.locked, false);
  assert.deepEqual(run.state.calls, []);
});

test("a video turn still refuses a second reference", async () => {
  const run = harness();
  await runAttachmentUpload({
    ...run.options,
    modelMode: "video",
    files: [png("one.png"), png("two.png")],
    existingNames: []
  });
  assert.ok(run.state.error);
  assert.equal(run.state.locked, false);
  assert.deepEqual(run.state.calls, []);
});

function assistant(parts: unknown[], metadata?: unknown): UIMessage {
  return { id: "m1", role: "assistant", parts, metadata } as unknown as UIMessage;
}

const knowledgeOutput = (references: unknown[]) => ({ type: "tool-searchKnowledge", state: "output-available", output: { results: references.map((reference) => ({ reference })) } });
const source = (chunkId: string) => ({
  documentId: "doc-1",
  chunkId,
  filename: "handbook.pdf",
  pageNumber: 2,
  ordinal: 0,
  snippet: `chunk ${chunkId}`
});

test("a citation that arrived twice is listed once, and the count is the list", async () => {
  const { getDocumentSources } = await import("@/features/chat/message-presentation");
  const message = assistant(
    [knowledgeOutput([source("chunk-a"), source("chunk-b")]), knowledgeOutput([source("chunk-a")])],
    { documentSources: [source("chunk-a"), source("chunk-c")] },
  );

  const sources = getDocumentSources(message);
  assert.deepEqual(sources.map((entry) => entry.chunkId), ["chunk-a", "chunk-c", "chunk-b"]);
  assert.equal(new Set(sources.map((entry) => entry.chunkId)).size, sources.length,
    "DocumentSources keys its list by chunkId, so a repeated citation would be a repeated React key as well");
});

test("the source tag names the tool the turn actually used", async () => {
  const { resolveMessageSourceTag } = await import("@/features/chat/message-presentation");
  const webSearch = resolveMessageSourceTag({ role: "assistant", toolParts: [{ type: "tool-webSearch" } as never] });
  const knowledge = resolveMessageSourceTag({ role: "assistant", toolParts: [knowledgeOutput([]) as never] });
  const plain = resolveMessageSourceTag({ role: "assistant", toolParts: [] });

  const { t } = await import("@/lib/locale");
  assert.equal(webSearch?.label, `${t("chatMsg.sourcePrefix")}${t("chatMsg.sourceWebSearch")}`);
  assert.equal(knowledge?.label, `${t("chatMsg.sourcePrefix")}${t("chatMsg.sourceKnowledge")}`);
  assert.equal(plain?.label, `${t("chatMsg.sourcePrefix")}${t("chatMsg.sourceContext")}`);
  assert.equal(resolveMessageSourceTag({ role: "user", toolParts: [] }), null);
});

test("a refused local file tool is not listed as a file the turn used", async () => {
  const { getLocalFileUses } = await import("@/features/chat/message-presentation");
  const uses = getLocalFileUses(assistant([
    { type: "tool-readLocalFile", state: "output-available", input: { grantId: "g1" }, output: { path: "notes.md", grantLabel: "Docs" } },
    { type: "tool-readLocalFile", state: "output-denied", input: { grantId: "g1", path: "secret.md" }, output: { path: "secret.md" } },
  ] as never));

  assert.deepEqual(uses, [{ grantLabel: "Docs", grantId: "g1", path: "notes.md", toolId: "readLocalFile" }]);
});

test("every schedule kind the runner implements can be created in the settings card", async () => {
  const [card, jobs] = await Promise.all([
    readFile("src/features/settings/schedules.tsx", "utf8"),
    readFile("src/lib/scheduler/jobs.ts", "utf8")
  ]);
  const list = (source: string, name: string) => {
    const start = source.indexOf(`${name} = [`);
    assert.ok(start > 0, `${name} is expected to exist`);
    return [...source.slice(start, source.indexOf("]", start)).matchAll(/"(\w+)"/g)].map((match) => match[1]);
  };

  const offered = list(card, "const KINDS");
  const implemented = list(jobs, "export const ScheduledJobKind");
  assert.deepEqual([...implemented].sort(), [...offered].sort(),
    "a kind the runner and the schema accept but the card does not offer cannot be created at all");

  const { zhCN } = await import("@/lib/locale/zh-CN");
  for (const kind of offered) {
    assert.ok(`settings.schedules.kind.${kind}` in zhCN, `${kind} has no interface copy, so its option would render blank`);
  }
});
