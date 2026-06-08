# Vision: usedhonda型エージェント・グリッド（最終形）

> 起案: claude 2026-06-08 / 参考: usedhonda(@usedhonda) の実環境スクショ
> GOAL: cmux 1ワークスペースに、プロジェクトを横列で並べ、各列=CC(上)+Codex(下)の縦ペア。ダッシュボードは小さい側パネル。1画面マルチタスク。

## 最終レイアウト
- cmux 1 workspace。左端に narrow なダッシュボード列(Current Workspace パネル: プロジェクト行+Memory+CC&Codex)。
- その右に、プロジェクトごとの縦列(left-right split)。各列内は CC(上)/Codex(下) の up-down split。
- 列はドラッグ/追加/削除で増減。全部同時に見える。

## 段階
- **Phase 1（実装中）**: 1プロジェクト = CC(上)+Codex(下) 縦split・見える・collab自動連携が実働。slot=縦分割パネル、オフで消える。slot検出/collab active修正。
- **Phase 2**: 複数プロジェクトを【1ワークスペースの横列】に配置(今は project=別workspace)。ダッシュボードを同workspaceの小さい側パネルに。列の追加/削除/並べ替え。
- **Phase 3**: 監視(Memory/CC&Codex)を側パネルで常時更新、切り替えUI、安定性・配布。

## 運用
- /loop 10m で claude が完成まで自律ドライブ(各tick: codex報告を検証→次を発注→STATUS更新)。
- 各プロジェクト collab(claude↔codex pane-delivery)既定ON。暴走防止(プロセスspawnなし・単一・read-only)厳守。
- リソース注意: 多数の agent 列は重い。資源圧迫(fork失敗)時は列数を抑える/警告。

## 不変の安全則(土台)
- サーバーは cmuxペイン内(in-pane)起動・孤児化禁止。collabはpane-delivery(headless spawnしない)。実機検証はclaude。
