# Sprint 1 実装指示書 — T4(#4): grid rebalance 修正＋手動整形トリガー

> 親計画: docs/plans/PLAN_TICKETS_SWEEP.md / Issue: #4 / 担当: codex（実装・テスト）/ 検証: claude(Opus) 実機
> 前提: 着手前に `git status` を確認。cmuxctl.js には**未コミットの暫定パッチ**（係数env化＋killswitch）が既にある。これを土台に積む。

## ゴール
崩れた grid（全列スリバー＋左ブラウザ最大化）から **rebalance が確実に均等列へ収束**し、**列を潰さない**。さらに **UI から1アクションで手動整形**できる。

## 既存コード（確認済みのタッチポイント）
- `cmuxctl.js`
  - `GRID_RESIZE_FALLBACK_PX_PER_AMOUNT`（≈L1206, 暫定で env `CMUX_DASH_GRID_PX_PER_AMOUNT`・既定1.0 に修正済み）
  - `rebalanceGridColumns(wsRef)`（≈L3576, 8パス/tolerance5%/stagnant検出。**冒頭に killswitch `CMUX_DASH_GRID_REBALANCE=off` 追加済み**）
  - `resizeGridBoundary(wsRef, boundaryOrPaneRef, targetRightPx, cellWidthHintPx, opts)`（≈L3488–3568, resize本体。**ここに amount クランプが無いのが残課題**）
  - `rebalanceGridColumnsBestEffort(wsRef)`（≈L3718）/ `rebuildGridSafely(opts)`（≈L4239）
- `server.js`: `POST /api/grid/rebuild`（≈L178）→ `ctl.rebuildGridSafely()`（**手動トリガAPIは既存**）
- `public/index.html`: grid UI（手動整形ボタンが未配線）
- `test.sh`: grid rebalance guard テスト（≈L2074 付近）

## 実装タスク

### 1. amount クランプ（resizeGridBoundary）
- resize 量 `amount`（= 移動px / pxPerAmount）を **cmux が1コマンドで受け付ける上限内にクランプ**する。
- 上限の決め方: ワークスペース実幅（または利用可能な cell 総数）を基準にした安全上限。具体値はハードコードせず定数化＋env 上書き可（例 `CMUX_DASH_GRID_MAX_RESIZE_AMOUNT`、既定は「ws総セル幅の50%」相当などの実装で妥当な値）。
- クランプが発動して1パスで到達できない場合でも、`rebalanceGridColumns` の**複数パスで段階的に詰める**（既存の最大8パス＋stagnant検出と整合させる）。クランプ起因の「動いたが未到達」を stagnant と誤判定して abandoned にしないこと（=実際に動いた距離>0 ならその境界は生存扱い）。
- 戻り値に `clamped: true/false` と `requestedAmount`/`appliedAmount` を含め、後段の calibration とテストで観測可能にする。

### 2. スリバー状態からの収束順序
- 初期が「左 anchor(browser) 最大化＋右側列が全部スリバー」のとき、**まず左 anchor 境界を目標比率（左 ≈18%）へ縮める**ことを優先し、空いた幅を列へ配る順序を保証する。
- anchor 欠落・余剰サーフェス混入でも abandoned で止まらず `repair` 経路（`rebuildGridSafely`）へ落ちること。

### 3. 手動整形トリガを UI に配線
- `public/index.html` の grid セクションに **「⚖️ 今すぐ整形」ボタン**を追加。
- クリックで `POST /api/grid/rebuild` を呼び、結果（`converged` / `passCount` / `clamped` 等）を**トースト/ステータス表示**。
- 失敗時はエラーメッセージを出す（既存の row-status/トースト方式に合わせる）。

### 4. （任意）CLI トリガ
- `cmux-dash` に `rebalance` サブコマンド（`POST /api/grid/rebuild` を叩く薄いラッパ）を追加してもよい。時間が無ければ省略可。

### 5. 回帰テスト（test.sh）
- 既存 grid rebalance guard テストを壊さず、以下を**新規追加**:
  - **係数1.0** が既定で使われること（env 未設定時）。
  - **amount クランプ**: 過大な目標移動量を与えたとき amount が上限にクランプされる（`clamped:true`・`appliedAmount<=上限`）。
  - **スリバー収束**: 全列スリバー＋anchor最大化の初期状態（fake cmux）から rebalance を回し、列がスリバーのまま放棄されず均等方向に動く（少なくとも「列を潰さない＝列幅が増える」方向）こと。
  - **killswitch**: `CMUX_DASH_GRID_REBALANCE=off` で rebalance が `disabled:true` を返し resize を呼ばないこと。
- fake cmux で検証できる範囲を最大化。実比率の最終収束は claude 実機で担保（テストでは「潰さない/クランプ/順序」を保証）。

## 受入基準（このスプリントの DoD）
- [ ] `resizeGridBoundary` に amount クランプ実装、戻り値に clamped/requested/applied
- [ ] スリバー状態から rebalance が列を潰さず収束方向に動く
- [ ] `POST /api/grid/rebuild` を呼ぶ手動整形ボタンが UI にあり、結果表示する
- [ ] 係数1.0・クランプ・killswitch・スリバー収束の**新規テストを test.sh に追加**
- [ ] `./test.sh` 全PASS（既存 283 相当を1つも壊さない）
- [ ] 変更を**ローカルcommit**（push はしない＝人間がまとめて承認）。コミットメッセージに Issue #4 を参照。

## codex への注意
- コードは fake cmux でテストまで完了させ、`./test.sh` の最終 PASS と FAIL=0 を証跡として agmsg で claude に返信。
- 実 cmux での目視（スリバー→1クリック整形）は claude が担当するので、codex は実 cmux 操作を強行しない（健全でない場合は fake にフォールバックし明示）。
- 不明点・設計判断が要る箇所（クランプ上限の具体値など）は、推測で突っ走らず妥当なデフォルト＋env化で実装し、選択理由を返信に明記。
