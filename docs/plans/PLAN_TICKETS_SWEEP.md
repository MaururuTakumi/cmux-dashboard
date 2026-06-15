# Plan: cmux-dashboard Issue #1–#5 全消化（チケットスイープ）

> ステータス: **claude(Opus) 設計 → codex レビュー待ち（Plan Gate）→ 合意後に実装**
> 起案: claude(Opus) 2026-06-14
> 体制: Opus=計画/レビュー/最終ジャッジ・実機ブラウザ確認 / codex=実装・テスト・E2E / Opusサブエージェント=評価
> GOAL: GitHub Issue #1–#5 を1つずつ実装・検証し、cmux-dashboard を「完成」状態にする。
> 連携: agmsg（team=`cmux-dashboard`）。push は人間確認ゲート。

## ユーザー確定事項（2026-06-14）
- **T2**: 選択肢 **B（setup専用に縮小）** — headless ブリッジ削除、`collab.sh init` だけ残す。
- **T5**: **フル実装** — 列ごとのコンテキスト率＋死活＋コスト（直近/セッション/週次）＋予算。
- **着手順**: **基盤→可視化** = **T4 → T1 → T3 → T5 → T2**。

## 実装契約（全スプリント共通）
1. 1スプリント=1チケット。codex は agmsg で wake → `docs/plans/PLAN_TICKETS_SWEEP.md` と本文を読む → 該当スプリントのみ実装 → `./test.sh` 全PASS → agmsg で証跡返信。
2. **既存テスト（最新 283 checks 相当）を1つも壊さない**。各スプリントで新規チェックを追加。
3. **破壊的操作は人間確認**: `git push`、外部送信、削除、本番書き込み。ローカル commit は各スプリント完了時に可（push は保留してまとめて人間承認）。
4. 不明点・スコープ衝突・合意外作業に気づいたら、推測せず claude に blocker 報告して停止。
5. 実機検証（実 cmux / ブラウザ）は claude(Opus) が担当。codex は fake cmux フォールバックでの単体・統合テストまで。
6. cmux が Broken pipe で不調なときは、実機検証前に cmux.app 再起動で土台を安定化（T4/T5備考）。

---

## スプリント1 — T4(#4): grid rebalance 修正＋手動整形トリガー

**なぜ最初か**: グリッドが崩れると他チケットの実機検証（T1/T3/T5）が詰まる。土台。

### 現状（調査済み）
- `cmuxctl.js:1206` `GRID_RESIZE_FALLBACK_PX_PER_AMOUNT` は既に**実測値 1.0**（暫定パッチ適用済み・**未コミット**）。env `CMUX_DASH_GRID_PX_PER_AMOUNT` 上書き可。
- `rebalanceGridColumns()`（`cmuxctl.js:3570`）: 8パス・tolerance 5%・stagnant検出・pxPerAmount学習あり。**だがクランプなし** → 過大 amount を cmux が無効化し、stagnant→abandoned で列を潰す根本症状が残る。
- `resizeGridBoundary()`（`cmuxctl.js:3488`）: resize 本体。
- 手動トリガ API **`POST /api/grid/rebuild`** は既存（`server.js:178` → `rebuildGridSafely()` `cmuxctl.js:4239`）。UI ボタンは未配線。

### やること
1. **未コミット暫定パッチを確定**: 係数 0.5→1.0、キルスイッチ `CMUX_DASH_GRID_REBALANCE=off` をコードとして整理・コミット対象に。
2. **amount クランプ**: `resizeGridBoundary()` で算出 amount を cmux 許容範囲内にクランプ（上限を画面実幅ベースで設定、例: 列幅×係数の安全上限）。過大算出時は分割パスで段階移動。divergence が大きいほど 1 パスで動かしきらず複数パスに分配。
3. **スリバー収束**: 全列スリバー＋左ブロック最大化の初期状態から、まず左 anchor（browser）を目標比率（左18%）へ確実に縮める順序を保証してから列を均等化。anchor 欠落・余剰サーフェス混入でも abandoned で止まらず repair 経路へ。
4. **手動トリガ UI**: ダッシュボードに「⚖️ 今すぐ整形」ボタンを追加 → `POST /api/grid/rebuild` を呼ぶ。結果（converged/passCount）をトースト表示。
5. **CLI**: `cmux-dash` に `rebalance` サブコマンド（API 叩く薄いラッパ）を任意で追加。

### 受入基準
- [ ] スリバー状態から手動トリガ1回で均等列に収束（実 cmux / claude 実機確認）
- [ ] 自動 rebalance が列を潰さない（**回帰テスト**を test.sh に追加）
- [ ] UI から1アクションで整形を呼べる
- [ ] 係数1.0・クランプ・キルスイッチを test.sh に反映
- [ ] `./test.sh` 全PASS（既存283 + 新規）

### リスク
- 実 cmux の resize 挙動はディスプレイ依存（pxPerAmount は学習で吸収）。fake cmux ではクランプ境界値とパス分配ロジックを単体検証、実比率収束は claude 実機で担保。

---

## スプリント2 — T1(#1): collab 既定自動セットアップの「完了」

**位置づけ**: 設計合意9項目（PLAN_COLLAB_DEFAULT.md §合意条件）は**コード上ほぼ実装済み**。本スプリントは**実機 E2E 検証で穴を塞ぎ「整わないことがある」を消す**こと。

### 現状（調査済み・9項目すべて実装根拠あり）
- `projects.json` `defaults.collab=true`、`openProject()`→`ensureCollabSlots()` で cc/cdx 自動作成、`ensureCollab()` は setup-only（`collab.sh init --no-start`＋残存 bridge stop）、`collab-delivery.js` が read-only DB 監視・固定 wake 文・HWM/dedup/rate-limit・single in-flight・marker優先特定・`collab.active=pane-delivery-active` を実装。

### やること
1. **E2E 再現テスト（claude 実機）**: 新規プロジェクトを開く→手動設定ゼロで claude↔codex が双方向 agmsg→「人間→CC→`agmsg send codex`→サーバーが Cdx ペイン投入→codex 反応→返信」が通るか。**「整わない」具体ケースを再現**して原因特定。
2. **想定される穴の補修**（再現結果次第で codex 実装）:
   - `$agmsg`（引数なし）が各ペインで正しい team/FROM の inbox を出すこと（CC既定FROM=claude / Cdx既定FROM=codex）。シェル側のエイリアス/環境（config.env の FROM 既定）がペイン起動時に確実に入るか検証・修正。
   - collab.active の判定タイミング（slot 起動直後に active=false のままデリバリが回らない隙間がないか）。
   - 残存 headless bridge / 旧プロセスの確実な停止（runaway 再発ゼロ）。
3. `.collab-disabled` マーカーの扱いを整理（既定ONと矛盾しないこと）。

### 受入基準
- [ ] 新規列を開く→手動設定なしで claude↔codex が agmsg 双方向（claude 実機）
- [ ] `$agmsg` 単体実行でそのペインの team/FROM inbox が出る
- [ ] headless codex を spawn しない（`ps` で runaway なし確認）
- [ ] 既存 collab デリバリ単体テスト（R5/R6/R6b）PASS＋穴補修分の新規テスト
- [ ] `./test.sh` 全PASS

### リスク
- 「整わない」が環境依存（cmux Broken pipe 等）の可能性。再現できない場合は**観測ログを仕込んで条件を記録**し、確実な再現手順を残してからクローズ判断（推測でクローズしない）。

---

## スプリント3 — T3(#3): 可観測性（CC→codex指示の表示＋安定追跡ID）

**依存**: T1 完了後（collab が確実に動く前提で「何が投げられたか」を見せる）。

### 現状（調査済み）
- agmsg 本文読み取り API **`/api/agmsg/:id?since=&limit=`** 既存（`getTeamMessages()` `cmuxctl.js:648`）。
- 安定 marker（`cmuxdash:slot:cdx` / grid列 `cmuxdash:grid:__grid__:column:<pid>:slot:<slot>`）既存 → PID 非依存の追跡 ID 素材あり。
- プロセス分類は command 文字列の PID ベース（`classifyProcess()` `cmuxctl.js:513`）。

### やること（※下記「要確認」を反映してから実装）
1. **UI: 列ごとの CC→Cdx 指示タイムライン**: 各列/プロジェクト行に、`to=codex` メッセージ（と `to=claude` の返信）を時系列ペア表示。`/api/agmsg` をポーリング（既存 since/limit 利用）。MVP は「直近の CC 指示＋Cdx 返信」を1アクション以内で表示。
2. **安定追跡 ID**: 列の同一性を **PID ではなく `team+role`（例 `cmux-dashboard:codex`）＋ surface marker** で表現。`/api/state`・`/api/grid` の列に `stableId` を付与し、再起動・複数プロセスでも UI 上で継続。PID は診断補助としてのみ表示。
3. **死活との連動**: surface marker が live かで「この列の codex が生きているか」を判定（T5 の死活と共通基盤化）。

### 要確認（Issue が明示的にユーザー補足を求めている — 実装前に回答が必要）
- **「PID が違う」のは具体的にどの場面か**（サーバー/cmux 再起動後？ codex が複数立つ？ どの画面で気づく？）
- **見たい粒度**（最新1件だけ / 全履歴 / UI上 / ターミナル）
- → MVP は「UI上・列ごと・直近指示＋返信ペア」で設計するが、回答で詳細確定。

### 受入基準
- [ ] どの列でも「CC が Cdx に出した最新の指示」が UI で1アクション以内に見える
- [ ] プロセスが入れ替わっても追跡 ID（stableId）が継続
- [ ] `/api/agmsg` ポーリングが既存負荷を悪化させない（rate/limit）
- [ ] `./test.sh` 全PASS（stableId 付与・抽出ロジックの単体テスト追加）

---

## スプリント4 — T5(#5): statusline メトリクス（フル実装）

**最大の新規実装**。データ源は ccsl と同じ = Claude Code statusline stdin JSON ＋ transcript(jsonl) ＋ usage。

### 現状（調査済み）
- transcript/usage 読み取りは**未実装**。`getMetrics()`（`cmuxctl.js:1845`）は memory/top の RSS/CPU のみ。`/api/metrics`・`.metrics-panel` UI は既存。

### 方式（確定: フル実装 / 統合方式 C = Node 移植を主、ライセンス確認）
- ccsl（参照 OSS: usedhonda/statusline, Python/PyPI `ccsl`）の**コスト/コンテキスト算出ロジックを参考に Node 実装**（pip 依存を増やさない）。ライセンスを確認し「参考実装」に留める（コード流用時は LICENSE 準拠）。
- データ源: 各ペインの Claude Code セッションの transcript jsonl と usage を**ダッシュボードが直接読み**、列ごとに算出。パスは環境変数で上書き可能に。
- **モデル価格/従量（Fable 5 メーター課金, Opus/Sonnet/Haiku）は claude-api リファレンスで最新値を確認**してから単価表を実装（codex は実装時に claude-api スキルを参照）。

### やること
1. **メトリクス算出モジュール（Node）**: transcript jsonl をパースして (a) コンテキストウィンドウ使用率%（1M 対応・キャッシュ率・80%黄/90%赤閾値）、(b) 直近ターン/5hセッション/週次のトークン・コスト・Ext（従量）、(c) 予算消費（週次リミット）を算出。
2. **死活判定**: surface marker live + プロセス存在で agent 死活（死＝赤）。T3 の stableId 基盤と共有。
3. **API**: `GET /api/grid/metrics`（列ごと）＋ 既存 `/api/metrics` 拡張。列に `{contextPct, cache, cost:{turn,session,week}, budget, alive}` を返す。
4. **UI**: 各列に (a) コンテキスト使用率バー（黄/赤閾値）、(b) 直近/セッション/週次コスト＆予算、(c) 死活バッジ（死＝赤）、(d) スパークライン（5h/週次, 任意）。
5. **段階リリース内でも**: まず列ごとコンテキスト率＋死活を動かし、続けてコスト/週次/スパークラインを積む（フル完了まで本スプリント内）。

### 受入基準
- [ ] 各列で claude/codex のコンテキスト使用率(%)が見える
- [ ] 各列の直近コスト＆週次予算消費が見える（Fable/Opus）
- [ ] agent 死活が列ごとに分かる（死＝赤警告）
- [ ] スパークライン（5h/週次）表示
- [ ] transcript/usage パス・単価が環境変数で設定可能、未取得時は graceful degrade（バー非表示等で落ちない）
- [ ] `./test.sh` 全PASS（算出ロジックを固定 fixture jsonl で単体テスト）

### リスク
- transcript/usage の実フォーマットは要実機確認（サンプル jsonl を1本取得して fixture 化）。価格は変動するので単価表は1箇所に集約＋環境変数上書き。

---

## スプリント5 — T2(#2): スキルを setup 専用に縮小（B）

**最後**: T1 でダッシュボード側 collab が確実に動くことを確認した上で、重複するスキルを畳む。

### やること
1. `/claude-codex-collab` スキルから **headless ブリッジ（暴走原因）を削除/無効化**。`collab.sh init`（team＋CLAUDE.md セットアップ）と `status`/`stop`/`update` の最小限だけ残す。
2. `SKILL.md` を「setup 専用・headless bridge は非推奨/削除」に更新。ダッシュボードはこの init を idempotent に呼ぶ（T1 で既にそうなっている）旨を明記。
3. 移行ドキュメント: ブリッジ利用していた箇所（cmux-dashboard 側はもう使っていない）を確認し、ドキュメント更新。`.claude-codex-collab/` の残存 bridge 状態をクリーンアップ。
4. README / docs の関連記述を更新。

### 受入基準
- [ ] スキルが setup 専用に縮小され、headless bridge を起動しない
- [ ] SKILL.md・README・関連 docs 更新
- [ ] ダッシュボードの collab（T1）が引き続き動く（回帰確認）
- [ ] `./test.sh` 全PASS

### リスク
- スキルは cmux-dashboard リポジトリ外（`~/.claude/skills/claude-codex-collab`）。**スキル本体の変更は別リポジトリ/別場所**なので、変更範囲と影響を明示して人間確認の上で実施。

---

## 完了の定義（ダッシュボード「完成」）
- Issue #1–#5 すべて受入基準を満たし GitHub でクローズ。
- `./test.sh` 全PASS（既存を壊さず新規追加）。
- claude(Opus) による実機検証（grid 整形・collab E2E・可観測性 UI・statusline 表示）。
- Opus サブエージェント評価でプラン照合 PASS。
- ローカル commit を積み、**push は人間（たくみん）確認後にまとめて**。

## オープンな確認事項（実装前に解消したい）
1. T3「PID が違う」の具体場面と見たい粒度（上記スプリント3「要確認」）。
2. T2 スキル本体変更（リポジトリ外）の実施可否・タイミングの人間承認。
3. push のタイミング（各スプリント毎 / 全部終わってまとめて）。
