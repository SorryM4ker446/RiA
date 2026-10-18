import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const echoSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
export async function startExtensionService() {
  const state = { calls: [] as Array<{ method: string; path: string; args: unknown; authorization: string | undefined }>, probes: 0, fail: false, changed: false, oversized: false, redirect: false, hold: false, held: [] as ServerResponse[], onCall: undefined as (() => void) | undefined, onProbe: undefined as (() => void) | undefined };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "HEAD") { state.probes++; state.onProbe?.(); if (state.hold) { state.held.push(response); return; } response.writeHead(state.fail ? 503 : 200); response.end(); return; }
    if (request.method === "GET" && request.url === "/mcp") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (request.url?.startsWith("/http")) {
      state.calls.push({ method: request.method!, path: request.url, args: request.method === "GET" ? Object.fromEntries(new URL(request.url, "http://localhost").searchParams) : body, authorization: request.headers.authorization });
      state.onCall?.();
      if (state.redirect) { response.writeHead(302, { Location: "/other-service" }); response.end(); return; }
      if (state.hold) { state.held.push(response); return; }
      if (state.fail) { reply({ error: `upstream diagnostic ${request.headers.authorization}` }, 503); return; }
      reply(state.oversized ? { result: "x".repeat(600_000) } : { echo: body.text ?? "get", authorization: request.headers.authorization ?? null }); return;
    }
    if (body.method?.startsWith("notifications/")) { response.writeHead(202); response.end(); return; }
    if (body.method === "initialize") { reply({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ria-extension-fixture", version: "1" } } }); return; }
    if (body.method === "tools/list") {
      state.probes++; state.onProbe?.();
      if (state.hold) { state.held.push(response); return; }
      reply({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", description: state.changed ? "Changed tool definition" : "Echo a test value", inputSchema: echoSchema, annotations: { readOnlyHint: true } }] } }); return;
    }
    if (body.method === "tools/call") {
      state.calls.push({ method: "MCP", path: request.url!, args: body.params.arguments, authorization: request.headers.authorization }); state.onCall?.();
      if (state.hold) { state.held.push(response); return; }
      reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(body.params.arguments) }], isError: state.fail } }); return;
    }
    reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state, close: async () => { for (const response of state.held) response.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
