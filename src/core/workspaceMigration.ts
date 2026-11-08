import { TFile, type App } from "obsidian";
import { LEGACY_WORKSPACE_FOLDER, WORKSPACE_FOLDER } from "../types";

/** Move local state before reading it or starting sync. Legacy files overwrite collisions. */
export async function migrateWorkspaceFolder(app: App): Promise<void> {
  const { vault } = app;
  const { adapter } = vault;

  async function remove(path: string, folder: boolean): Promise<void> {
    const file = vault.getAbstractFileByPath(path);
    // This removes only a migrated source or an empty folder, not user content.
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
    if (file) await vault.delete(file);
    else if (folder) await adapter.rmdir(path, false);
    else await adapter.remove(path);
  }

  async function move(source: string, destination: string): Promise<void> {
    const sourceStat = await adapter.stat(source);
    if (!sourceStat) return;
    const destinationStat = await adapter.stat(destination);
    if (!destinationStat) {
      const file = vault.getAbstractFileByPath(source);
      if (file) await vault.rename(file, destination);
      else await adapter.rename(source, destination);
      return;
    }
    if (sourceStat.type !== destinationStat.type) {
      throw new Error(`Cannot migrate workspace: file/folder collision at ${destination}`);
    }
    if (sourceStat.type === "file") {
      // Keep the source until the replacement has been written successfully.
      // Binary I/O also preserves non-text backups without decoding them.
      const content = await adapter.readBinary(source);
      const file = vault.getAbstractFileByPath(destination);
      if (file instanceof TFile) await vault.modifyBinary(file, content);
      else await adapter.writeBinary(destination, content);
      await remove(source, false);
      return;
    }
    const children = await adapter.list(source);
    for (const path of [...children.files, ...children.folders]) {
      await move(path, `${destination}/${path.slice(source.length + 1)}`);
    }
    // Never recursively remove a folder: interrupted moves can be retried.
    const remaining = await adapter.list(source);
    if (remaining.files.length === 0 && remaining.folders.length === 0) {
      await remove(source, true);
    }
  }

  await move(LEGACY_WORKSPACE_FOLDER, WORKSPACE_FOLDER);
}
