import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const globalProxyState = globalThis as typeof globalThis & {
  __privateAiProxyConfigured?: boolean;
};

function resolveProxyUrl(): string | null {
  const envProxy =
    process.env.OUTBOUND_PROXY_URL ||
    process.env.HTTPS_PROXY ||
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

  if (!process.env.HTTPS_PROXY) {
    process.env.HTTPS_PROXY = proxyUrl;
  }
  if (!process.env.HTTP_PROXY) {
    process.env.HTTP_PROXY = proxyUrl;
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  globalProxyState.__privateAiProxyConfigured = true;

  console.info("[proxy] outbound proxy enabled");
}
