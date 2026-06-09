# Plan: 入口を grid に一本化（usedhonda「1画面・横タイル」体験）2026-06-09 夜 /loop

> 起案: claude / 実装: codex / 検証: claude（実機）
> 背景: ユーザー録画(20.44)で確認。現状は「プロジェクト行の CC/Cdx」→ **プロジェクトごとに別ワークスペース（別タブ）**が開く。
> usedhonda の「1つの画面に dashboard＋プロジェクト列が横タイルで並ぶ・タブを切り替えない」になっていない。
> grid 機能（横タイル）は実装済みだが **別タブ**にあり、per-project ボタンと繋がっていないのが原因。

## ゴール（完了の定義 / claude が実機検証）
ダッシュボードでプロジェクトを「開く」と、**同じ grid ワークスペース内に列（CC上/Codex下）が横タイルで増え**、
ユーザーは**タブを切り替えずに**その並列ビューを見られる。「どれを押せば良いか」が一目で分かる。

## スコープ（段階的・既存を壊さない）

### G1（最優先）: per-project「開く」を grid 列追加に繋げ＋自動フォーカス
1. **server/cmuxctl**: grid ワークスペースへ**フォーカスする経路**を用意（例 `focusGridWorkspace()`：grid wsRef を `cmux` でフォーカス）。`addProjectColumn` 成功後にフォーカスできるよう、`/api/grid/column/<id>`（on:true）または専用 `/api/grid/focus` で対応。
2. **UI(public/index.html)**: 各プロジェクト行に**目立つ主ボタン「▶ 開く」**を追加。押すと:
   - `POST /api/grid/column/<id> {on:true}`（= grid に列として追加＝CC/Codex 縦ペアを横タイル生成）
   - 続けて grid ワークスペースへ**自動フォーカス**（ユーザーが切替不要で並列ビューを見る）
   - 再度押す/「× 閉じる」で列を外す（`{on:false}`）。状態（開いている＝列がある）を行に明示。
3. 既存の `CC/Cdx/Yazi/Term` は**「詳細」へ畳む**（小さく/折りたたみ）。デフォルト動線は「▶ 開く」1本に。
4. グリッド・サイドパネルの「列一覧」と行の開閉状態を整合（二重操作で壊れない）。

### G2（仕上げ・余力で）
- 「すべて閉じる」「並べ替え」を grid 列にも。
- 空状態の説明（「▶ 開く を押すと右に並びます」）。

## 受入条件（claude 実機独立検証）
1. `node --check cmuxctl.js` / `node --check server.js` PASS。
2. `./test.sh` FINAL: PASS（FAIL 0、既存数を減らさない）。grid focus / 開く動線の単体 or API テスト追加。
3. 実機(claude): ダッシュボードで2プロジェクトを「▶ 開く」→ **同一 grid ワークスペースに2列（各 CC/Codex）が横タイル**で出て、**自動でその画面にフォーカス**される。「閉じる」で列が消える。per-project 個別ワークスペースは**新規に増えない**（開く＝grid 列）。
4. 既存の grid API / R-B / R-C / slot を壊さない。

## 進め方
- 既存 grid 実装（addProjectColumn / rebuildGridWorkspace / `/api/grid/column`）を流用。差分のみ。
- plan-gate だが低リスク・既存vision整合。懸念なければ実装→テストまで進め証跡を agmsg で返す。
- push しない（commit まで）。ブラウザ実機目視は claude。
