# Master Plan: cmux-dashboard 全面リビルド（usedhonda版相当のリッチ・ダッシュボード）

> ステータス: claude 設計 → codex 実装（フェーズ分割）
> 起案: claude (plan層) 2026-06-07
> 方針(the maintainer決定): ゼロから作り直す。機能は全部入り（CC/Cdx/Yazi/Term個別トグル＋メモリ/トークン監視＋並び替え/追加削除/自動サイズ＋安定土台）。参考: usedhonda(@usedhonda)のGhosttyベースのツール。

## 0. 前提・土台の教訓（絶対に守る）
- cmux は Ghostty 内蔵のターミナル。バックエンドは cmux CLI(`/Applications/cmux.app/Contents/Resources/bin/cmux`)。cmux.app が起動していないと何も動かない。
- ★サーバーは「生きている cmux ペインの子プロセス」である間だけ cmux に繋がる。孤児化(サブシェル/launchd/detached)で Broken pipe になる。→ **サーバーは専用 cmux ペインで `exec node`(フォアグラウンド)常駐が正。background/launchd 起動は禁止/非推奨。** ([[cmux-dashboard-launch-bug]])
- 全 cmux 呼び出しは直列化＋一過性エラーは指数バックオフでリトライ。失敗はUIに可視化（「起動中」固定にしない）。
- claude=plan/codex=実装+テスト。証跡なしに完了としない。

## 1. cmux CLI 能力マップ（調査済み・これを使う）
- ワークスペース: `new-workspace --name --description --cwd --layout`, `list-workspaces --json`, `close-workspace`, `reorder-workspaces --order <refs>`, `select-workspace`, `workspace-action`
- ペイン/サーフェス: `new-pane --type terminal|browser --direction`, `new-surface --type terminal|browser --pane`, `close-surface --surface`, `list-panes --json`, `list-pane-surfaces --json`, `move-surface`, `reorder-surface`, `split-off`, `focus-pane`
- 入力: `send --workspace --surface "<text>"`（`\n`/`\r`でEnter）→ ペインで claude/codex/yazi 等を起動
- 監視: `top --all --processes --format tsv`（total→window→workspace→pane→surface→process 各行に CPU% / RSS(bytes) / proc数 / 種別 / ref / 親ref / コマンド名）、`memory --all`（footprint/子RSS/上位グループ）, `surface-health`

### top tsv の形（例）
`cpu  rss  proc  kind  ref  parentRef  command`
kind ∈ total|window|workspace|pane|surface|process。workspace 行の command はワークスペースのタイトル。process 行の command がプロセス名（`2.1.168`=エージェント本体, `zsh`, `cmux`, `node` 等）。これを集計して per-project / per-agent の RSS とプロセス種別内訳を出す。

## 2. データモデル
- Project（=1 cmux workspace, `description` に `cmuxdash:<id>` タグ）。
  - slots: { cc: on/off, cdx: on/off, yazi: on/off, term: on/off }。各 slot = workspace 内の1 surface（縦並び）。
  - 各 slot の起動コマンド: cc=`claude`(+flags), cdx=`codex`, yazi=`yazi`, term=`$SHELL`(何もせず)。
  - 状態検出: list-pane-surfaces の各 surface の title/直下プロセスから、どの slot が現在 ON かを判定。
- projects.json: プロジェクト定義（id/name/path/color/emoji/有効slot既定/コマンド上書き）。グローバル行(cc-general等)も将来対応。

## 3. バックエンド(Node, 依存ゼロ)
- `cmuxctl` 再設計: workspace/surface 操作 + slot トグル(`ensureSlot(project, slot, on)` = ON:new-surface+send / OFF:close-surface)、状態取得、監視パーサ(`parseTop()`,`parseMemory()`)。
- API:
  - `GET /api/state` → projects[]（各 slot の on/off, workspace ref, 最新活動）+ server health。
  - `POST /api/project/:id/slot/:slot` body{on} → slot トグル。
  - `POST /api/open/:id` / `POST /api/close/:id` / `POST /api/reorder` body{order:[ids]}。
  - `GET /api/metrics` → per-project/per-agent RAM・プロセス内訳（top/memory パース）。
  - `POST /api/projects`(追加) / `DELETE /api/projects/:id`。
- 全 cmux 呼び出し直列化＋リトライ＋失敗の state 記録。

## 4. フロントエンド(単一HTML, リッチ)
- プロジェクト行: `#n [lcl] name  [CC][Cdx][Yazi][Term][Drop]` 各ボタンが slot の on/off をトグル（色で状態表示）。
- ドラッグ並び替え（→ /api/reorder）、追加(＋)/削除。
- Memory パネル（Free/Used バー + per-project RSS）、CC & Codex パネル（per-agent RSS・プロセス内訳・凡例 C/M/X/O）。
- ポーリングで live 更新（監視は cmux ソケットに触るので直列キュー経由）。
- usedhonda 版の見た目（ダークUI、コンパクト）を参考に。

## 5. フェーズ分割（各フェーズ codex 実装＋テスト、claude 検証）
- **R1 コア**: データモデル＋cmuxctl 再設計＋slot トグル(CC/Cdx/Yazi/Term)＋open/close＋安定サーバー(foreground前提)＋基本UI（行とトグルボタン）。test.sh 刷新。
- **R2 監視**: top/memory パーサ＋/api/metrics＋Memory/CC&Codex パネル。
- **R3 リッチ操作**: ドラッグ並び替え・追加削除・自動サイズ・UI仕上げ（usedhonda 見た目に寄せる）。
- **R4 仕上げ**: グローバル行(cc-general等)、Workspace YAML、（任意）MIDI 等。

## 6. テスト方針
- 実ファイル/実 read 状態を汚さない一時projects/team。slot トグルは実 cmux で surface 増減を検証。監視パーサは固定 tsv サンプルで単体検証。実 cmux 不健全時は明示スキップ。各フェーズ `./test.sh` 全PASS出力を agmsg 報告。GUI目視は claude。
