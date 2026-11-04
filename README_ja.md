# kiokuflow - Drive Sync for Obsidian

Obsidian の Vault を Google Drive と同期し、[kiokuflow](https://kiokuflow.net) と完全互換で連携できます。Obsidian でノートを編集し、kiokuflow の Web インターフェースからアクセスすることも、その逆も可能です。

## kiokuflow とは？

[kiokuflow](https://kiokuflow.net) は、Google Gemini を Google Drive と統合されたパーソナル AI アシスタントに変える Web アプリケーションです。

![kiokuflow インターフェース](docs/images/gemihub_connection/push_pull.png)

### kiokuflow 限定機能

以下の機能は kiokuflow の Web インターフェースでのみ利用可能です：

- **自動 RAG** - kiokuflow に同期されたファイルは自動的にセマンティック検索用にインデックスされます
- **OAuth2 対応 MCP** - OAuth2 認証が必要な MCP サーバーを使用可能（例：Google Calendar、Gmail、Google Docs）
- **Markdown から PDF/HTML への変換** - Markdown ノートをフォーマット済みの PDF または HTML ドキュメントに変換
- **公開パブリッシュ** - ドキュメントを共有可能な公開 URL で公開

### このプラグインで Obsidian に追加される機能

- **Diff プレビュー付き双方向同期** - 変更をコミットする前に、詳細なファイル一覧と Unified Diff ビューで Push・Pull を実行
- **Diff 付きコンフリクト解決** - カラーコード付き Unified Diff でどちらのバージョンを保持するか判断
- **Drive 編集履歴** - Obsidian と kiokuflow の両方での変更を追跡、ファイルごとの履歴エントリに変更元（ローカル/リモート）を表示
- **コンフリクトバックアップ管理** - Drive に保存されたコンフリクトバックアップの閲覧、プレビュー、復元
- **自動 RAG 登録** - Google API キーが設定されている場合、Push したファイルを自動的に kiokuflow の RAG ストアに登録

## 同期の概要

- **双方向同期** - ローカルの変更を Drive に Push、リモートの変更を Obsidian に Pull
- **kiokuflow 互換** - 同じ `_sync-meta.json` フォーマットと kiokuflow の暗号化認証を使用
- **コンフリクト解決** - 同じファイルが両方で編集された場合のコンフリクトを検出・解決
- **選択的同期** - パターンマッチングでファイル/フォルダを除外可能
- **バイナリ対応** - 画像、PDF、その他のバイナリファイルも同期

## GemiHub からの移行

リポジトリ・パッケージ名は `obsidian-kiokuflow`、Obsidian のプラグイン ID は `kiokuflow`（旧 `gemihub`）になりました。新プラグインを有効にする前に旧プラグインを無効にしてください。初回起動時は旧プラグインをインストールしたままにすると、新プラグインに保存済みの設定がない場合、暗号化認証や Secret Storage の選択を含む旧設定を自動で引き継ぎます。引き継いだ設定を確認してから旧プラグインをアンインストールできます。

同期情報・RAG の状態・競合バックアップは、互換性のため既存の `GemiHub/` フォルダと `gemini-workspace.json` を継続して使います。これらのパスはそのまま維持してください。共通の RAG キーと依存ライブラリ `gemihub-sync-core` も維持します。Drive の同期先はエクスポートしたトークンのフォルダ ID で確認するため、アプリ名や Drive フォルダ名を変えても同期先は切り替わりません。

## 事前準備

[kiokuflow](https://kiokuflow.net) アカウントで Google Drive 同期が設定済みである必要があります。プラグインは kiokuflow の暗号化認証トークンを使用して Google Drive に接続します。

1. kiokuflow にサインイン
2. **Settings** → **Obsidian Sync** セクションを開く
3. **Migration Tool token** をコピー

![Migration Tool Token](docs/images/gemihub_connection/migration_tool.png)

## セットアップ

1. Obsidian の **設定** → **kiokuflow - Drive Sync** → **Google Drive sync** セクションまでスクロール
2. **Enable drive sync** をオンに切り替え

![Drive 同期を有効化](docs/images/gemihub_connection/setting_drive_sync.png)

3. kiokuflow からコピーした **Migration Tool token** を貼り付け
4. **Setup** をクリックして Google Drive から暗号化認証を取得

![Migration Tool Token の設定](docs/images/gemihub_connection/setting_migration_tool_token.png)

5. **パスワード** を入力して現在のセッションの同期をアンロック

![Drive Sync のアンロック](docs/images/gemihub_connection/start_with_sync.png)

> Obsidian 1.11.4 以上が必要です。再起動時に自動でロック解除するには、プラグイン設定の **Secret Storage のパスワード** で、kiokuflow のパスワードを保存したシークレットを選択・作成してください。プラグイン設定にはシークレット名のみ保存します。シークレットは各端末で設定してください。選択を解除すると手入力に戻ります。保存値がない場合やロック解除に失敗した場合は入力画面が開きます。認証のリセットでは選択を解除しますが、Obsidian の Secret Storage 内のシークレットは削除しません。

## 同期の仕組み

### Drive 上のファイル構造

すべての Vault ファイルは Drive 上のルートフォルダに**フラット**に格納されます。Drive 上のファイル名には Vault の完全パスが含まれます：

| Vault パス | Drive ファイル名 |
|---|---|
| `notes.md` | `notes.md` |
| `daily/2024-01-15.md` | `daily/2024-01-15.md` |
| `attachments/image.png` | `attachments/image.png` |

Drive 上にサブフォルダは作成されません（`trash/`、`sync_conflicts/`、`__TEMP__/` などのシステムフォルダを除く）。kiokuflow も同じフラット構造を使用しています。

### 同期メタデータ

2つのメタデータファイルで同期状態を管理します：

- **`_sync-meta.json`**（Drive 上） - kiokuflow と共有。同期対象ファイルの ID、チェックサム、タイムスタンプを保持。
- **`GemiHub/drive-sync-meta.json`**（ローカル） - Vault パスと Drive ファイル ID のマッピング、最終同期時のチェックサムを保持。

### Push

ローカルの変更を Google Drive にアップロードします。

1. Vault 内の全ファイルの MD5 チェックサムを計算
2. ローカル同期メタデータと比較し、変更ファイルを特定
3. リモートに未取得の変更がある場合、Push を拒否（先に Pull が必要）
4. 新規・変更ファイルを Drive にアップロード
5. ローカルで削除されたファイルを Drive の `trash/` に移動（ソフトデリート）
6. Drive 上の `_sync-meta.json` を更新
7. 対象ファイルを kiokuflow の RAG ストアに自動登録（バックグラウンド、設定済みの場合）

![Drive への Push](docs/images/gemihub_connection/push.png)

### Pull

リモートの変更を Vault にダウンロードします。

1. リモートの `_sync-meta.json` を取得
2. ローカルのチェックサムを計算し、ローカル変更を検出
3. コンフリクトがある場合、コンフリクト解決モーダルを表示
4. ローカルにのみ存在するファイルを削除（Obsidian のゴミ箱に移動）
5. リモートの新規・変更ファイルを Vault にダウンロード
6. ローカル同期メタデータを更新

![ローカルへの Pull](docs/images/gemihub_connection/pull_to_local.png)

### Full Pull

すべてのローカルファイルをリモートバージョンで置き換えます。Vault を Drive の状態に完全にリセットしたい場合に使用します。

> **注意:** Drive に存在しないローカルファイルは削除されます（Obsidian のゴミ箱に移動）。

### コンフリクト解決

同じファイルがローカルとリモートの両方で変更された場合：

- モーダルにコンフリクトファイルの一覧が表示される
- 各ファイルについて **Keep local**（ローカルを保持）または **Keep remote**（リモートを保持）を選択
- 選ばれなかった方のバージョンは Drive の `sync_conflicts/` フォルダにバックアップ
- **編集・削除コンフリクト**（ローカルで編集、リモートで削除）の場合は **Restore (push to drive)**（復元して Drive に Push）または **Accept delete**（削除を受け入れる）を選択
- 一括操作: **Keep all local** / **Keep all remote**

![コンフリクト解決](docs/images/gemihub_connection/conflict.png)

**Diff** をクリックすると、ローカルとリモートのバージョン間のカラーコード付き Unified Diff が表示されます：

![コンフリクト Diff ビュー](docs/images/gemihub_connection/conflict_diff.png)

## データ管理

### ゴミ箱

同期中に削除されたファイルは、完全に削除されるのではなく Drive の `trash/` フォルダに移動されます。設定画面から以下の操作が可能です：

- **Restore** - ファイルをゴミ箱からルートフォルダに戻す
- **Delete permanently** - ファイルを Drive から完全に削除

### コンフリクトバックアップ

コンフリクト解決時に選ばれなかったバージョンは Drive の `sync_conflicts/` に保存されます。以下の操作が可能です：

- **Restore** - バックアップをルートフォルダに復元（現在のバージョンを上書き）
- **Delete** - バックアップを完全に削除

![コンフリクトバックアップ](docs/images/gemihub_connection/conflict_backup.png)

### 一時ファイル

kiokuflow が一時保存したファイルは Drive の `__TEMP__/` に格納されます。以下の操作が可能です：

- **Apply** - 一時ファイルの内容を対応する Drive ファイルに適用
- **Delete** - 一時ファイルを削除

3つの管理モーダルすべてで、ファイルプレビューと一括操作がサポートされています。

一時ファイルの一覧は名前・日時だけを取得します。プレビュー時に対象1件の本文を読み込み、別のプレビューを開くか画面を閉じると保持を解除します。選択したファイルの適用も1件ずつ読み込み・処理し、削除時は本文を取得しません。バイナリのプレビューでは添付のエンコード済みデータを表示しません。

モバイルのバックグラウンド件数確認では、Obsidianの変更通知を監視できるファイルのハッシュをセッション中だけ再利用します。変更通知でキャッシュを無効化し、索引にないファイルは毎回読み直します。明示的な同期プレビュー・Push・Pullではモバイルの本文を再検証するため、サイズ・更新時刻が変わらない編集も検出します。ハッシュキャッシュに本文は保持しません。

## 設定項目

| 設定 | 説明 | デフォルト |
|---|---|---|
| **Enable drive sync** | 同期機能の有効/無効 | オフ |
| **Migration Tool token** | kiokuflow の設定（Obsidian Sync セクション）から貼り付け | - |
| **Auto sync check** | 定期的にリモートの変更をチェックしてカウントを更新 | オフ |
| **Sync check interval** | チェック間隔（分） | 5 |
| **Exclude patterns** | 除外パス（1行1パターン、`*` ワイルドカード対応） | `node_modules/` |

## コマンド

コマンドパレットから4つのコマンドが利用可能です：

| コマンド | 説明 |
|---|---|
| **Drive sync: push to drive** | ローカルの変更を Drive に Push |
| **Drive sync: pull to local** | リモートの変更を Vault に Pull |
| **Drive sync: full push to drive** | すべてのローカルファイルを Drive に Push |
| **Drive sync: full pull to local** | すべてのローカルファイルをリモートバージョンで置き換え |

## 除外ファイル

以下は常に同期から除外されます：

- `_sync-meta.json`, `settings.json`
- `history/`, `trash/`, `sync_conflicts/`, `__TEMP__/`, `plugins/`, `.trash/`, `node_modules/`
- Obsidian 設定ディレクトリ（`.obsidian/` またはカスタム設定）
- プラグインワークスペースフォルダ（`GemiHub/`）
- 設定で定義したユーザー除外パターン

### 除外パターンの構文

- `folder/` - フォルダとその中身を除外
- `*.tmp` - Glob パターン（すべての `.tmp` ファイルにマッチ）
- `*.log` - Glob パターン（すべての `.log` ファイルにマッチ）
- `drafts/` - `drafts` フォルダを除外

## トラブルシューティング

### "Remote has pending changes. Please pull first."

リモートの Drive に未取得の変更があります。Push の前に **Pull to local** を実行してください。

### "Drive sync: no remote data found. Push first."

Drive 上に `_sync-meta.json` が存在しません。**Push to drive** を実行して同期を初期化してください。

### パスワードのアンロックに失敗する

- kiokuflow と同じパスワードを使用しているか確認してください
- kiokuflow でパスワードを変更した場合は、設定画面の **Reset auth** を使用し、新しい Migration Tool token で再セットアップしてください

### コンフリクトモーダルが繰り返し表示される

両方に変更があります。各ファイルについてローカルまたはリモートを選択し、すべてのコンフリクトを解決してください。全コンフリクト解決後、Pull が自動的に続行されます。

## 関連リポジトリ

- [kiokuflow](https://kiokuflow.net) — このプラグインの同期先となる Web アプリ
- [gemihub-sync-core](https://github.com/takeshy/gemihub-sync-core) — このプラグイン、kiokuflow、kiokuflow Desktop プラグインが共通で使う同期ライブラリ。`_sync-meta.json` のプロトコルと読み書き、Google Drive REST クライアント、同期除外とファイル種別の判定、コンフリクトバックアップの命名、暗号化と外部同期の認証情報を提供します。上記の同期の挙動はこのライブラリによるもので、同じ Drive フォルダをすべてのクライアントが同じ規則で扱います。

## ライセンス

MIT
