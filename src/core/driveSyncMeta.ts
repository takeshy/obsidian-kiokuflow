// Sync metadata management for Google Drive sync.
// Manages both local (Vault) and remote (Drive) sync metadata.
// Adapted from kiokuflow's sync-meta.server.ts.

import type { App } from "obsidian";
import { WORKSPACE_FOLDER } from "../types";
import {
  buildConflictBackupName as buildCoreConflictBackupName,
  parseConflictBackupName,
} from "gemihub-sync-core/conflict";
import { createSyncMetaStore, removeFilesFromMeta, upsertDriveFileInMeta } from "gemihub-sync-core/sync-meta";
import {
  listUserFiles,
  readFile,
  createFile,
  updateFile,
  deleteFile,
  findFilesByExactName,
  getFileMetadata,
  type DriveFile,
} from "./googleDrive";
import type { FileSyncMeta, SyncMeta } from "./syncDiff";

// ========================================
// Local sync metadata (stored in Vault)
// ========================================

export interface LocalDriveSyncMeta {
  lastUpdatedAt: string;
  files: Record<string, {
    md5Checksum: string;
    modifiedTime: string;
    name?: string;
    localMtime?: number;  // Vault file mtime (epoch ms) for checksum skip
    localSize?: number;   // Vault file size (bytes) for checksum skip
  }>;
  pathToId: Record<string, string>;  // Vault path → Drive file ID
}

const EMPTY_LOCAL_META: LocalDriveSyncMeta = {
  lastUpdatedAt: "",
  files: {},
  pathToId: {},
};

export function getLocalMetaPath(): string {
  return `${WORKSPACE_FOLDER}/drive-sync-meta.json`;
}

export async function readLocalSyncMeta(
  app: App,
): Promise<LocalDriveSyncMeta> {
  const metaPath = getLocalMetaPath();
  try {
    const exists = await app.vault.adapter.exists(metaPath);
    if (!exists) return { ...EMPTY_LOCAL_META, files: {}, pathToId: {} };
    const content = await app.vault.adapter.read(metaPath);
    return JSON.parse(content) as LocalDriveSyncMeta;
  } catch (err) {
    console.error("[DriveSync] Failed to read local sync meta:", err);
    return { ...EMPTY_LOCAL_META, files: {}, pathToId: {} };
  }
}

export async function writeLocalSyncMeta(
  app: App,
  meta: LocalDriveSyncMeta
): Promise<void> {
  const metaPath = getLocalMetaPath();
  // Ensure workspace folder exists
  const folderExists = await app.vault.adapter.exists(WORKSPACE_FOLDER);
  if (!folderExists) {
    await app.vault.adapter.mkdir(WORKSPACE_FOLDER);
  }
  await app.vault.adapter.write(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Build a reverse map: Drive file ID → Vault path
 */
export function buildIdToPathMap(meta: LocalDriveSyncMeta): Record<string, string> {
  const idToPath: Record<string, string> = {};
  for (const [path, id] of Object.entries(meta.pathToId)) {
    idToPath[id] = path;
  }
  return idToPath;
}

// ========================================
// Remote sync metadata (stored on Drive as _sync-meta.json)
// ========================================

// Reading (with duplicate consolidation), reconciliation and writing are
// shared with kiokuflow web and Desktop (gemihub-sync-core/sync-meta). Bound
// through this module's imports so tests can replace the Drive module.
export const syncMetaStore = createSyncMetaStore({
  findFilesByExactName: (token, name, parentId) => findFilesByExactName(token, name, parentId),
  readFile: (token, id) => readFile(token, id),
  updateFile: (token, id, content, mimeType) => updateFile(token, id, content, mimeType),
  createFile: (token, name, content, parentId, mimeType) => createFile(token, name, content, parentId, mimeType),
  deleteFile: (token, id) => deleteFile(token, id),
  listUserFiles: (token, rootId) => listUserFiles(token, rootId),
  getFileMetadata: (token, id) => getFileMetadata(token, id),
});

/**
 * Current remote registry; null only when it is missing or malformed.
 *
 * Read failures (network, 5xx) are thrown, never reported as null: callers
 * treat null as "no registry yet" and write a fresh one, which would replace
 * the real registry with a near-empty copy.
 */
export function readRemoteSyncMeta(
  accessToken: string,
  rootFolderId: string
): Promise<SyncMeta | null> {
  return syncMetaStore.read(accessToken, rootFolderId) as Promise<SyncMeta | null>;
}

/**
 * Write remote sync meta, returning the Drive file ID that was written.
 *
 * Callers that write repeatedly (push checkpoints) should pass the previously
 * returned ID as `knownFileId` to skip the name lookup on every write.
 */
export function writeRemoteSyncMeta(
  accessToken: string,
  rootFolderId: string,
  meta: SyncMeta,
  knownFileId?: string | null
): Promise<string> {
  return syncMetaStore.write(accessToken, rootFolderId, meta, { knownFileId });
}

/**
 * Rebuild sync meta from Drive API (full scan), keeping publish state and
 * vault paths recorded on the previous entries.
 */
export function rebuildSyncMeta(
  accessToken: string,
  rootFolderId: string
): Promise<SyncMeta> {
  return syncMetaStore.rebuild(accessToken, rootFolderId) as Promise<SyncMeta>;
}

/**
 * Add or update a single file entry in remote meta.
 *
 * Publish state (`shared`, `webViewLink`, `publicPath`) is carried over from
 * `previous` (defaults to the entry being replaced — Full Push starts from an
 * empty meta, so it passes the pre-push entry); see upsertDriveFileInMeta.
 */
export function upsertFileInMeta(
  meta: SyncMeta,
  file: DriveFile,
  vaultPath?: string,
  previous: FileSyncMeta | undefined = meta.files[file.id]
): void {
  const entry: FileSyncMeta = upsertDriveFileInMeta(meta, file, previous);
  entry.path = vaultPath;
}

/**
 * Remove a file entry from remote meta.
 */
export function removeFileFromMeta(
  meta: SyncMeta,
  fileId: string
): void {
  removeFilesFromMeta(meta, [fileId]);
}

export function getConflictBackupFolder(): string {
  return `${WORKSPACE_FOLDER}/conflict-backups`;
}

/**
 * Save a conflict backup into the Vault.
 *
 * Backups used to be uploaded to sync_conflicts/ on Drive, which cost two
 * round trips per file (folder lookup + upload) and dominated bulk conflict
 * resolution. WORKSPACE_FOLDER is already sync-excluded (isSyncExcludedPath),
 * so a local copy is never pushed back to Drive.
 *
 * Supports both text (string) and binary (ArrayBuffer) content.
 */
export async function saveConflictBackup(
  app: App,
  fileName: string,
  content: string | ArrayBuffer
): Promise<void> {
  const folder = getConflictBackupFolder();
  // Conflict resolution backs up files concurrently, so two callers can race on
  // the same missing folder; mkdir failures are ignored and caught by the write.
  for (const dir of [WORKSPACE_FOLDER, folder]) {
    if (await app.vault.adapter.exists(dir)) continue;
    try {
      await app.vault.adapter.mkdir(dir);
    } catch {
      /* concurrent creation */
    }
  }
  // buildConflictBackupName percent-encodes the path separators, so the result
  // is always a single flat file name.
  const backupName = buildConflictBackupName(fileName);
  let backupPath = `${folder}/${backupName}`;
  let suffix = 1;
  while (await app.vault.adapter.exists(backupPath)) {
    const dot = backupName.lastIndexOf(".");
    const uniqueName = dot > 0
      ? `${backupName.slice(0, dot)}-${suffix}${backupName.slice(dot)}`
      : `${backupName}-${suffix}`;
    backupPath = `${folder}/${uniqueName}`;
    suffix++;
  }
  if (content instanceof ArrayBuffer) {
    await app.vault.adapter.writeBinary(backupPath, content);
  } else {
    await app.vault.adapter.write(backupPath, content);
  }
}

/** Shared backup name format (see gemihub-sync-core/conflict). */
export function buildConflictBackupName(filePath: string, now: Date = new Date()): string {
  return buildCoreConflictBackupName(filePath, now);
}

export function restorePathFromConflictBackupName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** Original vault path of a backup, from any kiokuflow client's name format. */
export function restoreOriginalPathFromConflictBackupName(name: string): string {
  return parseConflictBackupName(name).originalPath;
}

/**
 * Convert remote SyncMeta to local format (for syncing after push/pull).
 *
 * `preserveIds` lists files the caller deliberately left untouched on disk
 * (pull "Ignore", or a remote deletion that has not been applied to the vault
 * yet). Adopting the remote state for those would point the local metadata at
 * a path the file does not occupy — or drop the tracking entry entirely for
 * ids absent from remoteMeta — so their previous local entry and path mapping
 * are carried over verbatim instead.
 */
export function toLocalSyncMeta(
  remoteMeta: SyncMeta,
  existingLocal: LocalDriveSyncMeta | null,
  vaultStats?: Map<string, { mtime: number; size: number }>,
  preserveIds?: Set<string>
): LocalDriveSyncMeta {
  const files: LocalDriveSyncMeta["files"] = {};
  const pathToId: Record<string, string> = existingLocal?.pathToId
    ? { ...existingLocal.pathToId }
    : {};

  // Build reverse map (id → path) to avoid O(n²) lookup inside the loop
  const idToExistingPath = new Map<string, string>();
  for (const [existingPath, existingId] of Object.entries(pathToId)) {
    idToExistingPath.set(existingId, existingPath);
  }

  // Build case-insensitive lookup for vaultStats (handles NTFS/macOS case mismatches)
  const vaultStatsLower = new Map<string, { mtime: number; size: number }>();
  if (vaultStats) {
    for (const [p, s] of vaultStats) vaultStatsLower.set(p.toLowerCase(), s);
  }

  for (const [id, f] of Object.entries(remoteMeta.files)) {
    const preservedPath = preserveIds?.has(id) ? idToExistingPath.get(id) : undefined;
    const preservedEntry = preservedPath ? existingLocal?.files[id] : undefined;
    if (preservedPath && preservedEntry) {
      files[id] = { ...preservedEntry };
      pathToId[preservedPath] = id;
      continue;
    }
    // Always prefer name (Drive API name = vault path, always up-to-date).
    // path is an Obsidian extension that can become stale after remote renames
    // (rebuildSyncMeta copies prev.path without updating it).
    const remotePath = f.name;
    // On case-insensitive FS (NTFS, macOS), the existing local path may differ
    // in case from the remote path. Prefer the local (actual vault) path when
    // paths match case-insensitively to avoid path mismatches in subsequent syncs.
    let resolvedPath = remotePath;
    const existingPath = idToExistingPath.get(id);
    if (existingPath) {
      if (existingPath.toLowerCase() === remotePath.toLowerCase()) {
        resolvedPath = existingPath;
      } else if (pathToId[existingPath] === id) {
        // Only drop the old mapping while it still belongs to this file. When
        // two files swap paths remotely (a.md -> b.md and b.md -> a.md), an
        // earlier iteration has already claimed this key, and deleting it here
        // would leave that file untracked — so the next push would re-upload it
        // to Drive as a duplicate.
        delete pathToId[existingPath];
      }
    }
    const stats = vaultStats?.get(resolvedPath)
      ?? vaultStatsLower.get(resolvedPath.toLowerCase());
    const existing = existingLocal?.files[id];
    // Only carry over cached mtime/size if checksum hasn't changed;
    // otherwise the cached values are stale and must be recomputed.
    const checksumUnchanged = existing && existing.md5Checksum === (f.md5Checksum ?? "");
    files[id] = {
      md5Checksum: f.md5Checksum ?? "",
      modifiedTime: f.modifiedTime ?? "",
      name: f.name,
      localMtime: stats?.mtime ?? (checksumUnchanged ? existing.localMtime : undefined),
      localSize: stats?.size ?? (checksumUnchanged ? existing.localSize : undefined),
    };
    pathToId[resolvedPath] = id;
  }

  // Remove stale pathToId entries for files no longer in remoteMeta
  const remoteFileIds = new Set(Object.keys(remoteMeta.files));
  for (const [path, id] of Object.entries(pathToId)) {
    if (!remoteFileIds.has(id) && !preserveIds?.has(id)) {
      delete pathToId[path];
    }
  }

  // Preserved ids absent from remoteMeta keep their files entry too, but only
  // while their path mapping still points at them (a remote file adopting the
  // same path in the loop above takes precedence).
  if (preserveIds) {
    for (const id of preserveIds) {
      if (remoteFileIds.has(id)) continue;
      const path = idToExistingPath.get(id);
      const entry = existingLocal?.files[id];
      if (path && entry && pathToId[path] === id) {
        files[id] = { ...entry };
      }
    }
  }

  return {
    lastUpdatedAt: remoteMeta.lastUpdatedAt,
    files,
    pathToId,
  };
}
