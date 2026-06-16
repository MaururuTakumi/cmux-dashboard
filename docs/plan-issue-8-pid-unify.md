# Plan — issue #8: 1プロジェクト=可視 cc/cdx 1:1（見えるPID=働くPID）、裏ワーカー全廃

Status: AGREED (Plan Gate 合意 2026-06-16, codex レビュー反映 — Revision 1 参照) → Phase1 実装可 / Phase2 は人間立会い
Owner(plan): claude(Opus) / Owner(exec): codex(GPT-5)
Branch: `feat/issue-8-pid-unify`

## 最重要の構造的制約（自己参照リスク）
受入基準#1「裏ワーカー0（`com.agents.codex-bridge` を launchctl unload）」が殺す対象 = **いま私(claude)の agmsg を codex に届け、#7/#10/#11 を実装してきた `codex exec` を spawn している当の bridge（PID 3852）**。
→ **このセッション中に codex 自身がこの bridge を unload すると、codex 自身の受信経路が切れて作業継続不能**になる。よって:
- **破壊的カットオーバー（基準#1）は codex 自走では不可。Phase 1 検証後に、人間立会いで最後に実施する。**
- 先に「可視 cdx ペインへの pane-delivery(B)」を確実化し、それが唯一のワーカー経路になり得ることを実証してから裏を落とす。

## 現状（issue #8 実機調査の要点）
- A) launchd `com.agents.codex-bridge`(PID3852): agmsg DB を直読みして `codex exec` を headless spawn。**頑丈だが不可視・別PID**。← 勝つ。
- B) `collab-delivery.js` pane-delivery: claude の agmsg を**可視 cdx ペインに paste**(`submitToSurface`)。だが surface 参照依存で #7 の orphan/参照破綻時に**黙って不発**。← 負ける。
- C) per-project `.claude-codex-collab` bridge。
- 結果: 見えない A が処理、見える B が無反応 → PID 不一致／無言。新規 PJ は誰も拾わず沈黙。

## 二段構えプラン

### Phase 1 — 自走可・dashboard 側・テスト可能（このリポジトリ内）
目的: pane-delivery(B) を「決定論的・1:1・PID可視」な唯一ワーカー経路に成熟させる（裏を落とせる前提を作る）。
1. **cdx ターゲットの決定論的解決**: `gridColumnDeliveryTarget`/`deliveryTargetsFromState`(collab-delivery.js L221/L249) を強化し、claude の agmsg が**常にその project の可視 cdx ペイン**へ解決されるようにする。surface 参照/マーカーが壊れていても **#7 永続化＋#11 cwd+process 再採用**で cdx surface を解決。`collab.active` が false でも live カラムなら配信する。
2. **1:1 バインド**: project ごとに cc(claude)+cdx(codex) を厳密 1:1、対応(cc surfaceRef/PID ↔ cdx surfaceRef/PID)を #7 の `.grid-state.json` に永続。
3. **PID 可視化**: #11 の process-PID 解決(surfaceProcessMap＋classify)を使い、cc/cdx の PID を `/api/state`・grid snapshot に出す。UI で「見えるPID=働くPID」を表示。
4. **決定論的 team ルーティング**: `team=<projectId>` → その project の可視 cdx、取り合い無し（dashboard 配信内で）。
5. **回帰テスト**: pane-delivery が「surface 参照が壊れても cdx ターゲット解決→起床」まで検証（#7/#11 と地続き）。fake cmux で。

→ 達成: 受入 4,5,6,7 と 2 の dashboard 半分。**codex が現行 bridge 経由で実装可能（自分の経路を殺さない）**。

### Phase 2 — 人間立会いカットオーバー（自走禁止・経路を切る）
目的: 受入 1（裏ワーカー0）＋ 2,3 の完成。
- Phase 1 を独立検証で緑にした後:
  - `launchctl unload` で `com.agents.codex-bridge`（plist 退避）、per-project `.claude-codex-collab` bridge、agentboard の `agmsg-codex-bridge.sh loop` を停止。`deepseek-worker-bridge`/`front-desk-openclaw` は要否判断。
  - **検証**: unload 後に「claude→可視 cdx ペイン往復」が Phase1 の pane-delivery で成立／`ps` で headless `codex exec`・bridge loop が 0／新規 PJ(honkoma-vault-search・honkoma-sowa)でも成立。
- **これは人間が（claude のガイドで）実施**。理由: codex 自身の受信経路を切るため自走不可。ロールバック手順（plist reload）を用意。

## クロスリポジトリ注意（安全則）
Phase 2 は `~/projects/agentboard`(bridge)・launchd・各 project ディレクトリに跨る = cmux-dashboard リポジトリ外。`launchctl unload` は system 設定変更・不可逆寄り。**人間確認必須**。Phase 1 はリポジトリ内で完結。

## 受け入れ基準（issue #8、本プランでの達成区分）
- Phase 1(自走+独立検証): #4 決定論, #5 PID可視, #6 #7連動の参照解決, #7 回帰テスト, #2 の配信側。
- Phase 2(人間立会い): #1 裏0, #3 新規成立, #2 完成(可視PID自身が反応)。

## codex への質問
1. pane-delivery を `collab.active` 非依存で「live grid カラムの cdx」に確実配信する形に変える際、既存の opt-in(`CMUX_DASH_FRONT_DESK_TEAM`)や front-desk 経路との整合は？ 二重配信/取り合いを生まない設計は？
2. cdx ターゲット解決を #11 の cwd+process 再採用と統合する具体ポイント（getGridState 後の column.cdx.surfaceRef を使う／無ければ再解決）。
3. 「可視 cdx ペインの codex TUI」が headless exec ではなく**対話 TUI として常駐**している必要があるが、現状各カラムの cdx は対話 codex TUI か？（pane-delivery の paste 先が TUI でないと起きない）。Phase2 で裏を落とした後、可視 cdx が確実に対話 codex である保証の作り方。
4. Phase1 だけで「見えるPID=働くPID」をどこまで実証できるか（裏 A が生きている間は A が先に拾う可能性）。Phase1 の独立検証は fake cmux 上の決定論で良いか、実機は Phase2 とセットか。

---

## Revision 1 (2026-06-16) — AGREED (codex レビュー全反映) → Phase1 実装可

### Phase1 受入の正確な再定義（最重要）
Phase1 は「**見えるPID=働くPID の実証**」ではなく「**それを可能にする決定論配送＋可視化基盤の実証**」。
理由: 裏 A が生きている間は A が先に `read_at` を付ける/返信しうるため、PID 一致の最終実証は **Phase2 後の実機受入**に移す。
Phase1 が証明すること: 「dashboard が `team=<projectId>` の未読を、live grid column の cdx surfaceRef へ**一意に submit** した」「marker/ref 欠損→#11 再採用後も同じ可視 surface へ submit」「front-desk と交差しない」「project-row と二重 wake しない」。

### Phase1 確定設計（codex 反映）
1. **grid-column primary / 二重配信防止**: grid 列が存在する project では **grid-column target のみ**配送し、`projectDeliveryTarget`(row slot 経路) は出さない（抑制/劣後）。配送 state は **projectId 単位に統合**し、同一 messageId を二度 wake しない。front-desk は `CMUX_DASH_FRONT_DESK_TEAM` opt-in の別 namespace のまま不変。
2. **canonical 参照（再探索しない）**: 配送は `ctl.getState()/getGridState` の `state.grid.columns` を正とする。#7 永続 ref 再採用・#11 cwd(PID→lsof)+process 再採用は **cmuxctl 側の責務**で完了済み前提。collab-delivery は `column.cdx.surfaceRef + wsRef` を必須にし、無ければ配送せず `lastError` に明示（delivery 内で別ロジック再探索＝二重の真実を作らない）。
3. **TUI readiness（paste 先が対話 codex か）**: `submitToSurface` は TUI 入力欄へ paste+Enter するだけなので、cdx surface が headless exec / zsh では起きない。配送前に **process=codex を確認**し、zsh/claude/unknown なら配送せず warning。`/api/state`・grid に **`cdxReady`（process=codex かつ awaiting/input readable）** 相当を出して Phase2 手順を安全化。
4. **PID 可視化（診断用）**: `surfaceProcessMap` の pid を `column.cc/cdx` に付与し UI 表示。ただし**安定 ID は surfaceRef / team+role**、PID は再起動で変わる前提（診断補助）。
5. **回帰テスト（隔離必須）**: fake cmux＋**隔離 sqlite/agmsg DB** で未読を必ず保持（裏 A の先取りで検証が曖昧化しないように）。検証: 未読 claude→codex を live grid cdx surface へ一意 submit／marker・ref 欠損から #11 再採用後も同じ可視 surface へ submit／front-desk 非交差／project-row と二重 wake 無し／process≠codex では配送しない。

### Phase2 確定（人間立会い・rollback 明記）
- **unload 対象**: `com.agents.codex-bridge`、per-project `.claude-codex-collab` bridge、agentboard `agmsg-codex-bridge.sh loop`。`deepseek-worker-bridge`/`front-desk-openclaw` は要否判断。
- **rollback 手順を plan に固定**: ①unload 対象リストと現状 PID 控え ②plist の退避先（例 `~/LaunchAgents-backup/`）③`launchctl unload <plist>` 実行 ④確認コマンド（`pgrep -fl "codex exec"` = 0、claude→可視cdx 往復成立、新規 PJ 成立）⑤**失敗時**: 退避 plist を `launchctl load` で即時復帰し A を戻す条件（pane-delivery が起こせない/沈黙が再発したら revert）。
- TUI readiness 確認を unload 前の必須チェックにする（全 live cdx が process=codex の対話 TUI であること）。

### 受入の達成区分（最終）
- Phase1(自走+独立検証, fake cmux): 配送一意性・#11統合・front-desk非交差・二重wake無し・PID/cdxReady 可視化・回帰テスト（受入 4,5,6,7＋2の配送基盤）。
- Phase2(人間立会い+実機): 裏0(#1)・新規成立(#3)・可視PID自身が反応(#2完成)。
