// Sync diff types and computation. The protocol lives in kiokuflow-sync-core so
// Obsidian, kiokuflow web and kiokuflow Desktop apply identical rules; this module
// only adds the Obsidian-specific fields.

import {
  computeSyncDiff as computeCoreSyncDiff,
  type FileSyncMeta as CoreFileSyncMeta,
} from "kiokuflow-sync-core/protocol";

export { SYNC_META_FILE_NAME } from "kiokuflow-sync-core/protocol";

export interface FileSyncMeta extends CoreFileSyncMeta {
  path?: string;        // Vault relative path (Obsidian extension)
}

export interface SyncMeta {
  lastUpdatedAt: string;
  files: Record<string, FileSyncMeta>; // key = fileId
}

export interface ConflictInfo {
  fileId: string;
  fileName: string;
  localChecksum: string;
  remoteChecksum: string;
  localModifiedTime: string;
  remoteModifiedTime: string;
  isEditDelete?: boolean;
}

export interface SyncDiff {
  toPush: string[];           // locally changed file IDs
  toPull: string[];           // remotely changed file IDs
  conflicts: ConflictInfo[];
  editDeleteConflicts: string[]; // locally edited but remotely deleted file IDs
  localOnly: string[];        // exists only locally (in localMeta but not remoteMeta)
  remoteOnly: string[];       // exists only remotely (in remoteMeta but not localMeta)
}

/** Minimal shape accepted as localMeta */
type SyncMetaLike = { files: Record<string, { md5Checksum: string; modifiedTime: string; name?: string }> } | null;

/** Compute sync diff by comparing two metadata snapshots (see kiokuflow-sync-core). */
export function computeSyncDiff(
  localMeta: SyncMetaLike,
  remoteMeta: SyncMeta | null,
  locallyModifiedFileIds: Set<string> = new Set()
): SyncDiff {
  return computeCoreSyncDiff(localMeta, remoteMeta, locallyModifiedFileIds);
}
