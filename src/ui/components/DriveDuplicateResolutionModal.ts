import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type { DriveSyncManager, DuplicateRemoteFileGroup } from "src/core/driveSync";
import { isBinaryExtension } from "src/core/driveSyncUtils";
import { t } from "src/i18n";
import { createDiffViewToggle, renderDiffView, type DiffRendererState } from "./DiffRenderer";

export class DriveDuplicateResolutionModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;
  private selected = new Map<string, string>();
  private renderers: DiffRendererState[] = [];

  constructor(app: App, private groups: DuplicateRemoteFileGroup[], private manager: DriveSyncManager) {
    super(app);
    for (const group of groups) {
      const newest = [...group.files].sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))[0];
      if (newest) this.selected.set(group.path, newest.id);
    }
  }

  openAndWait(): Promise<boolean> {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }

  onOpen(): void {
    this.modalEl.addClass("kiokuflow-sync-diff-modal");
    this.contentEl.createEl("h2", { text: t("driveSync.duplicateTitle") });
    this.contentEl.createEl("p", { text: t("driveSync.duplicateDesc"), cls: "setting-item-description" });
    const list = this.contentEl.createDiv({ cls: "kiokuflow-sync-diff-list" });
    for (const group of this.groups) this.renderGroup(list, group);

    const footer = new Setting(this.contentEl);
    footer.addButton(btn => btn.setButtonText(t("common.cancel")).onClick(() => this.finish(false)));
    footer.addButton(btn => btn.setButtonText(t("driveSync.resolveDuplicates")).setWarning().onClick(async () => {
      btn.setDisabled(true);
      try {
        await this.manager.resolveRemoteDuplicates(this.selected);
        this.finish(true);
      } catch (error) {
        btn.setDisabled(false);
        new Notice(t("driveSync.resolveDuplicatesFailed", { error: error instanceof Error ? error.message : String(error) }));
      }
    }));
  }

  private renderGroup(list: HTMLElement, group: DuplicateRemoteFileGroup): void {
    const item = list.createDiv({ cls: "kiokuflow-sync-diff-file" });
    item.createEl("h3", { text: group.path });
    const choices = item.createDiv({ cls: "kiokuflow-duplicate-choices" });
    for (const file of group.files) {
      const label = choices.createEl("label", { cls: "kiokuflow-duplicate-choice" });
      const radio = label.createEl("input", { type: "radio" });
      radio.name = `duplicate-${group.path}`;
      radio.checked = this.selected.get(group.path) === file.id;
      radio.addEventListener("change", () => this.selected.set(group.path, file.id));
      const date = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : t("common.none");
      label.createSpan({ text: `${file.name} · ${date} · ${file.size ? `${file.size} bytes · ` : ""}${file.id}` });
    }
    if (!isBinaryExtension(group.path) && group.files.length >= 2) {
      const button = item.createEl("button", { cls: "kiokuflow-sync-diff-toggle" });
      const icon = button.createSpan(); setIcon(icon, "git-compare");
      button.createSpan({ text: t("driveSync.diff") });
      const panel = item.createDiv({ cls: "kiokuflow-sync-diff-panel kiokuflow-hidden" });
      button.addEventListener("click", () => void this.showDiff(group, panel));
    }
  }

  private async showDiff(group: DuplicateRemoteFileGroup, panel: HTMLElement): Promise<void> {
    panel.removeClass("kiokuflow-hidden");
    panel.empty();
    panel.createDiv({ cls: "kiokuflow-sync-diff-loading", text: t("driveSync.loading") });
    try {
      const selectedId = this.selected.get(group.path) ?? group.files[0]?.id;
      const selected = group.files.find(file => file.id === selectedId) ?? group.files[0];
      if (!selected) return;
      const others = group.files.filter(file => file.id !== selected.id);
      const [selectedContent, ...otherContents] = await Promise.all([
        this.manager.readRemoteFile(selected.id),
        ...others.map(file => this.manager.readRemoteFile(file.id)),
      ]);
      panel.empty();
      for (let index = 0; index < others.length; index++) {
        panel.createEl("h4", { text: `${selected.id} ↔ ${others[index].id}` });
        const toggle = panel.createDiv({ cls: "kiokuflow-sync-diff-toggle-bar" });
        const renderer = renderDiffView(panel, selectedContent, otherContents[index] ?? "", "split");
        createDiffViewToggle(toggle, renderer);
        this.renderers.push(renderer);
      }
    } catch {
      panel.empty();
      panel.createDiv({ cls: "kiokuflow-sync-diff-error", text: t("driveSync.failedToLoadDiff") });
    }
  }

  private finish(confirmed: boolean): void {
    const resolve = this.resolve; this.resolve = null; this.close(); resolve?.(confirmed);
  }

  onClose(): void {
    for (const renderer of this.renderers) renderer.destroy();
    this.renderers = [];
    this.contentEl.empty();
    if (this.resolve) { this.resolve(false); this.resolve = null; }
  }
}
