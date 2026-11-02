// Conflict resolution modal for Google Drive sync.
// Shows conflicts and lets user choose local or remote for each file.

import { Modal, App, Setting, Notice, TFile } from "obsidian";
import { createTwoFilesPatch } from "diff";
import type { ConflictInfo } from "src/core/syncDiff";
import type { DriveSyncManager } from "src/core/driveSync";
import { isBinaryExtension } from "src/core/driveSyncUtils";
import { t } from "src/i18n";
import { formatError } from "src/utils/error";

interface DiffState {
  loading: boolean;
  diff: string | null;
  error: boolean;
  expanded: boolean;
}

export class DriveSyncConflictModal extends Modal {
  private syncManager: DriveSyncManager;
  private conflicts: ConflictInfo[];
  private onAllResolved: () => void;
  private resolving = false;
  private diffStates: Record<string, DiffState> = {};
  private statusEl: HTMLElement | null = null;
  private progress: { done: number; total: number } | null = null;

  constructor(
    app: App,
    syncManager: DriveSyncManager,
    conflicts: ConflictInfo[],
    onAllResolved: () => void
  ) {
    super(app);
    this.syncManager = syncManager;
    this.conflicts = [...conflicts];
    this.onAllResolved = onAllResolved;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.diffStates = {};
    contentEl.addClass("kiokuflow-conflict-modal");

    // Prevent closing by clicking outside
    this.containerEl.setCssProps({ "pointer-events": "none" });
    this.modalEl.setCssProps({ "pointer-events": "auto" });

    contentEl.createEl("h2", { text: t("driveSync.conflictTitle") });
    contentEl.createEl("p", {
      text: t("driveSync.conflictDesc", { count: String(this.conflicts.length) }),
      cls: "setting-item-description",
    });

    const listEl = contentEl.createDiv({ cls: "kiokuflow-conflict-list" });

    for (const conflict of this.conflicts) {
      this.renderConflictItem(listEl, conflict);
    }

    // Bulk actions
    const bulkContainer = contentEl.createDiv({ cls: "kiokuflow-button-container" });

    const keepAllLocalBtn = bulkContainer.createEl("button", {
      text: t("driveSync.keepAllLocal"),
    });
    keepAllLocalBtn.disabled = this.resolving;
    keepAllLocalBtn.addEventListener("click", () => {
      void this.resolveAll("local");
    });

    const keepAllRemoteBtn = bulkContainer.createEl("button", {
      text: t("driveSync.keepAllRemote"),
      cls: "mod-cta",
    });
    keepAllRemoteBtn.disabled = this.resolving;
    keepAllRemoteBtn.addEventListener("click", () => {
      void this.resolveAll("remote");
    });

    const resolveLaterBtn = bulkContainer.createEl("button", {
      text: t("driveSync.resolveLater"),
    });
    resolveLaterBtn.disabled = this.resolving;
    resolveLaterBtn.addEventListener("click", () => {
      this.close();
    });

    if (this.resolving) {
      this.statusEl = contentEl.createDiv({ cls: "kiokuflow-conflict-resolving-status" });
      this.statusEl.setText(this.progressText());
    } else {
      this.statusEl = null;
    }
  }

  private progressText(): string {
    if (!this.progress) return t("driveSync.resolving");
    return t("driveSync.resolvingProgress", {
      done: String(this.progress.done),
      total: String(this.progress.total),
    });
  }

  private renderConflictItem(container: HTMLElement, conflict: ConflictInfo): void {
    const isEditDelete = conflict.isEditDelete;
    const desc = isEditDelete
      ? t("driveSync.localEditRemoteDelete")
      : `Local: ${conflict.localChecksum.slice(0, 8)}... | Remote: ${conflict.remoteChecksum.slice(0, 8)}...`;

    const itemEl = container.createDiv({ cls: "kiokuflow-conflict-item" });

    // Declare diffPanel before use in click handler; element created after Setting for correct DOM order
    let diffPanel: HTMLElement | null = null;

    const setting = new Setting(itemEl)
      .setName(conflict.fileName)
      .setDesc(desc);

    // Diff toggle for non-binary, non-editDelete conflicts
    const canDiff = !isEditDelete && !isBinaryExtension(conflict.fileName);
    if (canDiff) {
      setting.addButton((btn) =>
        btn
          .setButtonText(t("driveSync.diff"))
          .onClick(() => {
            if (diffPanel) void this.handleDiffToggle(conflict, diffPanel, btn.buttonEl);
          })
      );
    }

    if (isEditDelete) {
      setting.addButton((btn) =>
        btn
          .setButtonText(t("driveSync.restorePush"))
          .setTooltip(t("driveSync.restorePushTooltip"))
          .setDisabled(this.resolving)
          .onClick(() => {
            void this.resolveOne(conflict.fileId, "local");
          })
      );
      setting.addButton((btn) =>
        btn
          .setButtonText(t("driveSync.acceptDelete"))
          .setTooltip(t("driveSync.acceptDeleteTooltip"))
          .setDisabled(this.resolving)
          .onClick(() => {
            void this.resolveOne(conflict.fileId, "remote");
          })
      );
    } else {
      setting.addButton((btn) =>
        btn
          .setButtonText(t("driveSync.keepLocal"))
          .setDisabled(this.resolving)
          .onClick(() => {
            void this.resolveOne(conflict.fileId, "local");
          })
      );
      setting.addButton((btn) =>
        btn
          .setButtonText(t("driveSync.keepRemote"))
          .setCta()
          .setDisabled(this.resolving)
          .onClick(() => {
            void this.resolveOne(conflict.fileId, "remote");
          })
      );
    }

    // Diff panel placed after Setting for correct DOM order
    if (canDiff) {
      diffPanel = itemEl.createDiv({ cls: "kiokuflow-sync-diff-panel kiokuflow-hidden" });
    }
  }

  private async handleDiffToggle(
    conflict: ConflictInfo,
    panel: HTMLElement,
    toggleBtn: HTMLButtonElement,
  ): Promise<void> {
    const state = this.diffStates[conflict.fileId];

    // If already loaded, toggle visibility
    if (state?.diff !== null && state?.diff !== undefined && !state.error) {
      state.expanded = !state.expanded;
      panel.toggleClass("kiokuflow-hidden", !state.expanded);
      toggleBtn.setText(state.expanded ? t("driveSync.hide") : t("driveSync.diff"));
      return;
    }

    // Prevent duplicate requests while loading
    if (state?.loading) {
      state.expanded = !state.expanded;
      panel.toggleClass("kiokuflow-hidden", !state.expanded);
      toggleBtn.setText(state.expanded ? t("driveSync.hide") : t("driveSync.diff"));
      return;
    }

    // Show loading
    this.diffStates[conflict.fileId] = { loading: true, diff: null, error: false, expanded: true };
    panel.toggleClass("kiokuflow-hidden", false);
    panel.empty();
    panel.createDiv({ cls: "kiokuflow-sync-diff-loading", text: t("driveSync.loading") });
    toggleBtn.setText(t("driveSync.hide"));

    try {
      // Get local content
      let localContent = "";
      try {
        const tfile = this.app.vault.getAbstractFileByPath(conflict.fileName);
        if (tfile instanceof TFile) {
          localContent = await this.app.vault.read(tfile);
        }
      } catch {
        // File may not exist locally
      }

      // Get remote content
      let remoteContent = "";
      try {
        remoteContent = await this.syncManager.readRemoteFile(conflict.fileId);
      } catch {
        // File may not exist remotely
      }

      // old=local, new=remote (show what remote changes look like vs local)
      const patch = createTwoFilesPatch(
        conflict.fileName,
        conflict.fileName,
        localContent,
        remoteContent,
        "Local",
        "Drive",
        { context: 3 },
      );

      this.diffStates[conflict.fileId] = { loading: false, diff: patch, error: false, expanded: true };
      panel.empty();
      this.renderDiffView(panel, patch);
    } catch {
      this.diffStates[conflict.fileId] = { loading: false, diff: null, error: true, expanded: true };
      panel.empty();
      panel.createDiv({ cls: "kiokuflow-sync-diff-error", text: t("driveSync.failedToLoadDiff") });
    }
  }

  private renderDiffView(container: HTMLElement, patch: string): void {
    const pre = container.createEl("pre", { cls: "kiokuflow-sync-diff-content" });
    const lines = patch.split("\n");

    for (const line of lines) {
      const div = pre.createDiv();

      if (line.startsWith("+") && !line.startsWith("+++")) {
        div.addClass("kiokuflow-diff-add");
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        div.addClass("kiokuflow-diff-remove");
      } else if (line.startsWith("@@")) {
        div.addClass("kiokuflow-diff-hunk");
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        div.addClass("kiokuflow-diff-header");
      }

      // Separate prefix from content (prefix is non-selectable)
      if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
        const prefix = div.createSpan({ cls: "kiokuflow-diff-prefix" });
        prefix.setText(line[0]);
        div.appendText(line.slice(1));
      } else {
        div.setText(line);
      }
    }
  }

  private resolveOne(fileId: string, choice: "local" | "remote"): Promise<void> {
    return this.runResolve([fileId], choice);
  }

  private resolveAll(choice: "local" | "remote"): Promise<void> {
    return this.runResolve(this.conflicts.map(c => c.fileId), choice);
  }

  /**
   * Single path for both the per-row buttons and the bulk actions: the manager
   * resolves the whole set in one batch, so metadata and vault scans happen
   * once instead of once per file.
   */
  private async runResolve(fileIds: string[], choice: "local" | "remote"): Promise<void> {
    if (this.resolving || fileIds.length === 0) return;
    this.resolving = true;
    this.progress = { done: 0, total: fileIds.length };
    this.onOpen();

    let result = { resolved: 0, failed: 0 };
    let threw = false;
    try {
      result = await this.syncManager.resolveConflicts(fileIds, choice, (done, total) => {
        // Update the status line in place: a full re-render would collapse any
        // diff panel the user has open.
        this.progress = { done, total };
        this.statusEl?.setText(this.progressText());
      });
    } catch (err) {
      threw = true;
      new Notice(t("driveSync.resolveFailed", { error: formatError(err) }));
    } finally {
      this.resolving = false;
      this.progress = null;
    }

    // The manager is the source of truth for what is still unresolved.
    this.conflicts = [...this.syncManager.conflicts];

    // A throw already reported the cause; don't stack a second notice on it.
    if (!threw && result.failed > 0) {
      new Notice(t("driveSync.resolveFailedCount", { count: String(result.failed) }));
    }
    if (this.conflicts.length === 0) {
      this.close();
      this.onAllResolved();
      return;
    }
    this.onOpen();
  }

  onClose(): void {
    this.diffStates = {};
    this.statusEl = null;
    this.progress = null;
    this.contentEl.empty();
  }
}
