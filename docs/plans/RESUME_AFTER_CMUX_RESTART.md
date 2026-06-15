# 🔄 引き継ぎ書 — cmux 再起動後はこれを読んで続行

> 作成: claude(Opus) 2026-06-14 / 目的: cmux.app 再起動でこのチャットが落ちるため、次の新セッションが**ここから迷わず続行**するための引き継ぎ。

## いまの状況（一言で）
**cmux-dashboard の GitHub Issue #1–#5 を実装し完成させる**作業。collab(codex)がハング＋cmux停止のため、ユーザー承認のもと **claude(Opus)が直接実装中**。branch `tickets-sweep` に commit 済み（push はゴール末にまとめて人間承認）。

## ✅ 最終状態（2026-06-15 更新）
- **PR #6** https://github.com/MaururuTakumi/cmux-dashboard/pull/6 （branch `tickets-sweep`, 10コミット）= #4/#3/#5。`./test.sh` **FINAL: PASS (320 checks)/0 FAIL（実cmux）**。
- **#4 ✅ / #3 ✅MVP / #5 ✅完全（死活・grid列含む）** — マージ可。
- **#2 ✅** スキルを setup専用に縮小（`~/.claude/skills/claude-codex-collab`: `start`/`run`/`run-once` 無効化、SKILL.md/bridge に非推奨明記）。git管理外なのでディスク反映済み。
- **#1 ✅ 実質完了**: 実装済＋配送テスト通過＋実機 `/api/statusline` 動作。**getState ハングの実バグを特定・修正**: front-desk(concierge)配送が既定ONで delivery loop が concierge surface を毎tick待ち→直列cmuxチェーン占有→`/api/state` 30秒ハング。**front-desk をオプトイン化**(`CMUX_DASH_FRONT_DESK_TEAM` 明示時のみ)して解消（live `/api/state` 1-3秒応答）。commit e702d7b（PR#6）。**残=claude↔codex 会話の目視のみ**（quota消費するため人間が実機GUIで確認推奨）。
- **残課題**: (a) #1 会話E2E目視（任意・人間推奨）、(b) #3 PID粒度の任意調整、(c) **PR#6 マージ**。テスト: 実cmuxで 320 PASS（grid-alpha のみ負荷時flaky、再実行で通る）。

## 進捗（2026-06-14 時点）
- ✅ **T4(#4) 完了**: grid rebalance の amount クランプ＋係数1.0＋killswitch＋UI「今すぐ整形」ボタン。node/fake-cmux テスト PASS。
- ✅ **T3(#3) MVP 完了**: 休眠していた claude↔codex 会話 thread を全プロジェクト行に「💬 会話」1アクションで配線（/api/agmsg, PID非依存）。
- ✅ **T5(#5) 大部分完了**: `statusline-metrics.js`(context%/cost/window/**スパークライン5h・7d**、単価override) ＋ `/api/statusline` ＋ 行ごと context% バー＋コスト＋週次スパークライン。実データで動作確認済み。
  - ⏳ 残: agent **死活**警告、grid列への配置 → **live process/surface データ必須＝cmux復活後**。
- ⏸ **T1(#1)**: 設計9項目は実装済み。残は**実機E2E検証**（cmux必須）。
- ⏸ **T2(#2)**: スキルを setup専用に縮小（headlessブリッジ削除）。**リポジトリ外＋人間承認必須**。

branch `tickets-sweep` commits: docs / fix(grid #4) / feat(observability #3) / feat(statusline #5 ×3)。

## cmux 再起動後の残タスク（このため再起動が要る）
1. **T1 実機E2E**: 新規列を開く→手動設定ゼロで claude↔codex 双方向→人間→CC→agmsg→Cdxペイン→codex反応→返信、を実走確認。穴があれば塞ぐ。
2. **T5 残**: 死活警告（surface marker live + プロセス存在）＋ grid列メトリクス配置 ＋ スパークライン。
3. **T2**: スキル(`~/.claude/skills/claude-codex-collab`)の headless bridge 削除＋SKILL.md更新（人間承認の上で）。
4. **全体**: `./test.sh` を cmux 健全下で完走させ FINAL PASS（今は API/実機フェーズが cmux停止でハング）。実機目視（grid整形/会話/ctxバー）。
5. push 承認 → Issue #1–#5 クローズ（done分は先にクローズ可）。

## 旧・初期状況（参考）
当初: (A) headless codex ハング → (B) 見える2ペイン方式に切替決定 → (C) cmux.sock 停止 → 再起動待ち。その後ユーザーが「私(Opus)が直接実装」を選択し上記を実装。

## ユーザーの確定事項
- 着手順: **基盤→可視化 = T4 → T1 → T3 → T5 → T2**
- T2 = **B（スキルを setup専用に縮小、headlessブリッジ削除）**
- T5 = **フル実装**（コンテキスト率＋死活＋コスト/週次予算）
- collab 方式 = **見える2ペイン**（headless ブリッジは codex ハングで不可と判明）
- push = **5件すべて完了後にまとめて人間承認**（途中の push 禁止、ローカルcommitはOK）
- 他プロジェクトの多日ゾンビ codex（honkoma-work 3日 / video-clipper 2.6日）は **触らない**

## 重要な発見（次セッションが踏まないように）
1. **headless `codex exec` はこの環境でハングする**（出力ゼロで600sタイムアウト×2、他プロジェクトに2-3日ゾンビ）。→ headless collab ブリッジは使わない。**見える2ペイン方式（cmux ペイン内 codex TUI＋サーバーの cmux send で起こす）**で進める。
2. cmux.sock が落ちていた（Sparkle 自動更新で半死）。**cmux.app 完全終了→再起動で復旧**。
3. PLAN_COLLAB_DEFAULT.md の合意9項目はコード上ほぼ実装済み（T1 は新規実装より実機E2E検証が主）。

## 成果物（すべて作成済み・このリポジトリ内）
- `docs/plans/PLAN_TICKETS_SWEEP.md` — 全体計画（着手順・各受入基準・テスト戦略）
- `docs/plans/SPRINT1_T4_SPEC.md` — S1(T4) 詳細実装指示書（codex 投入可・最優先）
- `docs/plans/SPRINT2-5_SPECS.md` — S2–S5 指示書（確定部分＋保留TODO）
- `docs/TICKETS.md` — Issue #1–#5 全文（gh 不要、これ1ファイルで足りる）

## 未完の Plan Gate
codex の Plan Gate レビューは未取得（codex ハングで失敗）。**cmux 復活後、見える2ペインの codex(TUI) に Plan Gate レビューを依頼 → 合意 → S1 から実装**。

## 次セッションの再開手順（claude=Opus 想定）
1. cmux.sock 復活を確認: `cmux list-workspaces`（エラーが消えていればOK）
2. ダッシュボードサーバー起動: `cd ~/cmux-dashboard && ./cmux-dash up`（専用ペインでフォアグラウンド常駐。背景/launchdは孤児化するので不可）
3. cmux-dashboard を **collab ON** で開く → CC(claude)/Cdx(codex) の見える2ペイン生成。codex は TUI で起動。
4. agmsg で Plan Gate レビュー依頼:
   `bash ~/.agents/skills/agmsg/scripts/send.sh cmux-dashboard claude codex "docs/plans/PLAN_TICKETS_SWEEP.md と docs/TICKETS.md を読んでPlan Gateレビュー。結論(GO/...)＋懸念を返信。"`
   → サーバーの collab-delivery が Cdx ペインに wake を投入 → codex が返信。
5. 合意できたら `docs/plans/SPRINT1_T4_SPEC.md` を codex に投入して実装開始。Opus は各スプリントを評価し、合格で次へ。
6. 全5件完了 → ローカルcommit を積み上げ → **人間にまとめて push 承認を求める** → GitHub Issue クローズ。

## 注意
- この作業は **agmsg 連携（team=cmux-dashboard, claude/codex）** で進める。
- /goal と /loop（15分点検）は前セッションで設定したが**再起動で消える**。必要なら新セッションで再設定: `/goal 全チケット解消…` と `/loop 15m …`。
- 実 cmux 目視・ブラウザ確認は メインセッション(Opus) が担当してよい。実装労働は codex。
