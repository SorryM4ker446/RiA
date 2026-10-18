import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio-echo", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo a test value", inputSchema: schema }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify({ text: request.params.arguments.text, leakedAppKey: !!process.env.RIA_EXTENSION_KEY, leakedAccess: !!process.env.LOCAL_ACCESS_TOKEN, ownToken: process.env.FIXTURE_TOKEN ?? null }) }] };
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
