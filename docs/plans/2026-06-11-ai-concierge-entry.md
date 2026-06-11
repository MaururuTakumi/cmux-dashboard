# 計画: AI窓口（コンシェルジュ）— プロジェクト作成の入口を必ずAI対話にする
- 作成: 2026-06-11 / 設計・監査: Fable 5（メイン） / 実装: codex / 評価: Opus
- 前提: grid 幅修正(resize)・スクロール修正(docs/plans/2026-06-11-fix-scroll-reset.md)の**後に**直列実行（cmuxctl.js / test.sh / index.html の競合回避）

## 1. 背景とゴール
ユーザー要望: 「プロジェクトを作りたい」と思ったとき、まず**AIとチャット**して（どんなプロジェクトを・どのフォルダに・何の目的で）を決め、その対話の結果として grid に CC/Codex 縦ペア列が開く。grid 最左で Claude Code とチャットでき、その Claude Code が作業（登録・起動）を実行する。

**設計の核**: チャットUIを自作しない。**Claude Code 本体を「コンシェルジュ」ペインとして grid 最左領域に常駐**させる。Claude Code は Bash を使えるため、対話で要件を確定したら dashboard の既存 HTTP API を自分で叩いて登録・列起動まで実行できる。dashboard 側の追加実装は「コンシェルジュペインの常駐管理」と「UIボタン→キックオフ文の注入」のみ。

受け入れ基準:
1. grid を開くと最左領域に「dashboard ブラウザ(上)＋コンシェルジュ Claude Code(下)」の縦ペアが常駐する（既存の列・右アンカーの幾何を壊さない）。
2. UI の「🤖 AIで新規プロジェクト」ボタン → grid にフォーカスし、コンシェルジュへキックオフ文が**自動投入**される（既存 submitToSurface の2段階送信方式）。
3. コンシェルジュは briefing（templates/CONCIERGE.md）に従い、対話→`POST /api/projects`（登録）→`POST /api/grid/column/<id> {on:true}`（列起動）を実行できる（briefing に curl チートシート同梱）。
4. コンシェルジュペインが死んでいたら ensure 経路で復活する（既存 slot repair と同思想）。
5. `./test.sh` FINAL: PASS（check数維持＋本機能 check 追加）。既存 grid/列/スロット/collab の挙動・API・export・env 不変。
6. Opus 評価合格: 静的照合＋実機メカニクスE2E（下記7）。

## 2. スコープ
- やること: cmuxctl.js（grid layout への concierge 常駐・ensure・ref追跡・キックオフ注入関数）、server.js（`POST /api/concierge/ask`）、public/index.html（ボタン）、templates/CONCIERGE.md（briefing）、test.sh（fake checks）。
- やらないこと: Web チャットUIの自作、LLM API 直接呼び出し、既存「＋追加」フォームの削除（残す。AI窓口は推奨入口として追加）、対話内容そのものの品質保証（それは Claude Code の仕事）。

## 3. 設計判断
- **A. レイアウト**: 既存 `gridMainAreaLayout` の browser 葉を「vertical split: browser(上, 既定0.5) + concierge terminal(下)」に変更。concierge は GRID 列とは別管理（gridRuntimeState.concierge = {surfaceRef,paneRef}）。右アンカー・列のロジックは触らない。
- **B. 起動**: concierge surface には `claude` を、cwd=`CMUX_DASH_PROJECTS_ROOT`、briefing は起動コマンドで `claude --append-system-prompt "$(cat templates/CONCIERGE.md)"` 方式ではなく**既存 slotLaunchText/gridLaunchCommand と同様の marker+コマンド注入方式**で（claude CLI のフラグ依存を避ける）。briefing は初回キックオフ文に「まず templates/CONCIERGE.md を読め（絶対パス同梱）」を含めて読ませる。
- **C. キックオフ注入**: `conciergeAsk(text)` を cmuxctl に追加。ensureGrid → ensureConcierge → `submitToSurface(conciergeSurface, kickoffText)`。kickoffText = ユーザー文 + 「CONCIERGE.md のプロトコルに従え」。
- **D. CONCIERGE.md の内容**: 役割（プロジェクト作成の窓口）/ 質問プロトコル（名前・フォルダ（既定: PROJECTS_ROOT 配下）・目的・絵文字/色は任意）/ 確定後の実行手順（curl で POST /api/projects → POST /api/grid/column/<id>）/ 安全則（既存ディレクトリ破壊禁止・登録前に要約して人間の Yes を取る）。
- 却下案: Web チャットUI + API キー管理（依存・複雑性過大）/ 専用 cc-general 流用（窓口専用 briefing と cwd が必要なため分離）。

## 4. タスク分解
| # | タスク | 担当 | 完了条件 | 依存 |
|---|--------|------|----------|------|
| 0 | 本計画 commit | fable | 計画書がブランチに存在 | - |
| 1 | cmuxctl: concierge 常駐(A/B)＋conciergeAsk(C)＋ensure/repair。test.sh fake check | codex | ./test.sh FINAL: PASS | 0 |
| 2 | server: POST /api/concierge/ask。UI: 「🤖 AIで新規プロジェクト」ボタン（モーダルで一言入力→API→grid focus）。templates/CONCIERGE.md(D)。test.sh check | codex | 同上 | 1 |
| 3 | Opus 評価（静的＋実機メカニクス）。不合格は差し戻しループ | Opus | 下記7合格 | 2 |
| 4 | claude 実機目視＋人間へのデモ報告。push は人間確認後 | claude | 実機で対話→列が立つ | 3 |

## 5. リスク・未決事項
- concierge が API を叩く際のサーバーURL: `http://localhost:7799`（CMUX_DASH_PORT 反映）を CONCIERGE.md 生成時に埋め込む。
- grid layout 変更は幅修正(resize)実装と同じ関数群に触る → **resize 完了後に着手**（直列）。
- ユーザー環境で claude CLI が無い場合: 既存 doctor と同様に concierge ペインへ案内文を出すのみ（落とさない）。

## 6. codexへの指示文（コピペ可）
Sprint 1: 「main。docs/plans/2026-06-11-ai-concierge-entry.md §3 A/B/C を cmuxctl.js に実装。grid 最左を browser+concierge 縦ペア化、gridRuntimeState.concierge で ref 管理、ensure/repair、conciergeAsk(text) 追加(export)。既存列・右アンカー・API・export(追加はOK/変更削除NG)・env 不変。test.sh に fake check（grid 作成で concierge surface が出来る/conciergeAsk が submitToSurface 相当の send を発行）。./test.sh FINAL: PASS まで実行し1コミット、agmsg 報告」
Sprint 2: 「main。server.js に POST /api/concierge/ask {text}（defer 経由, label 'concierge:ask'）。index.html に主ボタン『🤖 AIで新規プロジェクト』→ 一言入力→ API → /api/grid/focus。templates/CONCIERGE.md を §3 D の内容で作成（curl チートシート・PORT埋め込み・安全則）。test.sh に API/UI 静的契約 check。FINAL: PASS→1コミット→agmsg 報告」

## 7. Evaluator観点（Opus）
- **静的照合**: §3 A〜D との一致 / 既存 export・API・env の不変 / 凍結領域(bridge/swift/app/bin)未接触 / ./test.sh 自走再実行で PASS。
- **動的メカニクスE2E（実機 cmux）**:
  1. grid を空から開く → list-panes で最左領域が browser(上)+terminal(下) の縦ペア、右アンカー・全高列の幾何不変。
  2. `POST /api/concierge/ask {"text":"テスト用プロジェクトを作りたい"}` → concierge ペインにキックオフ文が表示される（list-pane-surfaces/スクショ証跡）。
  3. 列を1本追加しても concierge と browser の幾何が崩れない。
  4. （人間対話そのものは評価対象外。メカニクスのみ）
- 不合格→具体的差し戻し指示で codex へ（Fable 経由）。合格まで反復。
