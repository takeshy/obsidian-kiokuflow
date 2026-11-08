// Sync utility functions for Google Drive sync.
// Exclusion and file type rules come from gemihub-sync-core (shared with
// kiokuflow web and Desktop); only the Obsidian-specific folders live here.

import {
  isSyncExcludedPath as isCoreSyncExcludedPath,
  SYNC_EXCLUDED_PREFIXES as CORE_SYNC_EXCLUDED_PREFIXES,
} from "gemihub-sync-core/paths";
import { guessMimeType, shouldTreatAsBinaryFile } from "gemihub-sync-core/files";
import { LEGACY_WORKSPACE_FOLDER, WORKSPACE_FOLDER } from "../types";

export { SYNC_EXCLUDED_FILE_NAMES, isGoogleWorkspaceMimeType } from "gemihub-sync-core/paths";
export { isBinaryMimeType, looksLikeBinary } from "gemihub-sync-core/files";

/** Shared system folders plus Obsidian's own trash folder. */
export const SYNC_EXCLUDED_PREFIXES = [...CORE_SYNC_EXCLUDED_PREFIXES, ".trash/"];

export function isSyncExcludedPath(filePath: string, userExcludePatterns: string[] = [], configDir?: string): boolean {
  return isCoreSyncExcludedPath(filePath, {
    excludePatterns: userExcludePatterns,
    extraPrefixes: [
      ".trash/",
      // Plugin workspace folder (chat history, sync meta, conflict backups)
      `${WORKSPACE_FOLDER}/`,
      `${LEGACY_WORKSPACE_FOLDER}/`,
      // Obsidian config directory (configurable via Vault.configDir)
      ...(configDir ? [`${configDir}/`] : []),
    ],
  });
}

/** MIME type for a vault path (shared table). */
export function getMimeType(filePath: string): string {
  return guessMimeType(filePath);
}

/**
 * Whether a vault file is synced as binary. Unknown extensions are binary:
 * decoding arbitrary bytes as UTF-8 and writing them back as text can
 * irreversibly corrupt the file.
 */
export function isBinaryExtension(filePath: string): boolean {
  return shouldTreatAsBinaryFile(filePath);
}

// MD5 (pure JS, for Drive md5Checksum comparison) is shared too.
export { md5Hash, md5HashString } from "gemihub-sync-core/hash";
