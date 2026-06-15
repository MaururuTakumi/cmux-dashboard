# Plan — issue #7: grid のカラム幅崩れ／再起動 orphan 化の根本修正

Status: AGREED (Plan Gate 合意済み 2026-06-15 — codex レビュー反映) → S1 実装可
Owner(plan): claude / Owner(exec): codex

## 確定した根本原因（コード確認済み）

- `server.js` は `const ctl = require('./cmuxctl')`。つまり **cmuxctl は server.js プロセス内の常駐モジュール**で、`gridRuntimeState`（`cmuxctl.js:1180`）は in-memory。`/api/restart` と `./cmux-dash up` は node を `process.exit` で落とす → このメモリは揮発し `columns=[]` で再起動する。
- 再起動後の再採用 `buildAdoptedGridColumns`（`cmuxctl.js:2812`）は、`gridRuntimeState.columns` が空なので **タイトルマーカー (`parseGridColumnMarker`) だけ**が頼り。ところがペイン内の claude/codex TUI が端末タイトルを上書きしてマーカーを消す → 全ペインが `unmanaged_grid_terminal` orphan 化。
- **重要な観測**: 再起動するのは node サーバーだけで、**cmux アプリ（multiplexer）は生き続ける**。よって surface（`surface:N`）は node 再起動をまたいで有効なまま。→ surfaceRef↔column の対応をディスクに残して再水和すれば、タイトルに依存せず ref で即再採用できる。
- サイズ崩れは派生症状: orphan 化したペインが `rebalanceGridColumns`（`cmuxctl.js:3594`、認識済み columns のみ対象）の計算から外れ、残りカラムだけで幅計算 → 不均等化。採用が直れば自然に解消する見込み。

## 方向性: A（ディスク永続）を主軸 ＋ B-lite（cwd 補助照合）

issue の推奨どおり A。surfaceRef 生存確認は既存 `validExistingGridColumn`（`cmuxctl.js:2798`、`byRef.has(ccRef)&&byRef.has(cdxRef)`）がそのまま使える。マーカーは不要になる（が後方互換として残す）。

---

## Sprint 1 — 永続化と再水和（コア修正）

1. 定数: `GRID_STATE_FILE = process.env.CMUX_DASH_GRID_STATE_FILE || path.join(__dirname, '.grid-state.json')`。
2. `persistGridRuntimeState()`: 原子的書き込み（tmp に書いて `fs.renameSync`）。内容は
   `{ version:1, wsRef, anchorSurfaceRef, concierge:{surfaceRef,paneRef}, columns:[{projectId,columnId,order,createdAt,cc:{surfaceRef,paneRef,marker},cdx:{surfaceRef,paneRef,marker}}] }`。
   try/catch で **絶対に throw しない**（永続化失敗で本機能を壊さない）。**orphans は永続しない**（再起動後に診断が stale 化するのを避ける）。
3. `hydrateGridRuntimeState()`: モジュール初期化時に 1 度読む。**sync / read-only / no-throw / cmux 呼び出し無し**。version 一致かつ schema 妥当なら `gridRuntimeState.wsRef/anchorSurfaceRef/concierge/columns` を復元。ファイル無し・壊れた JSON・version 不一致・不正 schema は **完全 no-op**。
4. hydrate をモジュール読込時（`gridRuntimeState` 定義の後・top-level）に 1 回呼ぶ。採用は後続 `validateGridRuntimeState`/`getGridState` が行うので server 側 hook は不要。
5. persist の呼び出し箇所（codex レビュー反映）:
   - `validateGridRuntimeState` は **return path 別**に扱う。persist する: ①正常 resync 後の canonical branch、②grid workspace が確実に消えて state をクリアする branch。**persist しない**: `listWorkspaceSurfacesStatus` 失敗等、一時的な cmux 読み取り失敗で既存 state を温存して返す branch（古い/部分 state をディスクに固定すると復旧性が落ちる）。
   - `addProjectColumn` 成功後／`removeProjectColumn`（final-column clear と通常 remove の両方）後／`rebuildGridWorkspace` の direct mutation 後／`ensureGridRightAnchorSurface` で `anchorSurfaceRef` 更新直後。
   - `rebuildGridSafely` は上記へ委譲するので個別 persist 不要。`reindexGridColumns` は order のみなので呼び出し元の canonical persist で足りる。
   - **要確認の単独経路**: `ensureGridWorkspace`/`ensureConciergeSurface`/`focusGridWorkspace`/`conciergeAsk` が wsRef/concierge を更新しうる。原則「必ず後続 validate に流れて canonical persist される」契約とし、流れない単独経路があれば末尾に persist を足す。実装時にこの契約を満たすか確認すること。
6. `.gitignore` に `.grid-state.json` を追加。
7. **buildAdoptedGridColumns の優先順位**: hydrated existing（ref 生存検証済み）が project を覆っている場合はそれを優先し、marker record は **existing が覆っていない project の追加のみ**に使う（同 project への marker 上書きをしない）。今回の marker 消失ケースは existing 優先で正しく再採用される。

受入(S1): 再起動（in-memory 揮発）を模した状態で、タイトル上書き済み・マーカー無しの surfaces に対し、hydrate 済み columns が surfaceRef 生存で再採用 → orphans=0・anchor 非 null。

## Sprint 2 — cwd/pane 補助照合（堅牢化, B-lite）

- hydrate した column の surfaceRef が live でない（byRef miss）が、**当該 project の cwd に一致する未請求の grid 端末 surface**（既存 `surfaceMatchesProjectCwd`、`cmuxctl.js:2005`）が同 slot に存在する場合だけ、その surface に再バインドする。
- ガード: 既に他 column/concierge/anchor が請求済みの surface には絶対バインドしない。cwd だけから新規 column を捏造しない（orphan 誤採用防止）。既知 column の欠けた cc/cdx を埋めるのみ。

## Sprint 3 — 応急修正の取り込み＋幅検証

- 既存の未コミット `ensureGridRightAnchorSurface` ガード緩和（`git diff` 済み・+19/-4）は**正しいので保持**し本対応へ統合。persist が更新後 `anchorSurfaceRef` を確実に拾うこと。
- 採用が直れば rebalance が全 column を対象に均等化（受入 1,3）。残差ドリフトがあれば既存 rebalance 内で調整（新機構は追加しない見込み）。

## ベースライン注記（2026-06-15 独立検証）

issue/docs の「320 PASS」は別環境の値。**本マシンの clean HEAD(4bdd672) ベースラインは ./test.sh フルで FINAL: FAIL (194 checks) = 193 PASS / 1 FAIL**。唯一の失敗は `R6 front-desk env defaults to front-desk/concierge and supports off` で、**grid 差分とは無関係の pre-existing**（claude/別 worktree で確認、早期 abort なし）。
→ 受入「既存テストを壊さない」は **『grid 差分が baseline(194 checks / R6 のみ失敗) に対し新規 failure・check 数減少を起こさない』** と読み替える。R6 は issue #7 スコープ外（別 issue 候補）。

## Sprint 4 — 回帰テスト（test.sh、baseline=194 を壊さない）

既存 fake cmux に `CMUX_FAKE_OVERWRITE_GRID_TITLE=1`（タイトル上書き＝マーカー消失を模擬）が既にある。fake cmux の surface ストアは **node 再起動をまたいで保持**される（実環境と同じ）。各テストは `CMUX_DASH_GRID_STATE_FILE` をテスト tmp 配下に向けて隔離し、**require 前に env を設定**。再起動相当は node 再起動 or `require.cache` を消して fresh require で表現する。`.grid-state.json` が N open 後に columns/anchor/concierge を持つことも確認。生 surface count が再採用前後で不変であることを assert（セッション非殺害の証跡）。

- **R1 再起動再採用**: server+fake cmux を起動 → N=3 カラム open → 均等幅(tolerance 内)・orphans=0 を確認 → `CMUX_FAKE_OVERWRITE_GRID_TITLE=1` を立てて node を再起動（同じ fake cmux ストア＋同じ `.grid-state.json`）→ `GET /api/grid` で「全 N project が columns に・orphans=[]・concierge 検出・anchorSurfaceRef 非 null」。さらに **生 surface が 1 つも閉じられていない**ことを確認。
- **R2 均等幅収束**: N∈{2..6} で open→rebalance→各カラム幅が `GRID_REBALANCE_TOLERANCE` 内で均等。

## ガードレール（厳守）

- `POST /api/grid/rebuild` の `confirm:true` は使わない／提案しない（生 codex を殺す）。
- 稼働中 claude/codex セッションを絶対に殺さない。
- `.grid-state.json` は per-install・gitignore。
- 既存 320 テストを壊さない。

## 確認したい点（codex への質問）

1. persist の呼び出し箇所は上記5点で十分か。open/close/rebuild 以外に columns を直接書き換える経路はあるか（`reindexGridColumns` 呼び出し元など）。
2. hydrate を「モジュール読込時」一括で良いか、それとも server.js 側の起動フックから明示呼び出しすべきか（テスト時の `require` 副作用を避けたい場合）。
3. Sprint 2 の cwd 照合は S1 だけで受入を満たすなら後回し可。要否の判断。
