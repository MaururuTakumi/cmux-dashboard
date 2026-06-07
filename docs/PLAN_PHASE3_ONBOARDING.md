# Plan: Phase 3 — Onboarding（初回起動ウィザード / 依存チェック）

> ステータス: claude 設計 → codex 実装
> 起案: claude (plan層) 2026-06-02
> 関連: vision / Phase2a,2b
> 目的: OSS公開前提。初めて触る人が、依存を確認し、最初の1プロジェクトを作り、2ペイン+agmsgモデルを理解して動かせるまでを、ダッシュボード内で導く。

## 1. ゴール
- 初回起動（プロジェクト未登録）時に**ウィザード**が出る。
- 依存（cmux / node / agmsg / claude / codex）の有無を**自動チェック**し、足りないものは導線（インストールコマンド/URL）を出す。
- 最初の1プロジェクト作成までガイドし、claude=plan/codex=実装+agmsgモデルを短く説明。

## 2. バックエンド: 依存チェック
### 2.1 `GET /api/doctor`（read-only）
各依存の状態を返す。返り値:
```json
{ "checks": [
  { "name":"node",   "ok":true,  "detail":"v22.x", "fixHint":null },
  { "name":"cmux",   "ok":true,  "detail":"reachable (ping ok)", "fixHint":"https://cmux.com" },
  { "name":"agmsg",  "ok":true,  "detail":"installed", "fixHint":"bash <(curl -fsSL https://raw.githubusercontent.com/fujibee/agmsg/main/setup.sh) --cmd agmsg" },
  { "name":"claude", "ok":true,  "detail":"/path/to/claude", "fixHint":"https://claude.com/claude-code" },
  { "name":"codex",  "ok":false, "detail":"not found in PATH", "fixHint":"<codex install hint>" },
  { "name":"app",    "ok":true,  "detail":"/Applications/cmux Dashboard.app", "fixHint":"./install-app.sh" }
],
  "allOk": false }
```
判定方法（cmuxctl.js に `doctor()` 追加）:
- node: `process.version`。常に ok。
- cmux: 既存 CMUX 解決 bin が存在し、`cmux ping` が通れば ok（ping は1回・既存の堅牢retry経由 cmux()。落ちても doctor は落とさず ok:false + detail にエラー要約）。
- agmsg: 既存 `agmsgAvailable()`（join.sh 存在）。
- claude: PATH/既知パスから claude bin を解決（`which claude` 相当 or 候補パス firstExisting）。
- codex: 同様に codex bin 解決（CODEX_BIN/PATH/候補）。
- app: `/Applications/cmux Dashboard.app` の存在。
- fixHint は固定文字列でよい（上記）。
- **read-only**。cmux ping 以外に副作用なし。doctor 全体は try/catch で必ず JSON を返す。

## 3. フロントエンド: ウィザード（index.html）
- 表示条件: `state.projects.length === 0`（初回） または ヘッダの「?ヘルプ/セットアップ」ボタン押下で再表示。
- ステップ:
  1. **依存チェック**: `/api/doctor` を呼び、各項目を ✓/✗ で表示。✗ には fixHint（コマンドはコピー可能なコード表示、URLはリンク）。「再チェック」ボタン。
  2. **モデル説明**: 「上=claude(plan/指示) / 下=codex(実装)、人間はclaudeに話す、agmsgで自動連携」を3〜4行 + 簡単な図。
  3. **最初のプロジェクト作成**: 既存の追加フォーム（POST /api/projects）を流用。name/path 入力 →作成。
  4. **完了**: 「作ったプロジェクトの『起動』を押そう」。閉じる。
- ウィザードは overlay/modal。閉じても「?」ボタンでいつでも再表示可能。
- 依存が ✗ でも先に進めること自体は禁止しない（情報提供が目的）。ただし allOk=false の時は注意表示。

## 4. 受入条件（テスト証跡なしは差し戻し）
`test.sh` に Phase3 チェック追加（既存47を壊さない）:
1. `GET /api/doctor` が checks 配列（name/ok/detail/fixHint）と allOk を返す。node は ok:true。
2. 依存欠如のシミュレーション: codex/claude bin を見つからない状態（PATH/環境を細工 or 候補パス上書き）にして doctor を呼ぶと、その項目が ok:false + fixHint 付きで返る。doctor は落ちない。
3. cmux ping 失敗時でも doctor が 5xx で落ちず ok:false + detail を返す（実cmux不健全 or fake で確認できる範囲）。
4. UI: projects 0件時にウィザードが表示される静的契約 / 「?」で再表示できる契約（既存の静的UI契約テストに倣う）。
- `./test.sh` 全PASS出力を agmsg で claude に報告。
- ブラウザ目視は claude 担当（codexは目視不要、APIとUI静的契約まで）。

## 5. 対象ファイル（目安）
- `cmuxctl.js`（`doctor()` 追加、codex/claude bin 解決ヘルパ）
- `server.js`（`GET /api/doctor`）
- `public/index.html`（ウィザード overlay + 「?」ボタン + 再チェック）
- `test.sh`（Phase3 チェック）

## 6. スコープ外（後続 Phase4）
- ネイティブ Swift 殻。
- 署名・notarize・配布。
