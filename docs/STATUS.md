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
- 残: test.sh slot-off を timing 耐性化、collab pane-delivery 実機反応確認、Phase2(複数列+側パネル)。
