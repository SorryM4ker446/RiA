import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants, requireActiveGrant, revokeGrant } = await import("@/lib/local-files/grants");
const { LocalFileRefused } = await import("@/lib/local-files/limits");
const { isNetworkLocation, resolveGrant, resolveWithinGrant } = await import("@/lib/local-files/safe-path");
const grantsRoute = await import("@/app/api/directory-grants/route");
const grantIdRoute = await import("@/app/api/directory-grants/[id]/route");

let cookie: string;
const req = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method,
  headers: { cookie, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const payload = async (response: Response, status = 200) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};

/** Every refusal in this suite is expected, so the reason is asserted, not the prose. */
async function refusedBy(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof LocalFileRefused, `expected a refusal, got ${String(error)}`);
    return error.reason;
  }
  assert.fail("expected the operation to be refused");
}

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(async () => {
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  await db.directoryGrant.deleteMany({});
});

after(async () => {
  await db.$disconnect();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  cleanup();
});

test("a granted folder resolves the names inside it and nothing above it", async () => {
  const root = temporaryDirectory("ria-grant-");
  mkdirSync(path.join(root, "notes"));
  writeFileSync(path.join(root, "notes", "plan.md"), "# Plan\n");

  const grant = await createGrant({ label: "项目资料", path: root });
  assert.equal(grant.label, "项目资料");
  assert.equal(await listGrants().then((rows) => rows.length), 1);

  const found = await resolveWithinGrant({ realPath: grant.realPath }, "notes/plan.md", "read");
  assert.equal(found.relativePath, "notes/plan.md");
  assert.ok(found.isFile);
  assert.equal(realpathSync.native(found.absolutePath), realpathSync.native(path.join(root, "notes", "plan.md")));
});

test("a name cannot climb out of the grant", async () => {
  const root = temporaryDirectory("ria-grant-");
  const outside = temporaryDirectory("ria-outside-");
  writeFileSync(path.join(outside, "secret.md"), "not yours");

  const grant = await createGrant({ path: root });
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "../secret.md", "read")), "traversal");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "notes/../../escape.md", "read")), "traversal");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, outside, "read")), "traversal");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "C:\\Windows\\System32\\drivers\\etc\\hosts", "read")), "traversal");
  // Backslashes are how a Windows path is written, so they are not a way past
  // the segment check.
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "..\\..\\secret.md", "read")), "traversal");
  assert.equal(grant.revokedAt, null);
});

test("a junction inside the grant cannot redirect a read outside it", async () => {
  const root = temporaryDirectory("ria-grant-");
  const outside = temporaryDirectory("ria-outside-");
  writeFileSync(path.join(outside, "secret.md"), "not yours");
  // A junction needs no elevation on Windows, which is what makes it the
  // realistic version of this escape rather than a symlink nobody can create.
  symlinkSync(outside, path.join(root, "shortcut"), "junction");

  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "shortcut/secret.md", "read")), "symlink-escape");
});

test("hidden files, network locations and system directories are refused as categories", async () => {
  const root = temporaryDirectory("ria-grant-");
  writeFileSync(path.join(root, ".env"), "SECRET=1");

  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, ".env", "read")), "hidden");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "\\\\fileserver\\share\\notes.md", "read")), "network-location");
  assert.equal(isNetworkLocation("//server/share"), true);
  assert.equal(await refusedBy(async () => resolveGrant({ label: "", path: "\\\\fileserver\\share" })), "network-location");

  const system = process.env.SystemRoot;
  if (system) {
    // Refused before anything is written down: a stored grant for `C:\Windows`
    // would be a standing permission no later check can undo.
    assert.equal(await refusedBy(async () => resolveGrant({ label: "", path: system })), "blocked-location");
  }
  assert.equal(await refusedBy(async () => resolveGrant({ label: "", path: path.parse(tmpdir()).root })), "blocked-location");
  assert.equal(await refusedBy(async () => resolveGrant({ label: "", path: path.join(process.env.USERPROFILE ?? ".", ".ssh") })), "blocked-location");
});

test("what may be read is not what may be written", async () => {
  const root = temporaryDirectory("ria-grant-");
  writeFileSync(path.join(root, "notes.md"), "ok");
  writeFileSync(path.join(root, "sheet.xlsx"), "binary");

  assert.equal((await resolveWithinGrant({ realPath: root }, "notes.md", "write")).relativePath, "notes.md");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "sheet.xlsx", "read")), "unsupported-format");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "notes.exe", "write")), "unsupported-format");
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "notes.pdf", "write")), "unsupported-format");
  // A name the assistant picks does not get to be executable just because the
  // extension is text.
  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "run.cmd", "write")), "unsupported-format");
});

test("a file larger than the single-read limit is refused rather than truncated silently", async () => {
  const { LOCAL_FILE_LIMITS } = await import("@/lib/local-files/limits");
  const root = temporaryDirectory("ria-grant-");
  writeFileSync(path.join(root, "large.md"), "x".repeat(LOCAL_FILE_LIMITS.fileBytes + 1));

  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: root }, "large.md", "read")), "too-large");
});

test("revoking a grant takes effect on the very next operation", async () => {
  const root = temporaryDirectory("ria-grant-");
  const grant = await createGrant({ path: root });
  const active = await requireActiveGrant(grant.id);
  assert.equal(active.id, grant.id);

  await revokeGrant(grant.id);
  await assert.rejects(() => requireActiveGrant(grant.id), (error: unknown) => error instanceof LocalFileRefused && error.reason === "outside-grant");
  // The row is kept so the settings page can show what was withdrawn, but it is
  // no longer listed as available.
  assert.equal(await listGrants().then((rows) => rows.length), 0);
  assert.equal(await listGrants({ includeRevoked: true }).then((rows) => rows.length), 1);

  // Revoking twice, and revoking something that is not there, both leave the
  // same state: the permission is gone.
  assert.deepEqual(await revokeGrant(grant.id), { revoked: true });
  assert.deepEqual(await revokeGrant("missing"), { revoked: true });
});

test("granting the same folder again revives it rather than stacking a second permission", async () => {
  const root = temporaryDirectory("ria-grant-");
  const first = await createGrant({ path: root });
  const again = await createGrant({ path: root });
  assert.equal(again.id, first.id);

  await revokeGrant(first.id);
  const revived = await createGrant({ path: root });
  assert.equal(revived.id, first.id);
  assert.equal(revived.revokedAt, null);
  assert.equal(await listGrants().then((rows) => rows.length), 1);
});

test("a folder renamed or replaced after granting is re-checked before use", async () => {
  const root = temporaryDirectory("ria-grant-");
  writeFileSync(path.join(root, "notes.md"), "ok");
  const grant = await createGrant({ path: root });

  const moved = temporaryDirectory("ria-moved-");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(moved, { recursive: true });
  writeFileSync(path.join(moved, "notes.md"), "ok");
  // Re-point the stored real path at a junction that leads elsewhere, which is
  // the shape of "the folder was swapped between granting and reading".
  symlinkSync(moved, root, "junction");
  writeFileSync(path.join(moved, "planted.md"), "planted");

  assert.equal(await refusedBy(async () => resolveWithinGrant({ realPath: grant.realPath }, "planted.md", "read")), "symlink-escape");
});

test("the grants endpoints grant and withdraw, and never without the local credential", async () => {
  const root = temporaryDirectory("ria-grant-");

  const created = await payload(await grantsRoute.POST(req("/api/directory-grants", "POST", { path: root })), 201);
  assert.equal(created.data.label, path.basename(root));
  const listed = await payload(await grantsRoute.GET(req("/api/directory-grants")));
  assert.equal(listed.data.length, 1);

  await payload(await grantIdRoute.DELETE(req(`/api/directory-grants/${created.data.id}`, "DELETE"), context(created.data.id)));
  assert.equal((await payload(await grantsRoute.GET(req("/api/directory-grants")))).data.length, 0);

  // A request without the local credential is refused at the boundary, so a
  // grant cannot be added by anything that is not this workspace.
  const anonymous = new NextRequest("http://localhost/api/directory-grants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: root }) });
  assert.equal((await grantsRoute.POST(anonymous)).status, 401);

  // A refused location is reported as a validation error carrying the reason,
  // not as a server fault.
  const refused = await grantsRoute.POST(req("/api/directory-grants", "POST", { path: "\\\\fileserver\\share" }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.details.reason, "network-location");
});

// --- 7-2 and 7-3: the tools the assistant may run inside a grant -------------

test("the local-file tools are not offered at all until a folder is granted", async () => {
  const { toolAvailability, listPublicToolCatalog, assertToolConfiguration } = await import("@/tools/catalog");

  const withoutGrant = await toolAvailability("readLocalFile");
  assert.equal(withoutGrant.available, false);
  assert.equal(withoutGrant.reason, "noDirectoryGranted");
  assert.equal(withoutGrant.configEntry, "/settings");
  assert.equal((await toolAvailability("createTask")).available, true);
  await assert.rejects(() => assertToolConfiguration("readLocalFile"), /资料目录/);

  await createGrant({ path: temporaryDirectory("ria-grant-") });
  assert.equal((await toolAvailability("readLocalFile")).available, true);
  const catalog = await listPublicToolCatalog("chat");
  assert.equal(catalog.find((tool) => tool.id === "listLocalFiles")?.available, true);

  // Withdrawing every folder takes the tools away again, with no switch to flip.
  const { listGrants, revokeGrant } = await import("@/lib/local-files/grants");
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  assert.equal((await toolAvailability("writeLocalFile")).available, false);
});

test("listing walks a granted folder within its limits and says when it stopped", async () => {
  const { listGrantedFiles } = await import("@/lib/local-files/tools");
  const root = temporaryDirectory("ria-grant-");
  mkdirSync(path.join(root, "notes", "deep"), { recursive: true });
  writeFileSync(path.join(root, "notes", "a.md"), "# A");
  writeFileSync(path.join(root, "notes", "deep", "b.txt"), "B");
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "notes", "image.png"), "binary");
  const grant = await createGrant({ path: root });

  const listing = await listGrantedFiles({ grantId: grant.id, path: "", depth: 2 });
  const paths = listing.entries.map((entry) => entry.path);
  assert.ok(paths.includes("notes/a.md"), "a readable file is listed");
  assert.ok(paths.includes("notes/deep"), "a subfolder is listed");
  // Hidden entries are not advertised either: refusing to read them is not
  // useful if the listing still says they are there.
  assert.equal(paths.some((entry) => entry.includes(".env")), false);
  assert.equal(listing.truncated, null);

  // Depth is a limit, not a suggestion.
  const shallow = await listGrantedFiles({ grantId: grant.id, path: "", depth: 1 });
  assert.equal(shallow.entries.some((entry) => entry.path === "notes/deep/b.txt"), false);
  assert.match(String(shallow.truncated), /levels deep/);
});

test("a file is read from inside the grant and nowhere else", async () => {
  const { readGrantedFile } = await import("@/lib/local-files/tools");
  const root = temporaryDirectory("ria-grant-");
  const outside = temporaryDirectory("ria-outside-");
  writeFileSync(path.join(root, "notes.md"), "# Notes\nbody");
  writeFileSync(path.join(outside, "secret.md"), "not yours");
  const grant = await createGrant({ path: root });

  const read = await readGrantedFile({ grantId: grant.id, path: "notes.md" });
  assert.equal(read.text, "# Notes\nbody");
  assert.equal(read.truncated, false);
  assert.equal(read.grantLabel, grant.label);

  assert.equal(await refusedBy(async () => readGrantedFile({ grantId: grant.id, path: "../secret.md" })), "traversal");
  assert.equal(await refusedBy(async () => readGrantedFile({ grantId: grant.id, path: "missing.md" })), "not-found");
});

test("writing creates a new file and never replaces one that is already there", async () => {
  const { writeGrantedFile } = await import("@/lib/local-files/tools");
  const root = temporaryDirectory("ria-grant-");
  const grant = await createGrant({ path: root });

  const created = await writeGrantedFile({ grantId: grant.id, path: "summary.md", content: "# Summary" });
  assert.equal(created.created, true);
  assert.equal(readFileSync(path.join(root, "summary.md"), "utf8"), "# Summary");

  // The second attempt must leave the first file exactly as it was. The create
  // is exclusive, so the refusal and the check are the same operation.
  assert.equal(await refusedBy(async () => writeGrantedFile({ grantId: grant.id, path: "summary.md", content: "replaced" })), "not-a-file");
  assert.equal(readFileSync(path.join(root, "summary.md"), "utf8"), "# Summary");

  assert.equal(await refusedBy(async () => writeGrantedFile({ grantId: grant.id, path: "run.cmd", content: "x" })), "unsupported-format");
  assert.equal(await refusedBy(async () => writeGrantedFile({ grantId: grant.id, path: "../escape.md", content: "x" })), "traversal");
  assert.equal(existsSync(path.join(root, "..", "escape.md")), false);
});

test("a grant withdrawn mid-turn stops the very next tool call", async () => {
  const { readGrantedFile, writeGrantedFile, listGrantedFiles } = await import("@/lib/local-files/tools");
  const root = temporaryDirectory("ria-grant-");
  writeFileSync(path.join(root, "notes.md"), "ok");
  const grant = await createGrant({ path: root });

  assert.equal((await listGrantedFiles({ grantId: grant.id })).entries.length, 1);
  await revokeGrant(grant.id);
  for (const call of [
    () => listGrantedFiles({ grantId: grant.id }),
    () => readGrantedFile({ grantId: grant.id, path: "notes.md" }),
    () => writeGrantedFile({ grantId: grant.id, path: "new.md", content: "x" })
  ]) {
    assert.equal(await refusedBy(call), "outside-grant");
  }
  assert.equal(existsSync(path.join(root, "new.md")), false, "a withdrawn folder is not written to");
});

test("a read is truncated at the character limit and says so", async () => {
  const { LOCAL_FILE_LIMITS } = await import("@/lib/local-files/limits");
  const { readGrantedFile } = await import("@/lib/local-files/tools");
  const root = temporaryDirectory("ria-grant-");
  writeFileSync(path.join(root, "long.md"), "y".repeat(LOCAL_FILE_LIMITS.characters + 500));
  const grant = await createGrant({ path: root });

  const read = await readGrantedFile({ grantId: grant.id, path: "long.md" });
  assert.equal(read.text.length, LOCAL_FILE_LIMITS.characters);
  assert.equal(read.truncated, true);
});

test("an approval is bound to the folder and the target as they were when it was raised", async () => {
  const { bindWriteApproval } = await import("@/lib/local-files/tools");
  const { fingerprintBinding, verifyWriteApproval } = await import("@/lib/local-files/approval");
  const { writeGrantedFile } = await import("@/lib/local-files/tools");
  const root = temporaryDirectory("ria-grant-");
  const grant = await createGrant({ path: root });

  const binding = await bindWriteApproval({ grantId: grant.id, path: "summary.md" });
  assert.equal(binding.targetWasAbsent, true);
  assert.equal(binding.path, "summary.md");
  // Stable, so a binding survives the restart an approval may wait through.
  assert.equal(fingerprintBinding(binding), fingerprintBinding({ ...binding }));

  // Nothing changed: the approval still describes the act the user read.
  await verifyWriteApproval(binding);
  await writeGrantedFile({ grantId: grant.id, path: "summary.md", content: "# ok", binding });
  assert.equal(readFileSync(path.join(root, "summary.md"), "utf8"), "# ok");

  // A file that appeared after the proposal invalidates it. The user approved
  // creating a new file, not replacing one that turned up meanwhile.
  const second = await bindWriteApproval({ grantId: grant.id, path: "later.md" });
  writeFileSync(path.join(root, "later.md"), "someone else was here");
  assert.equal(await refusedBy(() => verifyWriteApproval(second)), "not-a-file");
  assert.equal(readFileSync(path.join(root, "later.md"), "utf8"), "someone else was here", "the other file is untouched");
});

test("a withdrawn or replaced folder invalidates a pending approval", async () => {
  const { bindWriteApproval } = await import("@/lib/local-files/tools");
  const { verifyWriteApproval } = await import("@/lib/local-files/approval");
  const root = temporaryDirectory("ria-grant-");
  const grant = await createGrant({ path: root });
  const binding = await bindWriteApproval({ grantId: grant.id, path: "summary.md" });

  await revokeGrant(grant.id);
  assert.equal(await refusedBy(() => verifyWriteApproval(binding)), "outside-grant");

  // Re-granting restores the permission but with a new identity, so an approval
  // raised against the old one still does not carry over.
  const revived = await createGrant({ path: root });
  assert.equal(revived.id, grant.id);
  assert.equal(await refusedBy(() => verifyWriteApproval({ ...binding, grantUpdatedAt: new Date(0).toISOString() })), "outside-grant");
});

test("revealing a file re-checks the grant instead of trusting the caller", async () => {
  const revealRoute = await import("@/app/api/directory-grants/reveal/route");
  const root = temporaryDirectory("ria-grant-");
  const outside = temporaryDirectory("ria-outside-");
  writeFileSync(path.join(root, "notes.md"), "ok");
  writeFileSync(path.join(outside, "secret.md"), "not yours");
  const grant = await createGrant({ path: root });
  const post = (body: unknown) =>
    revealRoute.POST(req("/api/directory-grants/reveal", "POST", body));

  const revealed = await payload(await post({ grantId: grant.id, path: "notes.md" }));
  assert.equal(realpathSync.native(revealed.data.absolutePath), realpathSync.native(path.join(root, "notes.md")));

  // Every refusal the read path knows about is also a refusal here. The endpoint
  // exists to hand a file manager a path, so it must not become a way to ask
  // the service about paths outside a grant.
  for (const [path_, status] of [["../secret.md", 400], [".env", 400], ["missing.md", 400], ["run.cmd", 400]] as const) {
    assert.equal((await post({ grantId: grant.id, path: path_ })).status, status, path_);
  }
  assert.equal((await post({ grantId: grant.id, path: outside })).status, 400);

  await revokeGrant(grant.id);
  assert.equal((await post({ grantId: grant.id, path: "notes.md" })).status, 400);
});
