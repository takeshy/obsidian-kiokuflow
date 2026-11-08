import { describe, expect, it, vi } from "vitest";
import { KiokuflowPlugin } from "../src/plugin";
import { DEFAULT_SETTINGS, DEFAULT_RAG_SETTING } from "../src/types";
import { readLocalSyncMeta } from "../src/core/driveSyncMeta";
import { isSyncExcludedPath } from "../src/core/driveSyncUtils";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";

function setup(current: unknown = null, configDir = ".obsidian") {
  const vault = new FakeVault();
  vault.configDir = configDir;
  const loadData = vi.fn(async () => current);
  const saveData = vi.fn(async () => undefined);
  const plugin = Object.assign(Object.create(KiokuflowPlugin.prototype) as KiokuflowPlugin, {
    app: createFakeApp(vault),
    manifest: { id: "kiokuflow" },
    loadData,
    saveData,
  });
  return { plugin, vault, loadData, saveData, legacyPath: `${configDir}/plugins/gemihub/data.json` };
}

describe("kiokuflow settings migration", () => {
  it.each([".obsidian", "custom-config"])("imports old settings once using %s", async configDir => {
    const { plugin, vault, saveData, loadData, legacyPath } = setup(null, configDir);
    const legacy = {
      driveSync: {
        enabled: true,
        encryptedAuth: { data: "encrypted", encryptedPrivateKey: "key", salt: "salt", rootFolderId: "original-root" },
        passwordSecretId: "gemihub-password",
        rootFolderName: "gemihub",
        excludePatterns: ["private/"],
      },
      ragEnabled: true,
    };
    const raw = JSON.stringify(legacy);
    vault.setFile(legacyPath, raw);
    await plugin.loadSettings();
    expect(plugin.settings).toMatchObject(legacy);
    expect(plugin.settings.driveSync.syncIntervalMinutes).toBe(5);
    expect(saveData).toHaveBeenCalledExactlyOnceWith(plugin.settings);
    expect(vault.getFile(legacyPath)).toBe(raw);

    loadData.mockResolvedValue(plugin.settings);
    vault.setFile(legacyPath, JSON.stringify({ ragEnabled: false }));
    await plugin.loadSettings();
    expect(plugin.settings.ragEnabled).toBe(true);
    expect(saveData).toHaveBeenCalledOnce();
  });

  it("does not replace existing kiokuflow settings, including an empty saved object", async () => {
    const { plugin, vault, saveData, legacyPath } = setup({});
    vault.setFile(legacyPath, JSON.stringify({ driveSync: { enabled: true } }));
    await plugin.loadSettings();
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    expect(saveData).not.toHaveBeenCalled();
  });

  it("uses new defaults on a fresh install", async () => {
    const { plugin, saveData } = setup();
    await plugin.loadSettings();
    expect(plugin.settings.driveSync.rootFolderName).toBe("kiokuflow");
    expect(plugin.settings.driveSync.enabled).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
  });

  it("stops loading if legacy settings cannot be parsed", async () => {
    const { plugin, vault, saveData, legacyPath } = setup();
    vault.setFile(legacyPath, "{broken");
    await expect(plugin.loadSettings()).rejects.toThrow();
    expect(saveData).not.toHaveBeenCalled();
    expect(vault.getFile(legacyPath)).toBe("{broken");
  });

  it("migrates sync tracking and RAG state to KiokuFlow before reading them", async () => {
    const { plugin, vault } = setup();
    const state = { ragSettings: { gemihub: { ...DEFAULT_RAG_SETTING, storeId: "original-store" } } };
    const meta = { lastUpdatedAt: "", files: {}, pathToId: { "notes/a.md": "file-a" } };
    vault.setFile("GemiHub/gemini-workspace.json", JSON.stringify(state));
    vault.setFile("GemiHub/drive-sync-meta.json", JSON.stringify(meta));
    await plugin.loadWorkspaceState();
    expect(plugin.workspaceState).toEqual(state);
    expect(await readLocalSyncMeta(plugin.app)).toEqual(meta);
    expect(isSyncExcludedPath("KiokuFlow/drive-sync-meta.json")).toBe(true);
    expect(isSyncExcludedPath("KiokuFlow/conflict-backups/backup.md")).toBe(true);
    expect(isSyncExcludedPath("GemiHub/drive-sync-meta.json")).toBe(true);
    expect(await vault.adapter.exists("GemiHub")).toBe(false);
    await plugin.saveWorkspaceState();
    expect(JSON.parse(vault.getFile("KiokuFlow/gemini-workspace.json")!)).toEqual(state);
  });
});
