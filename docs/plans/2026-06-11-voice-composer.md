# 計画: 音声コンポーザー — 送信前に自分の発話テキストを確認できる入力UI
- 作成: 2026-06-11 / 設計・監査: Fable 5 / 実装: codex / 評価: Opus
- 前提仮定（ユーザー確認済みの課題から）: 現在ダッシュボードに音声入力は無く、OS音声入力が直接ペインに入るため「送信後にしか自分の文章が分からない」。本機能はダッシュボード側に確認ステップ付きの音声入力を新設する。
- 実行順: scroll修正 → コンシェルジュS1 → **本件（コンシェルジュS2のUIと統合実装）** → E2E（index.html/server.js/test.sh 競合回避の直列）

## 1. 背景とゴール
受け入れ基準:
1. UI に 🎤 ボタン。**タップで録音開始 → 再タップで終了**。終了した瞬間、認識テキストが**編集可能な textarea に表示**される（自動送信しない）。
2. 録音中は interim（暫定）認識をリアルタイム表示（グレー表示）。
3. ユーザーが内容を確認・編集後、「送信」ボタンで初めて送信。送信先セレクタ: コンシェルジュ（既定）/ 各プロジェクトの CC ペイン。
4. 送信は既存の2段階送信（submitToSurface: 本文→単独\r）経由で確実に投入。
5. Web Speech API 非対応ブラウザでは 🎤 を無効化しツールチップで案内（textarea手入力は常に可能）。
6. ./test.sh FINAL: PASS（静的契約 check 追加）。既存API/exportの変更・削除なし（追加は可）。

## 2. スコープ
- やること: public/index.html に composer UI（🎤/interim表示/textarea/送信先セレクタ/送信）、server.js に `POST /api/send/:projectId`（CCペインへの submitToSurface 公開、defer経由）※コンシェルジュ宛は /api/concierge/ask を流用、test.sh 契約check。
- やらないこと: 音声認識エンジン自作・外部STT API（Web Speech API のみ＝依存ゼロ維持）、TUI側の挙動変更、自動送信。

## 3. 設計判断
- **Web Speech API（webkitSpeechRecognition, lang=ja-JP, interimResults=true, continuous=true）**を採用。Chrome系で動作（ユーザーの閲覧環境）。理由: 依存ゼロ・実装小。却下案: 外部STT（鍵管理・依存）/ MediaRecorder+サーバー認識（過大）。
- **状態機械**: idle →(🎤tap)→ listening（interim をライブ表示・finalは textarea へ追記）→(🎤tap)→ review（textarea 編集可・送信ボタン活性）→(送信)→ sent（toast＋textareaクリア）。エラー（権限拒否/no-speech）は toast＋idle 復帰。
- **送信先ルーティング**: select要素。`concierge`（既定）→ POST /api/concierge/ask。`<projectId>`→ POST /api/send/<projectId>（cc スロット surface へ submitToSurface。スロット未起動なら ensureSlot 後に送信）。
- composer は画面上部固定バー（スクロール位置に依存せず使える）。scroll修正の差分更新と干渉しないよう #grid の外に配置。

## 4. タスク分解
| # | タスク | 担当 | 完了条件 | 依存 |
|---|--------|------|----------|------|
| 0 | 本計画 commit | fable | 済んだら codex へ | - |
| 1 | server: POST /api/send/:projectId（defer, ensureSlot(cc)→submitToSurface）。cmuxctl に薄い公開関数追加(export追加のみ) | codex | ./test.sh PASS | scroll修正後 |
| 2 | UI: composer バー（🎤状態機械/interim/textarea/セレクタ/送信）。コンシェルジュ宛は /api/concierge/ask（コンシェルジュS2と同コミット群で実装可） | codex | 同上＋静的契約check | 1, コンシェルジュS1 |
| 3 | Opus 評価 | Opus | 下記7 | 2 |

## 5. リスク・未決事項
- Web Speech API はネットワーク必須/ブラウザ依存 → 非対応時のフォールバック明示（基準5）。
- cmux 内蔵ブラウザペインでマイク権限が出ない可能性 → その場合「通常の Chrome で dashboard を開く」案内を UI に表示し、必要なら cmux 運営問い合わせ事項として報告。

## 6. codexへの指示文（コピペ可）
「main。docs/plans/2026-06-11-voice-composer.md §3 を実装。対象: server.js(POST /api/send/:projectId)・cmuxctl.js(公開関数の追加のみ・既存export変更禁止)・public/index.html(composerバー: 🎤状態機械 idle/listening/review、webkitSpeechRecognition lang=ja-JP interim表示、textarea編集→送信、送信先select)。自動送信は絶対にしない（録音終了=レビュー状態）。test.sh に静的契約check（🎤要素/recognition生成/review状態で送信ボタン活性/POST /api/send ルート存在）。./test.sh FINAL: PASS→1コミット→agmsg報告」

## 7. Evaluator観点（Opus）
- 静的: 録音終了→自動送信のコードパスが**存在しない**こと（review必須）/ interim と final の分離 / 非対応時無効化 / 既存export・API不変。./test.sh 自走再実行 PASS。
- 動的E2E（実ブラウザ）: 🎤押下→（マイク権限はE2E環境次第。権限不可なら textarea に直接入力で代替し状態機械を検証）→ review状態で textarea に文章が見え編集できる→送信→対象ペインに文面が到達（実機 cmux で確認）→ スクショ証跡。録音終了時点で**送信が発生していない**ことをネットワークログで確認。
