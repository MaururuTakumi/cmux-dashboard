# 計画: ダッシュボードのスクロール戻りバグ根治＋スクロール挙動テスト
- 作成: 2026-06-11 / 設計・監査: Fable 5（メイン） / 実装: codex / 評価: Opus（実ブラウザE2E）

## 1. 背景とゴール
UI を下にスクロールしても数秒で最上部へ戻る。原因（証拠確定）: `public/index.html` のポーリング（refresh 4s / metrics 5s / agmsg thread 3s）が毎回 `render()` → `$('#grid').innerHTML = renderProjectRows(s)+renderMetricsPanels()`（:834）で**コンテナ全体を innerHTML 再構築**するため。スクロール位置・`<details>`(詳細) 開閉・選択状態が定期的に破壊される。

受け入れ基準:
1. ページを下までスクロール→**3ポーリング周期(≥12s)放置してもスクロール位置が維持**される（±24px以内）。
2. 「詳細」を開いた状態がポーリングを跨いで維持される。
3. 行の追加/削除/状態変化（CC on/off 等）は従来どおり画面へ反映される（機能後退なし）。
4. `./test.sh` FINAL: PASS（check数 286 以上維持＋スクロール契約 check 追加）。
5. **Opus 実ブラウザE2E 合格**（下記7）。E2E が合格するまで codex へ差し戻しループ。

## 2. スコープ
- やること: `public/index.html`（inline script）の描画方式の差分更新化＋スクロールガード、test.sh への静的契約 check 追加。
- やらないこと: フレームワーク/依存導入（zero-dep 維持）、サーバーAPI変更、デザイン変更、cmuxctl への変更。

## 3. 設計判断（この方式で実装する）
**A. キー付き差分更新（主対策）**
- プロジェクト行: 各行を `data-row-id="<projectId>"` のキー付きノードにし、`renderProjectRows` を「行ごとの HTML を生成→**その行のシリアライズ結果が前回と同じなら DOM を触らない**、変わった行だけ `row.outerHTML` 差し替え、無くなった行は remove、新規行は正しい位置へ insert」に変更。順序変更は appendChild の再配置で対応。
- メトリクスパネル: 同様に `data-panel-id` ＋ パネル単位の前回HTML比較で変更時のみ差し替え。
- `#grid` コンテナ自体への `innerHTML =` 代入は**ポーリング経路から排除**（初期化時のみ可）。
- 実装は素の JS ヘルパ `syncKeyedChildren(container, items, keyFn, htmlFn, cache)` を1つ書く（依存ゼロ）。

**B. スクロールガード（保険）**
- `render()` 冒頭で `window.scrollY`（および `#grid` がスクロールコンテナの場合はその scrollTop）を保存し、描画後に値が**減って（上に飛んで）いたら**復元。ユーザーの意図的スクロールを上書きしないよう「描画前後で位置が変わった場合のみ」復元する。

**C. 開閉状態の保持**
- 差し替え対象行に `<details open>` があれば、差し替え後も open を引き継ぐ（差し替え前に open な data-row-id 集合を収集→適用）。A により「変わっていない行」はそもそも DOM が触られないため、通常は自然に保持される。

却下案: morphdom 等のライブラリ（依存導入禁止）/ iframe 分割（過剰）/ scroll 復元のみで全面再描画継続（details が壊れたまま・ちらつき残存のため不採用。Bはあくまで保険）。

## 4. タスク分解
| # | タスク | 担当 | 完了条件(テスト/証跡) | 依存 |
|---|--------|------|----------------------|------|
| 0 | 計画書（本書）＋契約定義 | fable | 本書 commit | - |
| 1 | A+B+C を public/index.html に実装、test.sh に静的契約 check 追加 | codex | ./test.sh FINAL: PASS (≥286+追加分) | 0 |
| 2 | 実ブラウザE2E評価（合格まで1↔2ループ） | Opus | 下記7の全シナリオ合格・スクショ証跡 | 1 |
| 3 | main へ commit（push は人間確認後） | claude | E2E合格後 | 2 |

## 5. リスク・未決事項
- 行差し替え時に当該行内の入力中フォーカスが失われる → 行が「変わった時だけ」差し替える設計で頻度を最小化（許容）。
- grid 幅修正タスク(resize)と test.sh が競合しうる → **resize codex の完了を待ってから Sprint 1 を投入**（直列化）。
- こちらの実ブラウザE2Eで合格しても**ユーザー環境で再現する場合**: 環境依存（cmux 埋め込みブラウザ等）の可能性が高い → cmux 運営への問い合わせ案件としてユーザーへ報告する（本計画の終了条件の一つ）。

## 6. codexへの指示文（コピペ可）
「main ブランチ。public/index.html と test.sh のみ変更。計画書 docs/plans/2026-06-11-fix-scroll-reset.md の §3 A/B/C をそのまま実装。`#grid` への innerHTML 代入をポーリング経路から排除し、syncKeyedChildren による行/パネル単位の差分更新へ。test.sh に静的契約 check（`data-row-id` の存在 / render が syncKeyedChildren を呼ぶ / ポーリング経路に `$('#grid').innerHTML` が無い / スクロールガード関数の存在と呼び出し）を追加。node --check は対象外(HTML)のため inline script 検査は既存の方式に従う。./test.sh FINAL: PASS まで実行し、1コミットして agmsg で報告。」

## 7. Evaluator観点（Opusが評価する基準）
- **静的照合**: 差分が §3 A/B/C と一致（コンテナ innerHTML 代入がポーリング経路に残っていないこと、キー付き差分更新の実装、ガードが「上方向ジャンプ時のみ復元」であること）。test.sh check 追加を確認し ./test.sh を自走再実行。
- **動的E2E（実ブラウザ・claude-in-chrome。各ステップでスクショ証跡）**:
  1. `http://localhost:7799` を開く（行が少なければ一時 projects 追加 API で 8 行以上にして縦に長くする）。
  2. ページ最下部へスクロール → `window.scrollY` を記録 → **15秒待機** → scrollY が初期値±24px 以内であること（複数ポーリングを跨いで維持）。
  3. 任意の行の「詳細」を開く → 10秒待機 → open のままであること。
  4. 機能後退なし: 行のボタン類が描画され、/api/state の変化（例: 1行 close）で画面が追従する。
  5. consoleにレンダー起因の例外が無い。
- 不合格なら: 具体的な再現手順＋期待/実際を添えて codex へ差し戻し（Fable経由）。**全シナリオ合格まで Sprint 1↔2 を繰り返す。**
