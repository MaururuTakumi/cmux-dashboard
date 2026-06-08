# cmux-dashboard リビルド 進捗（誰でも見られる追跡表）

> 更新: 2026-06-07 / オーケストレーター: claude / 実装: codex（claude-codex-collabブリッジ経由・単一）
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

## 既知の未解決（次に codex へ plan-gate で依頼）
- **slot-toggle のサーバー経路バグ**: `assert_cc_slot_toggle`(実cmux・**APIサーバー経由**)が `CC ON で surface数 1→1`（増えない）で **決定的に FAIL**。
  - 切り分け済み: 生の `cmux new-pane --direction down` は 1→2 で正常。`ensureSlot` 直叩きの node テスト(`exerciseSlotCycle`)も PASS。**サーバー経路/状態検出だけ**が surface を増やさず cc=on と判定している疑い（stale slotRefs か初期terminalの誤検出）。
  - 役割分担に従い、claudeが仕様＋受入(=このテストをgreen)を定義し **codex が実装+テスト** する。
- 残: 上記 slot バグ修正、collab follow-through（codex が inbox読了後に実装+返信まで完走するかの実機確認）、Phase2(複数列+側パネル)。
