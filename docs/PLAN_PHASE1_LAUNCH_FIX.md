# Plan: Phase 1 — 起動バグ修正（cmuxソケット Broken pipe 耐性）

> ステータス: claude 診断完了 → codex 実装中
> 起案: claude (plan層) 2026-06-02
> 関連: 全体構想は今後 docs/DESIGN.md にまとめる（Swift殻/CLAUDE.md固定/agmsg標準化/onboarding）

## 1. 症状
ダッシュボードで「起動」を押すと UI は「起動中」のまま、実際に workspace が開かない。

## 2. 根本原因（claude が live server で再現・切り分け済み）
- `.server.log` に `action error open:<id> Error: Failed to write to socket (Broken pipe, errno 32)` が6連続（=全リトライ失敗）で出る。
- 切り分け結果:
  - cmux CLI 単体 / フレッシュな node プロセスからの `openProject` は成功する（workspace 作成を確認）。
  - 環境変数（CMUX_PORT 等）・binary・socket（`~/Library/Application Support/cmux/cmux.sock`）はすべて正常。原因ではない。
  - 長寿命サーバーで `close→即open` や `open-all` 等の連続/高頻度操作をすると、フレッシュ再起動直後のサーバーでも Broken pipe が再発する。
- 結論: **cmux アプリは new-workspace でパネル生成中など "ビジー" な間、ソケットに Broken pipe を返す。** 現状の `cmuxctl.js` のリトライ（`CMUX_RETRIES=6`, backoff 150〜900ms ≒ 合計約3秒）ではこのビジー窓（パネル2枚生成で数秒〜）を耐えきれず open が確定失敗する。
- さらに `server.js` の `defer()` は失敗を `console.error` するだけなので、UI は `queued` のまま=「起動中」で固まる。
- 補足: `closeProject` が `{closed:false}` を返すのに workspace は実在、という現象も観測（list が一過性に取りこぼす疑い）。読み取りも robust 化が要る。

## 3. 修正要件（実装の具体は codex に委任、ただし下記を満たす）
1. **リトライ強化**: 一過性ソケットエラー（broken pipe / EPIPE / errno 32 / ECONNRESET / timeout）に対し、リトライ回数増 + 上限つき指数バックオフ + ジッタで「合計 15〜20 秒程度」耐える。env（`CMUX_DASH_RETRIES` 等）での調整可能性は維持。
2. **自己誘発の衝突緩和**: 重い操作（new-workspace）後に短い settle 待ちを入れる等、連続 socket アクセスの衝突を減らす。
3. **失敗の可視化**: `defer()` で確定失敗したアクションを state に記録し、UI（`public/index.html`）が「起動中」固定をやめて「失敗（再試行）」を表示する。最低でも `getState().lastError` をアクション単位で追えるよう改善。「起動中」がいつまでも残らないこと。
4. **読み取りの堅牢化**: close/list 等の読み取りも一過性失敗に強くする（`closed:false` 誤検知の解消）。

## 4. 受入条件（テスト証跡なしは差し戻し）
1. 既存 `test.sh` の 11 チェックを壊さない。
2. **ストレステスト追加**: `open→close→open` を連続 / `open-all→close-all` を連続で実行し、
   - 全アクションが最終的に success になること
   - workspace が実際に出現/消滅すること
   - `.server.log` に未回復の Broken pipe が残らないこと
   をアサートする。
3. `./test.sh` を実行して全 PASS の出力を agmsg で claude に報告する。

## 5. 対象ファイル（目安）
- `cmuxctl.js`（`run`/`cmux`/リトライ/`closeProject`/`listWorkspaces`）
- `server.js`（`defer` の失敗記録、`/api/state` への反映）
- `public/index.html`（「起動中」固定の解消、失敗表示）
- `test.sh`（ストレステスト追加）
