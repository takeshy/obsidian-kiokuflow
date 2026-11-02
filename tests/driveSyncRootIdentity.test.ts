import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { KiokuflowPlugin } from "../src/plugin";

vi.mock("../src/core/googleDrive", async () => {
  const { createFakeDrive } = await import("./helpers/fakeDrive");
  return createFakeDrive();
});
vi.mock("../src/core/googleDriveAuth", () => ({
  decryptAuthData: vi.fn(async () => ({ refreshToken: "refresh", apiOrigin: "https://kiokuflow.net" })),
  refreshAccessToken: vi.fn(async () => ({ accessToken: "access", expiryTime: Date.now() + 3600000 })),
}));

import * as drive from "../src/core/googleDrive";
import { DriveSyncManager } from "../src/core/driveSync";
import { DEFAULT_SETTINGS } from "../src/types";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";

function setup() {
  const vault = new FakeVault({ "GemiHub/drive-sync-meta.json": "original tracking" });
  const plugin = {
    settings: {
      ...DEFAULT_SETTINGS,
      driveSync: {
        ...DEFAULT_SETTINGS.driveSync,
        enabled: true,
        encryptedAuth: { data: "data", encryptedPrivateKey: "key", salt: "salt", rootFolderId: "token-root" },
      },
    },
    saveSettings: vi.fn(),
  } as unknown as KiokuflowPlugin;
  const manager = new DriveSyncManager(createFakeApp(vault) as unknown as App, plugin);
  vi.spyOn(manager, "startAutoSync").mockImplementation(() => undefined);
  vi.spyOn(manager, "startVaultWatcher").mockImplementation(() => undefined);
  vi.spyOn(manager, "refreshSyncCounts").mockResolvedValue();
  return { manager, vault, plugin };
}

beforeEach(() => vi.restoreAllMocks());

describe("Drive workspace identity after rebranding", () => {
  it.each(["gemihub", "kiokuflow", "custom-notes"])("uses the token folder ID when the folder is called %s", async name => {
    const { manager, vault, plugin } = setup();
    const getMetadata = vi.spyOn(drive, "getFileMetadata").mockResolvedValue({
      id: "token-root", name, mimeType: "application/vnd.google-apps.folder",
    });
    const findOrCreate = vi.spyOn(drive, "ensureRootFolder");
    await manager.unlockWithPassword("password");
    expect(getMetadata).toHaveBeenCalledExactlyOnceWith("access", "token-root");
    expect(findOrCreate).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(manager.isUnlocked).toBe(true);
    expect(vault.getFile("GemiHub/drive-sync-meta.json")).toBe("original tracking");
  });

  it.each(["missing", "trashed", "file"])("keeps tracking and stays locked for a %s root", async kind => {
    const { manager, vault, plugin } = setup();
    const getMetadata = vi.spyOn(drive, "getFileMetadata");
    if (kind === "missing") getMetadata.mockRejectedValue(new Error("Drive 404"));
    else getMetadata.mockResolvedValue({
      id: "token-root", name: "kiokuflow",
      mimeType: kind === "file" ? "text/plain" : "application/vnd.google-apps.folder",
      trashed: kind === "trashed",
    });
    const findOrCreate = vi.spyOn(drive, "ensureRootFolder");
    await expect(manager.unlockWithPassword("password")).rejects.toThrow();
    expect(manager.isUnlocked).toBe(false);
    expect(findOrCreate).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(manager.startAutoSync).not.toHaveBeenCalled();
    expect(vault.getFile("GemiHub/drive-sync-meta.json")).toBe("original tracking");
  });
});
