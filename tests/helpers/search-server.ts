import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type SearchRequest = { path?: string; body: any };

/** Answer with DeepSeek's independent search response shape. */
export function respondWithResults(res: ServerResponse, results: unknown[]) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ results }));
}

const fixtureResult = { title: "Local fixture", url: "https://example.invalid/fixture", summary: "fixture", rerank_score: 1 };

/**
 * A loopback stand-in for DeepSeek's independent search endpoint, so the search
 * tool genuinely runs over HTTP without a billed request. Point
 * DEEPSEEK_BASE_URL at `baseURL` (seedSearchModelPreferences does).
 */
export async function startSearchServer(respond: (res: ServerResponse, request: SearchRequest) => void = res => respondWithResults(res, [fixtureResult])) {
  const requests: SearchRequest[] = [];
  let disconnected: () => void = () => {};
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer(async (req, res) => {
    res.once("close", disconnected);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || "null") };
    requests.push(request);
    respond(res, request);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    closed,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
