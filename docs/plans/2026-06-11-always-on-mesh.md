# 計画: 常時オン・メッシュ — front-desk配信のサーバー統合 + ブリッジ launchd 常駐
- 作成: 2026-06-11 / 設計: Fable 5 / 実装: codex / 評価: Opus サブエージェント
## 原則
監視は bash(トークンゼロ)・LLM は新着時のみワンターン起動。新デーモンは作らず既存常駐(dashboardサーバー/launchd)に乗せる。
## S1(cmux-dashboard): front-desk → コンシェルジュ配信 + self-heal
1. collab-delivery.js を拡張: 既存のプロジェクトteam監視に加え team=front-desk, agent=concierge の新着を監視し、コンシェルジュ surface へ wake 文(本文全文+「返信は agmsg send front-desk concierge <from>」)を submitToSurface で注入。
2. **self-heal**: 注入前に ensureConciergeSurface を通し、ペイン死亡/claude不在なら修復(8eba5dfのガード+readiness gate を流用)。修復不能時は action error として可視化。
3. env: CMUX_DASH_FRONT_DESK_TEAM(既定 front-desk)/..._AGENT(既定 concierge)。off にもできる。
4. test.sh: fake check(front-desk新着→concierge surfaceへsend発行/self-heal経路/スロットル)。既存301退行なし。
## S2(agmsg-bridges): launchd 常駐化
bin/launchd の plist を実際に gui domain へ bootstrap する install/uninstall スクリプト(bin/install-launchd.sh)。再起動後も openclaw/hermes ブリッジが自動復活。README追記。
## 受入(E2E)
Discord→openclaw→front-desk→(サーバー配信)→コンシェルジュペインのclaudeが**可視で**動く→返信がDiscordへ。サーバー再起動・ペインkill後も自己復旧。Opusが静的照合+再現。
