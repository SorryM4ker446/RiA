import { Client, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

const globalProxyState = globalThis as typeof globalThis & {
  __riaProxyConfigured?: boolean;
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

export function outboundProxyOptions(): EnvHttpProxyAgent.Options | null {
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) return null;
  const explicit = process.env.OUTBOUND_PROXY_URL?.trim();
  return {
    ...(explicit ? { httpProxy: explicit, httpsProxy: explicit } : { httpProxy: process.env.http_proxy || process.env.HTTP_PROXY || proxyUrl, httpsProxy: process.env.https_proxy || process.env.HTTPS_PROXY || proxyUrl }),
    noProxy: [process.env.no_proxy ?? process.env.NO_PROXY ?? "", "localhost", "127.0.0.1", "[::1]"].filter(Boolean).join(","),
  };
}

/** Supply the operation's deadline explicitly to Undici's proxy CONNECT. */
export function proxyTunnelClient(signal: AbortSignal, authority?: string): NonNullable<EnvHttpProxyAgent.Options["clientFactory"]> {
  return (origin, options) => {
    const client = new Client(origin, options);
    const connect = client.connect.bind(client);
    return Object.assign(client, {
      connect: (request: Dispatcher.ConnectOptions) => connect({
        ...request, signal,
        ...(authority ? { path: authority, headers: { ...request.headers, host: authority } } : {}),
      }),
    });
  };
}

export function setupServerProxy() {
  if (globalProxyState.__riaProxyConfigured) return;
  const options = outboundProxyOptions();
  if (options) {
    setGlobalDispatcher(new EnvHttpProxyAgent(options));
    console.info("[proxy] outbound proxy enabled");
  }
  globalProxyState.__riaProxyConfigured = true;
}
