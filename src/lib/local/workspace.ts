import type { NextRequest } from "next/server";
import { assertRequestSecurity } from "@/lib/server/request-security";
import { readEmptyBody } from "@/lib/server/request-body";
import { identifyDataOperation } from "@/lib/server/data-operations";

/**
 * The single local workspace.
 *
 * One installation owns one workspace. There is no account and no login: the
 * local application credential (the desktop session cookie for the packaged
 * application, or the loopback credential issued by the local entry point)
 * decides whether a request may touch the data at all. That credential is
 * enforced by `assertRequestSecurity`.
 */

/**
 * Stable identifier of the local workspace.
 *
 * It is not an account. It names the workspace in derived values that are
 * already on disk, such as the media directory name
 * (`sha256(workspaceId)`), so the value must not change between releases.
 */
export const LOCAL_WORKSPACE_ID = "cmt4aw3vg0000v1j0gkv9bhei";

export type LocalWorkspace = { id: string };

const WORKSPACE: LocalWorkspace = { id: LOCAL_WORKSPACE_ID };

export function localWorkspace(): LocalWorkspace {
  return WORKSPACE;
}

/**
 * Validates local access for one request and returns the workspace it belongs
 * to. Use this in every protected API route.
 */
export async function requireLocalWorkspace(req: NextRequest): Promise<LocalWorkspace> {
  assertRequestSecurity(req);
  if (req.method === "DELETE") await readEmptyBody(req);
  identifyDataOperation(WORKSPACE.id);
  return WORKSPACE;
}

/** Only for read paths that must not fail when nothing is configured yet. */
export function currentWorkspaceId(): string {
  return LOCAL_WORKSPACE_ID;
}
