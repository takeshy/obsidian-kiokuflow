# kiokuflow - Drive Sync for Obsidian

Sync your Obsidian vault with Google Drive, fully compatible with [kiokuflow](https://kiokuflow.net). Edit notes in Obsidian and access them from kiokuflow's web interface, or vice versa.

## What is kiokuflow?

[kiokuflow](https://kiokuflow.net) is a web application that turns Google Gemini into a personal AI assistant integrated with your Google Drive.

![kiokuflow Interface](docs/images/gemihub_connection/push_pull.png)

### kiokuflow-exclusive features

These features are only available through kiokuflow's web interface:

- **Automatic RAG** - Files synced to kiokuflow are automatically indexed for semantic search
- **OAuth2-enabled MCP** - Use MCP servers that require OAuth2 authentication (e.g., Google Calendar, Gmail, Google Docs)
- **Markdown to PDF/HTML conversion** - Convert Markdown notes to formatted PDF or HTML documents
- **Public publishing** - Publish documents with a shareable public URL

### Features added to Obsidian through this plugin

- **Bidirectional sync with diff preview** - Push and pull files with a detailed file list and unified diff view before committing changes
- **Conflict resolution with diff** - Color-coded unified diff to help decide which version to keep
- **Drive edit history** - Track changes from both Obsidian and kiokuflow, with per-file history entries showing origin (local/remote)
- **Conflict backup management** - Browse, preview, and restore conflict backups stored on Drive
- **Automatic RAG registration** - Pushed files are automatically registered to kiokuflow's RAG store when a Google API key is configured

## Sync Overview

- **Bidirectional sync** - Push local changes to Drive, pull remote changes to Obsidian
- **kiokuflow compatible** - Uses the same `_sync-meta.json` format and encrypted auth from kiokuflow
- **Conflict resolution** - Detects and resolves conflicts when both sides edit the same file
- **Selective sync** - Exclude files/folders with pattern matching
- **Binary support** - Syncs images, PDFs, and other binary files

## Upgrading from GemiHub

The repository/package name is now `obsidian-kiokuflow`, and the Obsidian plugin ID is `kiokuflow` (previously `gemihub`). Disable the old plugin before enabling the new one. Keep the old plugin installed for the first launch: if the new plugin has no saved settings, it imports the old plugin's settings, including encrypted auth and the selected Secret Storage entry. After checking the imported settings, you can uninstall the old plugin.

Local sync tracking, RAG state and conflict backups continue to use the existing `GemiHub/` folder and `gemini-workspace.json` filename. Keep these paths unchanged. The shared RAG key and `gemihub-sync-core` dependency also retain their existing names for compatibility. Drive sync uses the folder ID from the exported token, so renaming the app or Drive folder does not switch workspaces.

## Prerequisites

You need a [kiokuflow](https://kiokuflow.net) account with Google Drive sync configured. The plugin uses kiokuflow's encrypted authentication token to connect to your Google Drive.

1. Sign in to kiokuflow
2. Go to **Settings** → **Obsidian Sync** section
3. Copy the **Migration Tool token**

![Migration Tool Token](docs/images/gemihub_connection/migration_tool.png)

## Setup

1. Open Obsidian **Settings** → **kiokuflow - Drive Sync** → scroll to **Google Drive sync**
2. Toggle **Enable drive sync** on

![Enable Drive Sync](docs/images/gemihub_connection/setting_drive_sync.png)

3. Paste the **Migration Tool token** from kiokuflow
4. Click **Setup** to fetch the encrypted auth from Google Drive

![Migration Tool Token Setup](docs/images/gemihub_connection/setting_migration_tool_token.png)

5. Enter your **password** to unlock sync for the current session

![Drive Sync Unlock](docs/images/gemihub_connection/start_with_sync.png)

> Requires Obsidian 1.11.4 or later. To unlock automatically after restarting, select or create a secret containing your kiokuflow password under **Password in Secret Storage** in the plugin settings. Only the secret name is saved in plugin settings. Configure the secret on each device; clear the selection to return to manual entry. If the secret is missing or unlock fails, the password prompt appears. Resetting auth clears the selection but leaves the secret in Obsidian's Secret Storage.

## How Sync Works

### File Storage on Drive

All vault files are stored **flat** in the root folder on Drive. The file name on Drive includes the full vault path:

| Vault path | Drive file name |
|---|---|
| `notes.md` | `notes.md` |
| `daily/2024-01-15.md` | `daily/2024-01-15.md` |
| `attachments/image.png` | `attachments/image.png` |

This means there are no subfolders on Drive (except for system folders like `trash/`, `sync_conflicts/`, `__TEMP__/`). kiokuflow uses the same flat structure.

### Sync Metadata

Two metadata files track sync state:

- **`_sync-meta.json`** (on Drive) - Shared with kiokuflow. Contains file IDs, checksums, and timestamps for all synced files.
- **`GemiHub/drive-sync-meta.json`** (local) - Maps vault paths to Drive file IDs and stores last-synced checksums.

### Push

Uploads local changes to Google Drive.

1. Computes MD5 checksums for all vault files
2. Compares with local sync metadata to find changed files
3. If remote has pending changes, push is rejected (pull first)
4. Uploads new/modified files to Drive
5. Moves locally deleted files to `trash/` on Drive (soft delete)
6. Updates `_sync-meta.json` on Drive
7. Syncs eligible files to kiokuflow's RAG store (background, if configured)

![Push to Drive](docs/images/gemihub_connection/push.png)

### Pull

Downloads remote changes to the vault.

1. Fetches remote `_sync-meta.json`
2. Computes local checksums to detect local changes
3. If conflicts exist, shows the conflict resolution modal
4. Deletes locally-only files (moved to Obsidian trash)
5. Downloads new/modified remote files to vault
6. Updates local sync metadata

![Pull to Local](docs/images/gemihub_connection/pull_to_local.png)

### Full Pull

Replaces all local files with remote versions. Use this to reset your vault to match Drive.

> **Warning:** This deletes local files not present on Drive (moved to Obsidian trash).

### Conflict Resolution

When the same file is modified both locally and remotely:

- A modal shows all conflicting files
- For each file, choose **Keep local** or **Keep remote**
- The losing version is backed up to `sync_conflicts/` on Drive
- **Edit-delete conflicts** (locally edited, remotely deleted) offer **Restore (push to drive)** or **Accept delete**
- Bulk actions: **Keep all local** / **Keep all remote**

![Conflict Resolution](docs/images/gemihub_connection/conflict.png)

Click **Diff** to see a color-coded unified diff between local and remote versions:

![Conflict Diff View](docs/images/gemihub_connection/conflict_diff.png)

## Data Management

### Trash

Files deleted during sync are moved to the `trash/` folder on Drive instead of being permanently deleted. From the settings, you can:

- **Restore** - Move files back from trash to the root folder
- **Delete permanently** - Permanently remove files from Drive

### Conflict Backups

When conflicts are resolved, the losing version is saved in `sync_conflicts/` on Drive. You can:

- **Restore** - Restore a backup to the local vault as a timestamped file, keeping the current file untouched
- **Delete** - Permanently remove backups

![Conflict Backups](docs/images/gemihub_connection/conflict_backup.png)

### Temporary Files

Files temporarily saved by kiokuflow are stored in `__TEMP__/` on Drive. You can:

- **Apply** - Apply temporary file content to the corresponding Drive file
- **Delete** - Remove temporary files

All three management modals support file preview and batch operations.

The temporary-file list loads names and dates only. Preview loads one selected payload and releases it when another preview is opened or the dialog closes. Applying selected files reads and applies one payload at a time; deleting files does not download their contents. Binary previews show a file notice instead of rendering encoded attachment data.

On mobile, background change counts reuse session-only hashes for unchanged files watched by Obsidian. File changes invalidate those hashes. Unindexed files are still read on each check, and explicit sync previews, Push and Pull rehash mobile files to detect edits that preserve their size and modification time. File contents are never kept in this hash cache.

## Settings

| Setting | Description | Default |
|---|---|---|
| **Enable drive sync** | Toggle the sync feature | Off |
| **Migration Tool token** | Paste from kiokuflow settings (Obsidian Sync section) | - |
| **Auto sync check** | Periodically check for remote changes and update counts | Off |
| **Sync check interval** | How often to check (minutes) | 5 |
| **Exclude patterns** | Paths to exclude (one per line, supports `*` wildcards) | `node_modules/` |

## Commands

Four commands are available from the command palette:

| Command | Description |
|---|---|
| **Drive sync: push to drive** | Push local changes to Drive |
| **Drive sync: pull to local** | Pull remote changes to vault |
| **Drive sync: full push to drive** | Push all local files to Drive |
| **Drive sync: full pull to local** | Replace all local files with remote versions |

## Excluded Files

The following are always excluded from sync:

- `_sync-meta.json`, `settings.json`
- `history/`, `trash/`, `sync_conflicts/`, `__TEMP__/`, `plugins/`, `.trash/`, `node_modules/`
- Obsidian config directory (`.obsidian/` or custom)
- Plugin workspace folder (`GemiHub/`)
- User-defined exclude patterns from settings

### Exclude Pattern Syntax

- `folder/` - Exclude a folder and its contents
- `*.tmp` - Glob pattern (matches any `.tmp` file)
- `*.log` - Glob pattern (matches any `.log` file)
- `drafts/` - Exclude the `drafts` folder

## Troubleshooting

### "Remote has pending changes. Please pull first."

The remote Drive has changes that haven't been pulled yet. Run **Pull to local** before pushing.

### "Drive sync: no remote data found. Push first."

No `_sync-meta.json` exists on Drive. Run **Push to drive** to initialize sync.

### Password unlock fails

- Verify you are using the same password as in kiokuflow
- If you have changed your password in kiokuflow, use **Reset auth** in settings and re-setup with a new Migration Tool token

### Conflict modal keeps appearing

Both sides have changes. Resolve all conflicts by choosing local or remote for each file. After resolving all conflicts, pull continues automatically.

## Related Repositories

- [kiokuflow](https://kiokuflow.net) — the web app this plugin syncs with
- [gemihub-sync-core](https://github.com/takeshy/gemihub-sync-core) — shared sync library used by this plugin, kiokuflow and the kiokuflow Desktop plugin: `_sync-meta.json` protocol and storage, Google Drive REST client, sync exclusion and file type rules, conflict backup names, and encryption / external sync credentials. The sync behavior described above comes from this library, so all clients handle the same Drive folder identically.

## License

MIT
