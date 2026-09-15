import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { createTempDirectory } from "../helpers/temp-directory.mjs";
import { createLegacyWorkspace, readOwnerCounts } from "../helpers/legacy-workspace.mjs";
import { buildWorkspaceInventory, inspectLegacyDataset } from "../../electron/legacy-inventory.ts";
import {
  createWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
  verifyWorkspaceSnapshot,
} from "../../electron/workspace-snapshot.ts";

const temporaryDirectories = [];

function workspaceFixture(options = {}) {
  const temporary = createTempDirectory("private-ai-local-workspace-");
  temporaryDirectories.push(temporary);
  const workspace = createLegacyWorkspace(temporary.root, options);
  return { ...temporary, ...workspace, backupsDirectory: join(temporary.root, "backups") };
}

after(() => {
  for (const temporary of temporaryDirectories) temporary.remove();
});

describe("legacy workspace inventory", () => {
  it("reports an absent database without creating it", () => {
    const temporary = createTempDirectory("private-ai-local-workspace-");
    temporaryDirectories.push(temporary);
    const databaseFile = join(temporary.root, "app.db");

    const inventory = inspectLegacyDataset({ databaseFile });

    assert.equal(inventory.state, "absent");
    assert.equal(existsSync(databaseFile), false, "inspection must stay read-only");
  });

  it("treats a database without account tables as already workspace-scoped", () => {
    const temporary = createTempDirectory("private-ai-local-workspace-");
    temporaryDirectories.push(temporary);
    const workspace = createLegacyWorkspace(temporary.root, { owners: [] });
    const database = new DatabaseSync(workspace.databaseFile);
    database.exec('DROP TABLE "users"');
    database.close();

    const inventory = inspectLegacyDataset({ databaseFile: workspace.databaseFile });

    assert.equal(inventory.state, "empty");
    assert.equal(inventory.owners.length, 0);
    assert.ok(inventory.tables.includes("chats"));
  });

  it("distinguishes a placeholder account from an account with content", () => {
    const placeholder = workspaceFixture({ owners: [{ email: "demo@private-ai.local", name: "Demo User" }] });
    const withContent = workspaceFixture({
      owners: [{ email: "owner@example.invalid", name: "Owner", chats: 1, messagesPerChat: 2, memories: 3 }],
    });

    const placeholderInventory = inspectLegacyDataset({
      databaseFile: placeholder.databaseFile,
      mediaDirectory: placeholder.mediaDirectory,
    });
    const contentInventory = inspectLegacyDataset({
      databaseFile: withContent.databaseFile,
      mediaDirectory: withContent.mediaDirectory,
    });

    assert.equal(placeholderInventory.state, "single");
    assert.equal(placeholderInventory.owners[0].hasBusinessData, false);
    assert.deepEqual(placeholderInventory.owners[0].counts, {
      chats: 0,
      messages: 0,
      memories: 0,
      tasks: 0,
      mediaAssets: 0,
      knowledgeDocuments: 0,
      modelRequests: 0,
      preferences: 0,
    });

    assert.equal(contentInventory.owners[0].hasBusinessData, true);
    assert.equal(contentInventory.owners[0].counts.chats, 1);
    assert.equal(contentInventory.owners[0].counts.messages, 2);
    assert.equal(contentInventory.owners[0].counts.memories, 3);
  });

  it("normalizes both integer millisecond and SQL text timestamps", () => {
    const workspace = workspaceFixture({ owners: [{ email: "owner@example.invalid" }] });
    const database = new DatabaseSync(workspace.databaseFile);
    database.prepare('UPDATE "users" SET "createdAt" = ?').run(1_767_225_600_000);
    database.close();

    const inventory = inspectLegacyDataset({ databaseFile: workspace.databaseFile });
    assert.equal(inventory.owners[0].createdAt, new Date(1_767_225_600_000).toISOString());
  });

  it("reports unreadable data instead of guessing", () => {
    const temporary = createTempDirectory("private-ai-local-workspace-");
    temporaryDirectories.push(temporary);
    const databaseFile = join(temporary.root, "app.db");
    writeFileSync(databaseFile, "this is not a sqlite database");

    const inventory = inspectLegacyDataset({ databaseFile });

    assert.equal(inventory.state, "unreadable");
    assert.ok(inventory.unreadableReason);
    assert.deepEqual(buildWorkspaceInventory({ datasets: [{ databaseFile }] }).decision.action, "review");
  });

  it("initializes without asking when no dataset exists", () => {
    const temporary = createTempDirectory("private-ai-local-workspace-");
    temporaryDirectories.push(temporary);
    const decision = buildWorkspaceInventory({
      datasets: [{ databaseFile: join(temporary.root, "missing", "app.db") }],
    }).decision;
    assert.equal(decision.action, "initialize");
  });

  it("initializes without asking when the only dataset is empty", () => {
    const empty = workspaceFixture({ owners: [] });
    const decision = buildWorkspaceInventory({ datasets: [{ databaseFile: empty.databaseFile }] }).decision;
    assert.equal(decision.action, "initialize");
  });

  it("adopts the only dataset with content", () => {
    const workspace = workspaceFixture({
      owners: [{ id: "owner-with-content", email: "owner@example.invalid", chats: 2, messagesPerChat: 1 }],
    });
    const report = buildWorkspaceInventory({ datasets: [{ databaseFile: workspace.databaseFile }] });

    assert.equal(report.decision.action, "migrate");
    assert.equal(report.decision.datasetIndex, 0);
    assert.equal(report.decision.ownerId, "owner-with-content");
  });

  it("migrates an installed-application workspace that only holds placeholder accounts", () => {
    // Mirrors the real upgrade path: both the development and installed
    // databases contain a demo account and no user content.
    const development = workspaceFixture({ owners: [{ id: "demo-dev", email: "demo@private-ai.local" }] });
    const installed = workspaceFixture({ owners: [{ id: "demo-installed", email: "demo@private-ai.local" }] });

    const report = buildWorkspaceInventory({
      datasets: [{ databaseFile: development.databaseFile }, { databaseFile: installed.databaseFile }],
    });

    assert.equal(report.decision.action, "migrate");
    assert.equal(report.decision.ownerId, "demo-dev");
  });

  it("requires an explicit choice when two accounts hold content", () => {
    const first = workspaceFixture({ owners: [{ id: "owner-one", email: "one@example.invalid", chats: 1 }] });
    const second = workspaceFixture({ owners: [{ id: "owner-two", email: "two@example.invalid", memories: 2 }] });

    const report = buildWorkspaceInventory({
      datasets: [{ databaseFile: first.databaseFile }, { databaseFile: second.databaseFile }],
    });

    assert.equal(report.decision.action, "choose");
    assert.deepEqual(report.decision.candidates, [
      { datasetIndex: 0, ownerId: "owner-one" },
      { datasetIndex: 1, ownerId: "owner-two" },
    ]);
  });

  it("requires a choice when one database holds two accounts with content", () => {
    const workspace = workspaceFixture({
      owners: [
        { id: "owner-one", email: "one@example.invalid", chats: 1 },
        { id: "owner-two", email: "two@example.invalid", tasks: 1 },
      ],
    });

    const report = buildWorkspaceInventory({ datasets: [{ databaseFile: workspace.databaseFile }] });

    assert.equal(report.datasets[0].state, "multiple");
    assert.equal(report.decision.action, "choose");
    assert.equal(report.decision.candidates.length, 2);
  });

  it("ignores a placeholder account when another account holds content", () => {
    const placeholder = workspaceFixture({ owners: [{ id: "demo", email: "demo@private-ai.local" }] });
    const real = workspaceFixture({ owners: [{ id: "real-owner", email: "real@example.invalid", chats: 1 }] });

    const report = buildWorkspaceInventory({
      datasets: [{ databaseFile: placeholder.databaseFile }, { databaseFile: real.databaseFile }],
    });

    assert.equal(report.decision.action, "migrate");
    assert.equal(report.decision.datasetIndex, 1);
    assert.equal(report.decision.ownerId, "real-owner");
  });

  it("counts media files but never follows links", (context) => {
    const outside = createTempDirectory("private-ai-outside-media-");
    temporaryDirectories.push(outside);
    writeFileSync(join(outside.root, "outside.bin"), "x".repeat(1024));

    const workspace = workspaceFixture({
      owners: [{ email: "owner@example.invalid", mediaAssets: 1 }],
      mediaLinks: [{ path: "linked", target: outside.root }],
    });
    const linkCreated = existsSync(join(workspace.mediaDirectory, "linked"));
    if (!linkCreated) {
      context.diagnostic("Link creation is unavailable; skipping the link assertion.");
    }

    const inventory = inspectLegacyDataset({
      databaseFile: workspace.databaseFile,
      mediaDirectory: workspace.mediaDirectory,
    });

    assert.equal(inventory.media.available, true);
    assert.equal(inventory.media.fileCount, 1, "the linked directory must not be walked");
    assert.equal(inventory.media.totalBytes, Buffer.byteLength("asset-asset-0001"));
    if (linkCreated) assert.equal(inventory.media.skippedLinks, 1);
  });

  it("stops a media walk at the file limit", () => {
    const workspace = workspaceFixture({ owners: [{ email: "owner@example.invalid", mediaAssets: 5 }] });
    const inventory = inspectLegacyDataset({
      databaseFile: workspace.databaseFile,
      mediaDirectory: workspace.mediaDirectory,
      mediaLimits: { maxFiles: 2, maxDepth: 4 },
    });

    assert.equal(inventory.media.fileCount, 2);
    assert.equal(inventory.media.truncated, true);
  });
});

describe("workspace snapshot", () => {
  function snapshotFixture() {
    const fixture = workspaceFixture({
      owners: [
        {
          id: "owner-snapshot",
          email: "owner@example.invalid",
          name: "Owner",
          chats: 2,
          messagesPerChat: 2,
          memories: 1,
          tasks: 1,
          mediaAssets: 2,
          modelRequests: 3,
          preferences: { defaultMode: "image" },
        },
      ],
    });
    const inventory = inspectLegacyDataset({
      databaseFile: fixture.databaseFile,
      mediaDirectory: fixture.mediaDirectory,
    });
    return { ...fixture, inventory };
  }

  function takeSnapshot(fixture, suffix = "upgrade") {
    return createWorkspaceSnapshot({
      databaseFile: fixture.databaseFile,
      mediaDirectory: fixture.mediaDirectory,
      backupsDirectory: fixture.backupsDirectory,
      inventory: fixture.inventory,
      adoptedOwner: fixture.inventory.owners[0],
      decisionReason: "仅有一个数据集包含业务内容，按该数据集迁移。",
      suffix,
    });
  }

  it("records the database, its content and the media references it depends on", () => {
    const fixture = snapshotFixture();
    const snapshot = takeSnapshot(fixture);

    assert.ok(existsSync(snapshot.databaseFile));
    assert.ok(existsSync(join(snapshot.directory, "snapshot.json")));
    assert.ok(existsSync(join(snapshot.directory, "media-index.json")));

    const manifest = snapshot.manifest;
    assert.equal(manifest.tableCounts.chats, 2);
    assert.equal(manifest.tableCounts.messages, 4);
    assert.equal(manifest.tableCounts.memories, 1);
    assert.equal(manifest.adoptedOwner?.id, "owner-snapshot");
    assert.equal(manifest.media.fileCount, 2);
    assert.equal(manifest.media.missingCount, 0);
    assert.equal(manifest.databaseBytes > 0, true);

    const mediaIndex = JSON.parse(readFileSync(join(snapshot.directory, "media-index.json"), "utf8"));
    assert.equal(mediaIndex.entries.length, 2);
    assert.equal(mediaIndex.entries.every((entry) => entry.missing === false), true);
    assert.equal(mediaIndex.entries[0].sha256.length, 64);
  });

  it("verifies itself and detects a damaged copy", () => {
    const fixture = snapshotFixture();
    const snapshot = takeSnapshot(fixture);

    assert.deepEqual(verifyWorkspaceSnapshot(snapshot.directory).problems, []);

    const databaseFile = join(snapshot.directory, "app.db");
    const bytes = readFileSync(databaseFile);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(databaseFile, bytes);

    const verification = verifyWorkspaceSnapshot(snapshot.directory);
    assert.equal(verification.ok, false);
    assert.ok(verification.problems.some((problem) => problem.includes("校验值")));
  });

  it("lists snapshots and ignores unrelated backup files", () => {
    const fixture = snapshotFixture();
    const snapshot = takeSnapshot(fixture, "first");
    writeFileSync(join(fixture.backupsDirectory, "app.db.2026-01-01.bak"), "not a snapshot");

    const snapshots = listWorkspaceSnapshots(fixture.backupsDirectory);

    assert.deepEqual(snapshots, [snapshot.directory]);
  });

  it("restores the pre-upgrade database and keeps the replaced file", () => {
    const fixture = snapshotFixture();
    const snapshot = takeSnapshot(fixture);

    // Simulate a destructive upgrade that loses content.
    const database = new DatabaseSync(fixture.databaseFile);
    database.exec('DELETE FROM "messages"; DELETE FROM "chats";');
    database.close();
    assert.equal(readOwnerCounts(fixture.databaseFile, "owner-snapshot").chats, 0);

    const restored = restoreWorkspaceSnapshot({
      snapshotDirectory: snapshot.directory,
      targetDatabaseFile: fixture.databaseFile,
    });

    assert.ok(restored.replacedBackupFile && existsSync(restored.replacedBackupFile));
    assert.equal(readOwnerCounts(fixture.databaseFile, "owner-snapshot").chats, 2);
    const reopened = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    try {
      assert.equal(Number(reopened.prepare('SELECT count(*) AS count FROM "messages"').get().count), 4);
    } finally {
      reopened.close();
    }
  });

  it("refuses to restore a snapshot that fails verification", () => {
    const fixture = snapshotFixture();
    const snapshot = takeSnapshot(fixture);

    const databaseFile = join(snapshot.directory, "app.db");
    writeFileSync(databaseFile, "corrupted snapshot");
    const before = readOwnerCounts(fixture.databaseFile, "owner-snapshot");

    assert.throws(
      () =>
        restoreWorkspaceSnapshot({
          snapshotDirectory: snapshot.directory,
          targetDatabaseFile: fixture.databaseFile,
        }),
      /快照未通过校验/,
    );
    assert.deepEqual(readOwnerCounts(fixture.databaseFile, "owner-snapshot"), before);
  });

  it("reports missing media instead of silently dropping it", () => {
    const fixture = snapshotFixture();
    const ownerDirectory = createHash("sha256").update("owner-snapshot").digest("hex");
    rmSync(join(fixture.mediaDirectory, ownerDirectory), { recursive: true, force: true });

    const snapshot = takeSnapshot(fixture, "missing-media");

    assert.equal(snapshot.manifest.media.missingCount, 2);
    const mediaIndex = JSON.parse(readFileSync(join(snapshot.directory, "media-index.json"), "utf8"));
    assert.equal(mediaIndex.entries.every((entry) => entry.missing === true), true);
  });
});
