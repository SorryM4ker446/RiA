import { localAccessToken as issueToken } from "../../src/lib/server/local-access.ts";

/**
 * Credential for server tests.
 *
 * Routes authenticate the local application credential rather than an account,
 * so a test only has to present the token this process issues. Nothing in the
 * suite can present a cross-owner credential, because there is no second owner.
 */
export const localAccessCookie = () => `local_access=${issueToken()}`;
export const localAccessToken = () => issueToken();
