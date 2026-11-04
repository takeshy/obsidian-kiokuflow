import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { KiokuflowPlugin } from "../src/plugin";
import { Platform } from "./stubs/obsidian";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";
import { DEFAULT_SETTINGS } from "../src/types";
import { md5HashString } from "../src/core/driveSyncUtils";

vi.mock("../src/core/googleDrive", async () => {
  const { createFakeDrive } = await import("./helpers/fakeDrive");
  return createFakeDrive();
});
vi.mock("../src/core/googleDriveAuth", () => ({ getValidSessionTokens: vi.fn(async tokens => tokens) }));
import * as drive from "../src/core/googleDrive";
import { DriveSyncManager } from "../src/core/driveSync";
import type { FakeDriveState } from "./helpers/fakeDrive";
const fake = drive as unknown as { __state: FakeDriveState; __put(name: string, content: string, id?: string): { id: string } };

type Internals = {
  sessionTokens: unknown;
  computeVaultChecksums(files: { path: string; stat: { mtime: number; size: number } }[], meta?: undefined, verify?: boolean): Promise<{ checksums: Map<string, string> }>;
};
const managers: DriveSyncManager[] = [];
function fixture(initial: Record<string, string> = { "a.md": "old", "b.md": "same" }) {
  const vault = new FakeVault(initial);
  const app = createFakeApp(vault);
  const listeners = new Map<string, (file: { path: string }, oldPath?: string) => void>();
  Object.assign(app.vault, {
    on: (event: string, callback: (file: { path: string }, oldPath?: string) => void) => { listeners.set(event, callback); return { event }; },
    offref: (ref: { event: string }) => listeners.delete(ref.event),
  });
  const plugin = { settings: { ...DEFAULT_SETTINGS, driveSync: { ...DEFAULT_SETTINGS.driveSync, enabled: true } } } as unknown as KiokuflowPlugin;
  const manager = new DriveSyncManager(app as unknown as App, plugin);
  const internal = manager as unknown as Internals;
  internal.sessionTokens = { accessToken: "access", rootFolderId: "root", expiryTime: Date.now() + 3600000 };
  manager.startVaultWatcher(); managers.push(manager);
  const scan = async (verify = false) => {
    const files = await Promise.all(Object.keys(initial).map(async path => ({ path, stat: (await vault.adapter.stat(path))! })));
    return (await internal.computeVaultChecksums(files, undefined, verify)).checksums;
  };
  return { manager, vault, app, listeners, scan };
}
beforeEach(() => { Platform.isMobile = true; fake.__state.files.clear(); fake.__state.contents.clear(); fake.__state.reset(); });
afterEach(() => { for (const manager of managers.splice(0)) manager.destroy(); Platform.isMobile = false; vi.restoreAllMocks(); });

describe("bounded mobile background reads", () => {
  it("reuses hashes for unchanged files during repeated background count checks", async () => {
    const { manager, vault } = fixture();
    await manager.refreshLocalCounts(); expect(vault.counters.read).toBe(2);
    vault.resetCounters(); await manager.refreshLocalCounts(); expect(vault.counters.read).toBe(0);
    expect(manager.localModifiedCount).toBe(2);
  });
  it("invalidates only the edited file even when its mtime and size stay unchanged", async () => {
    const { vault, listeners, scan } = fixture();
    const stat = (await vault.adapter.stat("a.md"))!;
    await scan(); vault.resetCounters(); vault.setFile("a.md", "new");
    const original = vault.adapter.stat;
    vi.spyOn(vault.adapter, "stat").mockImplementation(path => path === "a.md" ? Promise.resolve(stat) : original(path));
    listeners.get("modify")!({ path: "a.md" });
    expect((await scan()).get("a.md")).toBe(md5HashString("new"));
    expect(vault.counters.read).toBe(1);
  });
  it("rehashes before explicit sync even if an edit arrives before its Vault event", async () => {
    const { vault, scan } = fixture({ "a.md": "old" });
    const stat = (await vault.adapter.stat("a.md"))!;
    await scan(); vault.setFile("a.md", "new"); vault.resetCounters();
    vi.spyOn(vault.adapter, "stat").mockResolvedValue(stat);
    expect((await scan(true)).get("a.md")).toBe(md5HashString("new"));
    expect(vault.counters.read).toBe(1);
  });
  it("always reads unindexed files whose same-stat edits may have no Vault events", async () => {
    const { vault, app, scan } = fixture({ "task.workflow": "old" });
    vi.spyOn(app.vault, "getAbstractFileByPath").mockReturnValue(null);
    const stat = (await vault.adapter.stat("task.workflow"))!;
    await scan(); vault.setFile("task.workflow", "new"); vault.resetCounters();
    vi.spyOn(vault.adapter, "stat").mockResolvedValue(stat);
    expect((await scan()).get("task.workflow")).toBe(md5HashString("new"));
    expect(vault.counters.read).toBe(1);
  });
  it("does not cache a read invalidated by an edit while it was in flight", async () => {
    const { vault, listeners, scan } = fixture({ "a.md": "old" });
    let release!: (value: string) => void;
    const read = vi.spyOn(vault.adapter, "read").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = scan(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    listeners.get("modify")!({ path: "a.md" }); release("old"); await pending;
    await scan(); expect(read).toHaveBeenCalledTimes(2);
  });
  it("invalidates renamed folder children and clears caches when the watcher stops", async () => {
    const { manager, vault, listeners, scan } = fixture({ "folder/a.md": "old" });
    await scan(); vault.resetCounters(); listeners.get("rename")!({ path: "other" }, "folder");
    await scan(); expect(vault.counters.read).toBe(1);
    manager.stopVaultWatcher(); manager.startVaultWatcher(); vault.resetCounters();
    await scan(); expect(vault.counters.read).toBe(1);
  });
});

describe("lazy temporary payload reads", () => {
  it("lists hundreds of temporary files without reading any payload", async () => {
    const { manager } = fixture();
    for (let i = 0; i < 500; i++) fake.__put("notes%2F" + i + ".md", "unread attachment", "temp-" + i);
    fake.__put("_internal", "system", "internal");
    const files = await manager.listTempFiles();
    expect(files).toHaveLength(500); expect(fake.__state.countCalls("readFile")).toBe(0);
  });
  it("reads just the requested payload and accepts legacy records without savedAt", async () => {
    const { manager } = fixture();
    fake.__put("note.md", JSON.stringify({ fileId: "original", content: "body", isBinary: false }), "temp");
    await expect(manager.readTempFile("temp")).resolves.toEqual({ fileId: "original", content: "body", isBinary: false, savedAt: "" });
    expect(fake.__state.calls.filter(call => call.fn === "readFile").map(call => call.args[1])).toEqual(["temp"]);
  });
  it("previews and applies Web temporary files without isBinary as text", async () => {
    const { manager, vault } = fixture();
    fake.__put("notes/web.md", "original", "original");
    const webPayload = { fileId: "original", content: "Web draft", savedAt: "2026-11-04T00:00:00Z" };
    fake.__put("notes%2Fweb.md", JSON.stringify(webPayload), "temp");

    const payload = await manager.readTempFile("temp");
    expect(payload).toEqual({ ...webPayload, isBinary: false });
    await manager.downloadTempToVault("temp", payload);

    expect(vault.getFile("notes/web.md")).toBe("Web draft");
    expect(fake.__state.contents.get("original")).toBe("Web draft");
    expect(fake.__state.files.has("temp")).toBe(false);
    expect(fake.__state.countCalls("updateFileBinary")).toBe(0);
  });
  it("preserves explicit binary payloads", async () => {
    const { manager } = fixture();
    const payload = { fileId: "original", content: "AAEC", isBinary: true, savedAt: "" };
    fake.__put("image.png", JSON.stringify(payload), "temp");
    await expect(manager.readTempFile("temp")).resolves.toEqual(payload);
  });
  it("rejects malformed payloads instead of applying corrupt data", async () => {
    const { manager } = fixture();
    for (const value of [null, {}, { fileId: "id", content: 123, isBinary: false },
      ...["false", null, 0].map(isBinary => ({ fileId: "id", content: "x", isBinary }))]) {
      fake.__put("bad.md", JSON.stringify(value), "bad");
      await expect(manager.readTempFile("bad")).rejects.toThrow();
    }
  });
});
