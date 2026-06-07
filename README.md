# cmux-dashboard

cmux-dashboard is a local dashboard for running multiple development projects in
[cmux](https://cmux.com). Each normal project is shown as one workspace with
slots for Claude Code, Codex, Yazi, and a terminal. A global `cc-general` row can
also be kept available for ad-hoc Claude work.


## 概要

`./cmux-dash up` starts the dashboard server inside a dedicated cmux workspace
(`cmuxdash:__server__`) and opens the UI. Keeping the server as a child process
of a live cmux pane prevents the common detached/orphan server failure mode.

The dashboard can:

- Open, close, and focus project workspaces.
- Toggle individual slots: `CC`, `Cdx`, `Yazi`, and `Term`.
- Show monitoring panels for cmux health, memory, actions, and agent messages.
- Reorder projects, add new projects, and delete rows from the local config.
- Optionally prepare Claude/Codex collaboration through agmsg. Automatic collab
  bridge startup is default OFF (`collab: false`) and only runs when explicitly
  enabled.

## 必要要件

- cmux.app and the `cmux` CLI.
- Node.js. No `npm install` is required; the app uses Node standard modules.
- Optional: `yazi` for the Yazi slot.
- Optional: `claude` for the Claude Code slot.
- Optional: `codex` for the Codex slot.
- Optional: `agmsg` for Claude/Codex agent messaging.

## クイックスタート

```bash
git clone <repo-url> cmux-dashboard
cd cmux-dashboard
./cmux-dash up
```

初回起動時に `projects.json` が無い場合、`projects.example.json` から自動生成されます。UIの「＋ 追加」から自分のプロジェクトを追加するか、生成された
`projects.json` を直接編集してください。

推奨の安定運用は `./cmux-dash up` です。`cmuxdash:__server__` の dedicated workspace 内で `server.js`
を起動し、`health.cmux` がokになるまで確認します。background/nohup/launchd で直接 server を常駐させる方式は、cmux
セッションから孤児化して orphan 状態になりやすいため使わないでください。

## English Quick Start

```bash
git clone <repo-url> cmux-dashboard
cd cmux-dashboard
./cmux-dash up
```

On first launch, `projects.json` is created from `projects.example.json` when it
does not already exist. Edit `projects.json` or use the dashboard add button to
replace the placeholder projects with your own local project paths.

Keep cmux.app running while using the dashboard. The supported startup path runs
the server inside a cmux pane so it stays attached to the live cmux session.
Detached background or launchd startup is intentionally unsupported for the
dashboard server.

## 使い方

### サーバー操作

```bash
./cmux-dash up       # 推奨: cmuxペイン内でserverを起動し、UIを開く
./cmux-dash          # up と同じ
./cmux-dash open     # server workspaceを起動または再利用してUIを開く
./cmux-dash restart  # serverを停止し、cmuxペイン内で再起動
./cmux-dash stop     # serverとwatchdogを停止
./cmux-dash server   # 診断用: 現在の端末でforeground起動
```

`CMUX_DASH_PORT` でポートを変更できます。既定は `7799` です。

### Slotトグル

各行の `CC`、`Cdx`、`Yazi`、`Term` をON/OFFできます。未起動の行でslotをONにすると、そのプロジェクトの
cmux workspace が自動で開きます。slotごとの起動コマンドは `defaults.slotCommands` またはプロジェクト単位の
`slotCommands` で上書きできます。

### 監視パネル

UIは `/api/state`、`/api/metrics`、`/api/agmsg/:id` を定期取得し、cmux接続状態、actionキュー、メモリ、プロセス種別、agent messageを表示します。cmuxが不調な場合はhealth表示とrestart導線で復旧を促します。

### 並び替え・追加・削除

通常プロジェクトはUIで並び替えできます。`cc-general` など `kind: "global"` の行は通常プロジェクトの並び替え対象外です。新規追加と削除もUIから行えます。

### 自動collab

`collab` は既定OFFです。自動collab bridgeを使うプロジェクトだけ、`projects.json` で明示的に有効化してください。

```json
{
  "id": "sample-app",
  "name": "Sample App",
  "path": "~/projects/sample-app",
  "collab": true
}
```

## プロジェクト設定

`projects.json` は個人環境用のローカル設定で、gitでは追跡しません。公開用の雛形は `projects.example.json` です。

```json
{
  "id": "sample-app",
  "name": "Sample App",
  "path": "~/projects/sample-app",
  "color": "#6ee7b7",
  "emoji": "🚀"
}
```

`defaults` では `topCmd`、`bottomCmd`、`slotCommands`、`agmsg`、`claudeMd`、`collab`、`briefing` を設定できます。プロジェクト単位に同じキーを置くと、その行だけ上書きされます。

## 既知の制約

- cmux.app は起動したままにしてください。
- dashboard server は cmuxセッションに接続できる同一環境で動かす必要があります。
- background/nohup/launchd で server を直接起動すると orphan 化し、live cmux session parent を復元できないことがあります。
- 実cmuxの目視確認やブラウザ操作はローカル環境に依存します。
- 公開前のgit履歴整理は別工程です。現在のP1では追跡対象から個人設定を外し、exampleを用意します。

## 開発とテスト

```bash
./test.sh
```

`test.sh` は一時 `projects.json` とfake cmuxを使う契約テストに加え、実cmuxを使う起動・slot・open/close検査も含みます。
