# Plan: 誰でも使える「実在プロジェクト自動作成」＋堅牢化（2026-06-09 /loop）

> 起案: claude（オーケストレーター）/ 実装: codex / 検証: claude（実機+独立test.sh）
> 背景: ユーザーが Even custom / evenapp の CC を押すと失敗。実機再現で根本原因確定 =
> `cmuxctl.js:687 normalizeCollabProjectDir()` の `fs.mkdirSync('/projects/evencustom', {recursive:true})`
> が macOS read-only root 配下のため ENOENT。projects.json のパスが書込不可な絶対パスだった。
> ユーザー要件: 「アプリ側で毎回“実在するプロジェクト”を作れるようにし、ターミナルが分からない人でも誰でも使えるようにする」。

## ゴール（このループの完了定義 / claude が独立検証）
非エンジニアが、パスを一切意識せず、ダッシュボードからプロジェクトを作って ON にすると、
そのプロジェクトが **CC(上)/Codex(下) の縦ペア列** として実機で開く。存在しない/不正なパスでも
ENOENT で落ちず、安全な書込可能ディレクトリを **自動作成** する。既存機能・全既存テストを壊さない。

## スコープ（codex 実装）

### R-B 実在プロジェクト自動作成 + 安全パス（最優先）
1. **安全ベースの導入**: 書込可能なプロジェクト・ベースを定義（既定 `~/cmux-projects`、env `CMUX_DASH_PROJECTS_ROOT` で上書き可）。
2. **パス正規化/ガード**: `rowCwd()` 解決後のパスについて、
   - `~` 展開済みパスがユーザーの書込可能領域（home 配下 or 明示の projects root 配下、または既に存在し書込可能なディレクトリ）なら従来通り。
   - それ以外（例: `/projects/...` のような root 直下で作成不可）の場合は、**安全ベース配下 `<projectsRoot>/<id>` に remap**（または明確な friendly エラー。既定は remap で自動前進）。
   - remap した事実は state/action 結果に `remappedFrom`/`remappedTo` として残し、UI が「保存先を ~/cmux-projects/<id> にしました」と表示できるようにする。
3. **自動作成の堅牢化**: ディレクトリ作成は `recursive:true` のまま、**作成失敗時に raw ENOENT を投げず**、安全ベースへフォールバック→再作成。最終的に作れない場合のみ、原因と対処を含む friendly エラー（`どこに作るか`を提示）。
4. **openProject / new-workspace の cwd も同じ解決を通す**（cmux `new-workspace --cwd` に渡る前に必ず実在保証）。
5. **Add-project（UI から新規作成）**: 非エンジニア向けに「名前だけ」でプロジェクトを作れる経路。
   - server に `POST /api/projects`（name, 任意で emoji/color）を追加。`id` は name から正規化、`path` は `<projectsRoot>/<id>` を **自動作成**して projects.json に追記。既存 id と衝突しない。
   - 既存の Add ボタン UI（public/index.html）をこの API に接続（最小実装で可。パス入力欄は任意・既定は自動）。
6. **回帰防止**: 既存 projects（~/projects/... 実在）の挙動は不変。

### R-C 一過性 spawn エラーの再試行（堅牢化）
- `cmuxctl.js:103 isTransient()` の正規表現に **`EAGAIN` と `ENOMEM`** を追加（`err.code` も判定に含める）。
  プロセス上限 spike 時の `spawn ... EAGAIN` / Broken pipe を既存の指数バックオフで再試行する。
- 過剰再試行で固まらないよう既存 `retryBudget` の範囲内に収める（新規 budget は不要）。

## 受入条件（claude 独立検証）
1. `node --check cmuxctl.js` / `node --check server.js` pass。
2. `./test.sh` = **FINAL: PASS（FAIL 0）**。R-B 用ユニット追加:
   - 書込不可な絶対パス（例 `/projects/x`）の project を解決すると安全ベースへ remap され、ディレクトリが実在する。
   - `POST /api/projects` で name から id/path 生成・ディレクトリ作成・projects.json 追記（fixture/temp dir、既存ファイルを汚さない）。
   - 既存 ~/... パスは remap されない（不変）。
   - R-C: `EAGAIN`/`ENOMEM` を持つ擬似エラーで `isTransient()` が true を返す。
3. 既存テスト本数を減らさない（253+ を維持）。
4. claude が実機で: 任意の新規 project を作成→ON→CC/Codex 縦ペア列が出る（browser スクショ）。`/projects/...` 不正パスでも ENOENT にならない。

## 進め方（plan-gate だが自律前進可）
- スコープは既存 vision（PLAN_GRID）と整合し低リスク。**懸念がなければ合意を待たず実装→テストまで実行**し、証跡を agmsg で返す。
- 設計上の blocker（例: projects.json 同時書込の競合、id 正規化規則の衝突）があれば、その点だけ claude に質問して止まる。
- 不可逆操作・外部送信・push はしない（commit までに留め、push は人間確認）。
