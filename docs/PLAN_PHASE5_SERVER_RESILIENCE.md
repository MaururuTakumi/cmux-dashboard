# Plan: Phase 5 — サーバー堅牢化（劣化の根本対策 + open-all ペーシング + 自己回復）

> ステータス: claude 設計 → codex 実装
> 起案: claude (plan層) 2026-06-02
> 背景: 実利用で「全部起動」が複数失敗。診断の結果、cmux本体はシェルから健全(list 5/5,ping 8/8 OK)だが、**長時間稼働した node サーバーの cmux 呼び出しだけが Broken pipe で持続的に失敗**する（FD漏れなし=19, 負荷なし時も再現）。これが最初の「起動しない」バグの真の根っこ。restart で必ず直る。

## 1. 症状の事実（claude 確認済み）
- フレッシュな node サーバー → cmux 呼び出し成功（test.sh 51チェック・単発openとも成功）。
- 長時間/多操作後の node サーバー → cmux 呼び出しが attempts:10/20s 全失敗（Broken pipe）。同時刻にシェルの `cmux list-workspaces`/`cmux ping` は 100% 成功。
- doctor の cmux チェックも、劣化サーバーでは ok:false（Broken pipe）になる。
- 「全部起動(open-all)」で7プロジェクトを一気に開く場合、cmux への高頻度アクセスが重なり失敗が増える。

## 2. 仮説（codex が検証して原因確定 → 対策）
A. **継承 CMUX_* 環境変数**: このサーバーは cmux ペイン内から起動されると `CMUX_WORKSPACE_ID/TAB_ID/PANEL_ID/SURFACE_ID/PORT/SOCKET` 等を継承し、execFile で cmux CLI にそのまま渡している(`env:{...process.env}`)。cmux CLI がこの継承コンテキストで特定セッション/ソケットに紐付き、そのセッションが古くなると接続を拒否(Broken pipe)する可能性。
   → 対策候補: cmuxctl の cmux 起動時に **CMUX_* を scrub** して渡す（CLI 本来のソケット自動探索に任せる）。CMUX_QUIET は維持。これが本命の根本対策仮説。
B. node プロセス内の何らかの状態（execFile/libuv）。Aで直らなければ調査。

## 3. 実装要件
1. **env scrub（本命）**: cmuxctl.js の cmux 実行で、子プロセスに渡す env から cmux ペイン固有変数を除去する。最低限: CMUX_WORKSPACE_ID, CMUX_TAB_ID, CMUX_PANEL_ID, CMUX_SURFACE_ID, CMUX_PORT, CMUX_PORT_END, CMUX_SOCKET, CMUX_SOCKET_PATH(保持すべきものがあれば精査), CMUX_CLAUDE_PID。CMUX_BIN は解決に使うので削らない。CMUX_QUIET=1 は付与。
   - 注意: CLI のソケット自動探索を壊さないこと（`cmux ping` が scrub後env でも通ることを確認）。
2. **open-all / close-all ペーシング**: openAll は1プロジェクトずつ、各 open 完了後に settle 待ち(既定 ~750ms、env CMUX_DASH_OPENALL_GAP_MS で調整)を入れて cmux への突発負荷を平準化。途中で1件失敗しても残りは続行し、結果配列に成否を残す。
3. **自己回復(self-heal)**: getState/doctor の cmux 読み取りが連続 N 回(既定5)失敗したら、サーバーは「unhealthy」を state に立て、終了コードで自プロセスを終了する → 起動元(Swift アプリ/cmux-dash)が再起動する。最低限、index.html が unhealthy を検知して「cmux応答不良: サーバー再起動が必要」バナー＋手動「サーバー再起動」導線を出す（Phase1の学びの health-aware UI）。
   - Swift 殻側: 自分が起動した node が異常終了したら再起動する(KeepAlive 的)挙動を main.swift に追加してよい(任意・できれば)。
4. cmux-dash スクリプトに `restart` サブコマンドを追加(stop+start)。

## 4. 受入条件（テスト証跡なしは差し戻し）
`test.sh` 既存51を壊さない。追加:
1. **env scrub**: cmuxctl が cmux を起動する際の子 env に CMUX_WORKSPACE_ID 等が含まれないことを検証（spawn をフック or ラッパで確認）。かつ scrub 後も `cmux ping` 相当が成功する。
2. **open-all ペーシング**: open-all → close-all が全 success、settle gap が効いている（gap を大きくして所要時間が増えることを確認 or ログで gap 適用を確認）、途中失敗時も残りcontinueの契約。
3. **self-heal**: cmux 読み取りを強制失敗させた擬似条件で、連続失敗カウンタが閾値に達すると unhealthy フラグが立つ（プロセス終了は test では検証困難なのでフラグ/カウンタのロジックを関数化して検証）。
4. UI: unhealthy バナー＋再起動導線の静的契約。
- `./test.sh` と必要なら `test-app.sh` を実行して全PASS出力を報告。

## 5. 対象ファイル
- `cmuxctl.js`（cmux 実行 env scrub、openAll ペーシング、連続失敗カウンタ/unhealthy）
- `server.js`（/api/state に health/unhealthy、必要なら自己終了）
- `public/index.html`（unhealthy バナー＋再起動導線）
- `cmux-dash`（restart サブコマンド）
- `swift/main.swift`（任意: owned node の異常終了時 再起動）
- `test.sh`（Phase5 チェック）

## 6. 優先度
env scrub(本命の根本対策) と open-all ペーシングを最優先。self-heal/UIバナーは次点。
