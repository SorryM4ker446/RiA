import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { textPdf } from "../helpers/document-fixtures";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const collection = await import("@/app/api/knowledge-folders/route");
const detail = await import("@/app/api/knowledge-folders/[id]/route");
const syncRoute = await import("@/app/api/knowledge-folders/[id]/sync/route");
const documents = await import("@/app/api/documents/route");
const documentDetail = await import("@/app/api/documents/[id]/route");
const folders = await import("@/lib/documents/folders/sync");
const { documentOcrSettled } = await import("@/lib/documents/ocr/runner");
const { documentIndexingSettled } = await import("@/lib/documents/auto-index");
const { searchDocuments } = await import("@/lib/documents/retrieval");
const roots: string[] = [];
after(async () => { folders.stopKnowledgeFolderWatching(); await folders.knowledgeFolderSyncSettled(); for (const root of roots) rmSync(root, { recursive: true, force: true }); await db.$disconnect(); cleanup(); });

let cookie: string;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {});
  cookie = localAccessCookie();
  globalThis.__riaRateLimitStore?.clear();
  folders.stopKnowledgeFolderWatching();
  await folders.knowledgeFolderSyncSettled(); await documentOcrSettled(); await documentIndexingSettled();
  await db.knowledgeFolder.deleteMany({}); await db.knowledgeDocument.deleteMany({});
});

/** A folder of files to sync, outside the test database's own folder. */
function folder(files: Record<string, string | Buffer>, name = "Handbook") {
  const root = mkdtempSync(join(tmpdir(), "ria-folder-sync-"));
  roots.push(root);
  const path = join(root, name);
  for (const [relative, content] of Object.entries({ ".keep": "", ...files })) {
    mkdirSync(dirname(join(path, relative)), { recursive: true });
    writeFileSync(join(path, relative), content);
  }
  return path;
}
const documentNames = async () => (await db.knowledgeDocument.findMany({ orderBy: { filename: "asc" }, select: { filename: true } })).map(row => row.filename);
async function synced(id: string, force = false) { folders.scheduleFolderSync(id, { force }); await folders.knowledgeFolderSyncSettled(); }
const view = async (id: string) => (await folders.listKnowledgeFolders()).find(row => row.id === id)!;
const request = (method: string, url = "http://localhost/api/knowledge-folders", body?: unknown) => new NextRequest(url, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("a synced folder imports its supported files, subfolders included, and leaves out hidden, lock, dependency and linked entries", async () => {
  const outside = folder({ "secret.md": "# Outside\n\nThis lies outside the synced folder." }, "Elsewhere");
  const path = folder({
    "travel.md": "# Travel\n\nHotels are booked through the travel desk.",
    "finance/invoices.txt": "Invoices are paid within thirty days.",
    "finance/policy.pdf": textPdf(),
    "~$draft.docx": "Office lock file", ".notes/hidden.md": "hidden", "node_modules/pkg/readme.md": "dependency", "photo.png": "not a document",
  });
  symlinkSync(outside, join(path, "linked"), "junction");
  const added = await folders.addKnowledgeFolder({ path, collection: "Ops" });
  assert.equal(added.label, "Handbook");
  await folders.knowledgeFolderSyncSettled();
  assert.deepEqual(await documentNames(), ["Handbook/finance/invoices.txt", "Handbook/finance/policy.pdf", "Handbook/travel.md"]);
  assert.ok((await db.knowledgeDocument.findMany()).every(document => document.collection === "Ops"));
  const state = await view(added.id);
  assert.equal(state.status, "synced");
  assert.equal(state.documents, 3);
  assert.ok((await searchDocuments("travel desk hotels")).some(source => source.filename === "Handbook/travel.md"));

  // A second folder with the same name gets a name of its own, so its documents never meet the first one's.
  assert.equal((await folders.addKnowledgeFolder({ path: folder({ "a.md": "Another handbook." }) })).label, "Handbook (2)");
});

test("a changed file is imported again, an unchanged one is not read, and a removed file takes its document with it", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk.", "meals.md": "Meals are covered up to forty euros." });
  const { id } = await folders.addKnowledgeFolder({ path });
  await folders.knowledgeFolderSyncSettled();
  const before = new Map((await db.knowledgeDocument.findMany()).map(document => [document.filename, document]));

  writeFileSync(join(path, "travel.md"), "Hotels are booked through the new travel portal.");
  utimesSync(join(path, "travel.md"), new Date(), new Date(Date.now() + 5_000));
  rmSync(join(path, "meals.md"));
  await synced(id);
  const after = new Map((await db.knowledgeDocument.findMany()).map(document => [document.filename, document]));
  assert.deepEqual([...after.keys()], ["Handbook/travel.md"]);
  assert.equal(after.get("Handbook/travel.md")!.id, before.get("Handbook/travel.md")!.id, "the same document, updated");
  assert.match(JSON.stringify(after.get("Handbook/travel.md")!.pages), /travel portal/);

  // Nothing changed: the scan reads no file and writes no document.
  const stamp = after.get("Handbook/travel.md")!.updatedAt.getTime();
  await synced(id);
  assert.equal((await db.knowledgeDocument.findFirstOrThrow()).updatedAt.getTime(), stamp);
});

test("a folder that cannot be found keeps its documents and says so, and syncs again once it is back", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk." });
  const { id } = await folders.addKnowledgeFolder({ path });
  await folders.knowledgeFolderSyncSettled();
  renameSync(path, `${path}-away`);
  await synced(id);
  assert.equal((await view(id)).status, "missing");
  assert.match((await view(id)).error ?? "", /找不到|cannot be found/);
  assert.deepEqual(await documentNames(), ["Handbook/travel.md"], "an unplugged drive removes nothing");

  renameSync(`${path}-away`, path);
  writeFileSync(join(path, "meals.md"), "Meals are covered up to forty euros.");
  // Once it is back, the regular look at folders that are not watched scans it again.
  await folders.recheckKnowledgeFolders();
  await folders.knowledgeFolderSyncSettled();
  assert.equal((await view(id)).status, "synced");
  assert.deepEqual(await documentNames(), ["Handbook/meals.md", "Handbook/travel.md"]);
});

test("a file that cannot be read is reported, keeps the last good version, is not retried until it changes, and Sync now retries it", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk.", "broken.pdf": "not a PDF at all" });
  const { id } = await folders.addKnowledgeFolder({ path });
  await folders.knowledgeFolderSyncSettled();
  let state = await view(id);
  assert.equal(state.failed, 1);
  assert.equal(state.problems[0].relativePath, "broken.pdf");
  assert.ok(state.problems[0].error);

  const failedAt = (await db.knowledgeFolderFile.findFirstOrThrow({ where: { relativePath: "broken.pdf" } })).updatedAt.getTime();
  await synced(id);
  assert.equal((await db.knowledgeFolderFile.findFirstOrThrow({ where: { relativePath: "broken.pdf" } })).updatedAt.getTime(), failedAt, "an unchanged failure is not read again on its own");

  writeFileSync(join(path, "broken.pdf"), textPdf());
  await synced(id, true);
  state = await view(id);
  assert.equal(state.failed, 0);
  assert.equal(state.documents, 2);

  // A later version that cannot be read leaves the document of the last one that could.
  writeFileSync(join(path, "broken.pdf"), "broken again");
  utimesSync(join(path, "broken.pdf"), new Date(), new Date(Date.now() + 5_000));
  await synced(id);
  const row = await db.knowledgeFolderFile.findFirstOrThrow({ where: { relativePath: "broken.pdf" } });
  assert.equal(row.status, "failed");
  assert.ok(row.documentId, "the earlier document stays linked, to go when the file goes");
  assert.equal(await db.knowledgeDocument.count({ where: { id: row.documentId! } }), 1);
  rmSync(join(path, "broken.pdf"));
  await synced(id);
  assert.equal(await db.knowledgeDocument.count({ where: { id: row.documentId! } }), 0);
});

test("removing a folder keeps its documents or deletes them, as asked", async () => {
  const keep = await folders.addKnowledgeFolder({ path: folder({ "a.md": "Kept after removal." }, "Kept") });
  const drop = await folders.addKnowledgeFolder({ path: folder({ "b.md": "Deleted with the folder." }, "Dropped") });
  await folders.knowledgeFolderSyncSettled();
  await folders.removeKnowledgeFolder(keep.id, { deleteDocuments: false });
  await folders.removeKnowledgeFolder(drop.id, { deleteDocuments: true });
  assert.deepEqual(await documentNames(), ["Kept/a.md"]);
  assert.equal(await db.knowledgeFolderFile.count(), 0);
  assert.equal(await db.knowledgeFolder.count(), 0);
});

test("folders that are not folders, RiA's own data, a network share or one already synced are refused", async () => {
  const path = folder({ "a.md": "Text." });
  await assert.rejects(folders.addKnowledgeFolder({ path: join(path, "a.md") }), /文件夹|folder/);
  await assert.rejects(folders.addKnowledgeFolder({ path: dirname(process.env.DATABASE_URL!.replace(/^file:/, "")) }), /RiA/);
  await assert.rejects(folders.addKnowledgeFolder({ path: "\\\\server\\share\\docs" }), /网络|Network/);
  await assert.rejects(folders.addKnowledgeFolder({ path: join(path, "missing") }), /找不到|could not be found/);
  await folders.addKnowledgeFolder({ path });
  await assert.rejects(folders.addKnowledgeFolder({ path: `${path}\\` }), /已经|already/);
  mkdirSync(join(path, "inner"));
  await assert.rejects(folders.addKnowledgeFolder({ path: join(path, "inner") }), /重叠|overlaps/, "a folder inside a synced one");
  await assert.rejects(folders.addKnowledgeFolder({ path: dirname(path) }), /重叠|overlaps/, "a folder around a synced one");
});

test("documents a restore or a deletion took are imported again from the folder", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk." });
  const { id } = await folders.addKnowledgeFolder({ path });
  await folders.knowledgeFolderSyncSettled();
  await db.knowledgeDocument.deleteMany({});
  assert.equal((await db.knowledgeFolderFile.findFirstOrThrow({ where: { folderId: id } })).documentId, null);
  await folders.resumeKnowledgeFolders();
  await folders.knowledgeFolderSyncSettled();
  assert.deepEqual(await documentNames(), ["Handbook/travel.md"]);
});

test("a watched folder picks up a new file a few seconds after it is saved", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk." });
  const { id } = await folders.addKnowledgeFolder({ path });
  await folders.startKnowledgeFolderWatching();
  await folders.knowledgeFolderSyncSettled();
  writeFileSync(join(path, "meals.md"), "Meals are covered up to forty euros.");
  const deadline = Date.now() + 20_000;
  while (!(await documentNames()).includes("Handbook/meals.md") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok((await documentNames()).includes("Handbook/meals.md"));
  await folders.removeKnowledgeFolder(id, { deleteDocuments: false });
});

test("the library says which folder a document comes from, and deleting such a document is refused with what to do instead", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk." });
  const { id } = await folders.addKnowledgeFolder({ path });
  await folders.knowledgeFolderSyncSettled();
  const listed = (await (await documents.GET(new NextRequest("http://localhost/api/documents", { headers: { cookie } }))).json()).data;
  assert.deepEqual(listed[0].folder, { id, label: "Handbook" });
  const refused = await documentDetail.DELETE(new NextRequest(`http://localhost/api/documents/${listed[0].id}`, { method: "DELETE", headers: { cookie } }), params(listed[0].id));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error.message, /Handbook/);
  assert.equal(await db.knowledgeDocument.count(), 1);
});

test("the folder API lists, adds, syncs and removes folders, and only for the local workspace", async () => {
  const path = folder({ "travel.md": "Hotels are booked through the travel desk." });
  const created = await collection.POST(request("POST", undefined, { path, collection: "Ops" }));
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = (await created.json()).data;
  await folders.knowledgeFolderSyncSettled();
  const listed = (await (await collection.GET(request("GET"))).json()).data;
  assert.equal(listed[0].documents, 1);
  assert.equal(listed[0].path, path);
  assert.equal((await syncRoute.POST(request("POST", `http://localhost/api/knowledge-folders/${id}/sync`), params(id))).status, 202);
  await folders.knowledgeFolderSyncSettled();
  assert.equal((await syncRoute.POST(request("POST", "http://localhost/api/knowledge-folders/missing/sync"), params("missing"))).status, 404);
  assert.equal((await detail.DELETE(request("DELETE", `http://localhost/api/knowledge-folders/${id}`), params(id))).status, 400, "keeping or deleting the documents must be said");
  assert.equal((await detail.DELETE(request("DELETE", `http://localhost/api/knowledge-folders/${id}?documents=delete`), params(id))).status, 200);
  assert.deepEqual(await documentNames(), []);
  cookie = "";
  assert.equal((await collection.GET(request("GET"))).status, 401);
  assert.equal(basename(path), "Handbook");
});
