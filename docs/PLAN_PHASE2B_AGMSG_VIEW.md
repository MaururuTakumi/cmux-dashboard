# Plan: Phase 2b — ダッシュボードに claude↔codex 会話を見える化（read-only）

> ステータス: claude 設計 → codex 実装
> 起案: claude (plan層) 2026-06-02
> 関連: vision / Phase2a docs/PLAN_PHASE2A_CLAUDEMD.md
> 目的: 人間はclaudeとだけ話すが、claude↔codex が agmsg で何をやり取りしているかを**ダッシュボードで見られる**ようにする。「誰でも使いこなせる」ための透明性。今回は **read-only**（送信UIは後続）。

## 1. ゴール
- 各プロジェクト（=agmsgチーム）の **claude↔codex の最近の会話**をダッシュボードで見られる。
- 最新メッセージ・方向(claude→codex / codex→claude)・時刻・本文が分かる。
- ポーリングで自動更新。

## 2. バックエンド
### 2.1 会話取得（cmuxctl.js）
- 新関数 `getTeamMessages(team, { since, limit })` を追加。
  - agmsg DB パスは `~/.agents/skills/agmsg/scripts/lib/storage.sh` の `agmsg_db_path` を **bash で source して取得**（bridge と同じ流儀。ハードコードしない）。
  - SQL: `SELECT id, created_at, from_agent, to_agent, body FROM messages WHERE team=? AND id > since ORDER BY id DESC LIMIT ?`（新しい順に limit 件 → 返す前に昇順へ並べ替え）。
  - **重要: 絶対に read_at を更新しない / inbox.sh を使わない。** read状態は claude の受信ポーラーと bridge の未読検知が依存しているため、閲覧で消費してはいけない。検出は DB read-only のみ。
  - body は転送上限（例: 4000文字）で truncate し `truncated:true` を付ける。
  - team 名は既存 `teamName(id)` で正規化した値を使う。
  - DB 不在・読めない時は空配列＋ `error` を返し、サーバーは落とさない。
- `limit` 既定 50、上限 200。`since` 既定 0。

### 2.2 エンドポイント（server.js）
- `GET /api/agmsg/:id?since=<n>&limit=<n>` を追加（:id はプロジェクトID。内部で teamName 変換）。
  - 返り値: `{ team, messages: [{id, at, from, to, body, truncated}], lastId }`。
  - read-only・副作用なし。`Cache-Control: no-store`。
- 任意: `/api/state` の各 project に「最新メッセージの要約」（最後の1件の from/to/抜粋/時刻）を含めてもよい（カード簡易表示用）。重い全文は専用エンドポイントで取得。

## 3. フロントエンド（public/index.html）
- 各プロジェクトカードに「会話」トグル（または右側パネル）。開くと当該チームのスレッドを表示。
  - メッセージを吹き出し表示: 左=codex→claude / 右=claude→codex（向きが分かること）、時刻、本文。
  - 本文は長いので折りたたみ（クリックで展開）。`truncated` は「…」表示。
  - 新しいものが下、開いている間はポーリングで追記更新（`since=lastId` で増分取得）。
- ポーリングは既存の state ポーリングに相乗りせず、**会話パネルを開いているプロジェクトだけ** `/api/agmsg/:id` を軽くポーリング（例: 3秒）。閉じたら止める。cmuxソケットには触らないのでcmux負荷は増えない。
- 既存の「action中はstateポーリング停止」挙動は維持。

## 4. 受入条件（テスト証跡なしは差し戻し）
`test.sh` に Phase2b チェックを追加（既存39を壊さない）:
1. テスト専用チーム名で `send.sh` で2通（claude→codex, codex→claude）送る → `GET /api/agmsg/<id>` がその2通を正しい from/to/順序で返す。
2. **read_at 非消費**: 取得API呼び出しの前後で、その2通の `read_at` が変化しない（NULLのまま）ことを DB 直読で検証。← 最重要。
3. `limit` が効く（limit=1 で1件）。`since` が効く（since=最初のid で2件目以降のみ）。
4. body truncate: 長文を送って truncated:true と上限長を確認。
5. DB 不在/異常時もサーバーが 5xx で落ちず、空配列＋errorを返す（モック等で確認できる範囲で）。
- `./test.sh` 全PASS出力を agmsg で claude に報告。

## 5. 対象ファイル（目安）
- `cmuxctl.js`（`getTeamMessages` 追加。AGMSG DB read-only 読取）
- `server.js`（`GET /api/agmsg/:id` ルート追加）
- `public/index.html`（会話パネル＋増分ポーリング）
- `test.sh`（Phase2b チェック追加）

## 6. スコープ外（後続）
- 送信UI（人間やclaudeがUIから送る）。今回はread-onlyのみ。
- onboarding ウィザード、Swift殻。
