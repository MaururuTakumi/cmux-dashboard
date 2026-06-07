# Master Plan: cmux-dashboard プロダクト化（OSS公開）

> ステータス: claude 設計 → codex 実装（段階）
> 起案: claude 2026-06-07
> GOAL: 誰でも DL → `./cmux-dash up` で動く OSS プロダクトにする。
> 前提: 土台（in-paneサーバー/collab既定OFF/監視/slot）は安定化済み。

## 段階
- **P1 OSSハイジーン（公開の最低条件・最優先）**
- **P2 オンボーディング強化**（依存チェック完備＋ワンコマンド導入）
- **P3 配布パッケージ**（Swift Macアプリ署名・配布手順）
- **P4 公開準備**（最終チェック・docs・push）

---

## P1: OSSハイジーン
公開しても個人情報が漏れず、誰でも動かせる状態にする。

1. **LICENSE 追加**: MIT（既定）。著作権表記は "cmux-dashboard contributors"（年 2026）。
2. **個人 projects.json を分離**:
   - `projects.example.json` を新規作成（プレースホルダ 1〜2件＋global cc-general 1件、パスは `~/projects/sample-app` 等の汎用例、emoji/color付き、defaults は現行の slot/agmsg/claudeMd/collab=false 等を継承）。
   - `.gitignore` に `projects.json` を追加し、`git rm --cached projects.json` で**追跡から外す**（ローカルの実ファイルは残す）。
   - cmuxctl `loadConfig`: `projects.json` が無ければ `projects.example.json` をコピーして作る（初回起動が動くように）。
   - ※git履歴には過去の個人projects.jsonが残る点は、公開直前に claude が squash/fresh-init で対処（P4）。今回はトラッキング除外＋exampleまで。
3. **README.md を OSS 品質に**:
   - 何か（cmux上で「1プロジェクト=上からCC/Cdx/Yazi/Term」を並べ、claude↔codex協業もできるダッシュボード）。スクショ参照（docs/screenshot.png があれば）。
   - 必要要件: cmux(.app), Node, （任意 yazi, claude, codex）。
   - クイックスタート: `git clone` → `cd cmux-dashboard` → `./cmux-dash up`（cmuxペイン内起動・孤児化しない旨）。
   - 使い方: slotトグル / 監視パネル / 並び替え・追加削除 / 自動collab（既定OFF・ONの仕方）。
   - 既知の制約: cmux.appは起動したままに。background/launchd起動は孤児化で不可。
   - 日本語＋英語（最低限、英語のクイックスタートを併記）。
4. **個人情報/secretの除去確認**: トラッキング対象ファイルに絶対パスの個人情報・APIキー等が無いか点検（projects.json以外）。`.server.log` 等ランタイムは既に gitignore 済みを確認。

### P1 受入条件（テスト証跡なしは差し戻し）
- `projects.json` 削除状態で `loadConfig` が `projects.example.json` から復元する契約をテスト。
- `projects.example.json` が valid JSON で slot/global を含む契約。
- `.gitignore` に projects.json、git で untracked になっている（`git ls-files` に出ない）。
- LICENSE / README 存在と必須セクションの契約（簡易）。
- 既存 test.sh(201) を壊さない。
- `./test.sh` 全PASS＋チェック数を報告。

### P1 対象ファイル
- `LICENSE`（新規, MIT）
- `projects.example.json`（新規）
- `.gitignore`（projects.json 追加）
- `cmuxctl.js`（loadConfig の example フォールバック）
- `README.md`（刷新）
- `test.sh`（P1 契約テスト）

---

## P2: オンボーディング強化（後続）
- `/api/doctor` を yazi 含む全依存（cmux/node/yazi/claude/codex）で完備、未導入時の導線（brew install yazi 等）。
- 初回ウィザードの実用化（依存チェック→最初のプロジェクト追加→起動）。
- `install.sh`（依存チェック＋初回セットアップのワンコマンド）。

## P3: 配布（後続）
- Swift Macアプリ再ビルド（build-app.sh）＋ad-hoc署名。Developer-ID署名/notarizeは Apple Developer アカウント要（the maintainer確認後）。

## P4: 公開（後続）
- 公開直前に git 履歴の個人情報を一掃（squash or fresh-init）。
- LICENSE/README/docs最終チェック。GitHub へ push（リポジトリ名・公開可否はthe maintainer判断）。
