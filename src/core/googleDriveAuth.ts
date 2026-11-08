// Google Drive authentication for Obsidian.
// Uses RSA hybrid encrypted auth exported from kiokuflow.
// Token refresh is proxied through kiokuflow API (clientId/clientSecret stay server-side).

import { requestUrl } from "obsidian";
import { findFileByExactName, readFile } from "./googleDrive";
import {
  buildTokenRefreshRequest,
  decodeMigrationToken,
  decryptEncryptedAuth,
  ENCRYPTED_AUTH_FILE_NAME,
  needsTokenRefresh,
  parseEncryptedAuthFile,
  parseTokenRefreshResponse,
  type EncryptedAuthFile,
  type ExternalSyncCredentials,
} from "kiokuflow-sync-core/auth";
import type { DriveSessionTokens } from "src/types";

// Token, _encrypted-auth.json and refresh message formats are shared with
// kiokuflow web and Desktop (kiokuflow-sync-core/auth); only the transport
// (Obsidian requestUrl) lives here.

/**
 * Decode a kiokuflow Migration Tool token (hex-encoded XOR 0x5a payload).
 * Returns { accessToken, rootFolderId }.
 */
export function decodeBackupToken(hexToken: string): { accessToken: string; rootFolderId: string } {
  return decodeMigrationToken(hexToken);
}

/**
 * Fetch _encrypted-auth.json from Drive using a temporary access token.
 * Returns RSA hybrid encrypted auth fields.
 */
export async function fetchEncryptedAuth(
  accessToken: string,
  rootFolderId: string
): Promise<EncryptedAuthFile> {
  const file = await findFileByExactName(accessToken, ENCRYPTED_AUTH_FILE_NAME, rootFolderId);
  if (!file) {
    throw new Error("_encrypted-auth.json not found on Drive. Export from kiokuflow first.");
  }
  return parseEncryptedAuthFile(await readFile(accessToken, file.id));
}

/**
 * Decrypt the RSA hybrid encrypted auth payload with user password.
 * Rejects non-https API origins.
 */
export async function decryptAuthData(
  data: string,
  encryptedPrivateKey: string,
  salt: string,
  password: string
): Promise<ExternalSyncCredentials> {
  return decryptEncryptedAuth({ data, encryptedPrivateKey, salt }, password);
}

/**
 * Refresh the access token via kiokuflow API proxy.
 * The server holds clientId/clientSecret and forwards to Google; rootFolderId
 * lets it resolve the account that owns the synced Drive folder.
 */
export async function refreshAccessToken(
  apiOrigin: string,
  refreshToken: string,
  rootFolderId?: string,
): Promise<{ accessToken: string; expiryTime: number }> {
  const request = buildTokenRefreshRequest({ apiOrigin, refreshToken }, rootFolderId);
  const response = await requestUrl({ ...request, throw: false });
  let body: unknown = null;
  try {
    body = response.json;
  } catch {
    // Non-JSON error page: fall through to the HTTP status message.
  }
  return parseTokenRefreshResponse(response.status, body);
}

let refreshInflight: Promise<DriveSessionTokens> | null = null;

/**
 * Get a valid access token from session tokens, refreshing if needed (5-minute buffer).
 * Concurrent calls are deduplicated so only one refresh request is made.
 */
export async function getValidSessionTokens(
  session: DriveSessionTokens
): Promise<DriveSessionTokens> {
  if (!needsTokenRefresh(session.expiryTime)) {
    return session;
  }

  if (refreshInflight) {
    return refreshInflight;
  }

  refreshInflight = (async () => {
    try {
      const refreshed = await refreshAccessToken(
        session.apiOrigin,
        session.refreshToken,
        session.rootFolderId,
      );
      return {
        ...session,
        accessToken: refreshed.accessToken,
        expiryTime: refreshed.expiryTime,
      };
    } finally {
      refreshInflight = null;
    }
  })();

  return refreshInflight;
}
