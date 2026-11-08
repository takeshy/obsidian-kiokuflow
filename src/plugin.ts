import { Plugin, TFile, Notice, normalizePath } from "obsidian";
import {
  type KiokuflowSettings,
  type WorkspaceState,
  DEFAULT_SETTINGS,
  DEFAULT_WORKSPACE_STATE,
  WORKSPACE_FOLDER,
} from "src/types";
import { DriveSyncManager } from "src/core/driveSync";
import { migrateWorkspaceFolder } from "src/core/workspaceMigration";
import { DriveSyncUIManager } from "src/plugin/driveSyncUI";
import { SettingsTab } from "src/ui/SettingsTab";
import { t } from "src/i18n";
import { formatError } from "src/utils/error";
import { ConfirmModal } from "src/ui/components/ConfirmModal";

const WORKSPACE_STATE_FILENAME = "gemini-workspace.json";

/**
 * Deep copy of the defaults, so nothing can write through to the shared
 * constant. Spelled out rather than using structuredClone(), which is missing
 * on iOS below 15.4 — still inside Obsidian's supported range.
 */
function cloneDefaultSettings(): KiokuflowSettings {
  return {
    ...DEFAULT_SETTINGS,
    driveSync: {
      ...DEFAULT_SETTINGS.driveSync,
      excludePatterns: [...DEFAULT_SETTINGS.driveSync.excludePatterns],
    },
    editHistory: {
      ...DEFAULT_SETTINGS.editHistory,
      diff: { ...DEFAULT_SETTINGS.editHistory.diff },
    },
  };
}

export class KiokuflowPlugin extends Plugin {
  settings: KiokuflowSettings = cloneDefaultSettings();
  workspaceState: WorkspaceState = { ...DEFAULT_WORKSPACE_STATE };
  driveSyncManager: DriveSyncManager | null = null;
  driveSyncUI!: DriveSyncUIManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadWorkspaceState();

    this.driveSyncManager = new DriveSyncManager(this.app, this);
    this.driveSyncUI = new DriveSyncUIManager(this);

    this.addSettingTab(new SettingsTab(this.app, this));
    this.setupDriveSyncUI();
    this.registerCommands();
    this.registerFileMenu();

    this.app.workspace.onLayoutReady(() => {
      if (this.driveSyncManager?.isConfigured && !this.driveSyncManager.isUnlocked) {
        void this.promptDriveSyncUnlock();
      }
    });
  }

  onunload(): void {
    this.driveSyncUI?.teardown();
    this.driveSyncManager?.destroy();
    this.driveSyncManager = null;
  }

  // ---- Settings persistence ----

  async loadSettings(): Promise<void> {
    let data = (await this.loadData()) as Partial<KiokuflowSettings> | null;
    let importedLegacySettings = false;
    if (data == null && this.manifest.id === "kiokuflow") {
      // The plugin ID determines loadData's location. Import once without
      // changing the old installation, including its selected Secret Storage ID.
      const legacyPath = normalizePath(`${this.app.vault.configDir}/plugins/gemihub/data.json`);
      if (await this.app.vault.adapter.exists(legacyPath)) {
        data = JSON.parse(await this.app.vault.adapter.read(legacyPath)) as Partial<KiokuflowSettings> | null;
        importedLegacySettings = data != null;
      }
    }
    const defaults = cloneDefaultSettings();
    this.settings = {
      ...defaults,
      ...data,
      driveSync: { ...defaults.driveSync, ...data?.driveSync },
      editHistory: {
        ...defaults.editHistory,
        ...data?.editHistory,
        diff: { ...defaults.editHistory.diff, ...data?.editHistory?.diff },
      },
    };
    if (importedLegacySettings) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- Workspace state persistence ----

  async loadWorkspaceState(): Promise<void> {
    await migrateWorkspaceFolder(this.app);
    const path = `${WORKSPACE_FOLDER}/${WORKSPACE_STATE_FILENAME}`;
    if (await this.app.vault.adapter.exists(path)) {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsed = JSON.parse(raw);
        this.workspaceState = Object.assign(
          {},
          DEFAULT_WORKSPACE_STATE,
          parsed
        );
      } catch {
        this.workspaceState = { ...DEFAULT_WORKSPACE_STATE };
      }
    }
  }

  async saveWorkspaceState(): Promise<void> {
    const folderPath = WORKSPACE_FOLDER;
    const filePath = `${folderPath}/${WORKSPACE_STATE_FILENAME}`;
    const json = JSON.stringify(this.workspaceState, null, 2);

    // Ensure workspace folder exists
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, json);
    } else {
      await this.app.vault.create(filePath, json);
    }
  }

  // ---- Drive Sync UI ----

  setupDriveSyncUI(): void {
    this.driveSyncUI.setup();
  }

  async promptDriveSyncUnlock(): Promise<void> {
    await this.driveSyncUI.promptDriveSyncUnlock();
  }

  // ---- Commands ----

  private registerCommands(): void {
    this.addCommand({
      id: "drive-sync-push",
      name: t("driveSync.commandPush"),
      callback: () => {
        const mgr = this.driveSyncManager;
        if (!mgr?.isConfigured || !mgr.isUnlocked) {
          void this.promptDriveSyncUnlock();
          return;
        }
        void this.driveSyncUI.showSyncDiffAndExecute(mgr, "push");
      },
    });

    this.addCommand({
      id: "drive-sync-pull",
      name: t("driveSync.commandPull"),
      callback: () => {
        const mgr = this.driveSyncManager;
        if (!mgr?.isConfigured || !mgr.isUnlocked) {
          void this.promptDriveSyncUnlock();
          return;
        }
        void this.driveSyncUI.showSyncDiffAndExecute(mgr, "pull");
      },
    });

    this.addCommand({
      id: "drive-sync-full-push",
      name: t("driveSync.commandFullPush"),
      callback: () => {
        const mgr = this.driveSyncManager;
        if (!mgr?.isConfigured || !mgr.isUnlocked) {
          new Notice(t("driveSync.notUnlocked"));
          return;
        }
        void (async () => {
          try {
            const confirmed = await new ConfirmModal(
              this.app,
              t("driveSync.fullPushConfirm"),
              t("driveSync.fullPush"),
              t("common.cancel")
            ).openAndWait();
            if (!confirmed) return;
            await mgr.fullPush();
          } catch (err) {
            new Notice(t("driveSync.pushFailed", { error: formatError(err) }));
          }
        })();
      },
    });

    this.addCommand({
      id: "drive-sync-full-pull",
      name: t("driveSync.commandFullPull"),
      callback: () => {
        const mgr = this.driveSyncManager;
        if (!mgr?.isConfigured || !mgr.isUnlocked) {
          new Notice(t("driveSync.notUnlocked"));
          return;
        }
        void (async () => {
          try {
            const confirmed = await new ConfirmModal(
              this.app,
              t("driveSync.fullPullConfirm"),
              t("driveSync.fullPull"),
              t("common.cancel")
            ).openAndWait();
            if (!confirmed) return;
            await mgr.fullPull();
          } catch (err) {
            new Notice(t("driveSync.pullFailed", { error: formatError(err) }));
          }
        })();
      },
    });
  }

  // ---- File menu (right-click) for temp upload/download ----

  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        const mgr = this.driveSyncManager;
        if (!mgr?.isUnlocked) return;

        menu.addItem((item) => {
          item
            .setTitle(t("driveSync.tempUpload"))
            .setIcon("upload")
            .onClick(() => {
              void (async () => {
                try {
                  await mgr.saveTempFile(file.path);
                  new Notice(t("driveSync.tempUploadDone"));
                } catch (err) {
                  new Notice(formatError(err));
                }
              })();
            });
        });
      })
    );
  }
}
