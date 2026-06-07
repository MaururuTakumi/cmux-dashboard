# Plan: Phase 4 — ネイティブ Swift 殻（WKWebView アプリ）

> ステータス: claude 設計 → codex 実装
> 起案: claude (plan層) 2026-06-02
> 関連: vision / Phase1-3
> 目的: Chrome --app をやめ、既存の Node サーバー + index.html をそのまま表示する**ネイティブ Swift(WKWebView) アプリ**にする。本物の .app / Dock / メニューバー。OSS配布前提だが、署名・notarize は別フェーズ。

## 0. 重要な進め方（安全策）
- 既存の動作する `cmux Dashboard.app`（現状=AppleScript applet で node起動+Chrome --app）を**壊さない**。
- 新しい Swift アプリは**別成果物**として `build/cmux Dashboard.app` にビルドし、検証が済むまで現行アプリを置き換えない。
- 置き換え（/Applications への配置）は claude が検証後に判断。`install-app.sh` を新アプリ対応に更新するが、デフォルトの上書きは確認付き（既存挙動を踏襲）。

## 1. 技術方針
- **Xcodeプロジェクトは作らない**（codexはheadlessなので）。`swiftc` でコンパイルし、`build-app.sh` が .app バンドルを組み立てる。
- 言語: Swift + AppKit(`NSApplication`/`NSWindow`) + WebKit(`WKWebView`)。
- ソース: `swift/main.swift`（単一ファイルで可）。
- 署名: ローカル実行用に **ad-hoc 署名**（`codesign -s - --force --deep`）。Developer-ID署名・notarize はスコープ外（§5）。

## 2. アプリの挙動（main.swift）
1. **サーバーライフサイクル**:
   - 起動時、`http://127.0.0.1:<port>/api/state` を叩いて既存サーバーの生存を確認。
   - 生きていれば再利用（**自分では起動しない／終了時も止めない**）。
   - 居なければ、空きポートを選び（既定 7799、埋まっていれば free port 探索）、`node server.js` を `CMUX_DASH_PORT=<port>` で起動（プロジェクトディレクトリは .app からの相対 or 既知パス。Resources に同梱 or 既知の ~/cmux-dashboard を参照——後者で可）。**自分が起動した場合のみ**終了時に停止する。
   - node バイナリ解決: `/opt/homebrew/bin/node` 優先、無ければ PATH。見つからなければエラーダイアログではなく**ウィンドウ内にメッセージ**（modal dialogは避ける）。
2. **サーバー ready 待ち**: `/api/state` が 200 を返すまで最大 ~10秒ポーリングしてから WKWebView をロード。
3. **ウィンドウ**: タイトル「cmux Dashboard」、サイズ 1280x880、`WKWebView` で `http://127.0.0.1:<port>` をロード。タブ/アドレスバー無し。
4. **メニューバー**: アプリ名メニュー(Quit ⌘Q)、View(Reload ⌘R)。Dock アイコン表示（`NSApplication.setActivationPolicy(.regular)`）。
5. **終了処理**: 自分が起動した node サーバーだけ terminate（PID保持）。既存サーバーは残す。

## 3. ビルド/インストール スクリプト
- `build-app.sh`:
  - `swiftc` で `swift/main.swift` をコンパイル → `build/cmux Dashboard.app/Contents/MacOS/cmux-dashboard`。
  - `Contents/Info.plist`（CFBundleName, CFBundleIdentifier=com.cmuxdash.app, LSMinimumSystemVersion, NSHighResolutionCapable 等）を生成。
  - 既存アイコンがあれば `Resources/applet.icns` を流用、無ければスキップ。
  - ad-hoc 署名: `codesign --force --deep -s - "build/cmux Dashboard.app"`。
  - 失敗は ERROR: で明示して非0終了。
- `install-app.sh`: source を `build/cmux Dashboard.app` 優先に更新（無ければ従来の同梱 .app）。既存挙動（確認/--force/CMUX_DASHBOARD_INSTALL_DIR）は維持。

## 4. 受入条件（テスト証跡なしは差し戻し）
Swift GUI は完全自動テストが難しいので、**機械検証できる範囲＋スモーク**に絞る。`test.sh` とは別に **`test-app.sh`** を新設（既存 test.sh の51チェックには手を入れない）:
1. **コンパイル**: `swiftc` が exit 0（Swift Tooling 不在環境では SKIP と明示ログ、FAILにしない）。
2. **バンドル妥当性**: `build/cmux Dashboard.app/Contents/MacOS/<bin>` が実行可能、`plutil -lint Contents/Info.plist` OK、`codesign --verify --deep` OK（ad-hoc）。
3. **サーバーライフサイクル スモーク**（任意・可能なら）: テスト用ポートで「既存サーバーなし→アプリがnode起動→/api/state 200→終了でnode停止」を、main.swift のサーバー管理ロジックを切り出せるなら検証。GUI起動が必要で困難なら、ロジックを小さな関数化し最低限の確認に留める。難しければ claude の手動検証に委ね、その旨を報告。
- codex は `bash test-app.sh` を実行して結果を報告。GUI の目視起動確認（実際にウィンドウが出てダッシュボードが表示される）は **claude 担当**。
- `./test.sh`（既存51）も回して壊れていないことを確認。

## 5. スコープ外（別フェーズ / 要ユーザー判断）
- **Developer-ID 署名 + notarize + stapler**（Apple Developer アカウントが必要。OSS配布の最終段で、the maintainerのアカウント確認後に実施）。
- 自動アップデート（Sparkle 等）。
- Node ランタイムの同梱（初期は外部 node 依存で可、配布安定後に検討）。
- これらは docs に TODO として残す。

## 6. 対象ファイル（目安）
- `swift/main.swift`（新規）
- `build-app.sh`（新規）
- `install-app.sh`（更新: build/ 優先）
- `test-app.sh`（新規）
- 既存 `cmux Dashboard.app`(AppleScript) は検証完了まで温存。
