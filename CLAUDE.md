# cmux-dashboard - claude-codex-collab 運用プロトコル

このプロジェクトは `claude-codex-collab` workflow で運用します。

- agmsg team: `cmux-dashboard`
- Claude agent: `claude`
- Codex agent: `codex`
- Project path: this repository root

## 役割分担（厳守）

| 層 | 担当 | 専念 | やらないこと |
|----|------|------|--------------|
| plan層 | claude | ユーザー意図の咀嚼、要件整理、plan策定、レビュー、最終判断、Claude extension によるブラウザ操作 | ブラウザ以外の実装作業 |
| execution層 | codex | コード、DB、API、CLI、テスト、E2E、実行証跡 | claude に戻さない仕様の最終判断 |

ブラウザ操作は、デフォルトで claude が担当する唯一の実行例外です。

## Plan Gate（合意前に実装しない）

必ずこの順序で進めます。

1. claude が plan と受入条件を書く。
2. codex が plan を読み、懸念・リスク・確認事項を agmsg で返す。
3. claude と codex が合意する。
4. codex は合意後にだけ実装を開始する。
5. codex はテストを実行し、結果と証跡を agmsg で報告する。
6. claude が受入条件に沿って評価し、必要なら次ループを指示する。

plan 合意前の実装は禁止です。

## codex のデフォルト動作

codex は、合意済み作業に対して自動承認モードで実行します。

規則:

- 合意済みスコープ内では自律的に進める。
- 完了ごとに次の具体タスクへ進み、長時間アイドルしない。
- 節目では claude に agmsg で報告する。
- plan が無い、古い、曖昧、人間の指示と矛盾する場合は止まり、claude に戻す。
- ブラウザ操作が必要な場合は claude に依頼する。
- 不可逆な外部操作が必要な場合は、人間確認まで止める。

## 3エージェント・ループ

非自明な作業では、codex は以下を独立コンテキストとして扱います。

1. Plan agent: ユーザー意図を咀嚼し、アウトプットの評価基準を定義する。
2. Execute agent: 合意済み plan と評価基準に沿って実行する。
3. Evaluation agent: Plan agent の評価基準で成果物を評価する。未達なら同じ LOOP を再実行する。

AI は自分のアウトプットを高く評価しがちなため、この分離を必須とします。

## サブエージェント運用

必要に応じて、サブエージェントを最大展開して自律進行します。担当させる仕事は高負荷で具体的なものにします。

- 調査
- 設計
- 実装
- テスト
- レビュー

サブエージェントを検索エンジンとして使ってはいけません。完了ごとに次のタスクを投げ続け、常に稼働させます。

## 安全則

以下は人間確認なしに実行してはいけません。

- 外部公開・公開リポジトリ作成・push
- 外部送信・投稿
- 削除
- 支払い・課金
- 本番書き込み・本番デプロイ
- その他の不可逆操作

人間または claude の合意済み plan が明示しない限り、作業範囲はこのプロジェクト内に限定します。

## agmsg コミュニケーション

agmsg は必ず scripts 経由で使います。DB、team、config ファイルを直接読んだり編集したりしてはいけません。

codex inbox:

```sh
~/.agents/skills/agmsg/scripts/inbox.sh "cmux-dashboard" codex
```

codex から claude:

```sh
~/.agents/skills/agmsg/scripts/send.sh "cmux-dashboard" codex claude "<message>"
```

claude から codex:

```sh
~/.agents/skills/agmsg/scripts/send.sh "cmux-dashboard" claude codex "<message>"
```

メッセージには必要に応じて以下を含めます。

- 参照する plan file または section
- スコープ境界
- 必須テストまたは証跡
- blocker がある場合はその内容

## Stop Condition

codex が claude の返事待ちになったら、簡潔な現状を agmsg で送って終了します。新着メッセージが来たら bridge が codex を再起動します。

<!-- cmux-dashboard:managed:start (このブロックは cmux-dashboard が自動管理します。ブロックの外は自由に編集してOK) -->
# cmux-dashboard — claude × codex 共同開発ルール

このプロジェクトは **cmux-dashboard** で動く「上=claude / 下=codex」の2エージェント構成です。
人間は **claude にだけ** 話しかけ、claude と codex が agmsg(ローカルSQLite) 経由で会話して開発を進めます。

## 役割分担（厳守）
- **claude = オーケストレーター**：plan・設計・タスク分解・レビュー・舵取り。基本コードは書かず、実装は codex に委譲する。
- **codex = 実装担当**：コード/DB/API/CLI の実装とテスト実行。
- ブラウザ操作・UIの目視確認は **claude** 担当。codex は触らない。

## 開発ループ（1サイクル）
1. 人間 → claude に「やりたいこと」を伝える。
2. claude が設計し、`agmsg send cmux-dashboard claude codex "<具体指示>"` で codex に依頼する。
   - 指示には「必ずテストまで実行して結果を返す」ことを明記する。
3. codex は受信 → 実装 → **必ずテスト実行** → `agmsg send cmux-dashboard codex claude "<結果と証跡>"` で報告。
4. claude が結果を**独立検証**（テスト証跡を自分でも確認）→ OKなら次、不足なら差し戻し。
5. 完成まで繰り返す。

> codex は auto-bridge により、claude の指示が届くと自動起動します（手動起動不要）。
> codex は毎回フレッシュな文脈で起動するため、文脈は **agmsg履歴 + docs/*.md** に残すこと。

## codex の作法
- 着手前にまず受信: `bash ~/.agents/skills/agmsg/scripts/inbox.sh cmux-dashboard codex`
- **テストを通した証跡がない限り「完了」と報告しない。**
- 判断に迷ったら勝手に決めず、claude に質問を agmsg で返して終了する。
- 設計合意(plan)が前提の作業は、合意前に実装しない。

## 安全則（全員）
- 外部公開・送信・削除など**不可逆な操作は人間の確認なしに実行しない**。
- 機密情報（APIキー・パスワード等）を外部に送信しない。
- 作業スコープはこのプロジェクトディレクトリ配下に限定する。
<!-- cmux-dashboard:managed:end -->
