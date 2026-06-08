# Plan: claude-codex-collab をダッシュボードのデフォルトに統合（見える2ペイン）

> ステータス: claude 設計 → **codex レビュー待ち（plan gate）** → 合意後に実装
> 起案: claude 2026-06-08
> GOAL: プロジェクトを開くと 上=claude / 下=codex が立ち、claude の指示が **codex ペインに自動投入**され、codex が**見える形**で実装→agmsg返信する。collab を既定ONに。

## 背景・前提
- 以前 collab を既定ONにしたら codex が17プロセス暴走した。原因=ブリッジ二重起動＋ headless codex exec の生み過ぎ。→ 既定OFFにして安定化済み。
- 今回ユーザー希望: **見える2ペイン**（CC上/Cdx下）で codex が動くのを見たい。
- ★重要な状況変化: ダッシュボードサーバーが **cmuxペイン内で動く**ようになった（in-session）。→ **サーバー自身から `cmux send` で codexペインに確実に投入できる**（以前はMonitor/launchdコンテキストで届かず失敗していた）。

## 方式（見える2ペイン＝ペイン投入。headless codex execは使わない＝暴走しない）
1. `projects.json` `defaults.collab` を **true**（project単位で上書き可）。
2. openProject(collab on): CC(claude/上) と Cdx(codex/下) slot を起動。`claude-codex-collab` スキルの **collab.sh init `<projectDir>`** を idempotent に実行し、**agmsgチーム＋CLAUDE.md（claude=plan/codex=実装プロトコル）をセットアップ**。
   - ★ただし **スキルの headless ブリッジは起動しない**（見える2ペイン方式では不要・暴走の元）。setup（team/CLAUDE.md）だけ使う。
3. **ペイン投入デリバリ（ダッシュボードサーバー内・in-pane＝cmux確実到達）**:
   - サーバーが、collab稼働中プロジェクトについて agmsg の to_agent=codex / team=project の未読を一定間隔で監視。
   - 未読があれば、そのプロジェクトの **Cdxペインの surface に `cmux send`** で「📨 claudeから新着。inbox確認→実装→必ずテスト→agmsgで返信」+Enter を投入。
   - ★これは既存ペインへの文字送信のみ。**プロセスを spawn しない**＝runaway構造的に起きない。
   - 単一インスタンス・per-project HWM で二重投入防止・レート制限（最短間隔）。collab稼働中の opened プロジェクトのみ。
4. closeProject: 投入停止＋collab.sh stop（あれば）。
5. `/api/state` に project.collab {enabled, active} を出す。UIに collab インジケータ（任意トグル）。
6. 人間は CC ペインの claude に話す→claude が agmsg send codex→サーバーが Cdx ペインに投入→codex が見える形で実装+返信→claude レビュー。**全部見える**。

## codex への確認事項（plan gate / 実装前に概念レビューを）
1. サーバーから Cdx surface への `cmux send`（in-pane context）でペインcodexがターンを起こす方式に、技術的懸念はあるか？
2. Cdx surface の特定方法（list-pane-surfaces＋slot marker cmuxdash:slot:cdx）でよいか？
3. 二重投入/ループ防止（HWM・codex返信は to_agent=claude なので投入対象外）の設計に穴は？
4. collab.sh init を「setupのみ・headlessブリッジ起動なし」で使う方法（スキルのオプション/環境変数 or init後にbridgeをstop）。
5. デリバリ監視を「サーバー本体の中」に置くか「サーバーが起動する in-pane 子プロセス」に置くか。サーバー本体だと cmux 直列キューと統合できるが本体を重くする。

## 受入条件（合意後）
- collab既定ON・opened projectのみ・単一・runawayしない（codex exec を spawn しない契約）。
- ペイン投入の実機確認（claude→agmsg→Cdxペインにcodexが反応→返信）はclaudeが担当。
- 既存208を壊さない＋ collab デリバリ/HWM/dedup ロジックの単体テスト。
- ./test.sh 全PASS。

## スコープ外
- headless codex exec 方式（今回は見える2ペイン優先）。
- 全プロジェクト一斉collab（opened のみ）。

---

## 合意条件（codex plan-gate レビュー #239 反映・2026-06-08）
このセクションが実装契約。

1. **wake判定は read-only DB（inbox.shを使わない）**: agmsg_db_path を source し `sqlite3 -readonly` で `team=<projectteam> AND to_agent='codex' AND from_agent='claude' AND read_at IS NULL` を見る。サーバーは未読を消費しない（消費するとペインcodexが読めなくなる）。
2. **Cdxへ投入するのは固定wake文のみ**: agmsg本文はペインに貼らない。Cdx側が `inbox.sh` で本文を読む契約（画面/ログへの本文露出を減らす）。
3. **delivered判定とpending retry**: cmux send成功だけでは完了としない。当該messageの read_at が立つ or codex→claude返信を観測するまで pending。pending未readは低頻度retry。**rate limit ＋ single in-flight guard**。HWMは「send済み」だけで前進させず、未readを取りこぼさない。
4. **Cdx surface特定**: marker `cmuxdash:slot:cdx` を第一条件。index/最初のterminal surfaceにフォールバックしない。process=codex は診断/補助のみ。
5. **openProject(collab on) は CC/Cdx slot を必ず作る**: 現状 openProject は workspace 作成のみ。default slots 作成を（再帰しない形で）入れる。
6. **collab.sh は setup専用**: `collab.sh init <dir> --team <team> --no-start`（--no-start で bridge は not-started）。現 ensureCollab() の「init後に headless bridge を nohup start」を分離し、**headlessブリッジは起動しない**。`--force` は使わず CLAUDE.md は既存 managed-block ensureClaudeMd を併用。
7. **旧/残存 headless bridge の停止**: collab有効化時に既存bridgeを検出して止める（二重投入防止）。closeProjectでは delivery停止＋残存bridgeのみ防御的に stop。
8. **collab.active の定義**: 「bridge running」ではなく「**pane delivery active**」を基準に /api/state へ出す。
9. **delivery監視の置き場所**: サーバー本体（既存のcmux直列キュー/health/retry経路を再利用）。巨大ロジックは置かず cmuxctl 側 or 小さな delivery module に分離。`setInterval + single in-flight + (opened && collab && cdx slot present)` 条件で軽く回す。

→ 上記込みで **実装GO**。受入条件は本plan §受入条件＋これら契約の単体テスト。
