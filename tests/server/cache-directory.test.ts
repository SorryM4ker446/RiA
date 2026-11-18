import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { localCacheDirectory, localDataDirectory } from "@/lib/local/data-directory";
import { checkpointRoot } from "@/lib/checkpoints/store";
import { terminalLogRoot } from "@/lib/terminal/logs";

test("undo copies and terminal output follow the data unless the desktop app names a cache folder", () => {
  const previousDatabase = process.env.DATABASE_URL, previousCache = process.env.RIA_CACHE_DIRECTORY;
  try {
    process.env.DATABASE_URL = "file:D:/RiA Data/app.db";
    delete process.env.RIA_CACHE_DIRECTORY;
    assert.equal(localCacheDirectory("test"), localDataDirectory("test"));
    assert.equal(checkpointRoot(), join("D:/RiA Data", "checkpoints"));

    process.env.RIA_CACHE_DIRECTORY = "E:\\RiA cache";
    assert.equal(checkpointRoot(), join("E:\\RiA cache", "checkpoints"));
    assert.equal(terminalLogRoot(), join("E:\\RiA cache", "terminal-logs"));
    assert.equal(localDataDirectory("test"), "D:/RiA Data", "the data folder itself does not move with the cache");

    process.env.RIA_CACHE_DIRECTORY = "relative\\cache";
    assert.throws(() => localCacheDirectory("test"));
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousCache === undefined) delete process.env.RIA_CACHE_DIRECTORY; else process.env.RIA_CACHE_DIRECTORY = previousCache;
  }
});
