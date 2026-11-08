import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { migrateWorkspaceFolder } from "../src/core/workspaceMigration";
import { FakeVault, createFakeApp } from "./helpers/fakeVault";

function fixture(files: Record<string, string>) {
  const vault = new FakeVault(files);
  const app = createFakeApp(vault) as unknown as App;
  return { vault, app, migrate: () => migrateWorkspaceFolder(app) };
}

describe("Vault workspace folder migration", () => {
  it("moves tracking, RAG state and nested binary backups without rewriting them", async () => {
    const { vault, migrate } = fixture({
      "GemiHub/drive-sync-meta.json": '{"pathToId":{"note.md":"original-id"}}',
      "GemiHub/gemini-workspace.json": '{"ragSettings":{"gemihub":{}}}',
    });
    const binary = new Uint8Array([0, 255, 128]).buffer;
    vault.setFile("GemiHub/conflict-backups/nested/backup.png", binary);
    const before = await vault.adapter.stat("GemiHub/drive-sync-meta.json");
    await migrate();
    expect(await vault.adapter.exists("GemiHub")).toBe(false);
    expect(vault.getFile("KiokuFlow/drive-sync-meta.json")).toBe('{"pathToId":{"note.md":"original-id"}}');
    expect(vault.getFile("KiokuFlow/gemini-workspace.json")).toBe('{"ragSettings":{"gemihub":{}}}');
    expect(await vault.adapter.readBinary("KiokuFlow/conflict-backups/nested/backup.png")).toEqual(binary);
    expect(await vault.adapter.stat("KiokuFlow/drive-sync-meta.json")).toEqual(before);
    await migrate();
    expect(vault.pathsUnder("KiokuFlow/")).toHaveLength(3);
  });

  it("overwrites collisions with legacy content while retaining destination-only files", async () => {
    const { vault, migrate } = fixture({
      "GemiHub/drive-sync-meta.json": "legacy tracking",
      "GemiHub/conflict-backups/old.md": "old backup",
      "GemiHub/conflict-backups/same.png": "placeholder",
      "KiokuFlow/drive-sync-meta.json": "new tracking",
      "KiokuFlow/conflict-backups/new.md": "new backup",
      "KiokuFlow/conflict-backups/same.png": "replacement target",
    });
    const binary = new Uint8Array([0, 255, 128]).buffer;
    vault.setFile("GemiHub/conflict-backups/same.png", binary);
    await migrate();
    await migrate();
    expect(vault.getFile("KiokuFlow/drive-sync-meta.json")).toBe("legacy tracking");
    expect(vault.getFile("KiokuFlow/conflict-backups/old.md")).toBe("old backup");
    expect(vault.getFile("KiokuFlow/conflict-backups/new.md")).toBe("new backup");
    expect(await vault.adapter.readBinary("KiokuFlow/conflict-backups/same.png")).toEqual(binary);
    expect(await vault.adapter.exists("GemiHub")).toBe(false);
  });

  it("works before the Vault index contains the folders", async () => {
    const { vault, app, migrate } = fixture({ "GemiHub/drive-sync-meta.json": "tracking", "KiokuFlow/drive-sync-meta.json": "new" });
    vi.spyOn(app.vault, "getAbstractFileByPath").mockReturnValue(null);
    await migrate();
    expect(vault.getFile("KiokuFlow/drive-sync-meta.json")).toBe("tracking");
    expect(await vault.adapter.exists("GemiHub")).toBe(false);
  });

  it("retains legacy files on a failed overwrite and allows a later retry", async () => {
    const { vault, migrate } = fixture({ "GemiHub/drive-sync-meta.json": "tracking", "KiokuFlow/drive-sync-meta.json": "new" });
    vi.spyOn(vault.adapter, "writeBinary").mockRejectedValueOnce(new Error("read only"));
    await expect(migrate()).rejects.toThrow("read only");
    expect(vault.getFile("GemiHub/drive-sync-meta.json")).toBe("tracking");
    expect(vault.getFile("KiokuFlow/drive-sync-meta.json")).toBe("new");
    await migrate();
    expect(vault.getFile("KiokuFlow/drive-sync-meta.json")).toBe("tracking");
    expect(await vault.adapter.exists("GemiHub")).toBe(false);
  });

  it("retains the whole source folder if renaming fails", async () => {
    const { vault, migrate } = fixture({ "GemiHub/drive-sync-meta.json": "tracking" });
    vi.spyOn(vault.adapter, "rename").mockRejectedValueOnce(new Error("read only"));
    await expect(migrate()).rejects.toThrow("read only");
    expect(vault.getFile("GemiHub/drive-sync-meta.json")).toBe("tracking");
    await migrate();
    expect(vault.getFile("KiokuFlow/drive-sync-meta.json")).toBe("tracking");
  });

  it("stops when a file occupies the destination folder", async () => {
    const { vault, migrate } = fixture({ "GemiHub/drive-sync-meta.json": "tracking", KiokuFlow: "user file" });
    await expect(migrate()).rejects.toThrow("file/folder collision");
    expect(vault.getFile("GemiHub/drive-sync-meta.json")).toBe("tracking");
    expect(vault.getFile("KiokuFlow")).toBe("user file");
  });

  it("does nothing on a fresh install", async () => {
    const { vault, migrate } = fixture({});
    await migrate();
    expect(await vault.adapter.exists("KiokuFlow")).toBe(false);
  });
});
