// Sync diff modal for Google Drive sync.
// Shows file list with expandable diff view, similar to kiokuflow's SyncDiffDialog.

import { Modal, App, Notice, Setting, setIcon, TFile } from "obsidian";
import type { SyncFileListItem, DriveSyncManager } from "src/core/driveSync";
import { isBinaryExtension } from "src/core/driveSyncUtils";
import { t } from "src/i18n";
import { renderDiffView, createDiffViewToggle, type DiffRendererState } from "./DiffRenderer";

interface DiffState {
  loading: boolean;
  oldContent: string | null;
  newContent: string | null;
  diffRenderer: DiffRendererState | null;
  error: boolean;
  expanded: boolean;
}

export class DriveSyncDiffModal extends Modal {
  private files: SyncFileListItem[];
  private direction: "push" | "pull";
  private syncManager: DriveSyncManager;
  private resolve: ((result: { confirmed: boolean; ignoredIds?: Set<string> }) => void) | null = null;
  private diffStates: Record<string, DiffState> = {};
  private ignoredIds: Set<string> = new Set();
  private restoring = false;
  private headerTitleEl: HTMLElement | null = null;

  // Drag state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private modalStartX = 0;
  private modalStartY = 0;

  // Resize state
  private isResizing = false;
  private resizeDirection = "";
  private resizeStartWidth = 0;
  private resizeStartHeight = 0;

  constructor(
    app: App,
    files: SyncFileListItem[],
    direction: "push" | "pull",
    syncManager: DriveSyncManager,
  ) {
    super(app);
    this.files = files;
    this.direction = direction;
    this.syncManager = syncManager;
  }

  openAndWait(): Promise<{ confirmed: boolean; ignoredIds?: Set<string> }> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("kiokuflow-sync-diff-modal");

    const title = this.direction === "push" ? t("driveSync.pushChanges") : t("driveSync.pullChanges");
    const header = contentEl.createDiv({ cls: "kiokuflow-sync-diff-header kiokuflow-drag-handle" });
    this.headerTitleEl = header.createEl("h2", { text: `${title} (${this.files.length})` });

    // Setup drag & resize
    this.addResizeHandles(modalEl);
    this.setupDrag(header, modalEl);

    if (this.files.length === 0) {
      contentEl.createEl("p", {
        text: t("driveSync.noFilesToSync"),
        cls: "setting-item-description",
      });
    } else {
      const listEl = contentEl.createDiv({ cls: "kiokuflow-sync-diff-list" });

      for (const file of this.files) {
        this.renderFileItem(listEl, file);
      }
    }

    const footer = new Setting(contentEl);
    footer.addButton((btn) =>
      btn.setButtonText(t("common.cancel")).onClick(() => {
        const resolve = this.resolve;
        this.resolve = null;
        this.close();
        resolve?.({ confirmed: false });
      })
    );

    footer.addButton((btn) =>
      btn
        .setButtonText(this.direction === "push" ? t("driveSync.push") : t("driveSync.pull"))
        .setCta()
        .onClick(() => {
          const resolve = this.resolve;
          const ignoredIds = this.ignoredIds.size > 0 ? new Set(this.ignoredIds) : undefined;
          this.resolve = null;
          this.close();
          resolve?.({ confirmed: true, ignoredIds });
        })
    );
  }

  private renderFileItem(listEl: HTMLElement, file: SyncFileListItem): void {
    const itemCls = file.type === "conflict" ? "kiokuflow-sync-diff-file is-conflict" : "kiokuflow-sync-diff-file";
    const itemEl = listEl.createDiv({ cls: itemCls });
    const headerEl = itemEl.createDiv({ cls: "kiokuflow-sync-diff-file-header" });

    // Type icon
    let iconName: string;
    let iconCls: string;
    switch (file.type) {
      case "new":
        iconName = "plus";
        iconCls = "kiokuflow-sync-diff-new";
        break;
      case "modified":
        iconName = "pencil";
        iconCls = "kiokuflow-sync-diff-modified";
        break;
      case "deleted":
        iconName = "trash-2";
        iconCls = "kiokuflow-sync-diff-deleted";
        break;
      case "renamed":
        iconName = "arrow-right";
        iconCls = "kiokuflow-sync-diff-modified";
        break;
      case "editDeleted":
        iconName = "alert-triangle";
        iconCls = "kiokuflow-sync-diff-edit-deleted";
        break;
      case "conflict":
        iconName = "git-merge";
        iconCls = "kiokuflow-sync-diff-conflict";
        break;
    }

    const iconEl = headerEl.createSpan({ cls: `kiokuflow-sync-diff-icon ${iconCls}` });
    setIcon(iconEl, iconName);

    // File name
    const nameEl = headerEl.createSpan({ cls: "kiokuflow-sync-diff-name" });
    if (file.type === "renamed" && file.oldName) {
      nameEl.setText(`${file.oldName} → ${file.name}`);
    } else {
      nameEl.setText(file.name);
    }

    if (file.type === "editDeleted") {
      const tagEl = headerEl.createSpan({ cls: "kiokuflow-sync-diff-tag" });
      tagEl.setText(t("driveSync.deletedOnRemote"));
    } else if (file.type === "conflict") {
      const tagEl = headerEl.createSpan({ cls: "kiokuflow-sync-diff-tag kiokuflow-sync-diff-conflict-tag" });
      tagEl.setText(t("driveSync.conflictNeedResolve"));
    }

    const canRestore = this.direction === "push"
      && ["new", "modified", "deleted", "renamed"].includes(file.type);
    const hasLocal = !(file.type === "deleted" && this.direction === "push")
      && !(file.type === "new" && this.direction === "pull");
    if (canRestore) {
      const restoreBtn = headerEl.createEl("button", { cls: "kiokuflow-sync-diff-toggle" });
      restoreBtn.title = file.type === "new" ? t("driveSync.restoreNewTooltip") : t("driveSync.restoreLocalTooltip");
      const restoreIconEl = restoreBtn.createSpan();
      setIcon(restoreIconEl, "rotate-ccw");
      const restoreLabel = restoreBtn.createSpan();
      restoreLabel.setText(t("driveSync.restore"));
      restoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.handleRestore(file, itemEl);
      });
    }
    if (hasLocal) {
      const openBtn = headerEl.createEl("button", { cls: "kiokuflow-sync-diff-toggle" });
      const openIconEl = openBtn.createSpan();
      setIcon(openIconEl, "external-link");
      const openLabel = openBtn.createSpan();
      openLabel.setText(t("driveSync.open"));
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const resolve = this.resolve;
        this.resolve = null;
        this.close();
        resolve?.({ confirmed: false });
        const target = this.app.vault.getAbstractFileByPath(file.name);
        if (target instanceof TFile) {
          void this.app.workspace.getLeaf(false).openFile(target);
        } else {
          // Extensions Obsidian does not index (html, css, …) sync fine but
          // have no TFile to open — say so instead of doing nothing.
          new Notice(t("driveSync.openFailed", { name: file.name }));
        }
      });
    }

    // Ignore toggle (pull only). Set for remote-modified files and for blocked
    // remote renames, so the latter never become an error-only dead end.
    if (this.direction === "pull" && file.ignorable) {
      const ignoreBtn = headerEl.createEl("button", { cls: "kiokuflow-sync-diff-toggle" });
      const ignoreIconEl = ignoreBtn.createSpan();
      setIcon(ignoreIconEl, "eye-off");
      const ignoreLabel = ignoreBtn.createSpan();
      ignoreLabel.setText(t("driveSync.ignore"));

      ignoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ignored = this.ignoredIds.has(file.id);
        if (ignored) {
          this.ignoredIds.delete(file.id);
          setIcon(ignoreIconEl, "eye-off");
          ignoreLabel.setText(t("driveSync.ignore"));
          itemEl.removeClass("kiokuflow-sync-diff-ignored");
        } else {
          this.ignoredIds.add(file.id);
          setIcon(ignoreIconEl, "eye");
          ignoreLabel.setText(t("driveSync.unignore"));
          itemEl.addClass("kiokuflow-sync-diff-ignored");
        }
        this.updateTitle();
      });
    }

    // Diff toggle button (for non-binary, non-editDeleted, non-conflict files)
    const canDiff = !isBinaryExtension(file.name) && file.type !== "editDeleted" && file.type !== "conflict";
    if (canDiff) {
      const diffBtn = headerEl.createEl("button", { cls: "kiokuflow-sync-diff-toggle" });
      const chevronEl = diffBtn.createSpan();
      setIcon(chevronEl, "chevron-right");
      const diffLabel = diffBtn.createSpan();
      diffLabel.setText(t("driveSync.diff"));

      const diffPanel = itemEl.createDiv({ cls: "kiokuflow-sync-diff-panel kiokuflow-hidden" });

      diffBtn.addEventListener("click", () => {
        void this.handleDiffToggle(file, diffPanel, chevronEl, diffLabel);
      });
    } else if (isBinaryExtension(file.name) && file.type !== "editDeleted") {
      const noDiffEl = headerEl.createSpan({ cls: "kiokuflow-sync-diff-no-diff" });
      noDiffEl.setText(t("driveSync.binary"));
    }
  }

  private async handleRestore(
    file: SyncFileListItem,
    itemEl: HTMLElement,
  ): Promise<void> {
    if (this.restoring) return;
    this.restoring = true;
    const buttons = Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>("button"));
    for (const button of buttons) button.disabled = true;
    try {
      await this.syncManager.restoreLocalChange(file);
      this.files = this.files.filter((f) => f.id !== file.id);
      this.diffStates[file.id]?.diffRenderer?.destroy();
      delete this.diffStates[file.id];
      itemEl.remove();
      this.updateTitle();
      if (this.files.length === 0) {
        const resolve = this.resolve;
        this.resolve = null;
        this.close();
        resolve?.({ confirmed: false });
      }
    } catch (err) {
      new Notice(t("driveSync.restoreFailed", { name: file.name, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.restoring = false;
      for (const button of buttons) button.disabled = false;
    }
  }

  private async handleDiffToggle(
    file: SyncFileListItem,
    panel: HTMLElement,
    chevronEl: HTMLElement,
    diffLabel: HTMLElement,
  ): Promise<void> {
    const state = this.diffStates[file.id];

    // If already loaded, toggle visibility
    if (state?.oldContent !== null && state?.oldContent !== undefined && !state.error) {
      state.expanded = !state.expanded;
      panel.toggleClass("kiokuflow-hidden", !state.expanded);
      setIcon(chevronEl, state.expanded ? "chevron-down" : "chevron-right");
      diffLabel.setText(state.expanded ? t("driveSync.hide") : t("driveSync.diff"));
      return;
    }

    // Prevent duplicate requests while loading
    if (state?.loading) {
      state.expanded = !state.expanded;
      panel.toggleClass("kiokuflow-hidden", !state.expanded);
      setIcon(chevronEl, state.expanded ? "chevron-down" : "chevron-right");
      diffLabel.setText(state.expanded ? t("driveSync.hide") : t("driveSync.diff"));
      return;
    }

    // Show loading
    this.diffStates[file.id] = { loading: true, oldContent: null, newContent: null, diffRenderer: null, error: false, expanded: true };
    panel.toggleClass("kiokuflow-hidden", false);
    panel.empty();
    panel.createDiv({ cls: "kiokuflow-sync-diff-loading", text: t("driveSync.loading") });
    setIcon(chevronEl, "chevron-down");
    diffLabel.setText(t("driveSync.hide"));

    try {
      // Get local content
      let localContent = "";
      try {
        const tfile = this.app.vault.getAbstractFileByPath(file.name);
        if (tfile instanceof TFile) {
          localContent = await this.app.vault.read(tfile);
        }
      } catch {
        // File may not exist locally (new remote file)
      }

      // Get remote content (skip when file doesn't exist on Drive)
      let remoteContent = "";
      const needRemote =
        (file.type !== "new" && file.type !== "deleted") ||
        (file.type === "new" && this.direction === "pull") ||
        (file.type === "deleted" && this.direction === "push");
      if (needRemote) {
        try {
          remoteContent = await this.syncManager.readRemoteFile(file.id);
        } catch {
          // File may not exist remotely
        }
      }

      // Determine old/new based on direction
      // Push: old=Drive(remote), new=Local
      // Pull: old=Local, new=Drive(remote)
      let oldContent: string;
      let newContent: string;

      if (file.type === "new") {
        oldContent = "";
        newContent = this.direction === "push" ? localContent : remoteContent;
      } else if (file.type === "deleted") {
        oldContent = this.direction === "push" ? remoteContent : localContent;
        newContent = "";
      } else {
        oldContent = this.direction === "push" ? remoteContent : localContent;
        newContent = this.direction === "push" ? localContent : remoteContent;
      }

      if (!this.diffStates[file.id]) return;
      panel.empty();

      // Render toggle + diff view
      const defaultMode = (file.type === "new" || file.type === "deleted") ? "unified" : "split";
      const toggleBar = panel.createDiv({ cls: "kiokuflow-sync-diff-toggle-bar" });
      const diffState = renderDiffView(panel, oldContent, newContent, defaultMode);
      createDiffViewToggle(toggleBar, diffState);

      this.diffStates[file.id] = { loading: false, oldContent, newContent, diffRenderer: diffState, error: false, expanded: true };
    } catch {
      this.diffStates[file.id] = { loading: false, oldContent: null, newContent: null, diffRenderer: null, error: true, expanded: true };
      panel.empty();
      panel.createDiv({ cls: "kiokuflow-sync-diff-error", text: t("driveSync.failedToLoadDiff") });
    }
  }

  private addResizeHandles(modalEl: HTMLElement) {
    const directions = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
    for (const dir of directions) {
      const handle = document.createElement("div");
      handle.className = `kiokuflow-resize-handle kiokuflow-resize-${dir}`;
      modalEl.appendChild(handle);
      this.setupResize(handle, modalEl, dir);
    }
  }

  private setupDrag(header: HTMLElement, modalEl: HTMLElement) {
    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;

      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;

      const rect = modalEl.getBoundingClientRect();
      this.modalStartX = rect.left;
      this.modalStartY = rect.top;

      modalEl.setCssProps({
        position: "fixed",
        margin: "0",
        transform: "none",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
      });

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDragging) return;

      const deltaX = e.clientX - this.dragStartX;
      const deltaY = e.clientY - this.dragStartY;

      modalEl.setCssProps({
        left: `${this.modalStartX + deltaX}px`,
        top: `${this.modalStartY + deltaY}px`,
      });
    };

    const onMouseUp = () => {
      this.isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    header.addEventListener("mousedown", onMouseDown);
  }

  private setupResize(handle: HTMLElement, modalEl: HTMLElement, direction: string) {
    const onMouseDown = (e: MouseEvent) => {
      this.isResizing = true;
      this.resizeDirection = direction;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;

      const rect = modalEl.getBoundingClientRect();
      this.resizeStartWidth = rect.width;
      this.resizeStartHeight = rect.height;
      this.modalStartX = rect.left;
      this.modalStartY = rect.top;

      modalEl.setCssProps({
        position: "fixed",
        margin: "0",
        transform: "none",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
      e.stopPropagation();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizing) return;

      const deltaX = e.clientX - this.dragStartX;
      const deltaY = e.clientY - this.dragStartY;
      const dir = this.resizeDirection;

      let newWidth = this.resizeStartWidth;
      let newHeight = this.resizeStartHeight;
      let newLeft = this.modalStartX;
      let newTop = this.modalStartY;

      if (dir.includes("e")) {
        newWidth = Math.max(400, this.resizeStartWidth + deltaX);
      }
      if (dir.includes("w")) {
        newWidth = Math.max(400, this.resizeStartWidth - deltaX);
        newLeft = this.modalStartX + (this.resizeStartWidth - newWidth);
      }
      if (dir.includes("s")) {
        newHeight = Math.max(300, this.resizeStartHeight + deltaY);
      }
      if (dir.includes("n")) {
        newHeight = Math.max(300, this.resizeStartHeight - deltaY);
        newTop = this.modalStartY + (this.resizeStartHeight - newHeight);
      }

      modalEl.setCssProps({
        width: `${newWidth}px`,
        height: `${newHeight}px`,
        left: `${newLeft}px`,
        top: `${newTop}px`,
      });
    };

    const onMouseUp = () => {
      this.isResizing = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    handle.addEventListener("mousedown", onMouseDown);
  }

  private updateTitle(): void {
    if (!this.headerTitleEl) return;
    const title = this.direction === "push" ? t("driveSync.pushChanges") : t("driveSync.pullChanges");
    if (this.ignoredIds.size > 0) {
      this.headerTitleEl.setText(`${title} (${this.files.length - this.ignoredIds.size} / ${this.files.length})`);
    } else {
      this.headerTitleEl.setText(`${title} (${this.files.length})`);
    }
  }

  onClose(): void {
    if (this.resolve) {
      this.resolve({ confirmed: false });
      this.resolve = null;
    }
    for (const state of Object.values(this.diffStates)) {
      state.diffRenderer?.destroy();
    }
    this.diffStates = {};
    this.ignoredIds.clear();
    this.headerTitleEl = null;
    this.contentEl.empty();
  }
}
