export const SQLITE_POOL_TIMEOUT_SECONDS = 30;

/** Keep concurrent application queries in a bounded queue instead of competing for SQLite's write lock. */
export function sqliteDatasourceUrl(url: string | undefined): string | undefined {
  if (!url?.startsWith("file:")) return url;

  // Do not parse the path as a URL: Prisma also accepts relative and Windows paths.
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const params = new URLSearchParams(queryStart === -1 ? "" : url.slice(queryStart + 1));
  params.set("connection_limit", "1");
  params.set("pool_timeout", String(SQLITE_POOL_TIMEOUT_SECONDS));
  params.set("socket_timeout", "5");
  return `${path}?${params}`;
}
