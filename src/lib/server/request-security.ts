import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/api-error";

function forbidden(message: string): never {
  throw new ApiError({ code: "FORBIDDEN", message });
}

/** Shared by Proxy and handlers: Proxy alone is not the authorization boundary. */
export function assertRequestSecurity(request: NextRequest) {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  let expectedOrigin: string;
  if (process.env.APP_RUNTIME === "desktop") {
    const expectedHost = process.env.DESKTOP_SERVER_HOST;
    if (!expectedHost || request.headers.get("host") !== expectedHost) forbidden("Desktop requests require the local application host.");
    expectedOrigin = `http://${expectedHost}`;
    if (url.pathname !== "/api/health") {
      const expectedToken = process.env.DESKTOP_SESSION_TOKEN;
      if (!expectedToken || request.cookies.get("desktop_session")?.value !== expectedToken) {
        forbidden("Desktop API session is missing or invalid.");
      }
    }
  } else if (process.env.APP_ORIGIN?.trim()) {
    const configured = process.env.APP_ORIGIN.trim();
    let origin: URL;
    try { origin = new URL(configured); }
    catch { throw new ApiError({ code: "CONFIGURATION_ERROR", message: "APP_ORIGIN must be an HTTP(S) origin" }); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== configured) {
      throw new ApiError({ code: "CONFIGURATION_ERROR", message: "APP_ORIGIN must be an exact HTTP(S) origin without a path" });
    }
    if (host !== origin.host) forbidden("Request host is not allowed.");
    expectedOrigin = origin.origin;
  } else {
    // Local default also prevents DNS rebinding when demo authentication is enabled.
    let hostUrl: URL;
    try { hostUrl = new URL(`${url.protocol}//${host}`); }
    catch { forbidden("Invalid request host."); }
    if (hostUrl.host !== host || !["localhost", "127.0.0.1", "[::1]"].includes(hostUrl.hostname)) forbidden("Configure APP_ORIGIN to use a non-loopback host.");
    expectedOrigin = hostUrl.origin;
  }

  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin !== null && origin !== expectedOrigin) forbidden("Cross-origin API writes are not allowed.");
  if (site && site !== "same-origin" && site !== "none") forbidden("Cross-site API writes are not allowed.");
  // Non-browser clients can omit Origin. Browser writes must establish their origin.
  if (origin === null && site && site !== "same-origin") forbidden("Browser API writes require a same-origin context.");
}
