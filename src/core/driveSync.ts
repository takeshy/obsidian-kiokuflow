// Main Google Drive sync engine for Obsidian.
// Manages push/pull sync between Obsidian Vault and Google Drive.
// Adapted from kiokuflow's useSync.ts hook — restructured as a class.

import { App, TFile, Notice, Platform, type EventRef } from "obsidian";
import { t } from "src/i18n";
import type { KiokuflowPlugin } from "src/plugin";
import { type DriveSyncSettings, type DriveSessionTokens, WORKSPACE_FOLDER, LEGACY_WORKSPACE_FOLDER } from "src/types";
import type { RagFileInfo } from "src/types";
import {
  getFileSearchManager,
  isSupportedFile,
  shouldIncludeFile,
  type FilterConfig,
} from "./fileSearch";
import {
  decodeBackupToken,
  fetchEncryptedAuth,
  decryptAuthData,
  refreshAccessToken,
  getValidSessionTokens,
} from "./googleDriveAuth";
import * as drive from "./googleDrive";
import {
  computeSyncDiff,
  type FileSyncMeta,
  type SyncMeta,
  type SyncDiff,
  type ConflictInfo,
} from "./syncDiff";
import { syncMetaSnapshotChanged } from "gemihub-sync-core/protocol";
import {
  readLocalSyncMeta,
  writeLocalSyncMeta,
  readRemoteSyncMeta,
  writeRemoteSyncMeta,
  syncMetaStore,
  toLocalSyncMeta,
  upsertFileInMeta,
  removeFileFromMeta,
  saveConflictBackup,
  getConflictBackupFolder,
  buildIdToPathMap,
  restorePathFromConflictBackupName,
  type LocalDriveSyncMeta,
} from "./driveSyncMeta";
import {
  isSyncExcludedPath,
  isBinaryExtension,
  isGoogleWorkspaceMimeType,
  getMimeType,
  md5Hash,
  md5HashString,
} from "./driveSyncUtils";
import { formatError } from "src/utils/error";
import { getLocalMetaPath } from "./driveSyncMeta";
import {
  saveEditToDrive,
  ensureEditHistoryFolderId,
  loadEditHistoryFromDrive,
  clearEditHistoryFromDrive,
  type DriveEditHistoryEntry,
} from "./driveEditHistory";

export type DriveSyncStatus = "idle" | "pushing" | "pulling" | "conflict" | "error";

export interface TempFilePayload {
  fileId: string;
  filePath?: string;
  content: string;
  savedAt: string;
  isBinary: boolean;
}

const MAX_TEMP_FILE_BYTES = 30 * 1024 * 1024; // 30 MB

/** Convert ArrayBuffer to base64 string in chunks (stack-safe). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Decode base64 string to ArrayBuffer. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export interface SyncFileListItem {
  id: string;   // Drive file ID or vault path (for new files)
  name: string;  // Display name (vault path)
  type: "new" | "modified" | "deleted" | "editDeleted" | "renamed" | "conflict";
  oldName?: string; // Previous path (for renames)
  /**
   * Whether pull can skip this entry. Only set for rows pull() actually honours
   * (remote-modified files and blocked remote renames) — content conflicts are
   * routed through the conflict modal instead, so offering "Ignore" there would
   * be a button that silently does nothing.
   */
  ignorable?: boolean;
}

export interface SyncFileListResult {
  files: SyncFileListItem[];
  hasRemoteChanges: boolean;  // true when remote has unpulled changes
}

export interface DuplicateRemoteFileGroup {
  path: string;
  files: drive.DriveFile[];
}

export class DuplicateRemoteFilesError extends Error {
  constructor(public readonly groups: DuplicateRemoteFileGroup[]) {
    super(`Google Drive contains duplicate file paths: ${groups.map(group => group.path).join(", ")}`);
    this.name = "DuplicateRemoteFilesError";
  }
}

interface CatchAllDeletePlan {
  fileId: string;
  path: string;
}

interface CatchAllRenamePlan {
  fileId: string;
  oldPath: string;
  newPath: string;
  backupExistingTarget: boolean;
}

interface CatchAllBlockedRename {
  fileId: string;
  oldPath: string;
  newPath: string;
}

interface CatchAllPullPlan {
  deletes: CatchAllDeletePlan[];
  renames: CatchAllRenamePlan[];
  blockedRenames: CatchAllBlockedRename[];
}

/** Validate that a vault path from remote metadata is safe (no traversal). */
function isValidVaultPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
  const parts = path.split("/");
  return parts.every(p => p !== ".." && p !== "." && p.length > 0);
}

const CONCURRENCY = 5;

/** Minimum spacing between remote-metadata checkpoints during a long push. */
const PUSH_CHECKPOINT_INTERVAL_MS = 15_000;

function remoteSnapshotChanged(
  expected: SyncMeta | null,
  currentFiles: drive.DriveFile[],
  isExcluded: (path: string) => boolean,
): boolean {
  const syncable = (file: { name: string; mimeType: string }) =>
    !isGoogleWorkspaceMimeType(file.mimeType) && !isExcluded(file.name);
  const before = Object.fromEntries(
    Object.entries(expected?.files ?? {}).filter(([, file]) => syncable(file)),
  );
  const after = Object.fromEntries(currentFiles.filter(syncable).map((file) => [file.id, {
    name: file.name,
    md5Checksum: file.md5Checksum ?? "",
    modifiedTime: file.modifiedTime ?? "",
  }]));
  return syncMetaSnapshotChanged(before, after);
}

/**
 * Lightweight file record from the adapter-level vault walker.
 * Shaped like TFile ({ path, stat: { mtime, size } }) so call sites that only
 * read those fields keep working unchanged.
 */
type VaultFileEntry = { path: string; stat: { mtime: number; size: number } };

/**
 * Loop-invariant state shared by every item in one conflict-resolution batch.
 *
 * Resolving conflicts one at a time re-read the remote metadata, re-walked the
 * whole vault and rewrote both metadata documents per file. Threading this
 * context through the per-item resolvers lets all of that happen once.
 */
interface ConflictResolveContext {
  /** Refreshed once per CONCURRENCY batch, not per item. */
  accessToken: string;
  rootFolderId: string;
  localMeta: LocalDriveSyncMeta;
  remoteMeta: SyncMeta;
  /** Threaded into writeRemoteSyncMeta so the name lookup happens at most once. */
  metaFileId: string | null;
  /** Set only where remoteMeta is actually mutated; "keep remote" never is. */
  remoteDirty: boolean;
  /** IDs whose current in-memory entries must be merged into fresh remote meta. */
  remoteUpsertIds: Set<string>;
  /** IDs that this batch intentionally removed from remote meta. */
  remoteDeleteIds: Set<string>;
  /** Vault paths this batch wrote, re-stat'd once at flush time. */
  touchedPaths: Set<string>;
}

/** A conflict backup file stored under the local conflict-backups folder. */
export interface ConflictBackupEntry {
  /** Full vault path of the backup file. */
  path: string;
  /** Base name; feeds restorePathFromConflictBackupName. */
  name: string;
  mtime: number;
}

export class DriveSyncManager {
  private app: App;
  private plugin: KiokuflowPlugin;
  private syncLock = false;
  private refreshCountsPromise: Promise<void> | null = null;
  private autoSyncInterval: ReturnType<typeof setInterval> | null = null;
  private vaultEventRefs: EventRef[] = [];
  private vaultChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Hashes only; file bodies are never retained. Mobile background counts may
  // reuse these while Vault events are watched. Explicit sync always rehashes.
  private vaultChecksums = new Map<string, { mtime: number; size: number; checksum: string }>();
  private vaultChecksumRevision = 0;

  // Session-only tokens (never persisted to disk)
  private sessionTokens: DriveSessionTokens | null = null;

  // Observable state
  private _syncStatus: DriveSyncStatus = "idle";
  localModifiedCount = 0;
  remoteModifiedCount = 0;
  conflicts: ConflictInfo[] = [];
  lastError: string | null = null;

  // Status change callback (used by status bar UI)
  onStatusChange: (() => void) | null = null;

  get syncStatus(): DriveSyncStatus {
    return this._syncStatus;
  }
  set syncStatus(value: DriveSyncStatus) {
    this._syncStatus = value;
    this.onStatusChange?.();
  }

  constructor(app: App, plugin: KiokuflowPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  get settings(): DriveSyncSettings {
    return this.plugin.settings.driveSync;
  }

  /** Whether the session has been unlocked (password entered). */
  get isUnlocked(): boolean {
    return this.sessionTokens !== null;
  }

  /** Whether encrypted auth is configured (but may not be unlocked). */
  get isConfigured(): boolean {
    return this.settings.enabled && this.settings.encryptedAuth !== null;
  }

  // ========================================
  // Setup & Unlock
  // ========================================

  /**
   * Initial setup: decode Migration Tool token, fetch encrypted auth from Drive, persist.
   */
  async setupWithBackupToken(backupTokenHex: string): Promise<void> {
    const { accessToken, rootFolderId } = decodeBackupToken(backupTokenHex);

    // Fetch encrypted auth from Drive
    const { data, encryptedPrivateKey, salt } = await fetchEncryptedAuth(accessToken, rootFolderId);

    // Persist encrypted auth
    this.plugin.settings.driveSync.encryptedAuth = { data, encryptedPrivateKey, salt, rootFolderId };
    await this.plugin.saveSettings();
  }

  /**
   * Unlock session with password: decrypt auth, refresh access token, start auto-sync.
   */
  async unlockWithPassword(password: string): Promise<void> {
    const auth = this.settings.encryptedAuth;
    if (!auth) throw new Error("No encrypted auth configured");

    // Decrypt refresh token + API origin (RSA hybrid decryption)
    const { refreshToken, apiOrigin } = await decryptAuthData(
      auth.data, auth.encryptedPrivateKey, auth.salt, password
    );

    // Get a fresh access token via kiokuflow API proxy
    const refreshed = await refreshAccessToken(apiOrigin, refreshToken, auth.rootFolderId);

    // The exported token identifies the workspace. A display-name change must
    // never select a different folder or reset local tracking.
    const rootFolder = await drive.getFileMetadata(refreshed.accessToken, auth.rootFolderId);
    if (rootFolder.trashed || rootFolder.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("The configured Drive sync folder is unavailable. Export a new Migration Tool token from kiokuflow.");
    }

    this.sessionTokens = {
      accessToken: refreshed.accessToken,
      refreshToken,
      apiOrigin,
      expiryTime: refreshed.expiryTime,
      rootFolderId: auth.rootFolderId,
    };

    this.startAutoSync();
    this.startVaultWatcher();

    // If autoSync is disabled, still refresh counts once after unlock
    if (!this.settings.autoSync) {
      void this.refreshSyncCounts();
    }
  }

  // ========================================
  // Auto-sync management
  // ========================================

  startAutoSync(): void {
    this.stopAutoSync();
    if (!this.settings.autoSync || !this.settings.enabled || !this.sessionTokens) return;

    // Refresh counts immediately, then on interval
    void this.refreshSyncCounts();

    const intervalMs = Math.max(3, this.settings.syncIntervalMinutes) * 60 * 1000;
    this.autoSyncInterval = setInterval(() => {
      void this.refreshSyncCounts();
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = null;
    }
  }

  /**
   * End the unlocked session without removing persisted configuration.
   * Used when sync is disabled or the saved authentication is reset.
   */
  lock(): void {
    this.stopAutoSync();
    this.stopVaultWatcher();
    this.sessionTokens = null;
    this.localModifiedCount = 0;
    this.remoteModifiedCount = 0;
    this.conflicts = [];
    this.lastError = null;
    this.syncStatus = "idle";
  }

  // ========================================
  // Token management
  // ========================================

  private async getTokens(): Promise<DriveSessionTokens> {
    if (!this.sessionTokens) {
      throw new Error("Drive sync not unlocked. Enter your password first.");
    }
    this.sessionTokens = await getValidSessionTokens(this.sessionTokens);
    return this.sessionTokens;
  }

  /** Read a remote file's text content by Drive file ID. */
  async readRemoteFile(fileId: string): Promise<string> {
    const tokens = await this.getTokens();
    return drive.readFile(tokens.accessToken, fileId);
  }

  /** Read a remote file's text content by vault path (uses pathToId mapping). */
  async readRemoteFileByPath(vaultPath: string): Promise<string | null> {
    const tokens = await this.getTokens();
    const localMeta = await readLocalSyncMeta(this.app);
    const fileId = localMeta.pathToId[vaultPath];
    if (!fileId) return null;
    return drive.readFile(tokens.accessToken, fileId);
  }

  /** Discard one push-preview change and restore the current Drive state locally. */
  async restoreLocalChange(file: SyncFileListItem): Promise<void> {
    if (this.syncLock) throw new Error("Sync already in progress");
    if (!["new", "modified", "deleted", "renamed"].includes(file.type)) {
      throw new Error("This change cannot be restored");
    }
    if (!isValidVaultPath(file.name) || this.isExcludedPath(file.name)) {
      throw new Error("Invalid local file path");
    }
    this.syncLock = true;
    try {
      await this.waitForRefreshCounts();
      const { accessToken, rootFolderId } = await this.getTokens();
      const localMeta = await readLocalSyncMeta(this.app);
      const remoteFiles = await drive.listUserFiles(accessToken, rootFolderId);
      if (file.type === "new") {
        // A stale preview must never discard a file that has since been synced.
        if (localMeta.pathToId[file.name] || remoteFiles.some(remote => remote.name === file.name)) {
          throw new Error("File is now tracked on Drive. Refresh the change list.");
        }
        await this.trashByPath(file.name);
      } else {
        const remoteFile = remoteFiles.find(remote => remote.id === file.id);
        if (!remoteFile) throw new Error("File not found on Drive");
        const targetPath = remoteFile.name;
        if (!isValidVaultPath(targetPath) || this.isExcludedPath(targetPath)
          || isGoogleWorkspaceMimeType(remoteFile.mimeType)) {
          throw new Error("Drive file cannot be restored to the vault");
        }
        const targetOwner = localMeta.pathToId[targetPath];
        if ((targetOwner && targetOwner !== file.id)
          || (targetPath !== file.name && await this.app.vault.adapter.exists(targetPath))) {
          throw new Error("Restore target already contains another local file");
        }
        const remoteMeta: SyncMeta = { lastUpdatedAt: "", files: {} };
        upsertFileInMeta(remoteMeta, remoteFile);
        // Download first so a failed read leaves the local rename intact.
        await this.downloadFile(accessToken, rootFolderId, file.id, remoteMeta, localMeta);
        const restoredFile = this.app.vault.getAbstractFileByPath(targetPath);
        const path = restoredFile instanceof TFile ? restoredFile.path : targetPath;
        if (targetPath !== file.name) await this.trashByPath(file.name);
        for (const [trackedPath, id] of Object.entries(localMeta.pathToId)) {
          if (id === file.id && trackedPath !== path) delete localMeta.pathToId[trackedPath];
        }
        const tfile = this.app.vault.getAbstractFileByPath(path);
        if (tfile instanceof TFile) {
          localMeta.files[file.id].localMtime = tfile.stat.mtime;
          localMeta.files[file.id].localSize = tfile.stat.size;
        }
        await writeLocalSyncMeta(this.app, localMeta);
      }
    } finally {
      this.syncLock = false;
    }
    await this.refreshSyncCounts();
  }

  /** Load remote edit history entries for a file from Google Drive. */
  async loadRemoteEditHistory(filePath: string): Promise<DriveEditHistoryEntry[]> {
    const tokens = await this.getTokens();
    const historyFolderId = await ensureEditHistoryFolderId(tokens.accessToken, tokens.rootFolderId);
    return loadEditHistoryFromDrive(tokens.accessToken, historyFolderId, filePath);
  }

  /** Clear remote edit history for a file from Google Drive. */
  async clearRemoteEditHistory(filePath: string): Promise<void> {
    const tokens = await this.getTokens();
    const historyFolderId = await ensureEditHistoryFolderId(tokens.accessToken, tokens.rootFolderId);
    await clearEditHistoryFromDrive(tokens.accessToken, historyFolderId, filePath);
  }

  // ========================================
  // Vault scanning
  // ========================================

  /**
   * Get all syncable files in the Vault.
   *
   * Walks the filesystem via DataAdapter instead of vault.getFiles(), because
   * Obsidian's index only surfaces known extensions (md, canvas, pdf, images,
   * audio, video) — files like .html/.css/.js are invisible to getFiles() even
   * with "Detect all file extensions" enabled, so they would silently skip push.
   */
  private async getAllVaultFiles(): Promise<VaultFileEntry[]> {
    const adapter = this.app.vault.adapter;
    const excludePatterns = this.settings.excludePatterns;
    const syncMetaPath = getLocalMetaPath();
    const configDir = this.app.vault.configDir;
    const out: VaultFileEntry[] = [];

    const directories = ["/"];
    while (directories.length > 0) {
      const dir = directories.shift()!;
      let listed: { files: string[]; folders: string[] };
      try {
        listed = await adapter.list(dir);
      } catch (err) {
        console.warn(`[DriveSync] list failed for ${dir || "/"}:`, err);
        continue;
      }
      for (const folderPath of listed.folders) {
        // Append "/" so prefix-based exclusions (e.g. "history/", configDir)
        // match against bare folder paths returned by adapter.list.
        if (isSyncExcludedPath(folderPath + "/", excludePatterns, configDir)) continue;
        directories.push(folderPath);
      }
      const candidates = listed.files.filter((filePath) =>
        filePath !== syncMetaPath && !isSyncExcludedPath(filePath, excludePatterns, configDir)
      );
      for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        await Promise.all(candidates.slice(i, i + CONCURRENCY).map(async (filePath) => {
          try {
            const stat = await adapter.stat(filePath);
            if (stat?.type === "file") out.push({ path: filePath, stat: { mtime: stat.mtime, size: stat.size } });
          } catch (err) {
            console.warn(`[DriveSync] stat failed for ${filePath}:`, err);
          }
        }));
      }
    }
    return out;
  }

  /** Check if a vault path is excluded from sync. */
  private isExcludedPath(filePath: string): boolean {
    return isSyncExcludedPath(filePath, this.settings.excludePatterns, this.app.vault.configDir);
  }

  /**
   * Google Workspace files (Sheets/Docs/etc.) cannot be downloaded via
   * Drive's alt=media endpoint. kiokuflow owns those through Workspace APIs, so
   * Obsidian sync ignores them while preserving their entries in remote meta.
   */
  private getObsidianSyncableRemoteMeta(remoteMeta: SyncMeta | null): SyncMeta | null {
    if (!remoteMeta) return null;
    return {
      lastUpdatedAt: remoteMeta.lastUpdatedAt,
      files: Object.fromEntries(
        Object.entries(remoteMeta.files).filter(([, f]) => !isGoogleWorkspaceMimeType(f.mimeType))
      ),
    };
  }

  private getObsidianSyncableLocalMeta(
    localMeta: LocalDriveSyncMeta,
    remoteMeta: SyncMeta | null
  ): LocalDriveSyncMeta {
    if (!remoteMeta) return localMeta;
    const ignoredIds = new Set(
      Object.entries(remoteMeta.files)
        .filter(([, f]) => isGoogleWorkspaceMimeType(f.mimeType))
        .map(([id]) => id)
    );
    if (ignoredIds.size === 0) return localMeta;
    return {
      lastUpdatedAt: localMeta.lastUpdatedAt,
      files: Object.fromEntries(
        Object.entries(localMeta.files).filter(([id]) => !ignoredIds.has(id))
      ),
      pathToId: Object.fromEntries(
        Object.entries(localMeta.pathToId).filter(([, id]) => !ignoredIds.has(id))
      ),
    };
  }

  /**
   * Compute MD5 checksums for all vault files.
   * Skips MD5 computation when file mtime+size match the cached values in localMeta.
   * Returns checksums (path → md5) and vaultStats (path → {mtime, size}).
   */
  private async computeVaultChecksums(
    files: VaultFileEntry[],
    localMeta?: LocalDriveSyncMeta,
    verifyMobileContents = true,
  ): Promise<{ checksums: Map<string, string>; vaultStats: Map<string, { mtime: number; size: number }> }> {
    const checksums = new Map<string, string>();
    const vaultStats = new Map<string, { mtime: number; size: number }>();
    const paths = new Set(files.map(file => file.path));
    for (const path of this.vaultChecksums.keys()) {
      if (!paths.has(path)) this.vaultChecksums.delete(path);
    }

    // Build path → cached entry lookup from localMeta (with CI fallback for NTFS/macOS)
    const cachedByPath = new Map<string, { md5Checksum: string; localMtime?: number; localSize?: number }>();
    const cachedByPathLower = new Map<string, { md5Checksum: string; localMtime?: number; localSize?: number }>();
    if (localMeta) {
      for (const [path, id] of Object.entries(localMeta.pathToId)) {
        const entry = localMeta.files[id];
        if (entry) {
          cachedByPath.set(path, entry);
          cachedByPathLower.set(path.toLowerCase(), entry);
        }
      }
    }

    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (file) => {
        try {
          const mtime = file.stat.mtime;
          const size = file.stat.size;
          vaultStats.set(file.path, { mtime, size });
          const watched = this.vaultEventRefs.length > 0 && this.app.vault.getAbstractFileByPath(file.path) instanceof TFile;
          const sessionCached = this.vaultChecksums.get(file.path);
          if (Platform.isMobile && !verifyMobileContents && watched && sessionCached?.mtime === mtime && sessionCached.size === size) {
            checksums.set(file.path, sessionCached.checksum);
            return;
          }

          // Skip MD5 if mtime+size unchanged from cached values
          const cached = cachedByPath.get(file.path)
            ?? cachedByPathLower.get(file.path.toLowerCase());
          // Mobile adapters can retain the same mtime for rapid edits, and an
          // edit can also preserve the byte length. Reusing the cached hash in
          // that case makes real changes (notably .desktop/.workflow edits)
          // disappear from the push list. Desktop filesystems provide reliable
          // enough stat changes for this optimization. Mobile explicit sync
          // always rehashes; only watched background counts use session hashes.
          if (!Platform.isMobile && cached?.localMtime === mtime && cached?.localSize === size && cached.md5Checksum) {
            checksums.set(file.path, cached.md5Checksum);
            return;
          }

          const revision = this.vaultChecksumRevision;
          let checksum: string;
          if (isBinaryExtension(file.path)) {
            const content = await this.app.vault.adapter.readBinary(file.path);
            checksum = md5Hash(new Uint8Array(content));
          } else {
            const content = await this.app.vault.adapter.read(file.path);
            checksum = md5HashString(content);
          }
          checksums.set(file.path, checksum);
          // An edit during the read must not repopulate an invalidated cache.
          if (Platform.isMobile && watched && revision === this.vaultChecksumRevision) {
            this.vaultChecksums.set(file.path, { mtime, size, checksum });
          }
        } catch (err) {
          console.warn(`[DriveSync] Skipping file (read error): ${file.path}`, err);
        }
      }));
    }
    return { checksums, vaultStats };
  }

  /**
   * Find locally modified files by comparing current checksums with local sync meta.
   * Also detects renames: files whose path changed but content (checksum) stayed the same.
   */
  private findLocallyModifiedFiles(
    localMeta: LocalDriveSyncMeta,
    currentChecksums: Map<string, string>
  ): { modifiedIds: Set<string>; newPaths: Set<string>; renames: Map<string, string>; deletedIds: Set<string> } {
    const modifiedIds = new Set<string>();
    const newPaths = new Set<string>();

    // Track disappeared paths (in pathToId but file no longer exists at that path)
    // Map: checksum → array of { fileId, oldPath } (multiple files can share the same checksum)
    const disappearedByChecksum = new Map<string, Array<{ fileId: string; oldPath: string }>>();
    // Files that disappeared but have no checksum for rename matching → directly deleted
    const disappearedNoChecksum = new Set<string>();

    // Build case-insensitive lookup for currentChecksums and pathToId (handles NTFS/macOS)
    const currentChecksumsLower = new Map<string, string>();
    for (const [p, c] of currentChecksums) currentChecksumsLower.set(p.toLowerCase(), c);
    const pathToIdLower = new Set<string>();
    for (const p of Object.keys(localMeta.pathToId)) pathToIdLower.add(p.toLowerCase());

    // Check existing tracked files
    for (const [path, fileId] of Object.entries(localMeta.pathToId)) {
      const currentChecksum = currentChecksums.get(path)
        ?? currentChecksumsLower.get(path.toLowerCase());
      const trackedChecksum = localMeta.files[fileId]?.md5Checksum;

      if (!currentChecksum && trackedChecksum) {
        // File disappeared from this path — candidate for rename detection
        const arr = disappearedByChecksum.get(trackedChecksum) ?? [];
        arr.push({ fileId, oldPath: path });
        disappearedByChecksum.set(trackedChecksum, arr);
      } else if (!currentChecksum && !trackedChecksum) {
        // File disappeared and tracked checksum is empty/falsy — can't do rename matching
        disappearedNoChecksum.add(fileId);
      } else if (currentChecksum && trackedChecksum && currentChecksum !== trackedChecksum) {
        modifiedIds.add(fileId);
      }
    }

    // Find new files (not in pathToId) and detect renames by matching checksums
    // renames: oldPath → newPath
    const renames = new Map<string, string>();
    for (const path of currentChecksums.keys()) {
      if (!localMeta.pathToId[path] && !pathToIdLower.has(path.toLowerCase())) {
        const checksum = currentChecksums.get(path)!;
        const disappearedArr = disappearedByChecksum.get(checksum);
        if (disappearedArr && disappearedArr.length > 0) {
          // Same checksum: this is a rename, not a new file
          const disappeared = disappearedArr.shift()!;
          renames.set(disappeared.oldPath, path);
          if (disappearedArr.length === 0) disappearedByChecksum.delete(checksum);
        } else {
          newPaths.add(path);
        }
      }
    }

    // Remaining disappeared entries are truly deleted files (not renamed)
    const deletedIds = new Set<string>(disappearedNoChecksum);
    for (const arr of disappearedByChecksum.values()) {
      for (const { fileId } of arr) {
        deletedIds.add(fileId);
      }
    }

    return { modifiedIds, newPaths, renames, deletedIds };
  }

  /**
   * Find files tracked in both local and remote meta but physically missing from disk.
   * These should be re-downloaded on pull.
   * Files that were previously on disk (have localMtime) but now missing
   * are treated as intentional local deletions and skipped.
   * Files that were never downloaded (no localMtime) are usually included.
   * Skip them only when a related new local path suggests a move/rename with content change.
   */
  private findMissingLocalFiles(
    localMeta: LocalDriveSyncMeta,
    remoteMeta: SyncMeta | null,
    checksums: Map<string, string>,
    diff: SyncDiff,
    renames: Map<string, string> = new Map(),
    deletedIds: Set<string> = new Set(),
    newPaths: Set<string> = new Set()
  ): string[] {
    if (!remoteMeta) return [];
    const idToPath = buildIdToPathMap(localMeta);
    const alreadyHandled = new Set([
      ...diff.toPush, ...diff.toPull,
      ...diff.localOnly, ...diff.remoteOnly,
      ...diff.editDeleteConflicts,
      ...diff.conflicts.map(c => c.fileId),
    ]);

    // Build case-insensitive lookup sets for checksums and renames (handles NTFS/macOS)
    const checksumsLower = new Set<string>();
    for (const p of checksums.keys()) checksumsLower.add(p.toLowerCase());
    const renamesLower = new Set<string>();
    for (const p of renames.keys()) renamesLower.add(p.toLowerCase());

    const hasChecksumCI = (p: string) => checksums.has(p) || checksumsLower.has(p.toLowerCase());
    const hasRenameCI = (p: string) => renames.has(p) || renamesLower.has(p.toLowerCase());
    // Check whether a newPath looks like a moved/encrypted version of trackedPath.
    // Uses basename after stripping .encrypted so that both directory moves
    // (a/foo.md → b/foo.md) and encryption renames (foo.md → foo.md.encrypted)
    // are recognised. This is a heuristic — same-basename coincidence across
    // unrelated files is possible but rare enough not to warrant stricter checks.
    const baseName = (p: string) => {
      const stripped = p.endsWith(".encrypted") ? p.slice(0, -".encrypted".length) : p;
      const slash = stripped.lastIndexOf("/");
      return (slash >= 0 ? stripped.slice(slash + 1) : stripped).toLowerCase();
    };
    const hasRelatedNewPath = (trackedPath: string) => {
      const tracked = baseName(trackedPath);
      for (const np of newPaths) {
        if (baseName(np) === tracked) return true;
      }
      return false;
    };

    const missing: string[] = [];
    for (const fileId of Object.keys(remoteMeta.files)) {
      if (alreadyHandled.has(fileId)) continue;
      if (!localMeta.files[fileId]) continue;
      // Skip files intentionally deleted by user.
      // - localMtime defined → was on disk before → intentional deletion
      // - name undefined → old meta format (predates localMtime tracking) → assume was downloaded
      // Only pull if localMtime is undefined AND name is defined (added by toLocalSyncMeta but never downloaded)
      if (deletedIds.has(fileId)) {
        const entry = localMeta.files[fileId];
        if (entry.localMtime !== undefined || entry.name === undefined) continue;
        const trackedPath = idToPath[fileId];
        if (trackedPath) {
          // Skip if a related new path (basename match) suggests a move/rename
          // with content change. Checksum-based rename detection fails when
          // the content also changes (e.g., Obsidian link updates, encryption).
          if (hasRelatedNewPath(trackedPath)) continue;
          // Fallback: the .encrypted version may already be tracked (not in
          // newPaths) but still present on disk — catch that case separately.
          if (hasChecksumCI(trackedPath + ".encrypted")) continue;
          if (trackedPath.endsWith(".encrypted") && hasChecksumCI(trackedPath.slice(0, -".encrypted".length))) continue;
        }
      }
      const remoteFile = remoteMeta.files[fileId];
      const path = idToPath[fileId] || remoteFile.name;
      if (!path) continue;
      if (hasRenameCI(path)) continue; // file was renamed, not deleted
      if (!hasChecksumCI(path)) {
        missing.push(fileId);
      }
    }
    return missing;
  }

  /**
   * Detect remote deletions/renames that older local metadata can miss.
   * The same plan is used for preview and for the actual pull.
   */
  private planCatchAllPullActions(
    localMeta: LocalDriveSyncMeta,
    remoteMeta: SyncMeta,
    diff: SyncDiff,
    checksums: Map<string, string>,
    ignoredIds?: Set<string>
  ): CatchAllPullPlan {
    const idToPath = buildIdToPathMap(localMeta);
    const handledIds = new Set([
      ...diff.toPush,
      ...diff.toPull,
      ...diff.localOnly,
      ...diff.remoteOnly,
      ...diff.editDeleteConflicts,
      ...diff.conflicts.map((c) => c.fileId),
    ]);
    // Use lowercase keys for case-insensitive matching (handles NTFS/macOS)
    const plannedRemovals = new Set<string>();

    for (const fileId of diff.localOnly) {
      const path = idToPath[fileId];
      if (path) plannedRemovals.add(path.toLowerCase());
    }
    for (const fileId of diff.toPull) {
      if (ignoredIds?.has(fileId)) continue;
      const oldPath = idToPath[fileId];
      const remotePath = remoteMeta.files[fileId]?.name;
      if (oldPath && remotePath && oldPath !== remotePath
          && oldPath.toLowerCase() !== remotePath.toLowerCase()) {
        plannedRemovals.add(oldPath.toLowerCase());
      }
    }

    const deletes: CatchAllDeletePlan[] = [];
    const rawRenames: Array<{ fileId: string; oldPath: string; newPath: string }> = [];
    for (const [path, id] of Object.entries(localMeta.pathToId)) {
      if (ignoredIds?.has(id) || handledIds.has(id)) continue;
      const remoteFile = remoteMeta.files[id];
      if (!remoteFile) {
        deletes.push({ fileId: id, path });
        plannedRemovals.add(path.toLowerCase());
        continue;
      }
      if (remoteFile.name !== path && remoteFile.name.toLowerCase() !== path.toLowerCase()) {
        rawRenames.push({ fileId: id, oldPath: path, newPath: remoteFile.name });
        plannedRemovals.add(path.toLowerCase());
      }
    }

    // Build CI lookup for pathToId (handles NTFS/macOS case mismatches in rename target detection)
    const pathToIdLowerMap = new Map<string, string>();
    for (const [p, id] of Object.entries(localMeta.pathToId)) pathToIdLowerMap.set(p.toLowerCase(), id);

    const renames: CatchAllRenamePlan[] = [];
    const blockedRenames: CatchAllBlockedRename[] = [];
    for (const rename of rawRenames) {
      const targetOwnerId = localMeta.pathToId[rename.newPath]
        ?? pathToIdLowerMap.get(rename.newPath.toLowerCase());
      if (targetOwnerId && targetOwnerId !== rename.fileId && !plannedRemovals.has(rename.newPath.toLowerCase())) {
        blockedRenames.push(rename);
        continue;
      }
      const targetExists = checksums.has(rename.newPath) || this.app.vault.getAbstractFileByPath(rename.newPath) instanceof TFile;
      renames.push({
        ...rename,
        backupExistingTarget: targetExists && !targetOwnerId,
      });
    }

    return { deletes, renames, blockedRenames };
  }

  // ========================================
  // Remote meta reconciliation
  // ========================================

  /**
   * Read remote sync meta and reconcile with actual Drive file listing in both
   * directions.
   * - Files deleted externally (kiokuflow web, Drive UI, another device) may still
   *   be listed in _sync-meta.json; remove stale entries so pull can detect them.
   * - Files added to the sync root without a metadata entry (external upload, or
   *   a push interrupted between the upload and the metadata write) are adopted.
   *   Without this they stay invisible to pull while still showing up in the
   *   Drive listing, which permanently blocks push's pre-flight snapshot check.
   * - Entries whose Drive file changed without a metadata update (another client
   *   wrote the file, or a metadata write was lost) adopt the Drive state, so
   *   the change surfaces as a pull/conflict instead of blocking push forever.
   * Writes corrected meta back to Drive if either side needed a change.
   */
  private async readReconciledRemoteMeta(
    accessToken: string,
    rootFolderId: string
  ): Promise<SyncMeta | null> {
    const caseInsensitivePaths = Platform.isWin || Platform.isMacOS || Platform.isIosApp;
    // Stale entries are verified by ID (Drive trash, permanent delete, moved out
    // of the root), drifted entries adopt the Drive state, and untracked files
    // are adopted — the rules shared with kiokuflow web and Desktop.
    const { meta } = await syncMetaStore.readReconciled(accessToken, rootFolderId, {
      rebuildIfMissing: false,
      // Excluded names are owned by another tool and must not become pull candidates.
      isAdoptable: (file) => !this.isExcludedPath(file.name),
      onListing: (driveFiles) => {
        const syncableFilesByPath = new Map<string, drive.DriveFile[]>();
        for (const file of driveFiles) {
          if (this.isExcludedPath(file.name) || isGoogleWorkspaceMimeType(file.mimeType)) continue;
          // Drive permits case-distinct names, while Windows/macOS vaults usually
          // resolve them to the same file. Treat those as duplicates too; otherwise
          // every pull rediscovers the losing case variant as a remote-only file.
          const normalizedPath = caseInsensitivePaths ? file.name.toLowerCase() : file.name;
          const files = syncableFilesByPath.get(normalizedPath) ?? [];
          files.push(file);
          syncableFilesByPath.set(normalizedPath, files);
        }
        const duplicateGroups = [...syncableFilesByPath]
          .filter(([, files]) => files.length > 1)
          .map(([, files]) => ({ path: files[0].name, files }))
          .sort((a, b) => a.path.localeCompare(b.path));
        if (duplicateGroups.length > 0) {
          throw new DuplicateRemoteFilesError(duplicateGroups);
        }
      },
    });
    return meta as SyncMeta | null;
  }

  /** Keep one Drive file for each duplicate path and move the others to trash/. */
  async resolveRemoteDuplicates(winners: ReadonlyMap<string, string>): Promise<void> {
    const tokens = await this.getTokens();
    const { accessToken, rootFolderId } = tokens;
    const files = await drive.listUserFiles(accessToken, rootFolderId);
    const trashFolderId = await drive.ensureSubFolder(accessToken, rootFolderId, "trash");
    const remoteMeta = await readRemoteSyncMeta(accessToken, rootFolderId);
    const caseInsensitivePaths = Platform.isWin || Platform.isMacOS || Platform.isIosApp;
    const matchesPath = (candidate: string, expected: string) =>
      caseInsensitivePaths ? candidate.toLowerCase() === expected.toLowerCase() : candidate === expected;

    for (const [path, winnerId] of winners) {
      const duplicates = files.filter(file =>
        matchesPath(file.name, path) && !this.isExcludedPath(file.name)
      );
      if (duplicates.length < 2 || !duplicates.some(file => file.id === winnerId)) {
        throw new Error(`Duplicate files changed while resolving: ${path}`);
      }
      for (const file of duplicates) {
        if (file.id === winnerId) continue;
        await drive.moveFile(accessToken, file.id, trashFolderId, rootFolderId);
        if (remoteMeta) delete remoteMeta.files[file.id];
      }
    }
    if (remoteMeta) {
      remoteMeta.lastUpdatedAt = new Date().toISOString();
      await writeRemoteSyncMeta(accessToken, rootFolderId, remoteMeta);
    }
  }

  // ========================================
  // Sync count refresh
  // ========================================

  /**
   * Wait for an in-flight background count refresh to finish.
   *
   * refreshSyncCounts() reconciles (and therefore may rewrite) _sync-meta.json,
   * so a sync that starts while one is still running could lose that write.
   * Sync entry points await this after taking the sync lock, which also stops
   * any further refresh from starting.
   */
  private async waitForRefreshCounts(): Promise<void> {
    const pending = this.refreshCountsPromise;
    if (!pending) return;
    try {
      await pending;
    } catch {
      // Refresh failures are non-fatal for the sync that is about to run.
    }
  }

  async refreshSyncCounts(): Promise<void> {
    if (this.syncLock || this.refreshCountsPromise) return;
    if (!this.settings.enabled || !this.sessionTokens) {
      this.localModifiedCount = 0;
      this.remoteModifiedCount = 0;
      this.onStatusChange?.();
      return;
    }

    const run = this.runRefreshSyncCounts();
    this.refreshCountsPromise = run;
    try {
      await run;
    } finally {
      this.refreshCountsPromise = null;
      this.onStatusChange?.();
    }
  }

  private async runRefreshSyncCounts(): Promise<void> {
    try {
      const tokens = await this.getTokens();
      const localMeta = await readLocalSyncMeta(this.app);
      const remoteMeta = await this.readReconciledRemoteMeta(tokens.accessToken, tokens.rootFolderId);
      const syncRemoteMeta = this.getObsidianSyncableRemoteMeta(remoteMeta);
      const syncLocalMeta = this.getObsidianSyncableLocalMeta(localMeta, remoteMeta);

      const vaultFiles = await this.getAllVaultFiles();
      const { checksums } = await this.computeVaultChecksums(vaultFiles, syncLocalMeta, false);
      const { modifiedIds, newPaths, renames, deletedIds } = this.findLocallyModifiedFiles(syncLocalMeta, checksums);

      const diff = computeSyncDiff(syncLocalMeta, syncRemoteMeta, modifiedIds);

      // Detect files tracked in meta but physically missing from disk (exclude intentional deletions)
      const missingLocal = this.findMissingLocalFiles(syncLocalMeta, syncRemoteMeta, checksums, diff, renames, deletedIds, newPaths);
      diff.toPull.push(...missingLocal);

      // Resolve id → path for exclusion filtering
      const idToPath = buildIdToPathMap(syncLocalMeta);
      const remoteFiles = syncRemoteMeta?.files ?? {};
      const resolvePath = (id: string): string | null => idToPath[id] || remoteFiles[id]?.name || null;

      const isExcludedId = (id: string): boolean => {
        const path = resolvePath(id);
        return path !== null && this.isExcludedPath(path);
      };

      // Push count = modified files + new files + renames + local deletions (excluding excluded paths)
      // Verify deletedIds with adapter.exists to avoid false positives from Obsidian index lag
      let verifiedDeletedCount = 0;
      for (const id of deletedIds) {
        if (isExcludedId(id)) continue;
        const path = resolvePath(id);
        if (path && !(await this.app.vault.adapter.exists(path))) {
          verifiedDeletedCount++;
        }
      }
      const pushCount = diff.toPush.filter(id => !isExcludedId(id)).length
        + [...newPaths].filter(p => !this.isExcludedPath(p)).length
        + [...renames].filter(([, newPath]) => !this.isExcludedPath(newPath)).length
        + diff.editDeleteConflicts.filter(id => !isExcludedId(id)).length
        + verifiedDeletedCount;
      this.localModifiedCount = pushCount;

      // Pull count = remote changes + remote-only + locally-deleted-remotely + conflicts (excluding excluded paths)
      if (!syncRemoteMeta) {
        this.remoteModifiedCount = 0;
      } else {
        const catchAllPlan = this.planCatchAllPullActions(syncLocalMeta, syncRemoteMeta, diff, checksums);
        const pullLocalOnly = diff.localOnly.filter(id => id in syncLocalMeta.files);
        // Filter remoteOnly: skip files that already exist locally with matching content
        // (matches computeSyncFileList logic)
        const remoteOnlyCount = diff.remoteOnly.filter(id => {
          if (isExcludedId(id)) return false;
          const name = remoteFiles[id]?.name;
          if (!name) return true;
          const remoteChecksum = remoteFiles[id]?.md5Checksum;
          const localChecksum = checksums.get(name);
          if (localChecksum && remoteChecksum && localChecksum === remoteChecksum) return false;
          return true;
        }).length;
        this.remoteModifiedCount =
          diff.toPull.filter(id => !isExcludedId(id)).length
          + remoteOnlyCount
          + pullLocalOnly.filter(id => !isExcludedId(id)).length
          + diff.editDeleteConflicts.filter(id => !isExcludedId(id)).length
          + diff.conflicts.filter(c => !isExcludedId(c.fileId)).length
          + catchAllPlan.deletes.filter(item => !this.isExcludedPath(item.path)).length
          + catchAllPlan.renames.filter(item => !this.isExcludedPath(item.newPath)).length
          + catchAllPlan.blockedRenames.filter(item => !this.isExcludedPath(item.newPath)).length;
      }
    } catch (err) {
      // Background refresh failure is expected (e.g. offline); silently ignored.
      console.debug("[DriveSync] refreshSyncCounts failed:", err);
    }
  }

  // ========================================
  // Lightweight local-only push count refresh
  // ========================================

  /**
   * Refresh only the local push count without network access.
   * Compares vault files against local sync metadata to count local changes.
   */
  async refreshLocalCounts(): Promise<void> {
    if (!this.settings.enabled || !this.sessionTokens) return;

    try {
      const localMeta = await readLocalSyncMeta(this.app);
      const vaultFiles = await this.getAllVaultFiles();
      const { checksums } = await this.computeVaultChecksums(vaultFiles, localMeta, false);
      const { modifiedIds, newPaths, renames, deletedIds } = this.findLocallyModifiedFiles(localMeta, checksums);

      const idToPath = buildIdToPathMap(localMeta);

      // Verify deletedIds with adapter.exists to avoid false positives from Obsidian index lag
      let verifiedLocalDeletedCount = 0;
      for (const id of deletedIds) {
        const path = idToPath[id];
        if (path && this.isExcludedPath(path)) continue;
        if (!path || !(await this.app.vault.adapter.exists(path))) {
          verifiedLocalDeletedCount++;
        }
      }
      const pushCount =
        [...modifiedIds].filter(id => {
          const path = idToPath[id];
          return !path || !this.isExcludedPath(path);
        }).length
        + [...newPaths].filter(p => !this.isExcludedPath(p)).length
        + [...renames].filter(([, newPath]) => !this.isExcludedPath(newPath)).length
        + verifiedLocalDeletedCount;

      this.localModifiedCount = pushCount;
    } catch (err) {
      console.debug("[DriveSync] refreshLocalCounts failed:", err);
    }
    this.onStatusChange?.();
  }

  // ========================================
  // Vault change watcher (debounced local count refresh)
  // ========================================

  startVaultWatcher(): void {
    this.stopVaultWatcher();
    if (!this.settings.enabled || !this.sessionTokens) return;

    const debouncedRefresh = (file: { path: string }, oldPath?: string) => {
      this.vaultChecksumRevision++;
      for (const path of this.vaultChecksums.keys()) {
        if ([file.path, oldPath].some(changed => changed && (path.toLowerCase() === changed.toLowerCase() || path.toLowerCase().startsWith(changed.toLowerCase() + "/")))) {
          this.vaultChecksums.delete(path);
        }
      }
      if (this.vaultChangeDebounceTimer) clearTimeout(this.vaultChangeDebounceTimer);
      this.vaultChangeDebounceTimer = setTimeout(() => {
        void this.refreshLocalCounts();
      }, 5000);
    };

    this.vaultEventRefs.push(
      this.app.vault.on("modify", debouncedRefresh),
      this.app.vault.on("create", debouncedRefresh),
      this.app.vault.on("delete", debouncedRefresh),
      this.app.vault.on("rename", debouncedRefresh),
    );
  }

  stopVaultWatcher(): void {
    this.vaultChecksumRevision++;
    this.vaultChecksums.clear();
    for (const ref of this.vaultEventRefs) {
      this.app.vault.offref(ref);
    }
    this.vaultEventRefs = [];
    if (this.vaultChangeDebounceTimer) {
      clearTimeout(this.vaultChangeDebounceTimer);
      this.vaultChangeDebounceTimer = null;
    }
  }

  // ========================================
  // Sync file list (for diff dialog)
  // ========================================

  async computeSyncFileList(direction: "push" | "pull"): Promise<SyncFileListResult> {
    if (!this.settings.enabled || !this.sessionTokens) return { files: [], hasRemoteChanges: false };

    const tokens = await this.getTokens();
    const localMeta = await readLocalSyncMeta(this.app);
    const remoteMeta = await this.readReconciledRemoteMeta(tokens.accessToken, tokens.rootFolderId);
    const syncRemoteMeta = this.getObsidianSyncableRemoteMeta(remoteMeta);
    const syncLocalMeta = this.getObsidianSyncableLocalMeta(localMeta, remoteMeta);

    const vaultFiles = await this.getAllVaultFiles();
    const { checksums } = await this.computeVaultChecksums(vaultFiles, syncLocalMeta);
    const { modifiedIds, newPaths, renames, deletedIds } = this.findLocallyModifiedFiles(syncLocalMeta, checksums);

    const diff = computeSyncDiff(syncLocalMeta, syncRemoteMeta, modifiedIds);

    // Detect files tracked in meta but physically missing from disk (for pull, exclude intentional deletions)
    if (direction === "pull") {
      const missingLocal = this.findMissingLocalFiles(syncLocalMeta, syncRemoteMeta, checksums, diff, renames, deletedIds, newPaths);
      diff.toPull.push(...missingLocal);
    }

    const remoteFiles = syncRemoteMeta?.files ?? {};
    const idToPath = buildIdToPathMap(syncLocalMeta);
    const catchAllPlan = direction === "pull" && syncRemoteMeta
      ? this.planCatchAllPullActions(syncLocalMeta, syncRemoteMeta, diff, checksums)
      : null;

    const files: SyncFileListItem[] = [];

    if (direction === "push") {
      for (const id of diff.toPush) {
        const name = idToPath[id] || remoteFiles[id]?.name || id;
        files.push({ id, name, type: "modified" });
      }
      for (const path of newPaths) {
        files.push({ id: path, name: path, type: "new" });
      }
      for (const [oldPath, newPath] of renames) {
        const fileId = syncLocalMeta.pathToId[oldPath] || oldPath;
        files.push({ id: fileId, name: newPath, type: "renamed", oldName: oldPath });
      }
      // Remote deletions, including edit/delete conflicts, are resolved from
      // the pull preview. Do not count them as push targets: push is blocked by
      // hasRemoteChanges below until the user accepts the delete or restores
      // the local version through conflict resolution.
      // Show locally deleted files (will be moved to trash/ on Drive)
      // Both localOnly (in localMeta only) and deletedIds (in both metas but deleted from disk)
      // Verify with adapter.exists to avoid false positives from Obsidian index lag
      for (const id of diff.localOnly) {
        const path = idToPath[id];
        if (path && !checksums.has(path) && !(await this.app.vault.adapter.exists(path))) {
          files.push({ id, name: path, type: "deleted" });
        }
      }
      const deletedIdsSeen = new Set(diff.localOnly);
      for (const id of deletedIds) {
        if (deletedIdsSeen.has(id)) continue;
        const path = idToPath[id];
        if (path && !(await this.app.vault.adapter.exists(path))) {
          files.push({ id, name: path, type: "deleted" });
        }
      }
    } else {
      for (const id of diff.remoteOnly) {
        const name = remoteFiles[id]?.name || id;
        // Skip files that already exist locally with matching content
        const remoteChecksum = remoteFiles[id]?.md5Checksum;
        const localChecksum = checksums.get(name);
        if (localChecksum && remoteChecksum && localChecksum === remoteChecksum) continue;
        files.push({ id, name, type: "new" });
      }
      for (const id of diff.toPull) {
        const name = idToPath[id] || remoteFiles[id]?.name || id;
        files.push({ id, name, type: "modified", ignorable: true });
      }
      for (const id of diff.localOnly) {
        if (!(id in syncLocalMeta.files)) continue;
        // Show the path that will actually be deleted: a pending local
        // rename means the file now lives at the renamed path (applyPullDiff
        // resolves the same way).
        const trackedPath = idToPath[id];
        const name = (trackedPath && renames.get(trackedPath)) || trackedPath || id;
        files.push({ id, name, type: "deleted" });
      }
      for (const id of diff.editDeleteConflicts) {
        const name = idToPath[id] || id;
        files.push({ id, name, type: "editDeleted" });
      }
      for (const c of diff.conflicts) {
        const name = idToPath[c.fileId] || remoteFiles[c.fileId]?.name || c.fileId;
        files.push({ id: c.fileId, name, type: "conflict" });
      }
      for (const item of catchAllPlan?.deletes ?? []) {
        files.push({ id: item.fileId, name: item.path, type: "deleted" });
      }
      for (const item of catchAllPlan?.renames ?? []) {
        files.push({ id: item.fileId, name: item.newPath, type: "renamed", oldName: item.oldPath });
      }
      for (const item of catchAllPlan?.blockedRenames ?? []) {
        files.push({ id: item.fileId, name: item.newPath, type: "conflict", ignorable: true });
      }
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    const filtered = files.filter((f) => !this.isExcludedPath(f.name));

    // Detect remote changes that would block a push
    const localMetaFiles = syncLocalMeta?.files ?? {};
    const remoteDeletedCount = diff.localOnly.filter(id => id in localMetaFiles).length;
    const hasRemoteChanges =
      diff.conflicts.length > 0 ||
      diff.editDeleteConflicts.length > 0 ||
      diff.toPull.length > 0 ||
      diff.remoteOnly.length > 0 ||
      remoteDeletedCount > 0 ||
      (catchAllPlan?.deletes.length ?? 0) > 0 ||
      (catchAllPlan?.renames.length ?? 0) > 0 ||
      (catchAllPlan?.blockedRenames.length ?? 0) > 0;

    return { files: filtered, hasRemoteChanges };
  }

  // ========================================
  // Push
  // ========================================

  async push(): Promise<void> {
    if (this.syncLock) {
      console.warn("[DriveSync] push skipped: sync already in progress");
      return;
    }
    this.syncLock = true;
    this.syncStatus = "pushing";
    this.lastError = null;
    new Notice(t("driveSync.startPushing"));

    try {
      await this.waitForRefreshCounts();
      const tokens = await this.getTokens();
      let { accessToken } = tokens;
      const { rootFolderId } = tokens;

      // 1. Get local and remote meta (reconcile with actual Drive files so
      //    external deletions missing from _sync-meta.json still block the push)
      const localMeta = await readLocalSyncMeta(this.app);
      let remoteMeta = await this.readReconciledRemoteMeta(accessToken, rootFolderId);
      const syncLocalMeta = this.getObsidianSyncableLocalMeta(localMeta, remoteMeta);
      const syncRemoteMeta = this.getObsidianSyncableRemoteMeta(remoteMeta);

      // 2. Compute vault checksums and find modified files
      const vaultFiles = await this.getAllVaultFiles();
      const { checksums, vaultStats } = await this.computeVaultChecksums(vaultFiles, syncLocalMeta);
      const { modifiedIds, newPaths, renames, deletedIds } = this.findLocallyModifiedFiles(syncLocalMeta, checksums);

      // 3. Compute diff
      const renamedFileIds = new Set<string>();
      for (const [oldPath] of renames) {
        const fid = syncLocalMeta.pathToId[oldPath];
        if (fid) renamedFileIds.add(fid);
      }
      const diff = computeSyncDiff(syncLocalMeta, syncRemoteMeta, modifiedIds);

      // 4. Reject push if remote has changes
      // A renamed file whose ID is localOnly means it was deleted on remote —
      // pushing would resurrect the trashed Drive file via renameFile, so it
      // must block the push like any other remote deletion (matches the
      // hasRemoteChanges check in computeSyncFileList).
      const localMetaFiles = syncLocalMeta?.files ?? {};
      const remoteDeletedCount = diff.localOnly.filter(id => id in localMetaFiles).length;
      if (
        diff.conflicts.length > 0 ||
        diff.editDeleteConflicts.length > 0 ||
        diff.toPull.length > 0 ||
        diff.remoteOnly.length > 0 ||
        remoteDeletedCount > 0
      ) {
        this.lastError = "Remote has pending changes. Please pull first.";
        this.syncStatus = "error";
        new Notice(`Drive sync push failed: ${this.lastError}`);
        return;
      }

      // Re-list Drive once immediately before applying the batch. This catches
      // edits/deletes/moves made while local checksums were being computed,
      // without adding one network request per changed file.
      const latestRemoteFiles = await drive.listUserFiles(accessToken, rootFolderId);
      if (remoteSnapshotChanged(syncRemoteMeta, latestRemoteFiles, (path) => this.isExcludedPath(path))) {
        this.lastError = "Remote changed during push preparation. Please pull first.";
        this.syncStatus = "error";
        new Notice(`Drive sync push failed: ${this.lastError}`);
        return;
      }

      // 5. Prepare remote meta for updates
      if (!remoteMeta) {
        remoteMeta = { lastUpdatedAt: new Date().toISOString(), files: {} };
      }

      // Checkpoint the remote metadata periodically so an interrupted push
      // leaves Drive IDs recorded rather than orphaned. Writing after every
      // batch would re-upload the whole metadata document (and re-run a Drive
      // name search) per five files, so the file ID is cached and writes are
      // time-throttled; anything newer than the last checkpoint is recovered by
      // readReconciledRemoteMeta() adopting the untracked uploads.
      const metaRef = remoteMeta;
      let metaFileId: string | null = null;
      let lastCheckpointAt = Date.now();
      const checkpointRemoteMeta = async (force = false): Promise<void> => {
        if (!force && Date.now() - lastCheckpointAt < PUSH_CHECKPOINT_INTERVAL_MS) return;
        metaRef.lastUpdatedAt = new Date().toISOString();
        accessToken = (await this.getTokens()).accessToken;
        metaFileId = await writeRemoteSyncMeta(accessToken, rootFolderId, metaRef, metaFileId);
        lastCheckpointAt = Date.now();
      };

      const idToPath = buildIdToPathMap(syncLocalMeta);

      // 6. Handle renames (update Drive file name, no re-upload needed)
      for (const [oldPath, newPath] of renames) {
        accessToken = (await this.getTokens()).accessToken;
        const fileId = syncLocalMeta.pathToId[oldPath];
        if (!fileId) continue;
        const driveFile = await drive.renameFile(accessToken, fileId, newPath);
        // Update local meta path mapping
        delete syncLocalMeta.pathToId[oldPath];
        syncLocalMeta.pathToId[newPath] = fileId;
        // Update remote meta
        upsertFileInMeta(remoteMeta, driveFile, newPath);
      }
      if (renames.size > 0) {
        await checkpointRemoteMeta(true);
      }

      // 7. Upload modified files (existing)
      const modifiedPaths: string[] = [];
      for (const fileId of diff.toPush) {
        const path = idToPath[fileId];
        if (path) modifiedPaths.push(path);
      }

      // 8. Upload new files
      const allPathsToUpload = [...modifiedPaths, ...newPaths];

      // Track old/new content for Drive edit history
      const uploadResults: Array<{ path: string; oldContent: string | null; newContent: string | null }> = [];

      // Process in batches of CONCURRENCY
      for (let i = 0; i < allPathsToUpload.length; i += CONCURRENCY) {
        const batch = allPathsToUpload.slice(i, i + CONCURRENCY);
        accessToken = (await this.getTokens()).accessToken;
        const results = await Promise.allSettled(batch.map(async (path) => {
          const existingId = syncLocalMeta.pathToId[path];
          const result = await this.uploadFile(accessToken, rootFolderId, path, existingId, remoteMeta, syncLocalMeta, checksums);
          uploadResults.push({ path, ...result });
        }));
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        // Force a checkpoint before bailing out so the IDs created by the
        // successful uploads in this batch are not lost.
        await checkpointRemoteMeta(rejected !== undefined);
        if (rejected) throw rejected.reason;
      }

      // 9. Handle locally deleted files: move to trash/ subfolder on Drive
      // - localOnly: files in localMeta but not remoteMeta (deleted locally before ever syncing remote)
      // - deletedIds: files in both metas but physically deleted from disk
      // Verify with adapter.exists to avoid trashing files that exist on disk
      // but are temporarily missing from Obsidian's index.
      // Skip excluded paths: an excluded file shows up here because
      // getAllVaultFiles filters it out, so findLocallyModifiedFiles treats
      // it as disappeared — but it's managed by another tool (e.g. kiokuflow
      // owns `web/`) and must not be trashed on Drive.
      const candidateTrash = [
        ...diff.localOnly.filter(id => {
          if (renamedFileIds.has(id)) return false;
          const path = idToPath[id];
          return path && !checksums.has(path);
        }),
        ...deletedIds,
      ];
      const filesToTrash: string[] = [];
      for (const id of candidateTrash) {
        const path = idToPath[id];
        if (!path) continue;
        if (this.isExcludedPath(path)) continue;
        if (!(await this.app.vault.adapter.exists(path))) {
          filesToTrash.push(id);
        }
      }
      if (filesToTrash.length > 0) {
        accessToken = (await this.getTokens()).accessToken;
        const trashFolderId = await drive.ensureSubFolder(accessToken, rootFolderId, "trash");
        for (const fileId of filesToTrash) {
          const path = idToPath[fileId];
          if (!path) continue;
          try {
            await drive.moveFile(accessToken, fileId, trashFolderId, rootFolderId);
            removeFileFromMeta(remoteMeta, fileId);
            delete syncLocalMeta.files[fileId];
            delete syncLocalMeta.pathToId[path];
          } catch (err) {
            console.warn(`[DriveSync] Failed to move file to trash on Drive: ${path}`, err);
          }
        }
      }

      // 10. Write updated remote meta
      await checkpointRemoteMeta(true);

      // 11. Update local meta (with vault stats for mtime/size caching)
      const updatedLocalMeta = toLocalSyncMeta(this.getObsidianSyncableRemoteMeta(remoteMeta) ?? remoteMeta, syncLocalMeta, vaultStats);
      await writeLocalSyncMeta(this.app, updatedLocalMeta);

      // 12. Save remote edit history in background (best-effort, does not block UI)
      const historyEntries = uploadResults.filter(
        (r) => r.oldContent != null && r.newContent != null && r.oldContent !== r.newContent
      );
      if (historyEntries.length > 0) {
        const editHistorySettings = this.plugin.settings.editHistory;
        void (async () => {
          try {
            const historyFolderId = await ensureEditHistoryFolderId(accessToken, rootFolderId);
            for (let i = 0; i < historyEntries.length; i += CONCURRENCY) {
              const batch = historyEntries.slice(i, i + CONCURRENCY);
              await Promise.all(batch.map(async (r) => {
                await saveEditToDrive(accessToken, historyFolderId, editHistorySettings, {
                  path: r.path,
                  oldContent: r.oldContent!,
                  newContent: r.newContent!,
                  source: "manual",
                });
              }));
            }
          } catch (err) {
            // best-effort: don't block sync for background history save
            console.debug("[DriveSync] background history save failed:", err);
          }
        })();
      }

      // 13. RAG sync in background (best-effort, does not block UI)
      void (async () => {
        try {
          await this.syncRagAfterPush(
            accessToken,
            rootFolderId,
            allPathsToUpload,
            renames,
            filesToTrash.map(id => idToPath[id]).filter((p): p is string => !!p)
          );
        } catch (err) {
          console.debug("[DriveSync] background RAG sync failed:", err);
        }
      })();

      this.syncStatus = "idle";
      const totalCount = allPathsToUpload.length + renames.size + filesToTrash.length;
      const parts: string[] = [];
      if (renames.size > 0) parts.push(`${renames.size} renamed`);
      if (filesToTrash.length > 0) parts.push(`${filesToTrash.length} trashed`);
      const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      new Notice(`Drive sync: pushed ${totalCount} file(s)${detail}`);
    } catch (err) {
      this.lastError = formatError(err);
      this.syncStatus = "error";
      new Notice(`Drive sync push failed: ${this.lastError}`);
    } finally {
      this.syncLock = false;
      await this.refreshSyncCounts();
    }
  }

  /**
   * Upload a single file to Drive.
   * Returns old/new content for text files (for edit history tracking).
   */
  private async uploadFile(
    accessToken: string,
    rootFolderId: string,
    vaultPath: string,
    existingDriveId: string | undefined,
    remoteMeta: SyncMeta,
    localMeta: LocalDriveSyncMeta,
    checksums: Map<string, string>,
    // Full Push rebuilds remoteMeta from scratch, so the entry being replaced
    // is not in `remoteMeta`; the caller passes the pre-push entry to keep
    // kiokuflow's publish state (shared/webViewLink/publicPath) on the file.
    previousEntry?: FileSyncMeta
  ): Promise<{ oldContent: string | null; newContent: string | null }> {
    // Read via adapter so Obsidian-unindexed extensions (html, css, js, etc.) upload.
    if (!(await this.app.vault.adapter.exists(vaultPath))) return { oldContent: null, newContent: null };

    const mimeType = getMimeType(vaultPath);
    const isBinary = isBinaryExtension(vaultPath);

    let oldContent: string | null = null;
    let newContent: string | null = null;

    // Drive uses flat structure: file name = vault path (e.g., "notes/daily/2024-01-01.md")
    let driveFile: drive.DriveFile;

    if (existingDriveId) {
      // Get old content for edit history (text files only)
      if (!isBinary) {
        try {
          oldContent = await drive.readFile(accessToken, existingDriveId);
        } catch (err) {
          console.debug("[DriveSync] old content read failed:", err);
        }
      }

      // Update existing file
      if (isBinary) {
        const content = await this.app.vault.adapter.readBinary(vaultPath);
        driveFile = await drive.updateFileBinary(accessToken, existingDriveId, content, mimeType);
      } else {
        const content = await this.app.vault.adapter.read(vaultPath);
        newContent = content;
        driveFile = await drive.updateFile(accessToken, existingDriveId, content, mimeType);
      }
    } else {
      // Create new file in root folder with vaultPath as name
      if (isBinary) {
        const content = await this.app.vault.adapter.readBinary(vaultPath);
        driveFile = await drive.createFileBinary(accessToken, vaultPath, content, rootFolderId, mimeType);
      } else {
        const content = await this.app.vault.adapter.read(vaultPath);
        newContent = content;
        driveFile = await drive.createFile(accessToken, vaultPath, content, rootFolderId, mimeType);
      }
    }

    // Update remote meta
    upsertFileInMeta(remoteMeta, driveFile, vaultPath, previousEntry ?? remoteMeta.files[driveFile.id]);

    // Update local meta mappings
    localMeta.pathToId[vaultPath] = driveFile.id;
    localMeta.files[driveFile.id] = {
      md5Checksum: checksums.get(vaultPath) ?? driveFile.md5Checksum ?? "",
      modifiedTime: driveFile.modifiedTime ?? "",
    };

    return { oldContent, newContent };
  }

  // ========================================
  // Pull
  // ========================================

  async pull(ignoredIds?: Set<string>): Promise<void> {
    if (this.syncLock) {
      console.warn("[DriveSync] pull skipped: sync already in progress");
      return;
    }
    this.syncLock = true;
    this.syncStatus = "pulling";
    this.lastError = null;
    new Notice(t("driveSync.startPulling"));

    try {
      await this.waitForRefreshCounts();
      const tokens = await this.getTokens();
      const { accessToken, rootFolderId } = tokens;

      // 1. Get local and remote meta (reconcile with actual Drive files to detect external deletions)
      const localMeta = await readLocalSyncMeta(this.app);
      const remoteMeta = await this.readReconciledRemoteMeta(accessToken, rootFolderId);
      const syncRemoteMeta = this.getObsidianSyncableRemoteMeta(remoteMeta);
      const syncLocalMeta = this.getObsidianSyncableLocalMeta(localMeta, remoteMeta);

      if (!syncRemoteMeta) {
        new Notice("Drive sync: no remote data found. Push first.");
        this.syncStatus = "idle";
        return;
      }

      // 2. Compute vault checksums and find modified files
      const vaultFiles = await this.getAllVaultFiles();
      const { checksums } = await this.computeVaultChecksums(vaultFiles, syncLocalMeta);
      const { modifiedIds, newPaths, renames, deletedIds } = this.findLocallyModifiedFiles(syncLocalMeta, checksums);

      // 3. Compute diff
      const diff = computeSyncDiff(syncLocalMeta, syncRemoteMeta, modifiedIds);

      // 3.1. Re-download files tracked in meta but physically missing from disk (exclude intentional deletions)
      const missingLocal = this.findMissingLocalFiles(syncLocalMeta, syncRemoteMeta, checksums, diff, renames, deletedIds, newPaths);
      diff.toPull.push(...missingLocal);

      // 3.5. Guard: detect untracked local files that would be overwritten,
      //       and skip files that already exist locally with matching content.
      const safeRemoteOnly: string[] = [];
      const alreadyMatchedIds: string[] = [];
      const untrackedConflicts: ConflictInfo[] = [];
      for (const fileId of diff.remoteOnly) {
        const fileMeta = syncRemoteMeta.files[fileId];
        if (!fileMeta) { safeRemoteOnly.push(fileId); continue; }
        const vaultPath = fileMeta.name;
        const localChecksum = checksums.get(vaultPath);
        if (!localChecksum) {
          // File doesn't exist locally — need to download
          safeRemoteOnly.push(fileId);
        } else if (localChecksum === fileMeta.md5Checksum) {
          // Same content already exists locally — skip download, just track in metadata
          alreadyMatchedIds.push(fileId);
        } else {
          // Different content — conflict
          untrackedConflicts.push({
            fileId,
            fileName: vaultPath,
            localChecksum,
            remoteChecksum: fileMeta.md5Checksum,
            localModifiedTime: "",
            remoteModifiedTime: fileMeta.modifiedTime,
          });
        }
      }
      diff.remoteOnly = safeRemoteOnly;

      // Track already-matched files in local metadata (no download needed)
      if (alreadyMatchedIds.length > 0) {
        for (const fileId of alreadyMatchedIds) {
          const fileMeta = syncRemoteMeta.files[fileId];
          if (!fileMeta) continue;
          syncLocalMeta.pathToId[fileMeta.name] = fileId;
          syncLocalMeta.files[fileId] = {
            md5Checksum: fileMeta.md5Checksum,
            modifiedTime: fileMeta.modifiedTime ?? "",
            name: fileMeta.name,
          };
        }
      }

      const catchAllPlan = this.planCatchAllPullActions(syncLocalMeta, syncRemoteMeta, diff, checksums, ignoredIds);
      if (catchAllPlan.blockedRenames.length > 0) {
        const first = catchAllPlan.blockedRenames[0];
        const count = catchAllPlan.blockedRenames.length;
        const detail = count === 1 ? first.newPath : `${first.newPath} (+${count - 1} more)`;
        throw new Error(`Remote rename target is already tracked locally: ${detail}`);
      }

      // 4. Handle conflicts
      const allConflicts: ConflictInfo[] = [...diff.conflicts, ...untrackedConflicts];
      if (diff.editDeleteConflicts.length > 0) {
        const idToPath = buildIdToPathMap(syncLocalMeta);
        for (const fid of diff.editDeleteConflicts) {
          allConflicts.push({
            fileId: fid,
            fileName: idToPath[fid] || fid,
            localChecksum: syncLocalMeta.files[fid]?.md5Checksum ?? "",
            remoteChecksum: "",
            localModifiedTime: syncLocalMeta.files[fid]?.modifiedTime ?? "",
            remoteModifiedTime: "",
            isEditDelete: true,
          });
        }
      }

      if (allConflicts.length > 0) {
        this.conflicts = allConflicts;
        this.syncStatus = "conflict";
        return;
      }

      // 5. Process the diff
      const cleanup = await this.applyPullDiff(accessToken, rootFolderId, syncLocalMeta, syncRemoteMeta, diff, catchAllPlan, renames, checksums, ignoredIds);

      this.syncStatus = "idle";
      const ignoredCount = ignoredIds?.size ?? 0;
      const pullCount = diff.toPull.length + diff.remoteOnly.length - ignoredCount + cleanup.cleanupRenamed;
      const deleteCount = diff.localOnly.length + cleanup.cleanupDeleted;
      const parts: string[] = [];
      if (pullCount > 0) parts.push(`pulled ${pullCount}`);
      if (deleteCount > 0) parts.push(`deleted ${deleteCount}`);
      if (parts.length > 0) {
        new Notice(`Drive sync: ${parts.join(", ")}`);
      } else {
        new Notice("Drive sync: already up to date");
      }
    } catch (err) {
      this.lastError = formatError(err);
      this.syncStatus = "error";
      new Notice(`Drive sync pull failed: ${this.lastError}`);
    } finally {
      this.syncLock = false;
      await this.refreshSyncCounts();
    }
  }

  /**
   * Trash a vault file by path. Two failure modes the plain
   * fileManager.trashFile() call doesn't cover:
   * - Obsidian's index doesn't surface the file (case mismatch on
   *   case-sensitive FS, external add not yet picked up) — trashFile
   *   silently no-ops because its TFile argument never existed.
   * - The user's "Deleted files" setting is "Permanently delete".
   *   fileManager.trashFile is documented to only handle .trash/ and
   *   OS-trash options; with "Permanent" it silently no-ops for certain
   *   file types (observed on .txt/.pdf but not .md).
   * In both cases the caller wipes the matching metadata while the file
   * stays on disk — it then looks new on the next sync and gets
   * re-pushed, undoing the remote delete. So after trashFile we verify
   * the file is gone and force-delete if not.
   * Returns true if a file was actually removed.
   */
  private async trashByPath(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        await this.app.fileManager.trashFile(file);
      } catch (err) {
        console.debug("[DriveSync] trashFile failed, will force-delete:", err);
      }
      if (!(await this.app.vault.adapter.exists(path))) return true;
      // trashFile returned but the file is still on disk: it silently
      // no-ops for the "Permanent delete" setting on some file types.
      // Force-remove via the adapter so the sync state stays consistent
      // with the remote deletion.
      await this.app.vault.adapter.remove(path);
      return true;
    }
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.trashLocal(path);
      return true;
    }
    return false;
  }

  /**
   * Apply pull diff: delete local-only, download remote changes.
   * Returns counts of files cleaned up by the catch-all step (not in diff).
   */
  private async applyPullDiff(
    accessToken: string,
    rootFolderId: string,
    localMeta: LocalDriveSyncMeta,
    remoteMeta: SyncMeta,
    diff: SyncDiff,
    catchAllPlan: CatchAllPullPlan,
    renames: Map<string, string> = new Map(),
    checksums: Map<string, string> = new Map(),
    ignoredIds?: Set<string>
  ): Promise<{ cleanupDeleted: number; cleanupRenamed: number }> {
    const idToPath = buildIdToPathMap(localMeta);

    // Case-insensitive lookup of current on-disk paths (handles NTFS/macOS
    // case divergence between tracked paths and the actual filesystem)
    const diskPathByLower = new Map<string, string>();
    for (const p of checksums.keys()) diskPathByLower.set(p.toLowerCase(), p);

    // 1. Delete localOnly files (remotely deleted)
    // The local copy may no longer sit at its tracked path (pending local
    // rename/move, or case divergence). Resolve the actual on-disk location
    // before trashing — otherwise trashByPath silently no-ops while the meta
    // entries below are still removed, leaving an untracked file on disk that
    // the next push re-uploads to Drive as a new file.
    for (const fileId of diff.localOnly) {
      const trackedPath = idToPath[fileId];
      if (trackedPath) {
        const target = renames.get(trackedPath)
          ?? (checksums.has(trackedPath)
            ? trackedPath
            : diskPathByLower.get(trackedPath.toLowerCase()) ?? trackedPath);
        await this.trashByPath(target);
        delete localMeta.pathToId[trackedPath];
      }
      delete localMeta.files[fileId];
    }

    // 2. Handle remote renames: remove old local file before downloading to new path
    //    Skip ignored files — they keep local content at the original path
    //    Skip case-only differences (same file on case-insensitive FS like NTFS/macOS)
    for (const fileId of diff.toPull) {
      if (ignoredIds?.has(fileId)) continue;
      const oldPath = idToPath[fileId];
      const remotePath = remoteMeta.files[fileId]?.name;
      if (oldPath && remotePath && oldPath !== remotePath
          && oldPath.toLowerCase() !== remotePath.toLowerCase()) {
        await this.trashByPath(oldPath);
        delete localMeta.pathToId[oldPath];
      }
    }

    // 2b. Download toPull + remoteOnly files (excluding ignored)
    const allFilesToPull = [...diff.toPull, ...diff.remoteOnly];
    const filesToPull = ignoredIds?.size ? allFilesToPull.filter(id => !ignoredIds.has(id)) : allFilesToPull;

    for (let i = 0; i < filesToPull.length; i += CONCURRENCY) {
      const batch = filesToPull.slice(i, i + CONCURRENCY);
      accessToken = (await this.getTokens()).accessToken;
      await Promise.all(batch.map(async (fileId) => {
        await this.downloadFile(accessToken, rootFolderId, fileId, remoteMeta, localMeta);
      }));
    }

    // 2c. Apply the fallback cleanup plan for metadata edge cases.
    let cleanupDeleteCount = 0;
    let cleanupRenameCount = 0;
    const additionalDownloads: string[] = [];
    for (const item of catchAllPlan.deletes) {
      if (ignoredIds?.has(item.fileId)) continue;
      if (await this.trashByPath(item.path)) {
        cleanupDeleteCount++;
      }
      delete localMeta.pathToId[item.path];
      delete localMeta.files[item.fileId];
    }

    for (const item of catchAllPlan.renames) {
      if (ignoredIds?.has(item.fileId)) continue;
      await this.trashByPath(item.oldPath);
      delete localMeta.pathToId[item.oldPath];
      if (item.backupExistingTarget) {
        if (await this.app.vault.adapter.exists(item.newPath)) {
          if (isBinaryExtension(item.newPath)) {
            const content = await this.app.vault.adapter.readBinary(item.newPath);
            await saveConflictBackup(this.app, item.newPath, content);
          } else {
            const content = await this.app.vault.adapter.read(item.newPath);
            await saveConflictBackup(this.app, item.newPath, content);
          }
        }
      }
      additionalDownloads.push(item.fileId);
      cleanupRenameCount++;
    }

    // Download renamed files that need new-path copies
    for (let i = 0; i < additionalDownloads.length; i += CONCURRENCY) {
      const batch = additionalDownloads.slice(i, i + CONCURRENCY);
      accessToken = (await this.getTokens()).accessToken;
      await Promise.all(batch.map(async (fileId) => {
        await this.downloadFile(accessToken, rootFolderId, fileId, remoteMeta, localMeta);
      }));
    }

    // 3. Update local meta. Ignored files keep their previous entry: their
    // local copy was deliberately left alone, so adopting the remote name and
    // checksum here would map them to a path they do not occupy and make the
    // next push overwrite whichever file actually lives there.
    const vaultStats = new Map<string, { mtime: number; size: number }>();
    for (const f of await this.getAllVaultFiles()) {
      vaultStats.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });
    }
    const updatedLocalMeta = toLocalSyncMeta(
      this.getObsidianSyncableRemoteMeta(remoteMeta) ?? remoteMeta,
      localMeta,
      vaultStats,
      ignoredIds
    );
    await writeLocalSyncMeta(this.app, updatedLocalMeta);

    return { cleanupDeleted: cleanupDeleteCount, cleanupRenamed: cleanupRenameCount };
  }

  /**
   * Download a single file from Drive and write to Vault.
   */
  private async downloadFile(
    accessToken: string,
    _rootFolderId: string,
    fileId: string,
    remoteMeta: SyncMeta,
    localMeta: LocalDriveSyncMeta
  ): Promise<void> {
    const fileMeta = remoteMeta.files[fileId];
    if (!fileMeta) return;
    if (isGoogleWorkspaceMimeType(fileMeta.mimeType)) {
      console.warn("[DriveSync] Skipping Google Workspace file:", fileMeta.name);
      return;
    }

    // Use Drive name as vault path (always current; path field can be stale after renames)
    const vaultPath = fileMeta.name;

    // Validate path safety (no traversal)
    if (!isValidVaultPath(vaultPath)) {
      console.warn("[DriveSync] Skipping unsafe remote path:", vaultPath);
      return;
    }

    // Skip excluded paths (e.g., workspace folder)
    if (this.isExcludedPath(vaultPath)) return;

    const isBinary = isBinaryExtension(vaultPath);

    // Ensure parent directories exist
    const dirPath = vaultPath.substring(0, vaultPath.lastIndexOf("/"));
    if (dirPath) {
      await this.ensureVaultFolder(dirPath);
    }

    // Download and write (use vault API to update Obsidian's internal cache/file tree)
    // Note: getAbstractFileByPath may return null even when the file exists on disk
    // (e.g., during concurrent batch downloads, or if Obsidian's index hasn't caught up).
    // Fall back to adapter.exists + modify if vault.create throws.
    // On case-insensitive filesystems (NTFS, macOS), the actual vault path may
    // differ in case from the remote path (e.g., "Articles/" vs "articles/").
    // Capture the actual TFile path from write operations for correct metadata.
    let actualPath = vaultPath;
    const existingFile = this.app.vault.getAbstractFileByPath(vaultPath);
    if (isBinary) {
      const content = await drive.readFileRaw(accessToken, fileId);
      if (existingFile instanceof TFile) {
        await this.app.vault.modifyBinary(existingFile, content);
        actualPath = existingFile.path;
      } else {
        try {
          const created = await this.app.vault.createBinary(vaultPath, content);
          actualPath = created.path;
        } catch {
          // File may already exist on disk; fall back to adapter write
          await this.app.vault.adapter.writeBinary(vaultPath, content);
          // On case-insensitive FS, the actual path may differ from vaultPath
          const found = this.app.vault.getAbstractFileByPath(vaultPath);
          if (found instanceof TFile) actualPath = found.path;
        }
      }
    } else {
      const content = await drive.readFile(accessToken, fileId);
      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, content);
        actualPath = existingFile.path;
      } else {
        try {
          const created = await this.app.vault.create(vaultPath, content);
          actualPath = created.path;
        } catch {
          // File may already exist on disk; fall back to adapter write
          await this.app.vault.adapter.write(vaultPath, content);
          // On case-insensitive FS, the actual path may differ from vaultPath
          const found = this.app.vault.getAbstractFileByPath(vaultPath);
          if (found instanceof TFile) actualPath = found.path;
        }
      }
    }

    // Update local meta using actual vault path (may differ from remote path on case-insensitive FS)
    localMeta.pathToId[actualPath] = fileId;
    localMeta.files[fileId] = {
      md5Checksum: fileMeta.md5Checksum,
      modifiedTime: fileMeta.modifiedTime ?? "",
      name: fileMeta.name,
    };
  }

  /**
   * Ensure a folder path exists in the Vault.
   * Uses vault.createFolder to register directories in Obsidian's index,
   * which prevents vault.create from failing for files in new directories.
   */
  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Folder may already exist on disk (concurrent creation);
          // ensure it exists at minimum via adapter
          try { await this.app.vault.adapter.mkdir(current); } catch { /* ignore */ }
        }
      }
    }
  }

  // ========================================
  // Full Pull
  // ========================================

  async fullPull(): Promise<void> {
    if (this.syncLock) {
      console.warn("[DriveSync] fullPull skipped: sync already in progress");
      return;
    }
    this.syncLock = true;
    this.syncStatus = "pulling";
    this.lastError = null;
    new Notice(t("driveSync.startFullPulling"));

    try {
      await this.waitForRefreshCounts();
      const tokens = await this.getTokens();
      let { accessToken } = tokens;
      const { rootFolderId } = tokens;

      // Get remote meta (or rebuild)
      const remoteMeta = await this.readReconciledRemoteMeta(accessToken, rootFolderId);
      const syncRemoteMeta = this.getObsidianSyncableRemoteMeta(remoteMeta);
      if (!syncRemoteMeta) {
        new Notice("Drive sync: no remote data found");
        this.syncStatus = "idle";
        return;
      }

      // Build empty local meta (full pull = remote is authoritative)
      const newLocalMeta: LocalDriveSyncMeta = {
        lastUpdatedAt: new Date().toISOString(),
        files: {},
        pathToId: {},
      };

      // Rebuild tracking by path and current contents, independent of old Drive
      // IDs. Full pull must rehash even when cached local stats are unchanged.
      const fileIds = Object.keys(syncRemoteMeta.files).filter(id => {
        const path = syncRemoteMeta.files[id].name;
        return isValidVaultPath(path) && !this.isExcludedPath(path);
      });
      let downloadedCount = 0;
      let matchedCount = 0;

      for (let i = 0; i < fileIds.length; i += CONCURRENCY) {
        const batch = fileIds.slice(i, i + CONCURRENCY);
        // Refresh per batch: a whole-vault download can outlast the token.
        accessToken = (await this.getTokens()).accessToken;
        await Promise.all(batch.map(async (fileId) => {
          const fileMeta = syncRemoteMeta.files[fileId];
          const path = fileMeta.name;
          let matches = false;
          if (fileMeta.md5Checksum) {
            try {
              if ((await this.app.vault.adapter.stat(path))?.type === "file") {
                const checksum = isBinaryExtension(path)
                  ? md5Hash(new Uint8Array(await this.app.vault.adapter.readBinary(path)))
                  : md5HashString(await this.app.vault.adapter.read(path));
                matches = checksum === fileMeta.md5Checksum;
              }
            } catch (err) {
              // A failed local check is never evidence of equality. Try the
              // normal download, which will report any persistent write error.
              console.warn(`[DriveSync] Full pull checksum failed: ${path}`, err);
            }
          }
          if (matches) {
            newLocalMeta.pathToId[path] = fileId;
            newLocalMeta.files[fileId] = {
              md5Checksum: fileMeta.md5Checksum,
              modifiedTime: fileMeta.modifiedTime,
              name: path,
            };
            matchedCount++;
            return;
          }
          await this.downloadFile(accessToken, rootFolderId, fileId, syncRemoteMeta, newLocalMeta);
          if (newLocalMeta.files[fileId]) downloadedCount++;
        }));
      }

      // Reconcile pathToId with actual vault paths (case-insensitive FS support).
      // On NTFS/macOS, remote path "articles/x.md" is written to "Articles/x.md"
      // but pathToId may store the remote-case path. Build a lookup to reconcile.
      const vaultPathsByLower = new Map<string, string>();
      for (const f of await this.getAllVaultFiles()) {
        vaultPathsByLower.set(f.path.toLowerCase(), f.path);
      }
      const reconciledPathToId: Record<string, string> = {};
      for (const [path, id] of Object.entries(newLocalMeta.pathToId)) {
        const actualPath = vaultPathsByLower.get(path.toLowerCase()) ?? path;
        reconciledPathToId[actualPath] = id;
      }
      newLocalMeta.pathToId = reconciledPathToId;

      // Delete vault files not in remote
      const vaultFiles = await this.getAllVaultFiles();
      for (const file of vaultFiles) {
        if (!newLocalMeta.pathToId[file.path]) {
          await this.trashByPath(file.path);
        }
      }

      // Save local meta (collect fresh vault stats after download)
      const freshVaultStats = new Map<string, { mtime: number; size: number }>();
      for (const f of await this.getAllVaultFiles()) {
        freshVaultStats.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });
      }
      // Only include downloaded or checksum-matched files in localMeta.
      // toLocalSyncMeta adds ALL remoteMeta entries, but files that were
      // skipped (excluded, invalid path, or not indexed by Obsidian) would
      // appear as false "deleted" items in subsequent push checks.
      const trackedIds = new Set(Object.keys(newLocalMeta.files));
      const filteredRemoteMeta: SyncMeta = {
        lastUpdatedAt: syncRemoteMeta.lastUpdatedAt,
        files: Object.fromEntries(
          Object.entries(syncRemoteMeta.files).filter(([id]) => trackedIds.has(id))
        ),
      };
      const updatedLocalMeta = toLocalSyncMeta(filteredRemoteMeta, newLocalMeta, freshVaultStats);
      await writeLocalSyncMeta(this.app, updatedLocalMeta);

      this.syncStatus = "idle";
      new Notice(`Drive sync: full pull completed (${downloadedCount} downloaded, ${matchedCount} unchanged)`);
    } catch (err) {
      this.lastError = formatError(err);
      this.syncStatus = "error";
      new Notice(`Drive sync full pull failed: ${this.lastError}`);
    } finally {
      this.syncLock = false;
      await this.refreshSyncCounts();
    }
  }

  // ========================================
  // Full Push
  // ========================================

  async fullPush(): Promise<void> {
    if (this.syncLock) {
      console.warn("[DriveSync] fullPush skipped: sync already in progress");
      return;
    }
    this.syncLock = true;
    this.syncStatus = "pushing";
    this.lastError = null;
    new Notice(t("driveSync.startFullPushing"));

    try {
      await this.waitForRefreshCounts();
      const tokens = await this.getTokens();
      let { accessToken } = tokens;
      const { rootFolderId } = tokens;

      // Build fresh local meta
      const newLocalMeta: LocalDriveSyncMeta = {
        lastUpdatedAt: new Date().toISOString(),
        files: {},
        pathToId: {},
      };

      // Read existing local meta to reuse Drive file IDs
      const oldLocalMeta = await readLocalSyncMeta(this.app);

      // Get all vault files and compute checksums
      const vaultFiles = await this.getAllVaultFiles();
      const { checksums, vaultStats: fullPushVaultStats } = await this.computeVaultChecksums(vaultFiles, oldLocalMeta);

      // Fetch the reusable Drive IDs only after the potentially long local
      // checksum scan, immediately before uploads begin.
      const existingRemoteMeta = await readRemoteSyncMeta(accessToken, rootFolderId);
      const existingRemoteFiles = await drive.listUserFiles(accessToken, rootFolderId);
      const reusableRemoteIds = new Set(existingRemoteFiles.map((file) => file.id));

      // Build fresh remote meta (full push = local is authoritative for
      // Obsidian-syncable files, but preserves Google Workspace files for kiokuflow).
      const remoteMeta: SyncMeta = {
        lastUpdatedAt: new Date().toISOString(),
        files: Object.fromEntries(
          existingRemoteFiles
            .filter((file) => isGoogleWorkspaceMimeType(file.mimeType))
            .map((file) => {
              const prev = existingRemoteMeta?.files[file.id];
              return [file.id, {
                name: file.name,
                path: prev?.path,
                mimeType: file.mimeType,
                md5Checksum: file.md5Checksum ?? "",
                modifiedTime: file.modifiedTime ?? "",
                createdTime: file.createdTime,
                shared: prev?.shared,
                webViewLink: prev?.webViewLink,
                publicPath: prev?.publicPath,
                size: file.size ?? prev?.size,
              }];
            })
        ),
      };

      // Upload all files. Like push(), refresh the token and checkpoint the
      // remote metadata as we go: a whole-vault upload is the longest operation
      // the plugin performs and can outlast both the token and the session.
      let uploadedCount = 0;
      const allPaths = vaultFiles.map(f => f.path);
      let metaFileId: string | null = null;
      let lastCheckpointAt = Date.now();
      const checkpointRemoteMeta = async (force = false): Promise<void> => {
        if (!force && Date.now() - lastCheckpointAt < PUSH_CHECKPOINT_INTERVAL_MS) return;
        remoteMeta.lastUpdatedAt = new Date().toISOString();
        accessToken = (await this.getTokens()).accessToken;
        metaFileId = await writeRemoteSyncMeta(accessToken, rootFolderId, remoteMeta, metaFileId);
        lastCheckpointAt = Date.now();
      };

      for (let i = 0; i < allPaths.length; i += CONCURRENCY) {
        const batch = allPaths.slice(i, i + CONCURRENCY);
        accessToken = (await this.getTokens()).accessToken;
        const results = await Promise.allSettled(batch.map(async (path) => {
          const cachedId = oldLocalMeta.pathToId[path];
          const existingId = cachedId && reusableRemoteIds.has(cachedId) ? cachedId : undefined;
          await this.uploadFile(
            accessToken, rootFolderId, path, existingId, remoteMeta, newLocalMeta, checksums,
            existingId ? existingRemoteMeta?.files[existingId] : undefined,
          );
          uploadedCount++;
        }));
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        await checkpointRemoteMeta(rejected !== undefined);
        if (rejected) throw rejected.reason;
      }

      // Move remote-only files to trash so full push makes Drive match the local vault.
      // Preserve files at excluded paths — they're owned by another tool
      // (e.g. kiokuflow's `web/`) that syncs to the same Drive folder.
      const trackedIds = new Set(Object.keys(remoteMeta.files));
      const filesToTrash = existingRemoteFiles.filter((file) => {
        if (trackedIds.has(file.id)) return false;
        if (isGoogleWorkspaceMimeType(file.mimeType)) return false;
        if (this.isExcludedPath(file.name)) return false;
        return true;
      });
      if (filesToTrash.length > 0) {
        accessToken = (await this.getTokens()).accessToken;
        const trashFolderId = await drive.ensureSubFolder(accessToken, rootFolderId, "trash");
        for (const file of filesToTrash) {
          await drive.moveFile(accessToken, file.id, trashFolderId, rootFolderId);
        }
      }

      // Write updated remote meta
      await checkpointRemoteMeta(true);

      // Save local meta (with vault stats for mtime/size caching)
      const updatedLocalMeta = toLocalSyncMeta(this.getObsidianSyncableRemoteMeta(remoteMeta) ?? remoteMeta, newLocalMeta, fullPushVaultStats);
      await writeLocalSyncMeta(this.app, updatedLocalMeta);

      this.syncStatus = "idle";
      const detail = filesToTrash.length > 0 ? `, ${filesToTrash.length} trashed` : "";
      new Notice(`Drive sync: full push completed (${uploadedCount} files${detail})`);
    } catch (err) {
      this.lastError = formatError(err);
      this.syncStatus = "error";
      new Notice(`Drive sync full push failed: ${this.lastError}`);
    } finally {
      this.syncLock = false;
      await this.refreshSyncCounts();
    }
  }

  // ========================================
  // Conflict Resolution
  // ========================================

  /**
   * Resolve conflicts in one batch.
   *
   * Everything loop-invariant — tokens, both metadata documents, the metadata
   * file id, the vault walk — is done once for the whole batch, and the
   * per-item network work runs CONCURRENCY-wide. Resolving items one at a time
   * previously cost ~7 Drive round trips and a full vault walk *per file*.
   *
   * Individual failures are collected rather than thrown, so one bad file
   * cannot abandon the rest of the batch.
   */
  async resolveConflicts(
    fileIds: string[],
    choice: "local" | "remote",
    onProgress?: (done: number, total: number) => void
  ): Promise<{ resolved: number; failed: number }> {
    if (fileIds.length === 0) return { resolved: 0, failed: 0 };
    if (this.syncLock) {
      console.warn("[DriveSync] resolveConflicts skipped: sync already in progress");
      return { resolved: 0, failed: fileIds.length };
    }
    this.syncLock = true;
    this.lastError = null;

    const resolvedIds = new Set<string>();
    let failed = 0;
    let shouldPull = false;
    try {
      // A background refreshSyncCounts() rewrites _sync-meta.json underneath us;
      // pull() and push() wait on it for the same reason before reading metadata.
      await this.waitForRefreshCounts();

      const { accessToken, rootFolderId } = await this.getTokens();
      const localMeta = await readLocalSyncMeta(this.app);
      const remoteMeta = await readRemoteSyncMeta(accessToken, rootFolderId);
      if (!remoteMeta) throw new Error("Remote meta not found");

      const ctx: ConflictResolveContext = {
        accessToken,
        rootFolderId,
        localMeta,
        remoteMeta,
        metaFileId: null,
        remoteDirty: false,
        remoteUpsertIds: new Set(),
        remoteDeleteIds: new Set(),
        touchedPaths: new Set(),
      };

      const idToPath = buildIdToPathMap(localMeta);
      const items: { fileId: string; vaultPath: string; conflict: ConflictInfo }[] = [];
      for (const fileId of fileIds) {
        const conflict = this.conflicts.find(c => c.fileId === fileId);
        if (!conflict) {
          console.warn("[DriveSync] resolveConflicts: conflict not found:", fileId);
          failed++;
          continue;
        }
        items.push({ fileId, vaultPath: idToPath[fileId] || conflict.fileName, conflict });
      }

      let lastCheckpointAt = Date.now();
      const checkpointRemoteMeta = async (force = false): Promise<void> => {
        if (!ctx.remoteDirty) return;
        if (!force && Date.now() - lastCheckpointAt < PUSH_CHECKPOINT_INTERVAL_MS) return;
        ctx.accessToken = (await this.getTokens()).accessToken;
        const latest = await readRemoteSyncMeta(ctx.accessToken, ctx.rootFolderId);
        if (!latest) throw new Error("Remote meta not found while saving conflict resolutions");
        // Merge only this batch's mutations into the latest document so files
        // added or changed by another device during a long resolution survive.
        for (const id of ctx.remoteDeleteIds) delete latest.files[id];
        for (const id of ctx.remoteUpsertIds) {
          const entry = ctx.remoteMeta.files[id];
          if (entry) latest.files[id] = entry;
        }
        latest.lastUpdatedAt = new Date().toISOString();
        ctx.remoteMeta = latest;
        ctx.metaFileId = await writeRemoteSyncMeta(
          ctx.accessToken, ctx.rootFolderId, ctx.remoteMeta, ctx.metaFileId
        );
        ctx.remoteDirty = false;
        ctx.remoteUpsertIds.clear();
        ctx.remoteDeleteIds.clear();
        lastCheckpointAt = Date.now();
      };

      try {
        for (let i = 0; i < items.length; i += CONCURRENCY) {
          const batch = items.slice(i, i + CONCURRENCY);
          ctx.accessToken = (await this.getTokens()).accessToken;
          await Promise.all(batch.map(async (item) => {
            try {
              if (item.conflict.isEditDelete) {
                await this.resolveEditDeleteConflict(ctx, item.fileId, item.vaultPath, choice);
              } else {
                await this.resolveNormalConflict(ctx, item.fileId, item.vaultPath, choice);
              }
              resolvedIds.add(item.fileId);
            } catch (err) {
              failed++;
              this.lastError = formatError(err);
              console.warn("[DriveSync] Conflict resolution failed:", item.vaultPath, err);
            }
          }));
          onProgress?.(resolvedIds.size + failed, fileIds.length);
          // Between batches only, so a half-mutated remoteMeta is never written.
          await checkpointRemoteMeta();
        }
      } finally {
        // Persist what was applied — and drop the items that were applied —
        // even if the loop threw partway through.
        const persisted = await this.flushConflictMeta(ctx, checkpointRemoteMeta);
        if (persisted) {
          this.conflicts = this.conflicts.filter(c => !resolvedIds.has(c.fileId));
        } else {
          failed += resolvedIds.size;
          resolvedIds.clear();
        }
      }

      // If no more conflicts, continue pull while still holding the lock
      if (this.conflicts.length === 0 && this.syncStatus === "conflict") {
        shouldPull = true;
      }
    } catch (err) {
      this.lastError = formatError(err);
      this.syncStatus = "error";
      throw err;
    } finally {
      this.syncLock = false;
    }

    if (shouldPull) {
      // pull() acquires its own lock; no gap for interleaving
      // since JS is single-threaded and we release+reacquire synchronously
      await this.pull();
    }
    return { resolved: resolvedIds.size, failed };
  }

  /**
   * Write the metadata a conflict batch accumulated.
   *
   * Never throws: it runs on the error path too, where masking the original
   * failure would be worse than a logged metadata write failure. Remote is
   * written first because the local metadata is derived from the in-memory
   * remote copy; if the remote write fails, readReconciledRemoteMeta re-derives
   * remote truth from a live Drive listing on the next sync anyway.
   */
  private async flushConflictMeta(
    ctx: ConflictResolveContext,
    checkpointRemoteMeta: (force?: boolean) => Promise<void>
  ): Promise<boolean> {
    let succeeded = true;
    try {
      await checkpointRemoteMeta(true);
    } catch (err) {
      succeeded = false;
      this.lastError = formatError(err);
      console.warn("[DriveSync] Failed to write remote meta after conflict resolution:", err);
    }
    try {
      const vaultStats = await this.statTouchedPaths(ctx.touchedPaths);
      // Conflict resolution applies only the selected files. Keep the local
      // baseline for everything else until pull actually applies its changes.
      // Adopting a pending remote rename here would drop the old path while
      // its file is still on disk, turning that copy into a new push target.
      // Pending remote deletions and edits need the same protection.
      const untouchedIds = new Set(
        Object.entries(ctx.localMeta.pathToId)
          .filter(([path]) => !ctx.touchedPaths.has(path))
          .map(([, id]) => id)
      );
      const updatedLocalMeta = toLocalSyncMeta(
        this.getObsidianSyncableRemoteMeta(ctx.remoteMeta) ?? ctx.remoteMeta,
        ctx.localMeta,
        vaultStats,
        untouchedIds
      );
      await writeLocalSyncMeta(this.app, updatedLocalMeta);
    } catch (err) {
      succeeded = false;
      this.lastError = formatError(err);
      console.warn("[DriveSync] Failed to write local meta after conflict resolution:", err);
    }
    return succeeded;
  }

  /**
   * Stat only the paths a conflict batch wrote.
   *
   * toLocalSyncMeta carries over the cached mtime/size of every untouched file
   * whose checksum is unchanged, so a full vault walk is unnecessary — and
   * stamping current on-disk stats onto files this batch never wrote would let
   * computeVaultChecksums' mtime+size fast path reuse a stale hash and hide a
   * real local edit.
   */
  private async statTouchedPaths(
    paths: Set<string>
  ): Promise<Map<string, { mtime: number; size: number }>> {
    const stats = new Map<string, { mtime: number; size: number }>();
    const list = [...paths];
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      await Promise.all(list.slice(i, i + CONCURRENCY).map(async (path) => {
        try {
          const stat = await this.app.vault.adapter.stat(path);
          if (stat?.type === "file") stats.set(path, { mtime: stat.mtime, size: stat.size });
        } catch (err) {
          console.warn(`[DriveSync] stat failed for ${path}:`, err);
        }
      }));
    }
    return stats;
  }

  /**
   * Read a vault file once, returning its content and MD5 (null if absent).
   * Hashes exactly like computeVaultChecksums, so the checksum is directly
   * comparable to Drive's md5Checksum.
   */
  private async readLocalWithChecksum(vaultPath: string): Promise<
    | { binary: true; content: ArrayBuffer; checksum: string }
    | { binary: false; content: string; checksum: string }
    | null
  > {
    if (!(await this.app.vault.adapter.exists(vaultPath))) return null;
    if (isBinaryExtension(vaultPath)) {
      const content = await this.app.vault.adapter.readBinary(vaultPath);
      return { binary: true, content, checksum: md5Hash(new Uint8Array(content)) };
    }
    const content = await this.app.vault.adapter.read(vaultPath);
    return { binary: false, content, checksum: md5HashString(content) };
  }

  private async resolveNormalConflict(
    ctx: ConflictResolveContext,
    fileId: string,
    vaultPath: string,
    choice: "local" | "remote"
  ): Promise<void> {
    // One read serves the identical-content check, the upload and the backup.
    const local = await this.readLocalWithChecksum(vaultPath);
    const fileMeta = ctx.remoteMeta.files[fileId];
    const remoteChecksum = fileMeta?.md5Checksum ?? "";

    // False conflict from stale metadata: the file on disk already matches the
    // remote content, so either choice is a no-op. Adopt the remote entry
    // without a backup or a transfer — same shortcut pull() applies to
    // already-matching remote-only files.
    if (local && fileMeta && remoteChecksum && local.checksum === remoteChecksum) {
      ctx.localMeta.pathToId[vaultPath] = fileId;
      ctx.localMeta.files[fileId] = {
        md5Checksum: remoteChecksum,
        modifiedTime: fileMeta.modifiedTime ?? "",
        name: fileMeta.name,
      };
      ctx.touchedPaths.add(vaultPath);
      return;
    }

    if (choice === "local") {
      // Local wins: upload local content to Drive, backup remote
      if (local) {
        // Backup remote content (binary or text)
        if (local.binary) {
          const remoteContent = await drive.readFileRaw(ctx.accessToken, fileId);
          await saveConflictBackup(this.app, vaultPath, remoteContent);
        } else {
          const remoteContent = await drive.readFile(ctx.accessToken, fileId);
          await saveConflictBackup(this.app, vaultPath, remoteContent);
        }

        // Upload local content
        const mimeType = getMimeType(vaultPath);
        const driveFile = local.binary
          ? await drive.updateFileBinary(ctx.accessToken, fileId, local.content, mimeType)
          : await drive.updateFile(ctx.accessToken, fileId, local.content, mimeType);

        upsertFileInMeta(ctx.remoteMeta, driveFile, vaultPath);
        ctx.remoteDirty = true;
        ctx.remoteUpsertIds.add(fileId);
        ctx.touchedPaths.add(vaultPath);
      }
    } else {
      // Remote wins: download remote content, backup local
      if (local) {
        await saveConflictBackup(this.app, vaultPath, local.content);
      }

      // Download remote content. remoteMeta is untouched here, so this branch
      // never needs a remote metadata write.
      await this.downloadFile(ctx.accessToken, ctx.rootFolderId, fileId, ctx.remoteMeta, ctx.localMeta);
      ctx.touchedPaths.add(vaultPath);
    }
  }

  private async resolveEditDeleteConflict(
    ctx: ConflictResolveContext,
    fileId: string,
    vaultPath: string,
    choice: "local" | "remote"
  ): Promise<void> {
    const local = await this.readLocalWithChecksum(vaultPath);

    if (choice === "local") {
      // Keep local file: re-upload to Drive
      if (local) {
        const mimeType = getMimeType(vaultPath);

        // Drive uses flat structure: file name = vault path
        const driveFile = local.binary
          ? await drive.createFileBinary(ctx.accessToken, vaultPath, local.content, ctx.rootFolderId, mimeType)
          : await drive.createFile(ctx.accessToken, vaultPath, local.content, ctx.rootFolderId, mimeType);

        // Update mappings with new file ID
        ctx.localMeta.pathToId[vaultPath] = driveFile.id;
        upsertFileInMeta(ctx.remoteMeta, driveFile, vaultPath);
        ctx.remoteUpsertIds.add(driveFile.id);
        ctx.touchedPaths.add(vaultPath);
      }
    } else {
      // Accept deletion: remove local file
      if (local) {
        // Backup before deleting (binary or text)
        await saveConflictBackup(this.app, vaultPath, local.content);
      }
      await this.trashByPath(vaultPath);
      delete ctx.localMeta.pathToId[vaultPath];
      delete ctx.localMeta.files[fileId];
    }

    // Remove old file ID from remote meta
    removeFileFromMeta(ctx.remoteMeta, fileId);
    ctx.remoteDeleteIds.add(fileId);
    ctx.remoteDirty = true;
  }

  // ========================================
  // Trash Management (trash/ folder on Drive)
  // ========================================

  async listTrashFiles(): Promise<drive.DriveFile[]> {
    const tokens = await this.getTokens();
    const trashFolderId = await drive.ensureSubFolder(tokens.accessToken, tokens.rootFolderId, "trash");
    return drive.listFiles(tokens.accessToken, trashFolderId);
  }

  async restoreFromTrash(fileIds: string[]): Promise<number> {
    const tokens = await this.getTokens();
    const { accessToken, rootFolderId } = tokens;
    const trashFolderId = await drive.ensureSubFolder(accessToken, rootFolderId, "trash");
    const remoteMeta = await readRemoteSyncMeta(accessToken, rootFolderId) ?? {
      lastUpdatedAt: new Date().toISOString(),
      files: {},
    };

    let restored = 0;
    for (const fileId of fileIds) {
      try {
        await drive.moveFile(accessToken, fileId, rootFolderId, trashFolderId);
        const fileMeta = await drive.getFileMetadata(accessToken, fileId);
        upsertFileInMeta(remoteMeta, fileMeta, fileMeta.name);
        restored++;
      } catch (err) {
        // ignore individual restore failures
        console.debug("[DriveSync] restoreFromTrash failed for file:", fileId, err);
      }
    }

    if (restored > 0) {
      await writeRemoteSyncMeta(accessToken, rootFolderId, remoteMeta);
    }
    return restored;
  }

  async permanentDeleteFiles(fileIds: string[]): Promise<number> {
    const tokens = await this.getTokens();
    let deleted = 0;
    for (const fileId of fileIds) {
      try {
        await drive.deleteFile(tokens.accessToken, fileId);
        deleted++;
      } catch (err) {
        // ignore individual delete failures
        console.debug("[DriveSync] permanentDeleteFiles failed for file:", fileId, err);
      }
    }
    return deleted;
  }

  // ========================================
  // Conflict Backup Management (local conflict-backups/ folder)
  // ========================================

  async listConflictFiles(): Promise<ConflictBackupEntry[]> {
    const adapter = this.app.vault.adapter;
    const folder = getConflictBackupFolder();
    if (!(await adapter.exists(folder))) return [];

    const { files } = await adapter.list(folder);
    const entries: ConflictBackupEntry[] = [];
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      await Promise.all(files.slice(i, i + CONCURRENCY).map(async (path) => {
        try {
          const stat = await adapter.stat(path);
          if (stat?.type !== "file") return;
          entries.push({ path, name: path.slice(path.lastIndexOf("/") + 1), mtime: stat.mtime });
        } catch (err) {
          console.warn(`[DriveSync] stat failed for ${path}:`, err);
        }
      }));
    }
    return entries.sort((a, b) => b.mtime - a.mtime);
  }

  async restoreConflictFile(backupPath: string, restoreName: string): Promise<void> {
    const restorePath = restorePathFromConflictBackupName(restoreName);
    const isBinary = isBinaryExtension(restorePath);

    // Restore the backup as a timestamped local file and keep the current file untouched.
    const dirPath = restorePath.substring(0, restorePath.lastIndexOf("/"));
    if (dirPath) await this.ensureVaultFolder(dirPath);

    const existingLocal = this.app.vault.getAbstractFileByPath(restorePath);
    if (isBinary) {
      const content = await this.app.vault.adapter.readBinary(backupPath);
      if (existingLocal instanceof TFile) {
        await this.app.vault.modifyBinary(existingLocal, content);
      } else {
        await this.app.vault.createBinary(restorePath, content);
      }
    } else {
      const content = await this.app.vault.adapter.read(backupPath);
      if (existingLocal instanceof TFile) {
        await this.app.vault.modify(existingLocal, content);
      } else {
        await this.app.vault.create(restorePath, content);
      }
    }
  }

  async deleteConflictFiles(backupPaths: string[]): Promise<number> {
    let deleted = 0;
    for (const path of backupPaths) {
      try {
        await this.app.vault.adapter.remove(path);
        deleted++;
      } catch (err) {
        // ignore individual delete failures
        console.debug("[DriveSync] deleteConflictFiles failed for file:", path, err);
      }
    }
    return deleted;
  }

  /** Read a local conflict backup for preview. */
  async readConflictBackup(backupPath: string): Promise<string> {
    return this.app.vault.adapter.read(backupPath);
  }

  // ========================================
  // Temp File Management (__TEMP__/ folder on Drive)
  // ========================================

  async listTempFiles(): Promise<drive.DriveFile[]> {
    const tokens = await this.getTokens();
    const tempFolderId = await drive.ensureSubFolder(tokens.accessToken, tokens.rootFolderId, "__TEMP__");
    const files = await drive.listFiles(tokens.accessToken, tempFolderId);

    return files.filter(file => !file.name.startsWith("_") && !isGoogleWorkspaceMimeType(file.mimeType));
  }

  /** Read one temporary payload only when previewing or applying it. */
  async readTempFile(fileId: string): Promise<TempFilePayload> {
    const tokens = await this.getTokens();
    const payload: unknown = JSON.parse(await drive.readFile(tokens.accessToken, fileId));
    if (!payload || typeof payload !== "object" ||
      !("fileId" in payload) || typeof payload.fileId !== "string" || !payload.fileId ||
      !("content" in payload) || typeof payload.content !== "string" ||
      ("isBinary" in payload && typeof payload.isBinary !== "boolean") ||
      ("filePath" in payload && (typeof payload.filePath !== "string" || !isValidVaultPath(payload.filePath))) ||
      ("savedAt" in payload && typeof payload.savedAt !== "string")) {
      throw new Error(t("driveSync.tempFilesInvalid"));
    }
    return {
      // Web text payloads omit isBinary; preserve their legacy text semantics.
      fileId: payload.fileId, content: payload.content, isBinary: "isBinary" in payload && payload.isBinary === true,
      ...("filePath" in payload && typeof payload.filePath === "string" ? { filePath: payload.filePath } : {}),
      savedAt: "savedAt" in payload ? payload.savedAt as string : "",
    };
  }

  async applyTempFile(tempFileId: string, payload: TempFilePayload): Promise<drive.DriveFile> {
    const tokens = await this.getTokens();
    const { accessToken, rootFolderId } = tokens;

    const vaultPath = payload.filePath ?? payload.fileId;
    // saveTempFile() sets fileId to the vault path when the file has never been
    // pushed, so a payload where both fields match describes a file that does
    // not exist on Drive yet. Payloads written before filePath existed (or by
    // another client) must not take this branch: their fileId is a real Drive
    // ID, and creating a file named after it would litter the vault root.
    const isNewFile = payload.filePath !== undefined && payload.fileId === payload.filePath;
    const mimeType = getMimeType(vaultPath);
    const fileMeta = isNewFile
      ? payload.isBinary
        ? await drive.createFileBinary(accessToken, vaultPath, base64ToArrayBuffer(payload.content), rootFolderId, mimeType)
        : await drive.createFile(accessToken, vaultPath, payload.content, rootFolderId, mimeType)
      : payload.isBinary
        ? await drive.updateFileBinary(accessToken, payload.fileId, base64ToArrayBuffer(payload.content))
        : await drive.updateFile(accessToken, payload.fileId, payload.content);

    // Update remote meta
    const remoteMeta = await readRemoteSyncMeta(accessToken, rootFolderId) ?? {
      lastUpdatedAt: new Date().toISOString(),
      files: {},
    };
    upsertFileInMeta(remoteMeta, fileMeta, payload.filePath ?? fileMeta.name);
    await writeRemoteSyncMeta(accessToken, rootFolderId, remoteMeta);

    // Delete the temp file
    await drive.deleteFile(accessToken, tempFileId);
    return fileMeta;
  }

  /**
   * Save a vault file to __TEMP__/ on Drive.
   * Mirrors kiokuflow's saveTempFile logic (overwrite if same name exists).
   * Returns { fileId, fileName } for use by callers.
   */
  async saveTempFile(vaultPath: string): Promise<{ fileId: string; fileName: string }> {
    const tokens = await this.getTokens();
    const { accessToken, rootFolderId } = tokens;

    const localMeta = await readLocalSyncMeta(this.app);
    const fileId = localMeta.pathToId[vaultPath] || vaultPath;

    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${vaultPath}`);
    if (file.stat.size > MAX_TEMP_FILE_BYTES) {
      throw new Error(`File too large (${Math.round(file.stat.size / 1024 / 1024)}MB). Max 30MB.`);
    }

    const binary = isBinaryExtension(vaultPath);
    const content = binary
      ? arrayBufferToBase64(await this.app.vault.readBinary(file))
      : await this.app.vault.read(file);

    const payload: TempFilePayload = {
      fileId,
      filePath: vaultPath,
      content,
      savedAt: new Date().toISOString(),
      isBinary: binary,
    };

    const tempFolderId = await drive.ensureSubFolder(accessToken, rootFolderId, "__TEMP__");
    // Use full vault path with "/" replaced to avoid collisions between
    // files with the same basename in different directories.
    const fileName = vaultPath.split("/").join("%2F");
    const payloadJson = JSON.stringify(payload);

    // Overwrite if same name exists
    const existing = (await drive.listFiles(accessToken, tempFolderId))
      .find((f) => f.name === fileName);
    if (existing) {
      await drive.updateFile(accessToken, existing.id, payloadJson, "application/json");
    } else {
      await drive.createFile(accessToken, fileName, payloadJson, tempFolderId, "application/json");
    }

    return { fileId, fileName };
  }

  /**
   * Download a temp file's content to the vault, then apply to Drive and delete temp.
   */
  async downloadTempToVault(tempFileId: string, payload: TempFilePayload): Promise<void> {
    // Resolve vault path from fileId
    const localMeta = await readLocalSyncMeta(this.app);
    const idToPath = buildIdToPathMap(localMeta);
    let vaultPath = payload.filePath ?? idToPath[payload.fileId];
    if (!vaultPath) {
      // Legacy/kiokuflow payloads do not carry filePath. Resolve the real Drive
      // name instead of ever treating the opaque Drive ID as a vault path.
      const tokens = await this.getTokens();
      vaultPath = (await drive.getFileMetadata(tokens.accessToken, payload.fileId)).name;
    }

    // Ensure parent directory exists
    const dirPath = vaultPath.substring(0, vaultPath.lastIndexOf("/"));
    if (dirPath) {
      await this.ensureVaultFolder(dirPath);
    }

    // Write to vault (use vault API to update Obsidian's internal cache/file tree)
    const existingFile = this.app.vault.getAbstractFileByPath(vaultPath);
    if (payload.isBinary) {
      const buf = base64ToArrayBuffer(payload.content);
      if (existingFile instanceof TFile) {
        await this.app.vault.modifyBinary(existingFile, buf);
      } else {
        await this.app.vault.createBinary(vaultPath, buf);
      }
    } else {
      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, payload.content);
      } else {
        await this.app.vault.create(vaultPath, payload.content);
      }
    }

    // Apply to Drive and delete temp
    const fileMeta = await this.applyTempFile(tempFileId, payload);

    // Record the applied state locally. The vault copy and the Drive copy are
    // now identical, so without this the stale local checksum makes the next
    // sync report a conflict on a file that is actually up to date.
    for (const [path, id] of Object.entries(localMeta.pathToId)) {
      if (id === fileMeta.id && path !== vaultPath) delete localMeta.pathToId[path];
    }
    localMeta.pathToId[vaultPath] = fileMeta.id;
    const stat = await this.app.vault.adapter.stat(vaultPath);
    localMeta.files[fileMeta.id] = {
      md5Checksum: fileMeta.md5Checksum ?? "",
      modifiedTime: fileMeta.modifiedTime ?? "",
      name: vaultPath,
      localMtime: stat?.mtime,
      localSize: stat?.size,
    };
    await writeLocalSyncMeta(this.app, localMeta);
  }

  async deleteTempFiles(fileIds: string[]): Promise<number> {
    const tokens = await this.getTokens();
    let deleted = 0;
    for (const fileId of fileIds) {
      try {
        await drive.deleteFile(tokens.accessToken, fileId);
        deleted++;
      } catch (err) {
        // ignore individual delete failures
        console.debug("[DriveSync] deleteTempFiles failed for file:", fileId, err);
      }
    }
    return deleted;
  }

  // ========================================
  // RAG Sync (after push)
  // ========================================

  // Shared persisted key; kiokuflow web also retains this for existing RAG stores.
  private static readonly DEFAULT_RAG_STORE_KEY = "gemihub";
  private static readonly RAG_CONCURRENCY = 5;

  /**
   * Sync files to the kiokuflow RAG store after a successful push.
   * Handles deletions, renames, and new/modified file uploads with checksum-based skip.
   */
  private async syncRagAfterPush(
    accessToken: string,
    rootFolderId: string,
    uploadedPaths: string[],
    renames: Map<string, string>,
    deletedPaths: string[]
  ): Promise<void> {
    // 1. Precondition checks
    if (!this.plugin.settings.ragEnabled) return;

    const ragSetting = this.plugin.workspaceState.ragSettings[DriveSyncManager.DEFAULT_RAG_STORE_KEY];
    if (!ragSetting) return;
    if (!ragSetting.storeId) return;
    if (ragSetting.isExternal) return;

    const fileSearchManager = getFileSearchManager();
    if (!fileSearchManager) return;

    const storeId = ragSetting.storeId;

    // 2. Build filter config with workspace/.obsidian exclusions
    const excludePatterns = [...ragSetting.excludePatterns];
    for (const folder of [WORKSPACE_FOLDER, LEGACY_WORKSPACE_FOLDER]) {
      excludePatterns.push(`^${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
    }
    excludePatterns.push(`^\\.obsidian/`);
    const filterConfig: FilterConfig = {
      includeFolders: ragSetting.targetFolders,
      excludePatterns,
    };

    const updatedFiles: Record<string, RagFileInfo> = { ...ragSetting.files };

    // 3. Delete files from RAG store
    for (const filePath of deletedPaths) {
      if (!updatedFiles[filePath]) continue;
      try {
        await fileSearchManager.deleteFileFromStoreById(filePath, storeId);
      } catch {
        // Ignore deletion errors
      }
      delete updatedFiles[filePath];
    }

    // 4. Handle renames (delete old path, upload new path)
    for (const [oldPath, newPath] of renames) {
      // Delete old path from RAG store
      if (updatedFiles[oldPath]) {
        try {
          await fileSearchManager.deleteFileFromStoreById(oldPath, storeId);
        } catch {
          // Ignore deletion errors
        }
        delete updatedFiles[oldPath];
      }

      // Upload new path if eligible
      const newFile = this.app.vault.getAbstractFileByPath(newPath);
      if (!(newFile instanceof TFile)) continue;
      if (!isSupportedFile(newFile)) continue;
      if (!shouldIncludeFile(newPath, filterConfig)) continue;

      try {
        const { checksum } = await fileSearchManager.getChecksumForFile(newFile);
        const fileId = await fileSearchManager.uploadFileToStore(newFile, storeId);
        updatedFiles[newPath] = { checksum, uploadedAt: Date.now(), fileId };
      } catch (err) {
        console.debug(`[DriveSync] RAG upload failed for renamed file: ${newPath}`, err);
      }
    }

    // 5. Upload new/modified files (checksum-based skip, batched)
    const renamedNewPaths = new Set(renames.values());
    const filesToProcess = uploadedPaths.filter(p => !renamedNewPaths.has(p));
    const uploadQueue: Array<{ file: TFile; path: string }> = [];

    for (const path of filesToProcess) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      if (!isSupportedFile(file)) continue;
      if (!shouldIncludeFile(path, filterConfig)) continue;
      uploadQueue.push({ file, path });
    }

    // Process uploads in batches with concurrency limit
    for (let i = 0; i < uploadQueue.length; i += DriveSyncManager.RAG_CONCURRENCY) {
      const batch = uploadQueue.slice(i, i + DriveSyncManager.RAG_CONCURRENCY);
      await Promise.all(batch.map(async ({ file, path }) => {
        try {
          const { checksum } = await fileSearchManager.getChecksumForFile(file);

          // Skip if unchanged
          const existing = updatedFiles[path];
          if (existing && existing.checksum === checksum) return;

          // Delete old document if it exists
          if (existing) {
            try {
              await fileSearchManager.deleteFileFromStoreById(path, storeId);
            } catch {
              // Ignore deletion errors
            }
          }

          const fileId = await fileSearchManager.uploadFileToStore(file, storeId);
          updatedFiles[path] = { checksum, uploadedAt: Date.now(), fileId };
        } catch (err) {
          console.debug(`[DriveSync] RAG upload failed for: ${path}`, err);
        }
      }));
    }

    // 6. Update local workspace state
    this.plugin.workspaceState.ragSettings[DriveSyncManager.DEFAULT_RAG_STORE_KEY] = {
      ...ragSetting,
      files: updatedFiles,
    };
    await this.plugin.saveWorkspaceState();

    // 7. Update kiokuflow settings.json on Drive
    await this.updateKiokuflowSettingsOnDrive(accessToken, rootFolderId, updatedFiles);

    console.debug(`[DriveSync] RAG sync completed: ${Object.keys(updatedFiles).length} files tracked`);
  }

  /**
   * Update kiokuflow's settings.json on Drive with the current RAG file tracking info.
   * Reads existing settings, merges ragSettings["gemihub"].files with status: "registered",
   * and writes back to Drive.
   */
  private async updateKiokuflowSettingsOnDrive(
    accessToken: string,
    rootFolderId: string,
    files: Record<string, RagFileInfo>
  ): Promise<void> {
    const SETTINGS_FILE_NAME = "settings.json";

    try {
      // Read existing settings.json from Drive
      const existingFile = await drive.findFileByExactName(accessToken, SETTINGS_FILE_NAME, rootFolderId);

      let settings: Record<string, unknown> = {};
      if (existingFile) {
        const content = await drive.readFile(accessToken, existingFile.id);
        try {
          settings = JSON.parse(content) as Record<string, unknown>;
        } catch {
          // Invalid JSON, start fresh
          settings = {};
        }
      }

      // Ensure ragSettings structure exists
      if (!settings.ragSettings || typeof settings.ragSettings !== "object") {
        settings.ragSettings = {} as Record<string, unknown>;
      }
      const ragSettings = settings.ragSettings as Record<string, Record<string, unknown>>;
      if (!ragSettings[DriveSyncManager.DEFAULT_RAG_STORE_KEY]) {
        ragSettings[DriveSyncManager.DEFAULT_RAG_STORE_KEY] = {};
      }
      const storeSettings = ragSettings[DriveSyncManager.DEFAULT_RAG_STORE_KEY];

      // Merge files with status: "registered" for kiokuflow compatibility
      const registeredFiles: Record<string, RagFileInfo & { status: string }> = {};
      for (const [path, info] of Object.entries(files)) {
        registeredFiles[path] = { ...info, status: "registered" };
      }
      storeSettings.files = registeredFiles;

      // Copy storeId from local ragSetting
      const localRagSetting = this.plugin.workspaceState.ragSettings[DriveSyncManager.DEFAULT_RAG_STORE_KEY];
      if (localRagSetting) {
        storeSettings.storeId = localRagSetting.storeId;
        storeSettings.storeName = localRagSetting.storeName;
      }

      // Set ragEnabled and selectedRagSetting if files are registered
      if (Object.keys(files).length > 0) {
        settings.ragEnabled = true;
        settings.selectedRagSetting = DriveSyncManager.DEFAULT_RAG_STORE_KEY;
      }

      // Write back to Drive
      const content = JSON.stringify(settings, null, 2);
      if (existingFile) {
        await drive.updateFile(accessToken, existingFile.id, content, "application/json");
      } else {
        await drive.createFile(accessToken, SETTINGS_FILE_NAME, content, rootFolderId, "application/json");
      }
    } catch (err) {
      console.debug("[DriveSync] Failed to update kiokuflow settings.json on Drive:", err);
    }
  }

  destroy(): void {
    this.lock();
  }
}
