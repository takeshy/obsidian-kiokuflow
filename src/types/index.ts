export const WORKSPACE_FOLDER = "KiokuFlow";
export const LEGACY_WORKSPACE_FOLDER = "GemiHub";

// Google Drive Sync settings
export interface DriveSyncSettings {
  enabled: boolean;
  encryptedAuth: DriveEncryptedAuth | null;
  passwordSecretId: string;
  excludePatterns: string[];
  autoSync: boolean;
  syncIntervalMinutes: number;
  rootFolderName: string;
}

export interface DriveEncryptedAuth {
  data: string;
  encryptedPrivateKey: string;
  salt: string;
  rootFolderId: string;
}

export interface DriveSessionTokens {
  accessToken: string;
  refreshToken: string;
  apiOrigin: string;
  expiryTime: number;
  rootFolderId: string;
}

export const DEFAULT_DRIVE_SYNC_SETTINGS: DriveSyncSettings = {
  enabled: false,
  encryptedAuth: null,
  passwordSecretId: "",
  excludePatterns: ["node_modules/", ".*"],
  autoSync: false,
  syncIntervalMinutes: 5,
  rootFolderName: "kiokuflow",
};

// Edit history settings (used by drive edit history)
export interface EditHistorySettings {
  enabled: boolean;
  diff: {
    contextLines: number;
  };
}

export const DEFAULT_EDIT_HISTORY_SETTINGS: EditHistorySettings = {
  enabled: true,
  diff: { contextLines: 3 },
};

// RAG file info (used by drive sync for file tracking)
export interface RagFileInfo {
  checksum: string;
  uploadedAt: number;
  fileId: string | null;
}

// Individual RAG setting
export interface RagSetting {
  storeId: string | null;
  storeIds: string[];
  storeName: string | null;
  isExternal: boolean;
  targetFolders: string[];
  excludePatterns: string[];
  files: Record<string, RagFileInfo>;
  lastFullSync: number | null;
}

export const DEFAULT_RAG_SETTING: RagSetting = {
  storeId: null,
  storeIds: [],
  storeName: null,
  isExternal: false,
  targetFolders: [],
  excludePatterns: [],
  files: {},
  lastFullSync: null,
};

// Workspace state (persisted in gemini-workspace.json)
export interface WorkspaceState {
  ragSettings: Record<string, RagSetting>;
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
  ragSettings: {},
};

// Plugin settings
export interface KiokuflowSettings {
  driveSync: DriveSyncSettings;
  editHistory: EditHistorySettings;
  ragEnabled: boolean;
}

export const DEFAULT_SETTINGS: KiokuflowSettings = {
  driveSync: DEFAULT_DRIVE_SYNC_SETTINGS,
  editHistory: DEFAULT_EDIT_HISTORY_SETTINGS,
  ragEnabled: false,
};
