# Sprint 2–5 実装指示書（確定部分＋保留TODO）

> 親計画: docs/plans/PLAN_TICKETS_SWEEP.md / 担当: codex 実装・claude(Opus) 検証
> 方針: 各スプリント着手の直前に claude が「保留TODO」を解消（実機E2E結果・ユーザー補足・実フォーマット確認）してから codex へ投入する。
> 着手順: S2(T1) → S3(T3) → S4(T5) → S5(T2)

---

## Sprint 2 — T1(#1): collab 既定自動セットアップの「完了」

### 既存（実装済みと判明）
合意9項目（PLAN_COLLAB_DEFAULT.md §合意条件）はコード上ほぼ実装済み:
`projects.json defaults.collab=true` / `openProject()→ensureCollabSlots()`（cc/cdx自動作成, cmuxctl.js≈L4544-4555）/ `ensureCollab()` setup-only（≈L1047）/ `collab-delivery.js`（read-only DB監視 L72-94, HWM/dedup/rate-limit, marker優先 L188-215, active=pane-delivery）/ `/api/state` に collab{enabled,active,running,mode}。

### このスプリントの本質
新規実装ではなく **実機E2Eで「たまに整わない」を再現→原因特定→穴埋め**。

### 確定タスク
1. `$agmsg`（引数なし）が各ペインで正しい team/FROM の inbox を出すこと。CC既定FROM=claude / Cdx既定FROM=codex。ペイン起動時に config.env の FROM 既定がシェル環境へ確実に入るか検証・修正。
2. collab.active 判定の隙間（slot起動直後 active=false でデリバリが回らない時間帯）を塞ぐ。
3. 残存 headless bridge / 旧プロセスの確実停止（runaway 再発ゼロを `ps` で確認）。
4. `.collab-disabled` マーカーと「既定ON」の矛盾を解消。

### 保留TODO（claude が着手前に解消）
- ⏳ **実機E2E再現**: cmux 復活後、claude が「新規列を開く→双方向agmsg→人間→CC→`agmsg send codex`→Cdxペイン投入→codex反応→返信」を実走し、「整わない」具体ケースを記録。再現結果でタスク2-4の優先度が決まる。

### 受入基準
- [ ] 新規列を開く→手動設定なしで claude↔codex 双方向（claude実機）
- [ ] `$agmsg` 単体でそのペインの team/FROM inbox が出る
- [ ] headless codex を spawn しない（runaway なし）
- [ ] 既存 collab テスト(R5/R6/R6b)PASS＋穴埋め分の新規テスト / `./test.sh` 全PASS
- [ ] ローカルcommit（push除く）

---

## Sprint 3 — T3(#3): 可観測性（CC→codex 指示表示＋安定追跡ID）

### 既存
agmsg本文API `/api/agmsg/:id?since=&limit=`（getTeamMessages cmuxctl.js≈L648）/ 安定marker（`cmuxdash:slot:cdx`, grid列marker）/ プロセス分類は PID ベース（classifyProcess ≈L513）。

### 確定タスク
1. **UI: 列ごと CC→Cdx 指示タイムライン**: 各列/行に `to=codex` の指示と `to=claude` の返信を時系列ペア表示。`/api/agmsg` をポーリング（since/limit 利用, rate制限）。MVP=「直近のCC指示＋Cdx返信」を1アクション以内。
2. **安定追跡ID**: 列の同一性を PID でなく `team+role`（例 `cmux-dashboard:codex`）＋surface marker で表現。`/api/state`・`/api/grid` の列に `stableId` を付与。PID は診断補助表示のみ。
3. **死活連動**: surface marker の live 判定で「この列の codex が生きているか」。T5(S4) の死活と共通基盤化。

### 保留TODO（claude が着手前に確定）
- ⏳ **ユーザー補足が必要**（Issue が明示）: 「PIDが違う/追えない」のは具体的にどの場面か（サーバー/cmux再起動後 / codex複数起動 / 気づく画面）／見たい粒度（最新1件 / 全履歴 / UI / ターミナル）。回答で UI 粒度を確定。MVP は「UI・列ごと・直近ペア」で先行設計可。

### 受入基準
- [ ] どの列でも「CCがCdxに出した最新指示」が UI で1アクション以内
- [ ] プロセス入替でも stableId 継続
- [ ] `/api/agmsg` ポーリングが既存負荷を悪化させない
- [ ] stableId 付与・抽出の単体テスト追加 / `./test.sh` 全PASS / ローカルcommit

---

## Sprint 4 — T5(#5): statusline メトリクス（フル実装）

### 既存
transcript/usage 読み取りは**未実装**。`getMetrics()`（cmuxctl.js≈L1845）は memory/top の RSS/CPU のみ。`/api/metrics`・`.metrics-panel` UI は既存。

### 方式（確定: フル / 統合方式C=Node移植・ライセンス確認）
ccsl（usedhonda/statusline, Python）のコスト/コンテキスト算出ロジックを**参考に Node 実装**（pip依存を増やさない）。データ源=Claude Code statusline stdin JSON＋transcript(jsonl)＋usage を**ダッシュボードが直接読む**。パスは env 上書き可。

### 確定タスク
1. **メトリクス算出モジュール(Node)**: transcript jsonl をパース→(a)コンテキストウィンドウ使用率%（1M対応・キャッシュ率・80%黄/90%赤）(b)直近ターン/5hセッション/週次のトークン・コスト・Ext(従量)(c)週次予算消費。
2. **死活判定**: surface marker live＋プロセス存在で agent 死活（死=赤）。S3 の stableId 基盤と共有。
3. **API**: `GET /api/grid/metrics`（列ごと）＋ `/api/metrics` 拡張。列に `{contextPct, cache, cost:{turn,session,week}, budget, alive}`。
4. **UI**: 各列に コンテキスト率バー（黄/赤）／直近・セッション・週次コスト＆予算／死活バッジ／スパークライン（5h・週次）。
5. **graceful degrade**: transcript/usage 未取得時もUIが落ちない（バー非表示等）。

### 保留TODO（claude が着手前に確定）
- ⏳ **実フォーマット確認**: cmux 復活後、claude が実セッションの transcript jsonl / usage を1本取得して fixture 化（codex のテストに渡す）。
- ⏳ **単価表**: Fable5(メーター課金)/Opus/Sonnet/Haiku の最新単価は **claude-api スキル**で確認。単価は1箇所集約＋env上書き。

### 受入基準
- [ ] 各列で claude/codex のコンテキスト使用率(%)
- [ ] 各列の直近コスト＆週次予算消費（Fable/Opus）
- [ ] agent 死活（死=赤）
- [ ] スパークライン（5h/週次）
- [ ] 算出ロジックを固定 fixture jsonl で単体テスト / `./test.sh` 全PASS / ローカルcommit

---

## Sprint 5 — T2(#2): スキルを setup 専用に縮小（B）

### 確定タスク
1. `/claude-codex-collab` スキルから **headless ブリッジ（暴走原因）を削除/無効化**。`collab.sh init` と `status/stop/update` の最小限だけ残す。
   - ★今セッションで判明: **headless codex exec はこの環境でハングする**（2-3日ゾンビ＋600s timeout 失敗）。T2(B) の「headlessブリッジ削除」を裏付ける実証。スキルのデフォルト動作から headless 起動を外す。
2. `SKILL.md` を「setup専用・headless bridge非推奨/削除」に更新。ダッシュボードは init を idempotent に呼ぶ旨明記。
3. ブリッジ利用箇所の確認＋ドキュメント更新。`.claude-codex-collab/` 残存 bridge 状態クリーンアップ。
4. README / docs 更新。

### 保留TODO（人間承認が必要）
- ⏳ **スキル本体はリポジトリ外**（`~/.claude/skills/claude-codex-collab`）。変更範囲を提示し**人間確認の上で**実施。

### 受入基準
- [ ] スキルが setup専用に縮小、headless bridge を起動しない
- [ ] SKILL.md・README・docs 更新
- [ ] ダッシュボードの collab（T1）が引き続き動く（回帰確認）
- [ ] `./test.sh` 全PASS / ローカルcommit

---

## 全体の完了条件（再掲）
Issue #1–#5 全クローズ／`./test.sh` 全PASS（既存283を壊さない）／claude実機検証＋Opusサブエージェント評価PASS／**push は5件完了後にまとめて人間承認**。
