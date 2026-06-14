# 🔄 引き継ぎ書 — cmux 再起動後はこれを読んで続行

> 作成: claude(Opus) 2026-06-14 / 目的: cmux.app 再起動でこのチャットが落ちるため、次の新セッションが**ここから迷わず続行**するための引き継ぎ。

## いまの状況（一言で）
**cmux-dashboard の GitHub Issue #1–#5 を collab で1つずつ実装し、ダッシュボードを完成させる**作業。
**計画は完成済み・実装は未着手**。理由＝(A) headless codex がハングして使えない → (B) 見える2ペイン方式に切替決定 → (C) その土台の cmux.sock が停止 → ユーザーが cmux.app を再起動するところ。

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
