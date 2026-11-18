import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { GET } = await import("@/app/api/conversations/live/route");
after(cleanup);

test("the number of conversations answering now is read with local access only", async () => {
  const allowed = await GET(new NextRequest("http://127.0.0.1/api/conversations/live", { headers: { cookie: localAccessCookie() } }));
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { data: { answering: 0 } });
  const refused = await GET(new NextRequest("http://127.0.0.1/api/conversations/live"));
  assert.notEqual(refused.status, 200);
});
