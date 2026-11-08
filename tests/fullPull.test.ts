import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { KiokuflowPlugin } from "../src/plugin";
import type { SyncMeta } from "../src/core/syncDiff";
import type { LocalDriveSyncMeta } from "../src/core/driveSyncMeta";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";
import { notices } from "./stubs/obsidian";
import { DEFAULT_SETTINGS } from "../src/types";
import { md5Hash, md5HashString } from "../src/core/driveSyncUtils";

vi.mock("../src/core/googleDrive", async () => {
  const { createFakeDrive } = await import("./helpers/fakeDrive");
  return createFakeDrive();
});
vi.mock("../src/core/googleDriveAuth", () => ({ getValidSessionTokens: vi.fn(async tokens => tokens) }));
import * as drive from "../src/core/googleDrive";
import { DriveSyncManager } from "../src/core/driveSync";
import type { FakeDriveState } from "./helpers/fakeDrive";
const fake = drive as unknown as {
  __state: FakeDriveState;
  __put(name: string, content: string | ArrayBuffer, id?: string): { id: string };
};

function fixture(initial: Record<string, string> = {}) {
  const vault = new FakeVault(initial);
  const app = createFakeApp(vault) as unknown as App;
  const plugin = { settings: { ...DEFAULT_SETTINGS, driveSync: { ...DEFAULT_SETTINGS.driveSync, enabled: true } } } as unknown as KiokuflowPlugin;
  const manager = new DriveSyncManager(app, plugin);
  const meta: SyncMeta = { lastUpdatedAt: "2026-11-08T00:00:00Z", files: {} };
  const internals = manager as unknown as {
    sessionTokens: unknown;
    readReconciledRemoteMeta: (token: string, root: string) => Promise<SyncMeta>;
  };
  internals.sessionTokens = { accessToken: "access", rootFolderId: "new-root", expiryTime: Date.now() + 3600000 };
  vi.spyOn(internals, "readReconciledRemoteMeta").mockResolvedValue(meta);
  vi.spyOn(manager, "refreshSyncCounts").mockResolvedValue();
  function remote(path: string, content: string | ArrayBuffer, id: string, checksum = true) {
    fake.__put(path, content, id);
    meta.files[id] = {
      name: path,
      mimeType: typeof content === "string" ? "text/markdown" : "application/octet-stream",
      modifiedTime: meta.lastUpdatedAt,
      md5Checksum: checksum ? (typeof content === "string" ? md5HashString(content) : md5Hash(new Uint8Array(content))) : "",
    };
  }
  const tracking = () => JSON.parse(vault.getFile("KiokuFlow/drive-sync-meta.json")!) as LocalDriveSyncMeta;
  return { vault, app, manager, meta, remote, tracking };
}

beforeEach(() => {
  vi.restoreAllMocks();
  fake.__state.files.clear();
  fake.__state.contents.clear();
  fake.__state.failFileIds.clear();
  fake.__state.reset();
  notices.length = 0;
});

describe("Full pull checksum matching", () => {
  it("skips hundreds of matching files, rebuilds migrated IDs and downloads only changes", async () => {
    const { vault, manager, remote, tracking } = fixture({ "changed.md": "local", "local-only.md": "remove" });
    const old: LocalDriveSyncMeta = { lastUpdatedAt: "old", files: {}, pathToId: {} };
    for (let i = 0; i < 200; i++) {
      const path = `notes/${i}.md`;
      vault.setFile(path, `content ${i}`);
      remote(path, `content ${i}`, `new-${i}`);
      old.pathToId[path] = `old-${i}`;
      old.files[`old-${i}`] = { name: path, md5Checksum: md5HashString(`content ${i}`), modifiedTime: "old" };
    }
    vault.setFile("KiokuFlow/drive-sync-meta.json", JSON.stringify(old));
    remote("changed.md", "remote", "changed");
    remote("new.md", "new", "added");
    const unchangedStat = await vault.adapter.stat("notes/0.md");
    vault.resetCounters();
    await manager.fullPull();
    expect(manager.syncStatus).toBe("idle");
    expect(vault.getFile("changed.md")).toBe("remote");
    expect(vault.getFile("new.md")).toBe("new");
    expect(vault.getFile("notes/0.md")).toBe("content 0");
    expect(await vault.adapter.stat("notes/0.md")).toEqual(unchangedStat);
    expect(vault.trashed).toEqual(["local-only.md"]);
    expect(fake.__state.countCalls("readFile")).toBe(2);
    expect(fake.__state.countCalls("readFileRaw")).toBe(0);
    expect(vault.counters.write).toBe(3); // changed, new and rebuilt tracking
    expect(vault.counters.writeBinary).toBe(0);
    expect(Object.keys(tracking().files)).toHaveLength(202);
    expect(tracking().pathToId["notes/0.md"]).toBe("new-0");
    expect(tracking().files["old-0"]).toBeUndefined();
    expect(tracking().files["new-0"].localMtime).toBe(unchangedStat!.mtime);
    expect(notices).toContain("Drive sync: full pull completed (2 downloaded, 200 unchanged)");
  });

  it("compares binary bytes without downloading or rewriting matching images", async () => {
    const { vault, manager, remote, tracking } = fixture();
    const bytes = new Uint8Array([0, 255, 128, 13, 10]).buffer;
    vault.setFile("image.png", bytes);
    remote("image.png", bytes, "image-new");
    await manager.fullPull();
    expect(manager.syncStatus).toBe("idle");
    expect(fake.__state.countCalls("readFileRaw")).toBe(0);
    expect(vault.counters.writeBinary).toBe(0);
    expect(tracking().pathToId["image.png"]).toBe("image-new");
  });

  it("downloads mismatched binary files and files without a remote checksum", async () => {
    const { vault, manager, remote } = fixture({ "no-hash.md": "same" });
    vault.setFile("image.png", new Uint8Array([1, 2]).buffer);
    const updated = new Uint8Array([3, 4]).buffer;
    remote("image.png", updated, "image");
    remote("no-hash.md", "same", "no-hash", false);
    await manager.fullPull();
    expect(fake.__state.countCalls("readFileRaw")).toBe(1);
    expect(fake.__state.countCalls("readFile")).toBe(1);
    expect(await vault.adapter.readBinary("image.png")).toEqual(updated);
  });

  it("rehashes actual contents despite unchanged cached mtime and size", async () => {
    const { vault, manager, remote } = fixture({ "note.md": "edit" });
    const stat = (await vault.adapter.stat("note.md"))!;
    vault.setFile("KiokuFlow/drive-sync-meta.json", JSON.stringify({
      lastUpdatedAt: "old", pathToId: { "note.md": "old-id" },
      files: { "old-id": { md5Checksum: md5HashString("same"), modifiedTime: "old", localMtime: stat.mtime, localSize: stat.size } },
    }));
    remote("note.md", "same", "new-id");
    await manager.fullPull();
    expect(vault.getFile("note.md")).toBe("same");
    expect(fake.__state.countCalls("readFile")).toBe(1);
  });

  it("downloads normally when the local checksum read fails", async () => {
    const { vault, manager, remote } = fixture({ "note.md": "same" });
    remote("note.md", "same", "note");
    vi.spyOn(vault.adapter, "read").mockRejectedValueOnce(new Error("temporary read failure"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await manager.fullPull();
    expect(manager.syncStatus).toBe("idle");
    expect(fake.__state.countCalls("readFile")).toBe(1);
  });

  it("preserves the actual local path when a case-insensitive adapter resolves the remote path", async () => {
    const { vault, manager, remote, tracking } = fixture({ "Notes/a.md": "same" });
    remote("notes/a.md", "same", "new-id");
    const read = vault.adapter.read;
    const stat = vault.adapter.stat;
    vi.spyOn(vault.adapter, "read").mockImplementation(path => read(path === "notes/a.md" ? "Notes/a.md" : path));
    vi.spyOn(vault.adapter, "stat").mockImplementation(path => stat(path === "notes/a.md" ? "Notes/a.md" : path));
    await manager.fullPull();
    expect(manager.syncStatus).toBe("idle");
    expect(fake.__state.countCalls("readFile")).toBe(0);
    expect(tracking().pathToId).toEqual({ "Notes/a.md": "new-id" });
    expect(vault.getFile("Notes/a.md")).toBe("same");
    expect(vault.trashed).toEqual([]);
  });

  it("downloads the exact remote path on a case-sensitive filesystem", async () => {
    const { vault, manager, remote, tracking } = fixture({ "Notes/a.md": "same" });
    remote("notes/a.md", "same", "new-id");
    await manager.fullPull();
    expect(manager.syncStatus).toBe("idle");
    expect(fake.__state.countCalls("readFile")).toBe(1);
    expect(tracking().pathToId).toEqual({ "notes/a.md": "new-id" });
    expect(vault.getFile("notes/a.md")).toBe("same");
    expect(vault.trashed).toEqual(["Notes/a.md"]);
  });

  it("leaves excluded paths alone and ignores unsafe remote paths", async () => {
    const { vault, manager, remote, tracking } = fixture({ "KiokuFlow/local.md": "private", "GemiHub/local.md": "legacy" });
    remote("KiokuFlow/local.md", "remote", "internal");
    remote("../outside.md", "unsafe", "unsafe");
    await manager.fullPull();
    expect(manager.syncStatus).toBe("idle");
    expect(fake.__state.countCalls("readFile")).toBe(0);
    expect(tracking().files).toEqual({});
    expect(vault.getFile("KiokuFlow/local.md")).toBe("private");
    expect(vault.getFile("GemiHub/local.md")).toBe("legacy");
  });
});
