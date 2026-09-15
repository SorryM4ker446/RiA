import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createTempDirectory } from "../helpers/temp-directory.mjs";
import { createLegacyWorkspace, readOwnerCounts } from "../helpers/legacy-workspace.mjs";
import { runWorkspaceUpgrade } from "../../electron/desktop-workspace-upgrade.ts";
import {
  planWorkspaceUpgrade,
  prepareWorkspaceUpgrade,
  restoreLatestWorkspaceSnapshot,
  writeRecordedOwner,
} from "../../electron/workspace-upgrade-core.ts";
import { verifyWorkspaceSnapshot } from "../../electron/workspace-snapshot.ts";

const temporaryDirectories = [];

function fixture(options = {}) {
  const temporary = createTempDirectory("private-ai-workspace-upgrade-");
  temporaryDirectories.push(temporary);
  const workspace = createLegacyWorkspace(temporary.root, options);
  const backupsDirectory = join(temporary.root, "backups");
  return {
    ...temporary,
    ...workspace,
    backupsDirectory,
    plan: (extra = {}) =>
      planWorkspaceUpgrade({
        runtime: "test",
        checkoutRoot: temporary.root,
        databaseFile: workspace.databaseFile,
        mediaDirectory: workspace.mediaDirectory,
        backupsDirectory,
        environment: {},
        // Other databases on this machine must never influence a test result.
        includeOtherWorkspaces: false,
        ...extra,
      }),
  };
}

after(() => {
  for (const temporary of temporaryDirectories) temporary.remove();
});

describe("workspace upgrade plan", () => {
  it("adopts the only account and snapshots before converting", () => {
    const workspace = fixture({
      owners: [
        {
          id: "owner-single",
          email: "owner@example.invalid",
          chats: 2,
          messagesPerChat: 2,
          memories: 1,
          mediaAssets: 1,
          preferences: { defaultMode: "image" },
        },
      ],
    });

    const plan = workspace.plan();
    assert.equal(plan.state, "ready");
    assert.equal(plan.needsConversion, true);
    assert.equal(plan.adoptionOwner?.id, "owner-single");

    const prepared = prepareWorkspaceUpgrade(plan);
    assert.ok(prepared.snapshot && existsSync(prepared.snapshot.directory));
    assert.deepEqual(verifyWorkspaceSnapshot(prepared.snapshot.directory).problems, []);
    assert.equal(prepared.snapshot.manifest.adoptedOwner?.id, "owner-single");

    // The adopted account is recorded for the migration and for the operator.
    const database = new DatabaseSync(workspace.databaseFile, { readOnly: true });
    try {
      const row = database.prepare('SELECT "ownerId" FROM "local_workspace_adoption"').get();
      assert.equal(row.ownerId, "owner-single");
    } finally {
      database.close();
    }
    const recorded = JSON.parse(readFileSync(join(workspace.backupsDirectory, "workspace-adoption.json"), "utf8"));
    assert.equal(recorded.ownerId, "owner-single");
  });

  it("reuses the existing snapshot instead of taking a second one", () => {
    const workspace = fixture({ owners: [{ id: "owner-single", email: "owner@example.invalid", chats: 1 }] });

    const first = prepareWorkspaceUpgrade(workspace.plan());
    const second = prepareWorkspaceUpgrade(workspace.plan());

    assert.ok(first.snapshot);
    assert.equal(second.snapshot, null);
    assert.match(second.message, /复用已有快照/);
  });

  it("rewrites adopted media and backup paths to the stable workspace directory", () => {
    const ownerId = "owner-single";
    const workspace = fixture({ owners: [{ id: ownerId, email: "owner@example.invalid", mediaAssets: 1 }] });
    const oldDirectory = createHash("sha256").update(ownerId).digest("hex");
    const newDirectory = createHash("sha256").update("cmt4aw3vg0000v1j0gkv9bhei").digest("hex");
    const oldBackupDirectory = join(workspace.backupsDirectory, oldDirectory);
    mkdirSync(oldBackupDirectory, { recursive: true });
    writeFileSync(join(oldBackupDirectory, "00000000-0000-0000-0000-000000000001.paib"), "backup");

    prepareWorkspaceUpgrade(workspace.plan());

    const database = new DatabaseSync(workspace.databaseFile, { readOnly: true });
    try {
      const asset = database.prepare('SELECT "id", "relativePath" FROM "media_assets"').get();
      assert.equal(asset.relativePath, `${newDirectory}/${asset.id}.png`);
      assert.equal(existsSync(join(workspace.mediaDirectory, asset.relativePath)), true);
      assert.equal(existsSync(join(workspace.mediaDirectory, oldDirectory, `${asset.id}.png`)), true);
    } finally {
      database.close();
    }
    assert.equal(existsSync(join(workspace.backupsDirectory, newDirectory, "00000000-0000-0000-0000-000000000001.paib")), true);
  });

  it("stops and asks for a choice when two accounts hold content", () => {
    const workspace = fixture({
      owners: [
        { id: "owner-one", email: "one@example.invalid", chats: 1 },
        { id: "owner-two", email: "two@example.invalid", memories: 1 },
      ],
    });

    const plan = workspace.plan();

    assert.equal(plan.state, "needs-owner-choice");
    assert.equal(plan.needsConversion, true);
    assert.match(plan.message, /需要先选择一个/);
    assert.equal(plan.adoptionOwner, null);
    assert.equal(plan.snapshot, null);

    // Nothing was written: no snapshot, no adoption row, data untouched.
    assert.equal(existsSync(join(workspace.backupsDirectory, "workspace-adoption.json")), false);
    const database = new DatabaseSync(workspace.databaseFile, { readOnly: true });
    try {
      const adoption = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_workspace_adoption'")
        .get();
      assert.equal(adoption, undefined);
    } finally {
      database.close();
    }
    assert.equal(readOwnerCounts(workspace.databaseFile, "owner-one").chats, 1);
    assert.equal(readOwnerCounts(workspace.databaseFile, "owner-two").memories, 1);
  });

  it("honours an explicitly chosen account", () => {
    const workspace = fixture({
      owners: [
        { id: "owner-one", email: "one@example.invalid", chats: 1 },
        { id: "owner-two", email: "two@example.invalid", memories: 2 },
      ],
    });

    const plan = workspace.plan({ environment: { LOCAL_WORKSPACE_OWNER: "owner-two" } });
    assert.equal(plan.state, "ready");
    assert.equal(plan.adoptionOwner?.id, "owner-two");

    const prepared = prepareWorkspaceUpgrade(plan);
    assert.equal(prepared.snapshot?.manifest.adoptedOwner?.id, "owner-two");
  });

  it("ignores an unknown or unsafe owner id", () => {
    const workspace = fixture({ owners: [{ id: "owner-one", email: "one@example.invalid", chats: 1 }] });

    const missing = workspace.plan({ environment: { LOCAL_WORKSPACE_OWNER: "not-an-owner" } });
    assert.equal(missing.state, "needs-owner-choice");

    const unsafe = workspace.plan({ environment: { LOCAL_WORKSPACE_OWNER: "owner'; DROP TABLE users; --" } });
    assert.equal(unsafe.state, "needs-owner-choice");
  });

  it("reads a recorded choice from the backups directory", () => {
    const workspace = fixture({
      owners: [
        { id: "owner-one", email: "one@example.invalid", chats: 1 },
        { id: "owner-two", email: "two@example.invalid", memories: 1 },
      ],
    });
    writeRecordedOwner(join(workspace.backupsDirectory, "workspace-adoption.json"), "owner-one");

    const plan = workspace.plan();
    assert.equal(plan.state, "ready");
    assert.equal(plan.adoptionOwner?.id, "owner-one");
  });

  it("reports an already converted database as needing no work", () => {
    const workspace = fixture({ owners: [] });
    const database = new DatabaseSync(workspace.databaseFile);
    database.exec('DROP TABLE "users"; DROP TABLE "sessions";');
    database.close();

    const plan = workspace.plan();

    assert.equal(plan.needsConversion, false);
    assert.equal(plan.state, "ready");
    assert.equal(plan.adoptionOwner, null);
    assert.match(plan.message, /已经是单用户工作区/);
  });

  it("handles a database with no accounts at all", () => {
    const workspace = fixture({ owners: [] });

    const plan = workspace.plan();

    assert.equal(plan.needsConversion, true);
    assert.equal(plan.state, "ready");
    assert.equal(plan.adoptionOwner, null);
    // Without accounts the migration keeps every row, so no snapshot is needed.
    assert.equal(prepareWorkspaceUpgrade(plan).snapshot, null);
  });
});

describe("desktop workspace upgrade entry point", () => {
  const logger = { info() {}, warn() {}, error() {} };

  it("prepares a single-account upgrade", () => {
    const workspace = fixture({ owners: [{ id: "owner-single", email: "owner@example.invalid", chats: 1 }] });
    const result = runWorkspaceUpgrade({
      desktopPaths: {
        projectRoot: workspace.root,
        databaseFile: workspace.databaseFile,
        mediaDirectory: workspace.mediaDirectory,
        backupsDirectory: workspace.backupsDirectory,
      },
      logger,
      environment: {},
    });

    assert.equal(result.state, "ready");
    assert.ok(result.snapshot);
  });

  it("refuses to merge accounts and explains what to do", () => {
    const workspace = fixture({
      owners: [
        { id: "owner-one", email: "one@example.invalid", chats: 1 },
        { id: "owner-two", email: "two@example.invalid", tasks: 1 },
      ],
    });

    assert.throws(
      () =>
        runWorkspaceUpgrade({
          desktopPaths: {
            projectRoot: workspace.root,
            databaseFile: workspace.databaseFile,
            mediaDirectory: workspace.mediaDirectory,
            backupsDirectory: workspace.backupsDirectory,
          },
          logger,
          environment: {},
        }),
      /需要先选择要保留的旧账户/,
    );
    // The refused upgrade must not have touched the data.
    assert.equal(readOwnerCounts(workspace.databaseFile, "owner-one").chats, 1);
    assert.equal(readOwnerCounts(workspace.databaseFile, "owner-two").tasks, 1);
  });
});

describe("workspace snapshot recovery", () => {
  it("restores the database that a failed upgrade replaced", () => {
    const workspace = fixture({
      owners: [{ id: "owner-single", email: "owner@example.invalid", chats: 2, memories: 1 }],
    });
    prepareWorkspaceUpgrade(workspace.plan());

    // Simulate a conversion that lost content.
    const database = new DatabaseSync(workspace.databaseFile);
    database.exec('DELETE FROM "chats"; DELETE FROM "memories";');
    database.close();

    const restored = restoreLatestWorkspaceSnapshot({
      databaseFile: workspace.databaseFile,
      backupsDirectory: workspace.backupsDirectory,
    });

    assert.ok(existsSync(restored.restoredFrom));
    assert.equal(readOwnerCounts(workspace.databaseFile, "owner-single").chats, 2);
    assert.equal(readOwnerCounts(workspace.databaseFile, "owner-single").memories, 1);
  });
});
