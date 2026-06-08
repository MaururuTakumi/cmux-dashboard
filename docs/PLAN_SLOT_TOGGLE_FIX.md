# Plan: slot-toggle のサーバー経路バグ修正（Generator=claude → Evaluator=codex）

> ステータス: claude(Generator) 提案 → **codex(Evaluator) レビュー待ち（plan gate）** → 合意後に codex 実装+テスト
> 起案: claude 2026-06-09

## 何を作るか（提案）
`assert_cc_slot_toggle`（test.sh・実cmux・**APIサーバー経由**）が `CC ON で surface 数 1→1` で決定的に FAIL する。これを green にする。

### 確定している切り分け（claude が実機で確認済み）
- 生の `cmux new-pane --type terminal --direction down` は **1→2** で正常（scratch workspace で確認）。
- `ensureSlot(id,'cc',true)` を**直接叩く** node テスト `exerciseSlotCycle` は **PASS**（surface が増える）。
- **APIサーバー経由（POST /api/project/:id/slot/cc {on:true}）だけ** が surface を増やさず、しかも `/api/state` は `cc=on` と報告する。
- → 疑い: サーバーの長寿命プロセスが持つ **in-memory slotRefs が stale**、または `getProjectState` が**初期 terminal を cc と誤検出**して `ensureSlot` が「already on」分岐に入り、`createSplitPaneSurface` を呼ばずに返している（`cmuxctl.js` ensureSlot の `if (state.slots[slot] && state.slotRefs[slot]) return already` 経路）。

### codex への調査・実装の指示（合意後）
1. サーバー経由で CC ON したとき、`ensureSlot` がどの分岐を通るか（already / repair / createSplitPaneSurface）をログor再現で特定する。
2. 初期 terminal surface が cc/codex として**誤検出**されていないか `getProjectState` の slot 判定（title/marker/process）を確認。誤検出なら判定条件を厳格化（空シェルの初期 terminal を slot 扱いしない）。
3. stale slotRefs が原因なら、ON 実行前に記録 ref を live `list-pane-surfaces` で再検証してから already 判定する。
4. 修正は最小差分で。既存の R1–R6/R6b と node `exerciseSlotCycle` を壊さない。

## 成功をどう検証するか（受入条件＝この通りになって初めて完了）
- `./test.sh` が **FINAL: PASS**（`assert_cc_slot_toggle` を含む全チェック green）。実行ログを agmsg で claude に提示。
- 回帰なし: R6b(2段階send) と R6(配送) は引き続き PASS。
- サーバーを再起動した直後・既存projectが開いている状態の**両方**で CC ON→surface が必ず1つ増える（stale 状態でも正しい）ことを実機 or テストで示す。
- 破壊的操作なし。projects.json（個人データ）を汚さない（テストは隔離 project/team）。

## Evaluator(codex) への確認（実装前に必ず）
- この切り分け（サーバー経路のみ失敗＝state検出/stale 起因）に同意するか。別の根本原因の仮説はあるか。
- 受入条件は十分か（抜けている検証観点はないか）。
- 「初期terminalをslot扱いしない」厳格化が、初期terminal再利用を廃止した現仕様（reusableInitialSurface 削除済み）と矛盾しないか。

→ 合意できたら codex が実装+テスト。合意できなければ blocker を claude に返す。
