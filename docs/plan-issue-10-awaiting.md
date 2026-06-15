# Plan — issue #10: per-pane awaiting 検知 → /api/state（#9 dashboard slice）

Status: AGREED (Plan Gate 合意 2026-06-15, codex GO-with-changes ＋実機 fixture 採取済み) → S1 実装可
Owner(plan): claude / Owner(exec): codex
Branch: `feat/issue-10-awaiting-detection`

## スコープ
grid 各ペイン（cc/cdx/concierge）が「承認待ち/入力待ち」かを検知し、`/api/state` の per-surface に `awaiting: 'approval'|'input'|null` を機械可読公開する。openclaw/Telegram/issue起票は #9 に残す（OUT）。

## 確定設計（codex レビュー反映）

### 取得
- `readSurfaceScreen(wsRef, ref, {lines})` = `cmux read-screen --surface <ref> --lines <n>`（必要なら `--workspace <wsRef>`）。**no-throw / 失敗 null**。
- **fast-fail 必須**: timeout 短め・retry 0〜低回数。既存 cmux() の通常 retry/budget には乗せない（/api/state が詰まる）。
- **可視範囲のみ**（scrollback を広く読まない）。`--lines` は小さく（~40）、露出/コスト最小化。
- **TTL cache + single-flight 必須**: key=`wsRef+surfaceRef`、TTL 1500–2500ms、`lines=40`。**null も短TTLで cache**（失敗連打回避）。同一 surface の同時読みは1回に dedupe。stale を真値扱いしすぎない（TTL短め＋必要なら `awaitingReadAt` 等メタ）。過負荷時は `awaiting=null` に倒す。
- **対象 surface は live grid の cc/cdx/concierge のみ**（`gridRuntimeState`/`getGridState`）。anchor/browser/orphans/通常 project workspace は読まない。

### 分類（role-aware・誤検知回避最優先）
- **cc / concierge = Claude**: approval ＋ input を判定。
- **cdx = Codex**: 初期は idle/input のみ（Claude 固有文言は適用しない）。codex は `--dangerously-bypass-approvals` で承認が出ないため approval は初期スコープ外。
- **判定順序**: approval を先に判定 → 次に input → どちらでもなければ null。busy/thinking は null。

#### approval（cc/concierge のみ・全条件 AND）
直近40行内に **(a) Claude承認文脈** ＋ **(b) 番号付き選択肢** ＋ **(c) 肯定選択肢** が共起する時のみ `approval`：
- (a) 文脈: `Do you want to proceed?` / `Do you want to make this edit` / `permission` / `tool use` 等。
- (b) 番号付き: `❯ 1. Yes` / `1. Yes` / `1) Yes`。
- (c) 肯定 + 否定の存在: `2. Yes, and don't ask again…` / `3. No, and tell Claude…` / `Allow` / `Approve`。
- **禁止**: generic な `yes` 単独、`Do you want` 単独、ログ中の `approval` 単語だけ、で approval 判定しない。

実機採取した正例（claude tool 承認 UI、標準形）:
```
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for <…> in <dir>
  3. No, and tell Claude what to do differently (esc)
```

#### input（cc/concierge/cdx）
idle 入力待ちのみ。実機採取した正例（claude 入力ボックス・thinking でない状態）:
```
─────────────────────────────
❯
─────────────────────────────
  ⏵⏵ auto mode on (shift+tab · …)
```
- 罫線 `───` に挟まれた `❯ `（空入力）＋ `auto mode on` / `? for shortcuts` フッタ。番号付き選択肢が無いこと（approval と区別）。

#### null（busy/thinking・負例）
- `✳ … (thinking)` / `Gesticulating…` / `esc to interrupt` 等の稼働中表示 → null。
- 通常出力・ビルド/ストリーミング中・ログ中の `Yes`/`Do you want`/`approval` 単語のみ → null。

### 公開
- `getProjectState`（cmuxctl.js:2214–2225 付近）の per-surface object に `awaiting` を追加（grid 対象のみ。非対象は null/未設定で後方互換）。grid columns 各 slot surface ＋ concierge に付与。

## S1 実装（codex）
上記の readSurfaceScreen（fast-fail＋TTL/single-flight）＋ classifyAwaiting（role-aware）＋ getProjectState への awaiting 付与。

## S2 テスト（test.sh・既存を壊さない）
fake cmux に `read-screen` スタブ追加（surfaceRef ごとに screen text を state JSON で注入＋呼び出し回数カウント）。検証:
- positive: approval（cc/concierge）/ input。
- negative: 通常出力・ログ中 `Yes`/`Do you want`/`approval` 単語 → null。thinking → null。
- failure: read-screen 失敗 → 当該 awaiting=null、**/api/state 全体は壊れない**。
- scope: read-screen 対象が grid cc/cdx/concierge のみ（anchor/browser/project を読まない）。
- cache/perf: 同一 surface 同時読みは1回 dedupe、TTL内再利用、TTL後再読込、連続 getState で read-screen 回数が増えすぎない。
- role: cdx に Claude approval パターンを適用しない（cdx の approval-like テキストでも approval にしない）。

## 受け入れ基準（issue #10）
1. read-screen 経由で grid 各ペインの awaiting を /api/state に公開。
2. approval 注入→`approval`、input→`input`、通常→null を自動テストで検証。
3. 誤検知に保守的（負例で approval を出さない）。
4. 既存 ./test.sh を壊さない（baseline=push後の main 同等、無関係 R6 のみ赤）。

## ガードレール
- 機密非送信。grid 限定。生セッション非干渉（read-screen は読み取りのみ・send しない）。
