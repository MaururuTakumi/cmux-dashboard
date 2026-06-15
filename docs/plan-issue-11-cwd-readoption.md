# Plan — issue #11: cwd+process 照合でレガシー orphan を非破壊再採用（#7 deferred S2）

Status: AGREED (Plan Gate 合意 2026-06-15, codex review 反映) → S1 実装可
Owner(plan): claude / Owner(exec): codex
Branch: `feat/issue-11-cwd-readoption`

## 目的
マーカー消失＋有効な永続状態が無い**レガシー orphan grid**でも、再起動時に **cwd→project × process→slot** 照合で**非破壊**にカラムを再採用する。実機 workspace:5 の orphan 8件（claude11/codex3 生存中）を復旧する。

## 確定設計（codex review 反映）

1. **process source**: `validateGridRuntimeState` で `surfaceProcessMap(wsRef)` を取得し、`buildAdoptedGridColumns` に `opts`(processMap) として渡す。buildAdoptedGridColumns は同期のまま。
2. **注入位置**: 採用判断は `buildAdoptedGridColumns` 内。既存 ref/marker merge の**後**、orphan 計算の**前**に cwd+process フォールバックを入れる。validate は surfaces/processes 取得と orchestration のみ。
3. **採用条件（厳格）**: ある configured project の cwd に一致する未請求 surface のうち、**cc(claude) と cdx(codex) が process で一意に確定し、両方そろう**場合のみ、新規カラムとして採用。
   - 片肺（片方 slot のみ）、同 cwd+同 slot が複数で曖昧、はいずれも**非採用**（orphan のまま）。
   - cwd だけで slot/column を作らない。
4. **claimed guard**: existing/marker で採用済みカラムの surface、concierge、right anchor、browser anchor を claimed set に入れフォールバック候補から除外。対象は grid workspace の surfaces のみ（通常 workspace は見ない）。
5. **process 判定**: `surface.process/processName/command` と `processMap[surfaceRef]` を併用（surfaceProcessValues 相当）。`classifyProcess` の C/X、または `SLOT_DEFS.cc/cdx` の processRe に限定。**title fallback は使わない**（誤検知回避）。
6. **永続化**: 採用後は `validateGridRuntimeState` の canonical persist で `.grid-state.json` に書かれ、**以後は ref 再採用に乗る**（次回再起動からは #7 本来の前進パス）。

## #7 S2 との差分（plan 明記）
- #7 S2 = hydrated column の**欠け slot 補完**。
- #11 = 有効永続状態が**無い** legacy の**新規カラム再構成**。対象は configured projects 限定、新規カラムは**両 slot 一意確定時のみ**許可。

## S1 実装（codex）
buildAdoptedGridColumns に processMap opts を追加し、上記フォールバックを実装。validateGridRuntimeState で surfaceProcessMap を取得して渡す。

## S2 テスト（test.sh、既存を壊さない）
既存 grid resync block 近辺に追加。fake cmux の `top` は既に surface.process を TSV 出力済み（大きな stub 追加不要）。
- **positive(legacy)**: marker/sendText 消失・gridRuntimeState/.grid-state 無し・各 surface に cwd(project配下)+process(cc=claude/cdx=codex) → cwd+process で**全カラム再採用・orphans=0・live refs 保持**。
- **negative**: cwd 不一致 / 片肺 / 同 slot duplicate・ambiguous / 既請求 ref / browser・concierge・anchor は対象外、で**非採用**。

## 受け入れ基準
1. cwd+process で legacy orphan を再採用し orphans=0、生 surface 全保持（非殺害）。
2. 負例で誤採用ゼロ（cwd不一致/片肺/曖昧/既請求/非grid）。
3. 採用後 .grid-state.json に永続化され次回から ref 再採用に乗る。
4. **実機**: workspace:5 の legacy orphan 8件 → 再起動で orphans→0、claude11/codex3 生存維持（claude 確認）。
5. 既存 ./test.sh を壊さない（無関係 R6 のみ赤）。

## ガードレール
生セッション非殺害 / `rebuild confirm:true` 不使用 / grid 端末のみ / configured projects 限定。

---

## Revision 2 (2026-06-16) — 実機検証で判明した修正（cwd source）

### 問題
v1 実装は自動テスト緑だったが**実機で失敗**: `columns:[] / orphans:8` のまま再採用されず。
根本原因: **cmux は既存 surface の cwd を一切出さない**（`list-pane-surfaces` は ref/title のみ、`top` も cwd 無し、capabilities に surface cwd 取得手段なし）。v1 の `surfaceMatchesProjectCwd` は `surface.cwd` 前提だったため live では常に不一致。fake cmux が cwd を注入していたためテストだけ通る**テスト不忠実**だった。

### 確定した方針（PID→lsof で cwd 解決）
- **process/PID**: `cmux top --processes --format tsv` のツリーは surface 配下に process 行（PID＋command）を持つ。各 grid surface の **claude/codex プロセス PID** を取得（既存 surfaceProcessMap を PID 付きに拡張 or 併用）。
- **cwd**: その PID から OS で解決 — macOS `lsof -a -p <pid> -d cwd -Fn`（→ プロジェクトディレクトリ）。これを **stub 可能な seam** にする（例: `resolveProcessCwd(pid)` をモジュール関数 or env 差し替え可能に）。テストは実 lsof を呼べないため、この seam を fake で差し替えて pid→cwd を注入する。
- **照合**: 解決した cwd を configured project に照合（既存ロジック）＋ process で slot（cc=claude/cdx=codex）。両 slot 一意確定＆未請求の時だけ採用（v1 と同じガード）。
- **性能**: lsof を毎 poll 全 surface に走らせない。**orphan 判定された grid surface の採用時のみ**＋**TTL キャッシュ/fast-fail**（解決失敗は cwd 無し＝非採用に倒す）。#10 の read-screen と同じ作法。

### テスト不忠実の是正（必須）
- fake cmux の surface は **cwd フィールドを持たない**（実 cmux に合わせる）。
- process/PID は fake `top` で供給、cwd は **stub した resolveProcessCwd(pid→cwd map)** で供給。
- positive(legacy) は「surface.cwd 無し・top で PID 取得・stub resolver で cwd 解決 → 全カラム再採用・orphans=0・live ref 保持」を検証。negative 群は維持。

### 受け入れ基準（追加・最重要）
- **実機**: feat 反映後に `./cmux-dash restart` → workspace:5 の legacy orphan が cwd(PID→lsof)+process で columns に再採用され orphans→0（完全 cc+cdx ペアが揃う project 分）、claude/codex セッション生存維持。**自動テスト緑だけでは不可、実機 orphans→0 を claude が確認するまで done としない。**
