# 計画: grid 状態再同期・リバランス収束保証・安全rebuild API
- 作成: 2026-06-12 / 設計: Fable 5 / 実装: codex(worktree隔離) / 評価: Opus
- 元レポート: 実機 workspace:1 で孤児ペイン多数・columns=1列のみ・lastRebalance converged:false(同一命令無限反復・actualBoundaryPx不動)・右アンカーがスライバー化なのに within tolerance。

## 修正4点
1. **起動時再同期(最重要)**: サーバー起動/validateGridRuntimeState 時に grid ws の全ペインを marker(cmuxdash:grid:__grid__:column:<id>:slot:cc|cdx / concierge / 右アンカー)でスキャンし、(a)markerが解釈できる列は gridRuntimeState.columns に **adopt**(順序は projects.json 準拠で reindex)、(b)marker無し・解釈不能ペインは「孤児」として state に列挙(即閉じない。closeはrebuild API or 明示操作で)。adopt後は通常の増分add/removeが正しく機能すること。
2. **リバランス収束保証**: 各 resize 後に実ジオメトリ再読 → 境界が動いていなければ同一命令を繰り返さない: (a)pxPerAmount 再キャリブレーション (b)対象ペイン/方向の再導出(境界の右ペイン-L/左ペイン-R 規約の検証) (c)2回不動なら当該境界を諦め、結果に unconverged として記録し repair 提案を載せる。無限同一命令の反復を禁止するガードをテストで固定。
3. **右アンカー実測検証**: tolerance 判定前にアンカー surface の実フレームを read し直し、幅が極小(例 < コンテナ1%)なら sliver と判定して矯正 resize を発行。計測値と判定値のソース不一致を解消。
4. **POST /api/grid/rebuild**: marker 基準の安全再構築。原則 = 生きている cc/cdx surface は**殺さず**正位置へ移動(cmux に move 系が無ければ: 新規構築は行わず、孤児のうち「列として adopt できないもの」だけ閉じて、不足列は増分addで補う方式に切替)。破壊が必要なケースは {requiresConfirm:true, detail} を返して実行しない(クライアントが confirm:true を付けた時のみ実行)。
## 検証
- ./test.sh: 孤児adopt/不動境界ガード/sliver検知/rebuild API(confirm含む) の fake check 追加、既存(301+alwayson分)退行なし。
- 実機: サーバー再起動→旧列がadoptされ columns に復元/off→on で割り込み崩れが起きない/rebuild API で孤児が安全回収。
