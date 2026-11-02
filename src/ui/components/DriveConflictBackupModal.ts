// Conflict backup management modal for Google Drive sync.
// Lists files in the local conflict-backups/ folder and allows restore or deletion.

import { Modal, App, Setting, Notice } from "obsidian";
import type { ConflictBackupEntry, DriveSyncManager } from "src/core/driveSync";
import { isBinaryExtension } from "src/core/driveSyncUtils";
import { restorePathFromConflictBackupName } from "src/core/driveSyncMeta";
import { t } from "src/i18n";
import { formatError } from "src/utils/error";
import { ConfirmModal } from "./ConfirmModal";

export class DriveConflictBackupModal extends Modal {
  private syncManager: DriveSyncManager;
  private files: ConflictBackupEntry[] = [];
  private selected = new Set<string>();
  private loading = true;
  private processing = false;
  private previewCache = new Map<string, string | null>();
  private expandedPreview: string | null = null;
  private onDone: () => void;

  constructor(app: App, syncManager: DriveSyncManager, onDone: () => void) {
    super(app);
    this.syncManager = syncManager;
    this.onDone = onDone;
  }

  onOpen(): void {
    this.render();
    void this.loadFiles();
  }

  private async loadFiles(): Promise<void> {
    try {
      this.files = await this.syncManager.listConflictFiles();
    } catch (err) {
      new Notice(formatError(err));
    }
    this.loading = false;
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kiokuflow-drive-manage-modal");

    contentEl.createEl("h2", { text: `${t("driveSync.conflictBackupsTitle")} (${this.files.length})` });

    if (this.loading || this.processing) {
      const el = contentEl.createDiv({ cls: "kiokuflow-drive-modal-processing" });
      el.createEl("div", { cls: "spinner" });
      el.createEl("div", { text: this.processing ? t("driveSync.processing") : t("driveSync.loading") });
      return;
    }

    if (this.files.length === 0) {
      contentEl.createEl("p", { text: t("driveSync.conflictBackupsNoFiles"), cls: "setting-item-description" });
      return;
    }

    // Select all
    new Setting(contentEl)
      .setName(t("driveSync.selectAll"))
      .addToggle((toggle) =>
        toggle.setValue(this.selected.size === this.files.length).onChange((val) => {
          if (val) { this.files.forEach((f) => this.selected.add(f.path)); }
          else { this.selected.clear(); }
          this.render();
        })
      );

    // File list
    const listEl = contentEl.createDiv({ cls: "kiokuflow-drive-file-list" });
    for (const file of this.files) {
      const desc = new Date(file.mtime).toLocaleString();
      const displayName = restorePathFromConflictBackupName(file.name);
      new Setting(listEl)
        .setName(displayName)
        .setDesc(desc)
        .addButton((btn) =>
          btn.setButtonText(t("driveSync.preview")).onClick(() => {
            this.togglePreview(file);
          })
        )
        .addToggle((toggle) =>
          toggle.setValue(this.selected.has(file.path)).onChange((val) => {
            if (val) { this.selected.add(file.path); }
            else { this.selected.delete(file.path); }
            this.render();
          })
        );

      if (this.expandedPreview === file.path) {
        this.renderPreviewPanel(listEl, file);
      }
    }

    // Footer
    const footer = contentEl.createDiv({ cls: "kiokuflow-drive-modal-footer" });
    const restoreBtn = footer.createEl("button", { text: t("driveSync.conflictRestore"), cls: "mod-cta" });
    restoreBtn.disabled = this.selected.size === 0;
    restoreBtn.addEventListener("click", () => { if (this.selected.size > 0) void this.doRestore(); });

    const deleteBtn = footer.createEl("button", { text: t("driveSync.conflictDelete"), cls: "mod-warning" });
    deleteBtn.disabled = this.selected.size === 0;
    deleteBtn.addEventListener("click", () => { if (this.selected.size > 0) void this.confirmAndDelete(); });
  }

  private togglePreview(file: ConflictBackupEntry): void {
    if (this.expandedPreview === file.path) {
      this.expandedPreview = null;
      this.render();
      return;
    }
    this.expandedPreview = file.path;
    if (!this.previewCache.has(file.path)) {
      this.render(); // show loading
      void this.fetchPreview(file);
    } else {
      this.render();
    }
  }

  private async fetchPreview(file: ConflictBackupEntry): Promise<void> {
    if (isBinaryExtension(file.name)) {
      this.previewCache.set(file.path, null);
      this.render();
      return;
    }
    try {
      const content = await this.syncManager.readConflictBackup(file.path);
      this.previewCache.set(file.path, content);
    } catch {
      this.previewCache.set(file.path, null);
    }
    this.render();
  }

  private renderPreviewPanel(container: HTMLElement, file: ConflictBackupEntry): void {
    const panel = container.createDiv({ cls: "kiokuflow-drive-preview-panel" });
    if (isBinaryExtension(file.name)) {
      panel.createDiv({ cls: "kiokuflow-drive-preview-loading", text: t("driveSync.previewBinary") });
      return;
    }
    const cached = this.previewCache.get(file.path);
    if (cached === undefined) {
      panel.createDiv({ cls: "kiokuflow-drive-preview-loading", text: t("driveSync.loading") });
    } else if (cached === null) {
      panel.createDiv({ cls: "kiokuflow-drive-preview-loading", text: t("driveSync.previewFailed") });
    } else {
      panel.createEl("pre", { text: cached });
    }
  }

  private async doRestore(): Promise<void> {
    this.processing = true;
    this.render();
    let count = 0;
    let failCount = 0;
    for (const backupPath of this.selected) {
      const file = this.files.find((f) => f.path === backupPath);
      if (!file) continue;
      try {
        await this.syncManager.restoreConflictFile(backupPath, file.name);
        count++;
      } catch { failCount++; }
    }
    if (count > 0) {
      new Notice(t("driveSync.restored", { count: String(count) }));
      this.onDone();
    }
    if (failCount > 0) new Notice(`${failCount} file(s) failed to restore`);
    this.selected.clear();
    this.expandedPreview = null;
    this.processing = false;
    this.loading = true;
    this.render();
    await this.loadFiles();
  }

  private async confirmAndDelete(): Promise<void> {
    const confirmed = await new ConfirmModal(this.app, t("driveSync.conflictDeleteConfirm")).openAndWait();
    if (!confirmed) return;
    this.processing = true;
    this.render();
    try {
      const count = await this.syncManager.deleteConflictFiles([...this.selected]);
      new Notice(t("driveSync.deleted", { count: String(count) }));
      this.selected.clear();
      this.expandedPreview = null;
      this.onDone();
    } catch (err) { new Notice(formatError(err)); }
    this.processing = false;
    this.loading = true;
    this.render();
    await this.loadFiles();
  }

  onClose(): void {
    this.previewCache.clear();
    this.contentEl.empty();
  }
}
