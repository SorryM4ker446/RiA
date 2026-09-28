import assert from "node:assert/strict";
import { test } from "node:test";
import { sqliteDatasourceUrl } from "@/db/sqlite-url";

for (const path of ["file:./app.db", "file:D:/data with spaces/app.db", "file:///D:/data/app.db", "file:/tmp/data%20space/app.db"]) {
  test(`SQLite connection policy preserves the database path ${path}`, () => {
    assert.equal(sqliteDatasourceUrl(path), `${path}?connection_limit=1&pool_timeout=30&socket_timeout=5`);
  });
}

test("SQLite connection policy replaces conflicting limits and preserves other parameters", () => {
  const path = "file:D:/data with spaces/app.db";
  const url = sqliteDatasourceUrl(`${path}?connection_limit=17&connection_limit=8&pool_timeout=0&socket_timeout=60&connection_timeout=12`);
  assert.equal(url.slice(0, url.indexOf("?")), path);
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.deepEqual(params.getAll("connection_limit"), ["1"]);
  assert.deepEqual(params.getAll("pool_timeout"), ["30"]);
  assert.deepEqual(params.getAll("socket_timeout"), ["5"]);
  assert.equal(params.get("connection_timeout"), "12");
  assert.equal(sqliteDatasourceUrl(url), url);
});

test("SQLite connection policy leaves missing or non-file configuration to Prisma validation", () => {
  assert.equal(sqliteDatasourceUrl(undefined), undefined);
  assert.equal(sqliteDatasourceUrl(""), "");
  assert.equal(sqliteDatasourceUrl("unsupported:database"), "unsupported:database");
});
