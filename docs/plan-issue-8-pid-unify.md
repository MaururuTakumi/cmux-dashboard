# Plan — issue #8: 1プロジェクト=可視 cc/cdx 1:1（見えるPID=働くPID）、裏ワーカー全廃

Status: DRAFT (Plan Gate — Opus起点ドラフト、codex レビュー待ち)
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
