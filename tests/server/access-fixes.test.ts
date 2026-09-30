import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";

/**
 * The launcher's handshake code, in the environment before anything is
 * imported. The serving process adopts it at module scope, so the value has to
 * be here before the first import that reaches `local-access`.
 */
const CONFIGURED_CODE = "0123456789abcdef0123456789abcdef";
process.env.LOCAL_HANDSHAKE_CODE = CONFIGURED_CODE;

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { consumeHandshakeCode, issueHandshakeCode, localAccessToken } = await import("@/lib/server/local-access");
const { exclusiveDataOperation, protectDataOperation, retainDataOperation } = await import("@/lib/server/data-operations");
const { ApiError } = await import("@/lib/server/api-error");
const { createGrant, revokeGrant } = await import("@/lib/local-files/grants");
const revealRoute = await import("@/app/api/directory-grants/reveal/route");

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

const cookie = () => `local_access=${localAccessToken()}`;
const req = (target: string, method = "POST", body?: unknown) => new NextRequest(`http://localhost${target}`, {
  method,
  headers: { cookie: cookie(), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const isApiError = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  globalThis.__privateAiRateLimitStore.clear();
  await db.directoryGrant.deleteMany({});
});
after(async () => {
  await db.$disconnect();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  cleanup();
});

test("the launcher's handshake code is adopted on first use in this process", () => {
  // Nothing issued this code: it came from the environment, and the module
  // scope call that adopts it runs before any caller can reach it, because the
  // function it calls is a hoisted declaration and the state it writes to is
  // initialised on the line above.
  assert.equal(consumeHandshakeCode(CONFIGURED_CODE), true);
});

test("a handshake code cannot be replayed, and a wrong attempt retires it", () => {
  const code = issueHandshakeCode();
  assert.equal(consumeHandshakeCode(code), true);
  // The code was cleared as it was read, so the leaked link stops working the
  // moment it is used once. The clear is in the same synchronous step as the
  // read, so there is no window in which two callers both hold it.
  assert.equal(consumeHandshakeCode(code), false, "a consumed code is refused on replay");
  assert.equal(consumeHandshakeCode(null), false);
  assert.equal(consumeHandshakeCode(undefined), false);

  // Burning on a wrong answer costs the legitimate user one click and buys an
  // attacker nothing: a leaked link is already enough to take the cookie.
  const burned = issueHandshakeCode();
  assert.equal(consumeHandshakeCode(`${burned.slice(0, -1)}0`), false);
  assert.equal(consumeHandshakeCode(burned), false, "a wrong attempt retires the code");
  assert.equal(consumeHandshakeCode(""), false);
});

test("a held data operation keeps the restore gate shut, and a release frees it exactly once", async () => {
  const release = retainDataOperation();
  await assert.rejects(() => exclusiveDataOperation(async () => "restored"), isApiError("CONFLICT"));
  // A chat turn holds one of these across the whole stream, so a second release
  // driving the counter below zero would let maintenance start while a request
  // is still persisting.
  release();
  release();
  assert.equal(await exclusiveDataOperation(async () => "restored"), "restored");
});

test("a request that fails still gives the restore gate back", async () => {
  const failing = protectDataOperation(async () => { throw new Error("handler failed"); });
  const response = await failing(req("/api/probe"));
  assert.equal(response.status, 500);
  assert.equal(await exclusiveDataOperation(async () => "restored"), "restored", "a failed request must not leave the gate held");
});

test("an unread stream holds the gate until the reader goes away", async () => {
  const streaming = protectDataOperation(async () => new Response(
    new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: 1\n\n")); } }),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const response = await streaming(req("/api/stream"));
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  await assert.rejects(() => exclusiveDataOperation(async () => "restored"), isApiError("CONFLICT"));
  // Disconnecting mid-turn is the ordinary case, not an error: the counter has
  // to come back or every later restore is refused for the life of the process.
  await response.body?.cancel();
  assert.equal(await exclusiveDataOperation(async () => "restored"), "restored");
});

test("revealing hands the shell a path only for a file the reader can decode", async () => {
  const root = temporaryDirectory("ria-reveal-");
  const outside = temporaryDirectory("ria-reveal-outside-");
  writeFileSync(path.join(root, "notes.md"), "ok");
  writeFileSync(path.join(root, "report.pdf"), Buffer.from("%PDF-1.7\nbinary"));
  writeFileSync(path.join(outside, "secret.md"), "not yours");
  symlinkSync(outside, path.join(root, "shortcut"), "junction");
  const grant = await createGrant({ path: root });
  const post = (body: unknown) => revealRoute.POST(req("/api/directory-grants/reveal", "POST", body));

  const revealed = await post({ grantId: grant.id, path: "notes.md" });
  assert.equal(revealed.status, 200, await revealed.clone().text());
  const body = await revealed.json();
  assert.equal(realpathSync.native(body.data.absolutePath), realpathSync.native(path.join(root, "notes.md")));

  // A format the reader has no decoder for is refused, so the endpoint cannot
  // become a way to point a file manager at content nothing else would surface.
  const unreadable = await post({ grantId: grant.id, path: "report.pdf" });
  assert.equal(unreadable.status, 400);
  assert.equal((await unreadable.json()).error.details.reason, "unsupported-format");

  // A junction planted inside the grant is resolved and then refused, exactly
  // as a read would refuse it.
  const escaped = await post({ grantId: grant.id, path: "shortcut/secret.md" });
  assert.equal(escaped.status, 400);
  assert.equal((await escaped.json()).error.details.reason, "symlink-escape");

  // The route reads the row rather than trusting the caller, so a withdrawal is
  // in force on the next request rather than at the end of the session.
  await revokeGrant(grant.id);
  const afterRevoke = await post({ grantId: grant.id, path: "notes.md" });
  assert.equal(afterRevoke.status, 400);
  assert.equal((await afterRevoke.json()).error.details.reason, "outside-grant");
});
