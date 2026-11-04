// Temporary files are listed as metadata; only the active preview keeps a body.
import { Modal, App, Setting, Notice } from "obsidian";
import type { DriveSyncManager, TempFilePayload } from "src/core/driveSync";
import type { DriveFile } from "src/core/googleDrive";
import { t } from "src/i18n";
import { formatError } from "src/utils/error";
import { ConfirmModal } from "./ConfirmModal";

type Preview = { id: string; loading: boolean; payload?: TempFilePayload; error?: string };

export class DriveTempFilesModal extends Modal {
  private syncManager: DriveSyncManager;
  private entries: DriveFile[] = [];
  private selected = new Set<string>();
  private loading = true;
  private processing = false;
  private preview: Preview | null = null;
  private previewRequest = 0;
  private listRequest = 0;
  private closed = false;
  private loadError: string | null = null;
  private onDone: () => void;

  constructor(app: App, syncManager: DriveSyncManager, onDone: () => void) {
    super(app);
    this.syncManager = syncManager;
    this.onDone = onDone;
  }

  onOpen(): void {
    this.closed = false;
    void this.loadFiles();
  }

  private async loadFiles(): Promise<void> {
    const request = ++this.listRequest;
    this.loading = true;
    this.loadError = null;
    this.render();
    try {
      const files = await this.syncManager.listTempFiles();
      if (this.closed || request !== this.listRequest) return;
      this.entries = files;
      const ids = new Set(files.map(file => file.id));
      this.selected = new Set([...this.selected].filter(id => ids.has(id)));
    } catch (err) {
      if (this.closed || request !== this.listRequest) return;
      this.loadError = formatError(err);
    }
    this.loading = false;
    this.render();
  }

  private async togglePreview(id: string): Promise<void> {
    if (this.processing || this.closed) return;
    const request = ++this.previewRequest;
    if (this.preview?.id === id) {
      this.preview = null;
      this.render();
      return;
    }
    this.preview = { id, loading: true };
    this.render();
    try {
      const payload = await this.syncManager.readTempFile(id);
      if (this.closed || request !== this.previewRequest) return;
      this.preview = { id, loading: false, payload };
    } catch (err) {
      if (this.closed || request !== this.previewRequest) return;
      this.preview = { id, loading: false, error: formatError(err) };
    }
    this.render();
  }

  private clearPreview(): void {
    this.previewRequest++;
    this.preview = null;
  }

  private render(): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kiokuflow-drive-manage-modal");
    contentEl.createEl("h2", { text: t("driveSync.tempFilesTitle") + " (" + this.entries.length + ")" });

    if (this.loading || this.processing) {
      const el = contentEl.createDiv({ cls: "kiokuflow-drive-modal-processing" });
      el.createEl("div", { cls: "spinner" });
      el.createEl("div", { text: this.processing ? t("driveSync.processing") : t("driveSync.loading") });
      return;
    }
    if (this.loadError) {
      contentEl.createEl("p", { text: this.loadError, attr: { role: "alert" } });
      contentEl.createEl("button", { text: t("driveSync.retry") }).addEventListener("click", () => { void this.loadFiles(); });
      return;
    }
    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: t("driveSync.tempFilesNoFiles"), cls: "setting-item-description" });
      return;
    }
    new Setting(contentEl)
      .setName(t("driveSync.selectAll"))
      .addToggle(toggle => toggle.setValue(this.selected.size === this.entries.length).onChange(val => {
        if (val) this.entries.forEach(file => this.selected.add(file.id));
        else this.selected.clear();
        this.render();
      }));

    const listEl = contentEl.createDiv({ cls: "kiokuflow-drive-file-list" });
    for (const file of this.entries) {
      const savedAt = file.modifiedTime || file.createdTime;
      new Setting(listEl)
        .setName(file.name)
        .setDesc(savedAt ? t("driveSync.tempFilesSavedAt", { date: new Date(savedAt).toLocaleString() }) : "")
        .addButton(btn => btn.setButtonText(t("driveSync.preview")).onClick(() => { void this.togglePreview(file.id); }))
        .addToggle(toggle => toggle.setValue(this.selected.has(file.id)).onChange(val => {
          if (val) this.selected.add(file.id);
          else this.selected.delete(file.id);
          this.render();
        }));
      if (this.preview?.id === file.id) {
        const panel = listEl.createDiv({ cls: "kiokuflow-drive-preview-panel" });
        if (this.preview.loading) panel.createEl("p", { text: t("driveSync.loading"), attr: { role: "status" } });
        else if (this.preview.error) {
          panel.createEl("p", { text: this.preview.error, attr: { role: "alert" } });
          panel.createEl("button", { text: t("driveSync.retry") }).addEventListener("click", () => {
            this.clearPreview(); void this.togglePreview(file.id);
          });
        } else if (this.preview.payload?.isBinary) panel.createEl("p", { text: t("driveSync.tempFilesBinaryPreview") });
        else panel.createEl("pre", { text: this.preview.payload?.content || "" });
      }
    }

    const footer = contentEl.createDiv({ cls: "kiokuflow-drive-modal-footer" });
    const applyBtn = footer.createEl("button", { text: t("driveSync.tempFilesApply"), cls: "mod-cta" });
    applyBtn.disabled = this.selected.size === 0;
    applyBtn.addEventListener("click", () => { if (this.selected.size > 0) void this.confirmAndApply(); });
    const deleteBtn = footer.createEl("button", { text: t("driveSync.tempFilesDelete"), cls: "mod-warning" });
    deleteBtn.disabled = this.selected.size === 0;
    deleteBtn.addEventListener("click", () => { if (this.selected.size > 0) void this.confirmAndDelete(); });
  }

  private async confirmAndApply(): Promise<void> {
    if (this.processing) return;
    const confirmed = await new ConfirmModal(this.app, t("driveSync.tempFilesApplyConfirm")).openAndWait();
    if (!confirmed || this.closed || this.processing) return;
    this.processing = true;
    this.clearPreview();
    this.render();
    let count = 0;
    let failCount = 0;
    for (const fileId of this.selected) {
      try {
        // Read and release one selected body at a time, including binary payloads.
        const payload = await this.syncManager.readTempFile(fileId);
        await this.syncManager.downloadTempToVault(fileId, payload);
        count++;
      } catch (err) { failCount++; new Notice(formatError(err)); }
    }
    if (count > 0) {
      new Notice(t("driveSync.applied", { count: String(count) }));
      this.onDone();
    }
    if (failCount > 0) new Notice(t("driveSync.tempFilesApplyFailed", { count: String(failCount) }));
    this.selected.clear();
    this.processing = false;
    if (!this.closed) await this.loadFiles();
  }

  private async confirmAndDelete(): Promise<void> {
    if (this.processing) return;
    const confirmed = await new ConfirmModal(this.app, t("driveSync.tempFilesDeleteConfirm")).openAndWait();
    if (!confirmed || this.closed || this.processing) return;
    this.processing = true;
    this.clearPreview();
    this.render();
    try {
      const count = await this.syncManager.deleteTempFiles([...this.selected]);
      new Notice(t("driveSync.deleted", { count: String(count) }));
      this.selected.clear();
      this.onDone();
    } catch (err) { new Notice(formatError(err)); }
    this.processing = false;
    if (!this.closed) await this.loadFiles();
  }

  onClose(): void {
    this.closed = true;
    this.listRequest++;
    this.clearPreview();
    this.entries = [];
    this.selected.clear();
    this.contentEl.empty();
  }
}
