import { shell, type BrowserWindow, type Session } from "electron";
import type { DesktopLogger } from "./logger";

function isTrustedExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function configureDesktopSession(input: {
  session: Session;
  origin: string;
  development: boolean;
  logger: DesktopLogger;
}) {
  input.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  input.session.setPermissionCheckHandler(() => false);

  const scriptPolicy = input.development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  const connectPolicy = input.development
    ? `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*`
    : "connect-src 'self'";
  const contentSecurityPolicy = [
    "default-src 'self'",
    scriptPolicy,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    connectPolicy,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  input.session.webRequest.onHeadersReceived(
    { urls: [`${input.origin}/*`] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy],
          "Cross-Origin-Opener-Policy": ["same-origin"],
          "X-Content-Type-Options": ["nosniff"],
          "Referrer-Policy": ["no-referrer"],
        },
      });
    },
  );
}

export function secureBrowserWindow(input: {
  window: BrowserWindow;
  origin: string;
  logger: DesktopLogger;
}) {
  input.window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  input.window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === input.origin) return;
    } catch {
      // Invalid navigation targets are denied below.
    }
    event.preventDefault();
    input.logger.warn("Blocked renderer navigation", { url });
  });
  input.window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedExternalUrl(url)) {
      void shell.openExternal(url).catch((error) => input.logger.warn("Unable to open external URL", error));
    } else {
      input.logger.warn("Blocked untrusted external URL", { url });
    }
    return { action: "deny" };
  });
}
