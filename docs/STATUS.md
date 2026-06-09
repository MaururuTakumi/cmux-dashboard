# cmux-dashboard リビルド 進捗（誰でも見られる追跡表）

> 更新: 2026-06-09 / オーケストレーター: claude / 実装: codex（claude-codex-collabブリッジ経由・単一）
> 設計の台帳: docs/PLAN_REBUILD.md ｜ 履歴: `git log --oneline`

## フェーズ進捗
| # | 内容 | 状態 | 検証(test.sh) |
|---|---|---|---|
| R1 | スロットモデル（CC/Cdx/Yazi/Term 個別トグル） | ✅ 完成 | 107 PASS(実cmux) |
| R2 | 監視パネル（Memory + CC&Codex、C/M/X/O分類） | ✅ 完成 | 107 PASS |
| R3 | ドラッグ並び替え・追加削除・usedhonda風コンパクトUI | ✅ 完成 | 119 PASS |
| R4 | グローバル行（cc-general等）＋ Workspace YAML | ✅ 完成 | 126 PASS |
| 修正 | slot起動を**プロジェクトのcwd**で開く + 網羅テスト拡充 | ✅ 完成 | 183 PASS |
| 最終 | 実機（専用ペインでサーバー常駐）で総合GUI確認 | ⏳ 人間の実機確認待ち |

**リビルド R1-R4 全機能完成（2026-06-07）。`./test.sh` = 183 checks PASS（実cmux、claude独立検証済み）。**

## 追跡の仕組み（claudeがどう管理しているか）
- **agmsg(SQLite)**: claude↔codexの全やり取りを記録。`bash ~/.agents/skills/agmsg/scripts/inbox.sh cmux-dashboard claude` で読める。
- **自前ポーラー**: codex返信を即通知（watch.shは死ぬので不使用）。
- **git**: 各フェーズ検証後にコミット（`git log`で到達点が分かる）。
- **./test.sh のチェック数**: フェーズ毎に増加（74→107→119）で実装の積み上げを客観確認。
- **このSTATUS.md**: 人間向けの可視化（ここ）。

## 運用の前提（重要）
- **cmux.app は起動したままに**（落ちると全機能停止。今日何度か落ちていた）。
- 本番サーバーは **専用cmuxペインで `./cmux-dash server`（フォアグラウンド常駐）**。背景起動/launchdは「孤児化」でcmuxに繋がらなくなる。
- codexを動かす仕組みは **claude-codex-collabスキルのブリッジ1本**に統一済み（二重起動の競合は解消）。

## 既知の制約
- codexのヘッドレス実行環境からは実cmuxが届かないことがあり、その場合テストは fake cmux にフォールバック（明示ログ）。実cmuxでの最終確認は claude/人間が担当。

## 安定化（プロダクト化の土台）2026-06-07
| 項目 | 状態 |
|---|---|
| `./cmux-dash up` 一発でcmuxペイン内サーバー起動・cmux ok（孤児化撲滅） | ✅ 実機確認 |
| 自動collab既定OFF＋ブリッジdedup（codex暴走撲滅） | ✅ |
| 回帰 test.sh | ✅ 201 PASS |

**運用の正解**: `./cmux-dash up`（または `server`）で起動。background/launchd起動は孤児化するので不可。cmux.appは起動したままに。

## グリッド化 進捗（2026-06-08, /loop運用）
- Phase1 縦分割UI: codex実装。**スロット検出のroot cause（claude/codexがタイトルを上書きしmarkerが消える）をclaudeが実cmuxで特定→state記録方式(slotRefs)へ修正済み**。直接実機テストで CC on→検出OK / off→除去OK を確認。
- ただし `./test.sh` の実cmux slot-off チェックが**環境過負荷で不安定**（Codex.app/Codex Computer Use/Chrome由来のゾンビ大量発生→fork失敗・cmux操作遅延）。コードは正しいが自動フル検証が timing で揺れる。
- /loop は環境ブロックのため一旦停止。資源を空けてから再開推奨。

## ★ブレークスルー：codex pane を確実に起こせるようになった（2026-06-09）
**セッション全体を止めていた最大の壁＝「サーバーから走行中の codex TUI に `cmux send` しても codex が動かない」を解決。**
- **根本原因**: codex(と claude)の TUI は **bracketed paste** が有効。`cmux send "text\r"` を1回で送ると、末尾の `\r`(Enter)もペーストの一部として input box に飲み込まれ、**送信(submit)されない**。
- **修正**: `cmuxctl.submitToSurface()` を新設。**テキスト本文を送る → 短い間(250ms) → 単独の `\r` を別sendで送る**の2段階。これで codex が注入入力を実行する。collab-delivery はこれを使用。
- **実機検証(✅)**:
  - 手動2段階send → codex が指定ファイルを実際に作成（`TWOSTEP-OK`）。
  - サーバーの delivery loop 経由 → claude→codex の agmsg を送ると **30秒で read_at が立つ**（=codex が起きて `agmsg inbox` を実行・消費した）。**配送機構は実機で動作**。
- 単体テスト: `R6b`(2段階send契約) + 既存`R6`(配送ロジック)すべて PASS。

## ★解決：slot-toggle バグ（Generator/Evaluator ループで完了, 2026-06-09）
**claude(Generator)→codex(Evaluator/実装)→claude(独立検証) のループが実機で完走。**
- claude が plan-gate(`docs/PLAN_SLOT_TOGGLE_FIX.md`)を agmsg で codex に提示 → codex が**実装+テスト+証跡返信** → claude が `./test.sh` を独立再実行して確認。
- **codex が特定した2つの原因**:
  1. **slot 誤検出（cmuxctl）**: 初期 terminal(=workspace の最初の pane)や marker無し surface が、title/process フォールバックで cc/cdx slot と誤判定され得た。→ `isInitialPaneRef` / `explicitOnly` 判定を追加し、**初期pane・marker無しを slot ref として採用/復元しない**よう厳格化（明示marker・記録refの正規経路は維持）。
  2. **テストの surface 計数バグ（test.sh）**: `surface_count_for_workspace` が pane を巡回せず**過少カウント**していた（これが `1→1` の主因）。→ pane ごとに list-pane-surfaces して合算するよう修正。
- **独立検証(✅)**: `./test.sh` = **FINAL: PASS (253 checks)**、exit 0、FAIL 0。`CC slot ON increased surface count (1 -> 2)` / `dedicated split (1 -> 2)` / `OFF decreased (2 -> 1)` / `slot detection ignores unmarked default terminal` / R6b 全 PASS。
- **collab follow-through も実機で確認**: codex は wake→`agmsg inbox`→実装→`./test.sh`→`agmsg send` で完走（返信に数分かかるだけで、最初の「120秒無返信」は作業中だった）。

## ★完成：Phase2 グリッド化 C0-C4（2026-06-09）
**複数プロジェクトを1つの `cmuxdash:__grid__` workspace に横並び表示する usedhonda layout が完了。**
- C0-C4 完了: `/api/grid`、grid列ON/OFF、project action反映、実cmux C2 grid、UI side-panel static contract、最終C4 dashboard anchor を実装済み。
- grid workspace の左端 anchor は dashboard browser surface。起動中サーバーの `CMUX_DASH_PORT`（未指定時7799）から `http://127.0.0.1:PORT` を開き、最初の project column はその右に split される。
- `getGridState()` は live surface refs を再検証し、消えた surface を含む stale column を落とす。
- 検証: `./test.sh` = **FINAL: PASS**（codex環境 272 / claude環境 267。差分は test.sh の C2 real-cmux フェーズが負荷時に health-gate でスキップするため。スキップは pass 扱いで FAIL は 0）。
- **claude による実機直接検証(✅, 2026-06-09)**: 一時projectでグリッドを実cmuxに生成 → **5ペイン = browser anchor 1 + 列2×(cc/cdx terminal 4)**、列順 ga(0)/gb(1) 各 cc+cdx、surface types=[browser, terminal×4]。`remove ga`→gb生存、`remove all`→grid workspace 自動クローズ(wsRef=null)・残骸なし。**browser dashboard anchor が実cmuxで機能することを確認**。
- 既知の軽微課題: test.sh の C2 real-cmux health-gate が負荷時に過敏（スキップしがち）。コードは正しく、claudeの直接実機検証で担保。

## 現状サマリー（2026-06-09）
- ✅ codex pane の確実な起こし方（2段階submit）解決・実機検証・commit/push 済み。
- ✅ slot-toggle バグ解決（Generator/Evaluator ループ）・`./test.sh` 253 PASS・独立検証済み。
- ✅ 自動collab（claude×codex の見える2ペイン交渉）が実機で機能。
- ✅ Phase2 グリッド化 C0-C4 完成（dashboard browser side panel + project columns）・`./test.sh` PASS・claude実機直接検証済み（5ペイン/2列/anchor=browser/add-remove-cleanup）。

## ★完成：誰でも使える化＋grid列の決定的ref修正（2026-06-09 夕, /loop運用）
**ユーザー報告「CCボタンが失敗」→ 根本2件を解消し、理想（実在projectを誰でも作れる＋複数列CC/Codex横タイル並列）を実機達成。**
- **根本原因(確定的)**: even系projectのpathが `/projects/evencustom`（macOS read-only root配下＝作成不可）で、CC押下時 `normalizeCollabProjectDir` の mkdir が ENOENT。
- **R-B 実在project自動作成（誰でも使える）**: `CMUX_DASH_PROJECTS_ROOT`(既定~/projects)導入。作成不可/書込不可な絶対パスを `<root>/<id>` へ remap+mkdir する resolver を rowCwd/openProject/ensureSlot/ensureCollab/ensureClaudeMd/addProject に接続。addProjectのmkdir握り潰し廃止。→ `POST /api/projects` 名前のみで `~/projects/<id>` 自動作成を実機確認。commit ed9b1c6。
- **R-C spike耐性**: `isTransient()` に EAGAIN/ENOMEM 追加（プロセス上限スパイク時の一過性失敗を再試行）。commit ed9b1c6。
- **grid列ref決定的化**: `rebuildGridWorkspace` が cc/cdx を marker(端末タイトル)再検出で解決→exec claude/codexがタイトル上書きでmarker消失→「did not create cc surface」で列追加失敗していた。素のterminalペアを作りlist-panes順序からsurfaceRefを確定してからlaunch送信する方式へ（slot同思想）。commit b300ad3。
- **検証**: `./test.sh` 独立再実行 FINAL: PASS (283 checks, FAIL 0)。実機: grid 2列→anchor(browser)+各列CC(✳Claude Code)/Codex の5ペイン、タイトル上書き下でも columns=2 cc/cdx確定、1列削除→残存、全削除→自動クローズ。
- **運用メモ**: サーバーは新コード反映に `./cmux-dash restart`（専用 __server__ ペイン内・孤児化なし）。.server.pid が古いと stop が空振るので現リスナーPIDに更新してから restart。push は人間確認のため保留中（commit 2本ローカル）。
