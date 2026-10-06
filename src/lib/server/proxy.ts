import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const globalProxyState = globalThis as typeof globalThis & {
  __privateAiProxyConfigured?: boolean;
};

function resolveProxyUrl(): string | null {
  const envProxy =
    process.env.OUTBOUND_PROXY_URL ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY;

  if (!envProxy) return null;
  const trimmed = envProxy.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function setupServerProxy() {
  if (globalProxyState.__privateAiProxyConfigured) return;

  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) {
    globalProxyState.__privateAiProxyConfigured = true;
    return;
  }

  const explicit = process.env.OUTBOUND_PROXY_URL?.trim();
  setGlobalDispatcher(new EnvHttpProxyAgent({
    ...(explicit ? { httpProxy: explicit, httpsProxy: explicit } : { httpProxy: process.env.http_proxy || process.env.HTTP_PROXY || proxyUrl, httpsProxy: process.env.https_proxy || process.env.HTTPS_PROXY || proxyUrl }),
    noProxy: [process.env.no_proxy ?? process.env.NO_PROXY ?? "", "localhost", "127.0.0.1", "[::1]"].filter(Boolean).join(","),
  }));
  globalProxyState.__privateAiProxyConfigured = true;

  console.info("[proxy] outbound proxy enabled");
}
