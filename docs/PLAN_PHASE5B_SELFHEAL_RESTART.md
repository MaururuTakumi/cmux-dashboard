# Plan: Phase 5b — サーバー自動再起動（劣化を実用上ゼロにする）

> ステータス: claude 設計 → codex 実装
> 背景: Phase5の env-scrub では長時間劣化を防げなかった。実測: 健全に起動したサーバーが約12時間で再び unhealthy(consecutiveFailures=5003) になり、最終的に応答停止。restart で必ず復旧。根本原因(長時間稼働nodeのcmux接続劣化)は未解明だが、**自動再起動で実用上ゼロにする**。

## 1. ゴール
- サーバーが劣化(unhealthy)または応答停止しても、**数秒〜数十秒で自動的に再起動して回復**する。人間もclaudeも手動restart不要。

## 2. 方針（launchd KeepAlive で server を常駐管理）
bridge と同じ launchd 方式を server にも適用する。
1. **EXIT_ON_UNHEALTHY を既定ON相当の常駐構成にする**: server.js は既に CMUX_DASH_EXIT_ON_UNHEALTHY=1 で unhealthy 検知時に exit する opt-in を持つ。これを launchd 構成で有効化する（環境変数で渡す）。
   - exit 前に1回 stderr/ログに理由を出す。exit code は非0。
2. **launchd LaunchAgent `com.cmux-dashboard.server`**: `node server.js` を CMUX_DASH_PORT=7799, CMUX_DASH_EXIT_ON_UNHEALTHY=1 で実行。RunAtLoad=true, KeepAlive=true。→ unhealthy exit / クラッシュ時に launchd が即再起動。
   - ★env: launchd の EnvironmentVariables には cmux ペイン変数を入れない（クリーンな env で起動＝そもそも継承劣化要因を断つ）。PATH に node を含める(/opt/homebrew/bin 等)。
   - StandardOut/Err を .server.launchd.{out,err}.log に。
3. **cmux-dash 拡張**: `install-server` / `uninstall-server` サブコマンド（bridge の install/uninstall と同型）。`cmux-dash` の通常起動も、launchd 管理が居ればそれを使う/二重起動しない。
4. **二重起動の防止**: server.js 起動時、既に :7799 が listen 中なら起動しないか、launchd 管理が優先。Swift アプリ(main.swift)は既存サーバー検出で reuse 済みなので、launchd 管理サーバーをそのまま使う（変更不要のはず。重複起動しないことだけ確認）。
5. (任意) **proactive restart**: 念のため launchd で 6時間ごと等の定期再起動を入れてもよいが、まずは unhealthy-exit + KeepAlive を主とする。

## 3. self-heal 検知の確実化（server.js）
- 連続失敗閾値(既定5)到達で unhealthy。CMUX_DASH_EXIT_ON_UNHEALTHY=1 なら、進行中レスポンスを壊さない範囲で速やかに process.exit(非0)。
- ただし「一過性で5回」誤検知を避けるため、閾値到達後に1回 cmux ping を試し、回復したらカウンタをリセットして exit しない（フラップ防止）。閾値・挙動は env で調整可能に。

## 4. 受入条件（テスト証跡なしは差し戻し）
既存 test.sh(64)/test-app.sh(7) を壊さない。追加:
1. EXIT_ON_UNHEALTHY: unhealthy 条件を擬似発生させ、CMUX_DASH_EXIT_ON_UNHEALTHY=1 のサーバープロセスが非0 exit することを検証（小さな子プロセス起動で確認、フラップ防止の1回再確認も）。
2. install-server/uninstall-server: plist 生成・bootstrap・bootout が成功し、二重起動しない契約（temp ラベル/環境で）。
3. cmux-dash restart/通常起動が launchd 管理と競合しない契約。
- `./test.sh` 全PASS出力を報告。launchd の実再起動挙動は claude 側で実機確認する（codex は plist 生成と exit ロジックまで）。

## 5. 対象ファイル
- `server.js`(unhealthy-exit のフラップ防止＋確実化)
- `cmux-dash`(install-server/uninstall-server、二重起動防止)
- 新規 launchd plist 生成ロジック(cmux-dash 内 or bin/)
- `test.sh`(Phase5b チェック)

## 6. 注意
- bin/agmsg-codex-bridge.sh と codex-bridge launchd は触らない(claude管理、別物)。
- 本番サーバーの実起動/停止・launchd の実 load は claude が実施。codex は実装＋ロジックテストまで。
