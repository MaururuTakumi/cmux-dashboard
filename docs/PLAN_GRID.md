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

---

# Phase 2 詳細 plan（Generator=claude 提案 → Evaluator=codex レビュー待ち, 2026-06-09）

## claude が実機で確認した前提（grounded）
- cmux は2Dグリッド可能: `new-pane --direction <left|right|up|down>`（既定 right）。spike で「初期pane → right split（列2）→ down split」= 3ペインの2D配置を実機生成できた。
- ★制約1: `list-panes --json` は **geometry（direction/x/y/width/height）を返さない**（全 null）。→ どのペインがどの列・上下かは **cmuxctl 側の状態(grid model)で管理**するしかない。cmux のレイアウトから逆算できない。
- ★制約2（要 codex 確認）: `new-pane` の split は**対象ペインの指定方法**が要検証。`--pane <ref>` で親を指定して決定的に分割できるか、それとも focus 中ペインのみ分割か。列を順に作るには「次の分割をどのペインから出すか」を制御できる必要がある。

## 方針（破壊しない・段階的）
現行 “project=別workspace” モデルは 253 PASS で安定。**これを壊さず**、別capabilityとして「グリッド」を足す。一気に全面置換しない。

## 受入条件（=完了の定義 / claude が独立検証）
1. 1つの cmux workspace に、選んだ複数プロジェクトが**横列**で同時表示される。各列 = CC(上)/Cdx(下) の縦ペア。
2. 左端に narrow なダッシュボード側パネル（どのプロジェクトをグリッドに出すかの選択/切替）。
3. 列の追加/削除がUIから可能。削除でその列のペアが消える。
4. 既存の per-project モデル＆全既存テストを壊さない。grid のユニット/実cmuxテストを追加。
5. `./test.sh` = **FINAL: PASS (0 FAIL)** を **claude が独立再実行**して確認。実機GUIは claude が Chrome で目視。
6. リソース安全: 列数×(CC+Cdx) は重い。fork圧迫時は列数を抑える/警告（暴走防止・spawnなし・単一・read-only 維持）。

## 段階的チャンク（1tick=1チャンクを codex に発注）
- **C0（今回の plan-gate / 実装前）**: codex がフィージビリティをレビュー。制約2（split対象ペインの指定）を実機で確認し、**grid データモデル**（grid workspace の表現、列順、各列の cc/cdx pane/surface 追跡、既存 getProjectState との共存）を提案。懸念・別案を返す。**この合意までコードを書かない。**
- **C1**: grid データモデル + cmuxctl の最小API（createGridColumn / addProjectColumn / removeColumn）。ユニットテスト（fake cmux）。
- **C2**: 実cmux で「2プロジェクトを横列＋各列CC/Cdx」を生成/破棄するトグル。実cmuxテスト（列数・ペイン数の検証, OFFで減少）。
- **C3**: ダッシュボード側パネル UI（グリッドに出す/外すの選択, 列の追加削除）。/api 拡張。
- **C4**: 監視/切替の仕上げ + STATUS更新 + claude 独立検証 + commit/push。

## codex への C0 指示（plan-gate, 実装前レビュー）
1. 上の制約2を実機確認: `new-pane --pane <ref> --direction right|down` で**親ペインを指定して決定的に**列・上下を作れるか？ focus 依存なら回避策は？
2. grid データモデルを提案（list-panes が geometry を返さない前提で、cmuxctl が列順と各列 cc/cdx を確実に追跡する方法）。
3. 既存 “project=workspace” と grid の**共存設計**（同一 project を両モードで開いた時の状態検出衝突を避ける）。
4. 懸念・リスク・より単純な代替があれば提示。合意できたら C1 へ。
