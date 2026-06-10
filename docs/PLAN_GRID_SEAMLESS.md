# Plan: grid シームレス化（列を作り直さず増分で追加/削除）2026-06-09 /loop

> 起案: claude / 実装: codex / 検証: claude（実機）
> 背景: 録画(21.25)で「▶開く時に別画面へ遷移して grid に戻る」ガクつき。原因 = addProjectColumn/removeProjectColumn が
> 毎回 rebuildGridWorkspace（grid ws を closeGridWorkspaceIfPresent→new-workspace で作り直す）を呼ぶため、
> teardown 中に cmux のフォーカスが別 ws に飛び、作り直して select-workspace で戻る。さらに既存列の CC/Codex も毎回再起動される。

## ゴール（claude 実機検証）
▶開く で列を足しても **grid ws を作り直さず**、既存 ws に列(CC上/Codex下)が **増分で1本スッと増える**。
画面が切り替わらない（フォーカスが飛ばない）。既存列の CC/Codex は生き残る（再起動しない）。

## スコープ（差分のみ・既存流用）
1. **増分追加** `addProjectColumn`: grid ws が既存なら rebuild せず、既存 ws に `new-pane --direction right`(新列=cc) → `new-pane --direction down`(同列=cdx) を差し込む。surfaceRef は gridfix と同様 **作成時に決定的取得**（before/after pane・surface 差分、createSplitPaneSurface 流用可）。その後各 surface に gridLaunchCommand を send。gridRuntimeState.columns に push。grid ws が無い初回のみ、anchor(browser)+最初の列で ws を新規作成（初回の1回フォーカスは許容）。
2. **増分削除** `removeProjectColumn`: rebuild せず、その列の cc/cdx の surface/pane だけ閉じる（close-surface/close-pane）。最後の1列を消したら grid ws ごと閉じる。
3. validateGridRuntimeState は現状維持（live ref 再検証で stale を落とす）。reindexGridColumns で order 整合。
4. rebuildGridWorkspace は初回作成/全消し等のフォールバックとして残してよいが、通常の add/remove 経路からは外す。

## 受入条件（claude 独立検証）
1. node --check 両ファイル PASS。
2. ./test.sh FINAL: PASS（FAIL 0・既存数維持）。「増分追加で既存列 surfaceRef が保持される」「削除で対象列のみ消える」テスト追加。
3. 実機(claude): 列を1本足す→既存列の surfaceRef が不変（=再起動していない）、新列が増える。フォーカスが grid から飛ばない（select-workspace の bounce が無い）。削除で対象列のみ消え、最後の削除で grid 自動クローズ。
4. 既存 grid API / R-A(▶開く) / R-B / R-C / slot を壊さない。

## 進め方
- 低リスク・既存vision整合。懸念なければ実装→テストまで進め証跡を agmsg で返す。push しない（commitまで）。実機目視は claude。
- blocker（new-pane の列順制御, anchor 左端維持）だけ質問で止まれ。
