import { Notice, Menu } from "obsidian";
import { DuplicateRemoteFilesError, type DriveSyncManager } from "src/core/driveSync";
import { DriveSyncConflictModal } from "src/ui/components/DriveSyncConflictModal";
import { DriveSyncDiffModal } from "src/ui/components/DriveSyncDiffModal";
import { DriveAuthPasswordModal } from "src/ui/components/DriveAuthPasswordModal";
import { DriveDuplicateResolutionModal } from "src/ui/components/DriveDuplicateResolutionModal";
import { formatError } from "src/utils/error";
import { t } from "src/i18n";
import type { KiokuflowPlugin } from "src/plugin";

export class DriveSyncUIManager {
  private plugin: KiokuflowPlugin;
  private statusBarEl: HTMLElement | null = null;
  private pushRibbonEl: HTMLElement | null = null;
  private pullRibbonEl: HTMLElement | null = null;
  private unlockPromise: Promise<void> | null = null;

  constructor(plugin: KiokuflowPlugin) {
    this.plugin = plugin;
  }

  private get mgr(): DriveSyncManager | null {
    return this.plugin.driveSyncManager;
  }

  /**
   * Prompt user for password to unlock Drive sync session.
   */
  async promptDriveSyncUnlock(): Promise<void> {
    if (this.unlockPromise) return this.unlockPromise;
    this.unlockPromise = this.unlockDriveSync();
    try {
      await this.unlockPromise;
    } finally {
      this.unlockPromise = null;
    }
  }

  private async unlockDriveSync(): Promise<void> {
    const mgr = this.mgr;
    if (!mgr?.isConfigured || mgr.isUnlocked) return;

    const secretId = this.plugin.settings.driveSync.passwordSecretId;
    if (secretId) {
      try {
        const password = this.plugin.app.secretStorage.getSecret(secretId);
        if (password) {
          await mgr.unlockWithPassword(password);
          this.updateStatusBar();
          return;
        }
      } catch {
        mgr.lock();
        new Notice(t("driveSync.secretUnlockFailed"));
      }
    }

    while (this.mgr?.isConfigured && !this.mgr.isUnlocked) {
      const modal = new DriveAuthPasswordModal(this.plugin.app);
      const result = await modal.openAndWait();
      if (!result) return; // User skipped/cancelled

      try {
        await this.mgr.unlockWithPassword(result.password);
        new Notice(t("driveSync.unlocked"));
        this.updateStatusBar();
      } catch (err) {
        this.mgr.lock();
        console.error("Drive sync unlock failed:", formatError(err));
        new Notice(t("driveSync.unlockFailed", { error: formatError(err) }));
        continue;
      }

      if (result.savePassword) {
        const previousId = this.plugin.settings.driveSync.passwordSecretId;
        try {
          const id = previousId || `kiokuflow-drive-password-${crypto.randomUUID()}`;
          this.plugin.app.secretStorage.setSecret(id, result.password);
          this.plugin.settings.driveSync.passwordSecretId = id;
          await this.plugin.saveSettings();
        } catch {
          this.plugin.settings.driveSync.passwordSecretId = previousId;
          new Notice(t("driveSync.secretSaveFailed"));
        }
      }
      return;
    }
  }

  teardown(): void {
    this.statusBarEl?.remove();
    this.statusBarEl = null;
    this.pushRibbonEl?.remove();
    this.pushRibbonEl = null;
    this.pullRibbonEl?.remove();
    this.pullRibbonEl = null;
    if (this.mgr) {
      this.mgr.onStatusChange = null;
    }
  }

  setup(): void {
    const mgr = this.mgr;
    if (!mgr) return;

    if (!this.plugin.settings.driveSync.enabled) {
      this.teardown();
      return;
    }

    // Create status bar element if not exists
    if (!this.statusBarEl) {
      this.statusBarEl = this.plugin.addStatusBarItem();
      this.statusBarEl.addClass("kiokuflow-drive-sync-status");
      this.statusBarEl.addEventListener("click", (e) => {
        this.showMenu(e);
      });
    }

    // Create ribbon icons for Push/Pull
    if (!this.pushRibbonEl) {
      this.pushRibbonEl = this.plugin.addRibbonIcon("upload", t("driveSync.ribbonPush"), () => {
        const currentMgr = this.mgr;
        if (!currentMgr?.isUnlocked) {
          void this.promptDriveSyncUnlock();
          return;
        }
        void this.showSyncDiffAndExecute(currentMgr, "push");
      });
      this.pushRibbonEl.addClass("kiokuflow-drive-sync-ribbon");
    }

    if (!this.pullRibbonEl) {
      this.pullRibbonEl = this.plugin.addRibbonIcon("download", t("driveSync.ribbonPull"), () => {
        const currentMgr = this.mgr;
        if (!currentMgr?.isUnlocked) {
          void this.promptDriveSyncUnlock();
          return;
        }
        void this.showSyncDiffAndExecute(currentMgr, "pull");
      });
      this.pullRibbonEl.addClass("kiokuflow-drive-sync-ribbon");
    }

    // Listen for status changes
    mgr.onStatusChange = () => {
      this.updateStatusBar();
      this.updateRibbonBadges();
    };

    this.updateStatusBar();
    this.updateRibbonBadges();
  }

  updateRibbonBadges(): void {
    const mgr = this.mgr;
    const local = mgr?.localModifiedCount ?? 0;
    const remote = mgr?.remoteModifiedCount ?? 0;

    if (this.pushRibbonEl) {
      const label = local > 0 ? t("driveSync.ribbonPushCount", { count: String(local) }) : t("driveSync.ribbonPush");
      this.pushRibbonEl.setAttribute("aria-label", label);
      // Update badge
      let badge = this.pushRibbonEl.querySelector(".kiokuflow-sync-badge");
      if (local > 0) {
        if (!badge) {
          badge = this.pushRibbonEl.createSpan({ cls: "kiokuflow-sync-badge" });
        }
        badge.textContent = String(local);
      } else {
        badge?.remove();
      }
    }

    if (this.pullRibbonEl) {
      const label = remote > 0 ? t("driveSync.ribbonPullCount", { count: String(remote) }) : t("driveSync.ribbonPull");
      this.pullRibbonEl.setAttribute("aria-label", label);
      // Update badge
      let badge = this.pullRibbonEl.querySelector(".kiokuflow-sync-badge");
      if (remote > 0) {
        if (!badge) {
          badge = this.pullRibbonEl.createSpan({ cls: "kiokuflow-sync-badge" });
        }
        badge.textContent = String(remote);
      } else {
        badge?.remove();
      }
    }
  }

  updateStatusBar(): void {
    const el = this.statusBarEl;
    if (!el) return;

    const mgr = this.mgr;
    if (!mgr || !mgr.isConfigured) {
      el.toggleClass("kiokuflow-hidden", true);
      return;
    }

    el.toggleClass("kiokuflow-hidden", false);

    if (!mgr.isUnlocked) {
      el.setText(t("driveSync.statusLocked"));
      el.setAttribute("aria-label", t("driveSync.statusLockedTooltip"));
      return;
    }

    const status = mgr.syncStatus;
    const local = mgr.localModifiedCount;
    const remote = mgr.remoteModifiedCount;

    let text: string;
    switch (status) {
      case "pushing":
        text = t("driveSync.statusPushing");
        break;
      case "pulling":
        text = t("driveSync.statusPulling");
        break;
      case "conflict":
        text = t("driveSync.statusConflict");
        break;
      case "error":
        text = "Drive: error";
        break;
      default: {
        const parts: string[] = [];
        if (local > 0) parts.push(`↑${local}`);
        if (remote > 0) parts.push(`↓${remote}`);
        text = parts.length > 0 ? t("driveSync.statusChanges", { changes: parts.join(" ") }) : t("driveSync.statusSynced");
        break;
      }
    }

    el.setText(text);
    el.setAttribute("aria-label", mgr.lastError ? t("driveSync.statusError", { error: mgr.lastError }) : t("driveSync.statusTooltip"));
  }

  private showMenu(e: MouseEvent): void {
    const mgr = this.mgr;
    if (!mgr) return;

    const menu = new Menu();

    if (!mgr.isUnlocked) {
      menu.addItem((item) => {
        item.setTitle(t("driveSync.unlock")).setIcon("lock").onClick(() => {
          void this.promptDriveSyncUnlock();
        });
      });
    } else {
      menu.addItem((item) => {
        item.setTitle(t("driveSync.push")).setIcon("upload").onClick(() => {
          void this.showSyncDiffAndExecute(mgr, "push");
        });
      });
      menu.addItem((item) => {
        item.setTitle(t("driveSync.pull")).setIcon("download").onClick(() => {
          void this.showSyncDiffAndExecute(mgr, "pull");
        });
      });
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(t("driveSync.refreshCounts")).setIcon("refresh-cw").onClick(() => {
          void mgr.refreshSyncCounts();
        });
      });
    }

    menu.showAtMouseEvent(e);
  }

  async showSyncDiffAndExecute(mgr: DriveSyncManager, direction: "push" | "pull"): Promise<void> {
    // Show loading notice while computing file list
    const loadingNotice = new Notice(t("driveSync.loadingFileList"), 0);
    try {
      const result = await mgr.computeSyncFileList(direction);
      // Update badge count from the actual file list to avoid race conditions
      // (refreshSyncCounts independently fetches metadata and may see different state)
      if (direction === "push") {
        mgr.localModifiedCount = result.files.length;
      } else {
        mgr.remoteModifiedCount = result.files.length;
      }
      mgr.onStatusChange?.();
      loadingNotice.hide();

      // Block push when remote has unpulled changes
      if (direction === "push" && result.hasRemoteChanges) {
        new Notice(t("driveSync.pushBlockedByRemote"));
        return;
      }

      const modal = new DriveSyncDiffModal(this.plugin.app, result.files, direction, mgr);
      const modalResult = await modal.openAndWait();
      if (!modalResult.confirmed) return;

      if (direction === "push") {
        await mgr.push();
      } else {
        await mgr.pull(modalResult.ignoredIds);
      }

      if (mgr.syncStatus === "conflict") {
        this.openConflictModal(mgr);
      }
    } catch (err) {
      loadingNotice.hide();
      if (err instanceof DuplicateRemoteFilesError) {
        const resolved = await new DriveDuplicateResolutionModal(this.plugin.app, err.groups, mgr).openAndWait();
        if (resolved) await this.showSyncDiffAndExecute(mgr, direction);
        return;
      }
      const key = direction === "push" ? "driveSync.pushFailed" as const : "driveSync.pullFailed" as const;
      new Notice(t(key, { error: formatError(err) }));
    }
  }

  openConflictModal(mgr: DriveSyncManager): void {
    new DriveSyncConflictModal(this.plugin.app, mgr, mgr.conflicts, () => {
      // After all conflicts resolved, pull() runs automatically inside resolveConflicts.
      // If pull() detects new conflicts, re-open the modal.
      if (mgr.syncStatus === "conflict") {
        this.openConflictModal(mgr);
      }
    }).open();
  }
}
