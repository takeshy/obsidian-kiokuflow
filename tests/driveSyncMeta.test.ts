import { describe, it, expect } from "vitest";
import {
  buildConflictBackupName,
  restorePathFromConflictBackupName,
  restoreOriginalPathFromConflictBackupName,
  getConflictBackupFolder,
  saveConflictBackup,
  toLocalSyncMeta,
  upsertFileInMeta,
  removeFileFromMeta,
  type LocalDriveSyncMeta,
} from "../src/core/driveSyncMeta";
import type { SyncMeta } from "../src/core/syncDiff";
import { isSyncExcludedPath } from "../src/core/driveSyncUtils";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";
import type { App } from "obsidian";

const asApp = (vault: FakeVault) => createFakeApp(vault) as unknown as App;

describe("conflict backup naming", () => {
  const at = new Date(Date.UTC(2026, 7, 11, 9, 30, 15));

  it("flattens nested paths into a single timestamped file name", () => {
    const name = buildConflictBackupName("notes/sub dir/foo.md", at);
    expect(name).toBe("notes%2Fsub%20dir%2Ffoo_20260811_093015_000.md");
    expect(name).not.toContain("/");
  });

  it("appends the timestamp when the path has no extension", () => {
    expect(buildConflictBackupName("LICENSE", at)).toBe("LICENSE_20260811_093015_000");
  });

  it("round-trips the original path", () => {
    const name = buildConflictBackupName("notes/sub dir/foo.md", at);
    expect(restoreOriginalPathFromConflictBackupName(name)).toBe("notes/sub dir/foo.md");
  });

  it("decodes to a timestamped sibling so restoring never clobbers the live file", () => {
    const name = buildConflictBackupName("notes/foo.md", at);
    expect(restorePathFromConflictBackupName(name)).toBe("notes/foo_20260811_093015_000.md");
  });

  it("decodes exactly once, so paths containing a percent survive", () => {
    // Double-decoding "100%25.md" would corrupt it into "100%.md" -> throw/garble.
    const name = buildConflictBackupName("notes/100% done.md", at);
    expect(restoreOriginalPathFromConflictBackupName(name)).toBe("notes/100% done.md");
  });
});

describe("saveConflictBackup", () => {
  it("writes into the vault instead of Drive, under the sync-excluded workspace folder", async () => {
    const vault = new FakeVault();
    await saveConflictBackup(asApp(vault), "notes/foo.md", "local text");

    const written = vault.pathsUnder(getConflictBackupFolder());
    expect(written).toHaveLength(1);
    expect(vault.getFile(written[0])).toBe("local text");

    // The whole point of choosing this folder: it never gets pushed back.
    expect(isSyncExcludedPath(written[0])).toBe(true);
  });

  it("stores binary content verbatim", async () => {
    const vault = new FakeVault();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await saveConflictBackup(asApp(vault), "img/pic.png", bytes.buffer as ArrayBuffer);

    const written = vault.pathsUnder(getConflictBackupFolder());
    expect(written).toHaveLength(1);
    const stat = await vault.adapter.stat(written[0]);
    expect(stat?.size).toBe(6);
  });

  it("survives concurrent callers racing to create the folder", async () => {
    const vault = new FakeVault();
    // mkdir on an existing folder throws in the fake, mirroring a real adapter.
    await Promise.all([
      saveConflictBackup(asApp(vault), "a.md", "a"),
      saveConflictBackup(asApp(vault), "b.md", "b"),
      saveConflictBackup(asApp(vault), "c.md", "c"),
      saveConflictBackup(asApp(vault), "d.md", "d"),
      saveConflictBackup(asApp(vault), "e.md", "e"),
    ]);
    expect(vault.pathsUnder(getConflictBackupFolder())).toHaveLength(5);
  });

  it("does not overwrite an existing backup with the same timestamped name", async () => {
    const vault = new FakeVault();
    const app = asApp(vault);
    await saveConflictBackup(app, "notes/foo.md", "first");
    await saveConflictBackup(app, "notes/foo.md", "second");
    const written = vault.pathsUnder(getConflictBackupFolder());
    expect(written).toHaveLength(2);
    expect(written.map((path) => vault.getFile(path)).sort()).toEqual(["first", "second"]);
  });
});

describe("toLocalSyncMeta", () => {
  const remote = (files: SyncMeta["files"]): SyncMeta => ({
    lastUpdatedAt: "2026-08-11T00:00:00.000Z",
    files,
  });

  it("carries over cached mtime/size for files with no fresh stat and an unchanged checksum", () => {
    // This is what lets conflict resolution stat only the paths it touched
    // instead of walking the entire vault.
    const existing: LocalDriveSyncMeta = {
      lastUpdatedAt: "",
      files: {
        untouched: { md5Checksum: "aaa", modifiedTime: "t1", name: "keep.md", localMtime: 111, localSize: 22 },
      },
      pathToId: { "keep.md": "untouched" },
    };
    const result = toLocalSyncMeta(
      remote({ untouched: { name: "keep.md", mimeType: "text/markdown", md5Checksum: "aaa", modifiedTime: "t1" } }),
      existing,
      new Map() // nothing was touched
    );

    expect(result.files.untouched.localMtime).toBe(111);
    expect(result.files.untouched.localSize).toBe(22);
  });

  it("drops stale cached mtime/size when the checksum changed", () => {
    const existing: LocalDriveSyncMeta = {
      lastUpdatedAt: "",
      files: {
        changed: { md5Checksum: "old", modifiedTime: "t1", name: "f.md", localMtime: 111, localSize: 22 },
      },
      pathToId: { "f.md": "changed" },
    };
    const result = toLocalSyncMeta(
      remote({ changed: { name: "f.md", mimeType: "text/markdown", md5Checksum: "new", modifiedTime: "t2" } }),
      existing,
      new Map()
    );

    // Keeping them would let the mtime+size fast path reuse a stale hash.
    expect(result.files.changed.localMtime).toBeUndefined();
    expect(result.files.changed.localSize).toBeUndefined();
  });

  it("prefers freshly stat'd values for touched paths", () => {
    const existing: LocalDriveSyncMeta = {
      lastUpdatedAt: "",
      files: { id1: { md5Checksum: "aaa", modifiedTime: "t1", name: "f.md", localMtime: 1, localSize: 2 } },
      pathToId: { "f.md": "id1" },
    };
    const result = toLocalSyncMeta(
      remote({ id1: { name: "f.md", mimeType: "text/markdown", md5Checksum: "bbb", modifiedTime: "t2" } }),
      existing,
      new Map([["f.md", { mtime: 999, size: 888 }]])
    );

    expect(result.files.id1).toMatchObject({ md5Checksum: "bbb", localMtime: 999, localSize: 888 });
  });

  it("matches stats case-insensitively so NTFS/macOS paths still record", () => {
    const result = toLocalSyncMeta(
      remote({ id1: { name: "Notes/F.md", mimeType: "text/markdown", md5Checksum: "bbb", modifiedTime: "t" } }),
      { lastUpdatedAt: "", files: {}, pathToId: { "notes/f.md": "id1" } },
      new Map([["notes/f.md", { mtime: 5, size: 6 }]])
    );

    expect(result.files.id1.localMtime).toBe(5);
    expect(result.pathToId["notes/f.md"]).toBe("id1");
  });

  it("prunes pathToId entries for files no longer on the remote", () => {
    const result = toLocalSyncMeta(
      remote({ kept: { name: "kept.md", mimeType: "text/markdown", md5Checksum: "a", modifiedTime: "t" } }),
      { lastUpdatedAt: "", files: {}, pathToId: { "kept.md": "kept", "gone.md": "deleted-id" } },
      new Map()
    );

    expect(result.pathToId).toEqual({ "kept.md": "kept" });
  });

  it("keeps preserved entries that are absent from the remote (pending remote deletion)", () => {
    const existing: LocalDriveSyncMeta = {
      lastUpdatedAt: "",
      files: {
        kept: { md5Checksum: "a", modifiedTime: "t", name: "kept.md" },
        "deleted-id": { md5Checksum: "b", modifiedTime: "t", name: "gone.md", localMtime: 7, localSize: 8 },
      },
      pathToId: { "kept.md": "kept", "gone.md": "deleted-id" },
    };
    const result = toLocalSyncMeta(
      remote({ kept: { name: "kept.md", mimeType: "text/markdown", md5Checksum: "a", modifiedTime: "t" } }),
      existing,
      new Map(),
      new Set(["deleted-id"])
    );

    // The tracking entry survives verbatim so a later pull can still see the
    // file as remotely deleted and remove it from disk.
    expect(result.pathToId["gone.md"]).toBe("deleted-id");
    expect(result.files["deleted-id"]).toEqual(existing.files["deleted-id"]);
  });

  it("lets a remote file that adopted the path win over a preserved absent id", () => {
    const result = toLocalSyncMeta(
      remote({ "new-id": { name: "gone.md", mimeType: "text/markdown", md5Checksum: "c", modifiedTime: "t" } }),
      {
        lastUpdatedAt: "",
        files: { "deleted-id": { md5Checksum: "b", modifiedTime: "t", name: "gone.md" } },
        pathToId: { "gone.md": "deleted-id" },
      },
      new Map(),
      new Set(["deleted-id"])
    );

    expect(result.pathToId["gone.md"]).toBe("new-id");
    expect(result.files["deleted-id"]).toBeUndefined();
  });
});

describe("remote meta mutation helpers", () => {
  it("upsert records the vault path and bumps lastUpdatedAt", () => {
    const meta: SyncMeta = { lastUpdatedAt: "old", files: {} };
    upsertFileInMeta(
      meta,
      { id: "id1", name: "a.md", mimeType: "text/markdown", md5Checksum: "abc", modifiedTime: "t" },
      "a.md"
    );

    expect(meta.files.id1).toMatchObject({ name: "a.md", path: "a.md", md5Checksum: "abc" });
    expect(meta.lastUpdatedAt).not.toBe("old");
  });

  it("upsert keeps kiokuflow publish state that Drive does not return", () => {
    const meta: SyncMeta = {
      lastUpdatedAt: "old",
      files: {
        id1: {
          name: "a.md", mimeType: "text/markdown", md5Checksum: "abc", modifiedTime: "t",
          shared: true, webViewLink: "https://drive/view", publicPath: "/public/file/id1/a.md?sig=x", size: "10",
        },
      },
    };
    upsertFileInMeta(
      meta,
      { id: "id1", name: "a.md", mimeType: "text/markdown", md5Checksum: "def", modifiedTime: "t2" },
      "a.md"
    );

    expect(meta.files.id1).toMatchObject({
      md5Checksum: "def",
      shared: true,
      webViewLink: "https://drive/view",
      publicPath: "/public/file/id1/a.md?sig=x",
    });
    // Content changed and Drive returned no size: the old size is stale.
    expect(meta.files.id1.size).toBeUndefined();
  });

  it("upsert takes the previous entry from the caller when meta was rebuilt", () => {
    const meta: SyncMeta = { lastUpdatedAt: "old", files: {} };
    upsertFileInMeta(
      meta,
      { id: "id1", name: "a.md", mimeType: "text/markdown", md5Checksum: "abc", modifiedTime: "t", size: "12" },
      "a.md",
      { name: "a.md", mimeType: "text/markdown", md5Checksum: "abc", modifiedTime: "t0", shared: true, publicPath: "/p" }
    );

    expect(meta.files.id1).toMatchObject({ shared: true, publicPath: "/p", size: "12" });
  });

  it("upsert leaves publish fields absent for a never-published file", () => {
    const meta: SyncMeta = { lastUpdatedAt: "old", files: {} };
    upsertFileInMeta(
      meta,
      { id: "id1", name: "a.md", mimeType: "text/markdown", md5Checksum: "abc", modifiedTime: "t" },
      "a.md"
    );
    expect("shared" in meta.files.id1).toBe(false);
    expect("publicPath" in meta.files.id1).toBe(false);
  });

  it("remove deletes the entry", () => {
    const meta: SyncMeta = {
      lastUpdatedAt: "old",
      files: { id1: { name: "a.md", mimeType: "text/markdown", md5Checksum: "abc", modifiedTime: "t" } },
    };
    removeFileFromMeta(meta, "id1");
    expect(meta.files).toEqual({});
  });
});
