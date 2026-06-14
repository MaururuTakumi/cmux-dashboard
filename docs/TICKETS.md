# cmux-dashboard チケット（バックログ）

> 起票: 2026-06-14 / 起票者: claude（たくみんの口頭メモを整理）
> 関連台帳: [docs/PLAN_COLLAB_DEFAULT.md](./PLAN_COLLAB_DEFAULT.md), [docs/STATUS.md](./STATUS.md)
> ※ 文中「CC」=Claude Code（上ペイン・計画）、「Cdx」=codex（下ペイン・実装）

---

## T1: claude+codex 列を開いたら agmsg collab を既定で自動セットアップする

- **GitHub**: [#1](https://github.com/MaururuTakumi/cmux-dashboard/issues/1)
- **種別**: 機能 / **優先**: 高 / **関連**: PLAN_COLLAB_DEFAULT.md

### 現状の不満
グリッド列（上=claude / 下=codex）を開いても、agmsg の collab 連携（互いに send / inbox できる状態、`$agmsg` の既定 FROM）が自動で整わないことがある。結局あとから手動で `/agmsg` 設定が要る。

### あるべき姿
列を開いた時点で、手動設定ゼロで以下が成立していること:
- 両ペインが同じ team（= project 名）に join 済み
- `$agmsg`（引数なし）が、そのペインの正しい team・正しい FROM で inbox を見る
- claude の FROM 既定 = `claude`、codex の FROM 既定 = `codex`（`$agmsg send <相手>` がデフォルトで正しく飛ぶ）
- 人間が CC に話す → CC が `agmsg send codex` → サーバーが Cdx ペインに投入、までが既定で動く

### 備考
PLAN_COLLAB_DEFAULT.md が方式を設計済み（collab 既定 ON＋サーバーからの in-pane `cmux send` デリバリ。headless ブリッジは使わない＝過去の codex 17プロセス暴走を回避）。本チケットはその実装/完了を指す。

### 受入基準
- 新規列を開く → 手動設定なしで claude↔codex が agmsg で双方向にやり取りできる
- `$agmsg` 単体実行で、そのペインの team/FROM の inbox が出る
- headless codex を spawn しない（runaway 再発なし）

---

## T2: `/claude-codex-collab` スキルの去就を決める（破棄 or setup 専用に縮小）

- **GitHub**: [#2](https://github.com/MaururuTakumi/cmux-dashboard/issues/2)
- **種別**: 設計判断 / **優先**: 中 / **関連**: PLAN_COLLAB_DEFAULT.md, T1

### 論点
ダッシュボードが collab を既定で自動セットアップ（T1）するなら、独立スキル `/claude-codex-collab` は役割が重複する。どう畳むかを決める。

### 選択肢
- **A. 破棄**: 機能を完全にダッシュボード側へ移管し、スキルは deprecated に。
- **B. setup 専用に縮小（推し）**: `collab.sh init`（team＋CLAUDE.md のセットアップ）だけ残し、headless ブリッジ（暴走の原因）は削除。ダッシュボードはこの init を idempotent に呼ぶ。PLAN_COLLAB_DEFAULT.md の前提（init だけ流用）と整合的。
- **C. 非ダッシュボード用途に存続**: cmux/ダッシュボード外でも claude+codex collab を使うケース用に残す。

### 決めること
- どの選択肢を採るか
- 破棄/縮小する場合の移行手順・ドキュメント更新・スキル定義（SKILL.md）の扱い

---

## T3: CC→codex の指示が見えない / PID がブレて追跡できない（可観測性）

- **GitHub**: [#3](https://github.com/MaururuTakumi/cmux-dashboard/issues/3)
- **種別**: 機能（可観測性） / **優先**: 高

### 症状（たくみん報告）
- 時々 **PID が違う**（プロセスの同一性がブレる：再起動後・複数 codex プロセスが立つ 等）
- 結局 **CC が Cdx にどんな指示を出しているのか分からない** ことがあり、とても気になる

### 背景
STATUS.md では agmsg(SQLite) に claude↔codex の全やり取りが記録され `inbox.sh` で読める建付け。だが実運用では「今この列の CC が Cdx に何を投げたか」が即座に見えず、PID 同一性が崩れて追えない。

### あるべき姿（案）
- ダッシュボード UI（列ごと）に **CC→Cdx の指示メッセージを時系列でリアルタイム表示**（agmsg の to=codex を抽出）
- プロセス同一性を **PID ではなく安定 ID（surface marker / team+role）** で追跡 → 再起動・複数プロセスでもブレない
- 「直近に CC が出した指示」「Cdx の返信」をペアで見せる

### 要たくみん補足（曖昧なので確認したい）
- 「PID が違う」のは具体的にどの場面？（サーバー/cmux 再起動後？ codex が複数立つ？ どの画面で気づく？）
- 見たい粒度は？（最新1件だけ / 全履歴 / UI 上 / ターミナル）

### 受入基準
- どの列でも「CC が Cdx に出した最新の指示」が UI で1アクション以内に見える
- プロセスが入れ替わっても追跡 ID が継続する

---

## T4: グリッドのサイズ整形（rebalance）を確実に動くよう修正＋手動整形トリガー追加

- **GitHub**: [#4](https://github.com/MaururuTakumi/cmux-dashboard/issues/4)
- **種別**: バグ修正＋機能 / **優先**: 高 / **関連コード**: `cmuxctl.js`（`GRID_RESIZE_FALLBACK_PX_PER_AMOUNT` / `rebalanceGridColumns` / `resizeGridBoundary`）

### 背景（実際に起きた不具合）
自動 rebalance が、崩れた状態（全列スリバー＋左ブロック最大化）から収束できず、毎回ブラウザを全幅近くに膨らませて列を潰す。

### 根本原因
初回キャリブレーション係数 `GRID_RESIZE_FALLBACK_PX_PER_AMOUNT = 0.5` が実測（約1.0）の半分 → 移動量を倍算出（2265px に amount≈4530）→ cmux が過大として無効化 → 境界が「動かない」と放棄 → 列だけ潰れる。

### 暫定対応（このセッション、未コミット）
- 係数を `1.0` に修正（env `CMUX_DASH_GRID_PX_PER_AMOUNT` で上書き可）
- rebalance 無効化キルスイッチ `CMUX_DASH_GRID_REBALANCE=off` 追加
- 手動 `cmux resize-pane` で均等化し安定確認済み

### あるべき姿
- スリバー状態からでも均等に収束
- アンカー欠落・余剰サーフェスでも破綻しない
- **「今すぐ整形」手動トリガー**（UI ボタン or API/CLI）
- 大 divergence 時は amount を cmux 許容内にクランプ

### 受入基準
- [ ] スリバー状態から手動トリガー1回で均等列に収束
- [ ] 自動 rebalance が列を潰さない（回帰テスト）
- [ ] 整形機能を UI から1アクションで呼べる
- [ ] 係数修正を test.sh に反映

---

## T5: ccsl(usedhonda/statusline) の要素を取り込む — 列ごとのコンテキスト使用率・コスト/予算・agent死活

- **GitHub**: [#5](https://github.com/MaururuTakumi/cmux-dashboard/issues/5)
- **種別**: 機能 / **優先**: 中〜高 / **関連**: T3（可観測性）, Opus/Fable 節約志向
- **参照OSS**: https://github.com/usedhonda/statusline （`ccsl` / Claude Code 用ステータスライン）

### 取り込みたい要素
- 列ごと（claude/codex）の**コンテキスト使用率バー**（あと何%で圧縮されるか）
- 最新ターン/セッション/週次の**コスト＆予算**（Fable/Opus 従量・週次リミット）
- **agent 死活警告**（死んだ列を赤表示）
- スパークライン（任意）

### 統合方式（検討）
- A. transcript jsonl/usage をダッシュボードが直接読み Node で算出 ／ B. `ccsl` をサブプロセス実行 ／ C. ロジックを Node 移植

### 受入基準
- [ ] 各列で claude/codex のコンテキスト使用率(%)が見える
- [ ] 各列の直近コスト＆週次予算消費が見える
- [ ] agent 死活が列ごとに分かる

---

### 備考（起票時の状況）
- 起票時、cmux が断続的に Broken pipe を起こす不調状態で、ダッシュボード経由のグリッド操作が詰まりやすい。T1/T3 の実装検証前に cmux アプリ再起動で土台を安定させること推奨。
