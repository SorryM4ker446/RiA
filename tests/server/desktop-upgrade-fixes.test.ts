import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it, test } from "node:test";
import { NextRequest } from "next/server";

import { createTempDirectory } from "../helpers/temp-directory";
import { createLegacyWorkspace } from "../helpers/legacy-workspace";
import { localAccessCookie } from "../helpers/local-access";
import { createTestDatabase } from "../helpers/database";
import {
  WORKSPACE_ADOPTION_TABLE,
  planWorkspaceUpgrade,
  prepareWorkspaceUpgrade,
  recordAdoptionInDatabase,
} from "../../electron/workspace-upgrade-core.ts";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { ScheduledJobKind, scheduleInputSchema } = await import("@/lib/scheduler/jobs");
const { zhCN } = await import("@/lib/locale/zh-CN");
const schedulesRoute = await import("@/app/api/schedules/route");

const temporaryDirectories = [];
let cookie: string;

const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

beforeEach(() => {
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
});

after(async () => {
  await db.$disconnect();
  cleanup();
  for (const temporary of temporaryDirectories) temporary.remove();
});

function upgradeFixture(options = {}) {
  const temporary = createTempDirectory("private-ai-upgrade-fixes-");
  temporaryDirectories.push(temporary);
  const workspace = createLegacyWorkspace(temporary.root, options);
  const backupsDirectory = join(temporary.root, "backups");
  return {
    ...temporary,
    ...workspace,
    backupsDirectory,
    plan: (extra = {}) =>
      prepareWorkspaceUpgrade(planWorkspaceUpgrade({
        runtime: "test",
        checkoutRoot: temporary.root,
        databaseFile: workspace.databaseFile,
        mediaDirectory: workspace.mediaDirectory,
        backupsDirectory,
        environment: {} as NodeJS.ProcessEnv,
        includeOtherWorkspaces: false,
        ...extra,
      })),
  };
}

const readAdoptionRows = (databaseFile: string) => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(WORKSPACE_ADOPTION_TABLE) as { name?: string } | undefined;
    if (table?.name !== WORKSPACE_ADOPTION_TABLE) return [];
    return database.prepare(`SELECT "ownerId" FROM "${WORKSPACE_ADOPTION_TABLE}"`).all() as Array<{ ownerId: string }>;
  } finally {
    database.close();
  }
};

// --- the settings card can label every kind a workspace can hold -----------

test("every schedule kind the app can store has interface copy", async () => {
  // The card renders `settings.schedules.kind.<kind>` through a key that is
  // cast, so a kind added to the scheduler without copy renders as an empty
  // label rather than failing the build. `weeklySummary` is exactly that: a
  // valid stored kind with a runner, and no translation key.
  for (const kind of ScheduledJobKind) {
    const copy = (zhCN as Record<string, string>)[`settings.schedules.kind.${kind}`];
    assert.equal(typeof copy, "string", `no interface copy for schedule kind ${kind}`);
    assert.ok(copy.trim().length > 0, `empty interface copy for schedule kind ${kind}`);
  }
});

test("a stored schedule of every kind is labelled, not blank", async (t) => {
  t.mock.method(console, "info", () => {});
  await db.scheduledJob.deleteMany({});

  for (const kind of ScheduledJobKind) {
    const parsed = scheduleInputSchema.safeParse({ kind, localTime: "09:00", timeZone: "UTC", interval: "daily" });
    assert.equal(parsed.success, true, `the API refuses kind ${kind}`);
    const created = await schedulesRoute.POST(
      req("/api/schedules", "POST", { kind, localTime: "09:00", timeZone: "UTC", interval: "daily" }),
    );
    assert.equal(created.status, 201, `creating a ${kind} schedule failed`);
  }

  const listed = await schedulesRoute.GET(req("/api/schedules"));
  const body = (await listed.json()) as { data: Array<{ kind: string }> };
  assert.deepEqual(
    body.data.map((job) => job.kind).sort(),
    [...ScheduledJobKind].sort(),
    "every storable kind is what the card is asked to label",
  );
  for (const job of body.data) {
    const copy = (zhCN as Record<string, string>)[`settings.schedules.kind.${job.kind}`];
    assert.ok(copy && copy.trim().length > 0, `a stored ${job.kind} schedule renders with no label`);
  }
});

// --- the adoption record is written once, and only for a completed upgrade --

describe("workspace adoption record", () => {
  it("records the adopted account once however often the upgrade is prepared", () => {
    const workspace = upgradeFixture({ owners: [{ id: "owner-single", email: "owner@example.invalid", chats: 1 }] });

    const first = workspace.plan();
    const second = workspace.plan();

    assert.equal(readAdoptionRows(workspace.databaseFile).length, 1, "preparing twice wrote the adoption twice");
    assert.deepEqual(
      readAdoptionRows(workspace.databaseFile).map((row) => row.ownerId),
      ["owner-single"],
    );
    assert.ok(first.message);
    assert.match(second.message, /复用已有快照/);
  });

  it("leaves no adoption behind when the workspace files cannot be moved", () => {
    const ownerId = "owner-single";
    const workspace = upgradeFixture({ owners: [{ id: ownerId, email: "owner@example.invalid", chats: 1 }] });
    // A file where the legacy backup directory belongs makes the copy step
    // refuse, which is the failure that happens after the decision was made
    // and before the record is written.
    const legacyBackupDirectory = join(workspace.backupsDirectory, createHash("sha256").update(ownerId).digest("hex"));
    mkdirSync(workspace.backupsDirectory, { recursive: true });
    writeFileSync(legacyBackupDirectory, "not a directory");

    assert.throws(() => workspace.plan(), /不安全|unsafe|不安全/);

    assert.deepEqual(readAdoptionRows(workspace.databaseFile), [], "a failed upgrade claimed an adoption");
    assert.equal(existsSync(join(workspace.backupsDirectory, "workspace-adoption.json")), false);
  });

  it("a repeated record call replaces the row rather than adding one", () => {
    const workspace = upgradeFixture({ owners: [{ id: "owner-single", email: "owner@example.invalid", chats: 1 }] });

    recordAdoptionInDatabase(workspace.databaseFile, "owner-other");
    recordAdoptionInDatabase(workspace.databaseFile, "owner-single");
    recordAdoptionInDatabase(workspace.databaseFile, "owner-single");

    assert.deepEqual(
      readAdoptionRows(workspace.databaseFile).map((row) => row.ownerId),
      ["owner-single"],
    );
  });
});
