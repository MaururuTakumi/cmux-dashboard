# Plan: Phase 2a — プロジェクト別 CLAUDE.md 固定/デフォルト注入

> ステータス: claude 設計 → codex 実装
> 起案: claude (plan層) 2026-06-02
> 関連: [全体構想] vision / [Phase1] docs/PLAN_PHASE1_LAUNCH_FIX.md
> 目的: 「誰でも claude+codex を使いこなせる」よう、各プロジェクトに開発ルール(CLAUDE.md)を自動で用意する。ユーザー要望「claude.md を各プロジェクトで固定」「デフォルトで入れる内容」「自動で agmsg を使って共同開発」への対応。

## 1. ゴール
- プロジェクトを開くと、そのプロジェクトディレクトリに **CLAUDE.md が用意/維持**される。
- 中身はデフォルトで「claude=plan / codex=実装 / agmsg共同開発 / テスト証跡必須 / 安全則」を含む（テンプレ `templates/CLAUDE.md` を claude が用意済み）。
- ユーザーが書いた既存内容は壊さない。

## 2. 設定（projects.json）
`defaults` と各 project の両方で指定可（project が優先）:
```jsonc
"claudeMd": {
  "mode": "managed-block",          // off | create-if-missing | managed-block (既定: managed-block)
  "templatePath": "templates/CLAUDE.md"  // cmux-dashboard ルートからの相対 or 絶対
}
```
未指定時の既定は `mode: "managed-block"`, `templatePath: "templates/CLAUDE.md"`。

## 3. 挙動（openProject の preflight = new-workspace の前に実行）
対象ファイル = `<expandHome(project.path)>/CLAUDE.md`。

- **off**: 何もしない。
- **create-if-missing**:
  - ファイルが無い → テンプレを描画して新規作成。
  - ファイルが有る → 触らない。
- **managed-block**（既定・推奨）:
  - テンプレ内の管理ブロック `<!-- cmux-dashboard:managed:start ... -->` 〜 `<!-- cmux-dashboard:managed:end -->` を「管理対象」とする。
  - ファイルが無い → テンプレ全体（=管理ブロックを含む）で新規作成。
  - ファイルが有り、管理ブロックがある → **そのブロックの中身だけ**を最新テンプレのブロックで置換。ブロック外のユーザー記述は完全保持。
  - ファイルが有り、管理ブロックが無い → 既存内容の**末尾に**管理ブロックを追記（既存は一切上書きしない）。

## 4. テンプレ描画（変数置換）
テンプレ内の `{{PROJECT_NAME}}` `{{TEAM}}` `{{PROJECT_ID}}` を置換する。
- PROJECT_NAME = project.name || project.id
- TEAM = teamName(project.id)（既存の teamName() を使用）
- PROJECT_ID = project.id

## 5. 失敗時の方針
- CLAUDE.md の用意に失敗しても **openProject 自体は止めない**（warn をログ＋ openProject の戻り値に `claudeMd: { ok:false, error }` を含める）。ワークスペース起動を優先。
- 成功時は戻り値に `claudeMd: { ok:true, action: "created"|"updated-block"|"appended-block"|"skipped"|"off" }`。

## 6. 受入条件（テスト証跡なしは差し戻し）
`test.sh` に Phase2a チェックを追加（**実ファイルを汚さないよう一時ディレクトリ/一時 projects.json を使用**。既存の temp 方式を踏襲）:
1. create-if-missing: CLAUDE.md 不在の一時プロジェクト → open 後にファイルが作られ、テンプレ内容（置換済み）を含む。
2. create-if-missing: 既存 CLAUDE.md がある → 内容が変わらない。
3. managed-block: 既存に「ユーザー独自テキスト＋管理ブロック」がある → open 後、ユーザーテキストは保持され、管理ブロック内だけ最新化される。
4. managed-block: 既存にユーザーテキストのみ（管理ブロック無し）→ open 後、ユーザーテキストは残り、末尾に管理ブロックが追記される。
5. off: 何もしない。
6. 変数置換: 生成物に `{{PROJECT_NAME}}` 等の未置換が残らない。
7. 既存の Phase1 33チェックを壊さない。
- `./test.sh` 全PASS出力を agmsg で claude に報告。

## 7. 対象ファイル（目安）
- `cmuxctl.js`（preflight 関数 `ensureClaudeMd(project, cfg)` を追加し openProject から呼ぶ。loadConfig の defaults に claudeMd 既定をマージ）
- `templates/CLAUDE.md`（claude 作成済み。codex は基本いじらない）
- `test.sh`（Phase2a チェック追加）
- 必要なら `public/index.html`（任意: カードに CLAUDE.md 状態を出す。今回は必須ではない）

## 8. スコープ外（後続 Phase2b）
- ダッシュボードに agmsg 会話スレッドを見える化する read-only パネル。
- onboarding ウィザード。
- 今回は CLAUDE.md 機構に集中する。
