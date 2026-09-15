import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/api-error";

/**
 * Local access credential.
 *
 * The workspace has no account and no login. What protects it is a credential
 * that only a process or page on this machine can obtain:
 *
 * - the packaged application receives a random token from its main process,
 *   which sets the desktop session cookie before the window loads;
 * - browser development exchanges a short-lived handshake code for an HttpOnly
 *   cookie through the local entry point.
 *
 * A request from an ordinary web page cannot obtain either one: reading the
 * cookie requires an actual same-origin navigation on this machine, and
 * DNS-rebinding is rejected because a non-loopback Host is refused.
 */

export const LOCAL_ACCESS_COOKIE = "local_access";
export const LOCAL_HANDSHAKE_QUERY = "handshake";

const TOKEN_BYTES = 32;
const HANDSHAKE_TTL_MS = 5 * 60_000;

type LocalAccessState = {
  token: string | null;
  handshake: { code: string; expiresAt: number } | null;
};

const shared = globalThis as typeof globalThis & { localAccessState?: LocalAccessState };
const state: LocalAccessState = shared.localAccessState ??= { token: null, handshake: null };

// The launcher's handshake code is adopted on first use in this process.
registerConfiguredHandshake();

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The credential automated tests present.
 *
 * A launcher that starts its own service writes this value to a token file next
 * to the database. The service reads that file at run time, so the harness and
 * the service agree on one credential even though they are separate processes.
 * Nothing writes the file for an installed or interactive development service,
 * which therefore keeps a random token per process.
 */
export const TEST_ACCESS_TOKEN = "00000000000000000000000000000000feedface";
const ACCESS_TOKEN_FILE = ".local-access-token";
export const ACCESS_DIAGNOSTIC_FILE = "access-diagnostic.log";

/** The directory holding the database, resolved at run time. */
function databaseDirectory(): string | null {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl.startsWith("file:")) return null;
  const databaseFile = databaseUrl.slice("file:".length);
  return databaseFile ? dirname(databaseFile) : null;
}

/**
 * Reads the launcher-provided credential, if any.
 *
 * This deliberately reads a file rather than an environment variable: the
 * environment is evaluated when the bundle is built, so a value provided at
 * start-up would not reach the running server.
 */
function pinnedAccessToken(): string | null {
  try {
    const directory = databaseDirectory();
    if (!directory) return null;
    const tokenFile = join(directory, ACCESS_TOKEN_FILE);
    if (!existsSync(tokenFile)) return null;
    const value = readFileSync(tokenFile, "utf8").trim();
    return /^[a-f0-9]{32,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Records which credential the service resolved and what a rejected request
 * presented. The location is derived from the database path at run time, not
 * from the environment, for the same reason the token is.
 *
 * Only a service started by a harness (one with a pinned credential file)
 * writes this, so an ordinary installation keeps no such file.
 */
export function writeAccessDiagnostic(entry: Record<string, unknown>) {
  try {
    const directory = databaseDirectory();
    if (!directory) return;
    if (!existsSync(join(directory, ACCESS_TOKEN_FILE))) return;
    appendFileSync(join(directory, ACCESS_DIAGNOSTIC_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Diagnostics must never break the request path.
  }
}

/** Issued once per server process; restarting the service invalidates it. */
export function localAccessToken(): string {
  if (!state.token) {
    const pinned = pinnedAccessToken();
    state.token = pinned ?? randomBytes(TOKEN_BYTES).toString("hex");
    // The serving process records what it resolved, so a harness that starts it
    // can read the answer instead of inferring it from rejected requests.
    writeAccessDiagnostic({
      event: "token-resolved",
      source: pinned ? "file" : "random",
      token: state.token.slice(0, 10),
      databaseUrl: process.env.DATABASE_URL ?? null,
    });
  }
  return state.token;
}

/**
 * Handshake codes are valid for a few minutes and then stop working. The
 * development launcher generates one and passes it to the serving process
 * through the environment, so it can also print the link the user opens. The
 * code only authorizes issuing the access cookie to a request that already
 * comes from this machine as a top-level navigation.
 */
export function issueHandshakeCode(): string {
  const provided = process.env.LOCAL_HANDSHAKE_CODE?.trim();
  const code = provided && /^[a-f0-9]{16,128}$/.test(provided) ? provided : randomBytes(24).toString("hex");
  state.handshake = { code, expiresAt: Date.now() + HANDSHAKE_TTL_MS };
  return code;
}

/** The serving process registers the launcher's code at startup. */
export function registerConfiguredHandshake() {
  const provided = process.env.LOCAL_HANDSHAKE_CODE?.trim();
  if (!provided || !/^[a-f0-9]{16,128}$/.test(provided)) return;
  state.handshake = { code: provided, expiresAt: Date.now() + HANDSHAKE_TTL_MS };
}

/**
 * Exchanges the launcher's code once. A consumed or expired code is refused,
 * so a link that leaked cannot be replayed.
 */
export function consumeHandshakeCode(code: string | null | undefined): boolean {
  const pending = state.handshake;
  state.handshake = null;
  if (!pending || !code) return false;
  if (pending.expiresAt <= Date.now()) return false;
  return constantTimeEquals(pending.code, code);
}

export function hasValidLocalAccess(request: NextRequest): boolean {
  const presented = request.cookies.get(LOCAL_ACCESS_COOKIE)?.value;
  const expected = localAccessToken();
  const valid = Boolean(presented) && constantTimeEquals(presented ?? "", expected);
  if (!valid) {
    writeAccessDiagnostic({
      event: "access-rejected",
      url: request.url,
      host: request.headers.get("host"),
      cookieHeader: request.headers.get("cookie") ? "present" : "absent",
      presented: presented ? presented.slice(0, 10) : null,
      expected: expected.slice(0, 10),
    });
  }
  return valid;
}

/**
 * Browser development only: the app is reached from a real page on this
 * machine. Requests that carry a browser Origin are cross-site by definition,
 * because a same-origin navigation never sends one.
 */
export function isTopLevelLocalNavigation(request: NextRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.get("origin") !== null) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "none" && site !== "same-origin") return false;
  return true;
}

export function assertLocalAccess(request: NextRequest) {
  if (hasValidLocalAccess(request)) return;
  throw new ApiError({
    code: "UNAUTHORIZED",
    message: "本地访问凭证缺失或无效，请从本机打开应用重新获取。",
  });
}
