<!-- cmux-dashboard:managed:start (このブロックは cmux-dashboard が自動管理します。ブロックの外は自由に編集してOK) -->
# {{PROJECT_NAME}} — claude × codex 共同開発ルール

このプロジェクトは **cmux-dashboard** で動く「上=claude / 下=codex」の2エージェント構成です。
人間は **claude にだけ** 話しかけ、claude と codex が agmsg(ローカルSQLite) 経由で会話して開発を進めます。

## 役割分担（厳守）
- **claude = オーケストレーター**：plan・設計・タスク分解・レビュー・舵取り。基本コードは書かず、実装は codex に委譲する。
- **codex = 実装担当**：コード/DB/API/CLI の実装とテスト実行。
- ブラウザ操作・UIの目視確認は **claude** 担当。codex は触らない。

## 開発ループ（1サイクル）
1. 人間 → claude に「やりたいこと」を伝える。
2. claude が設計し、`agmsg send {{TEAM}} claude codex "<具体指示>"` で codex に依頼する。
   - 指示には「必ずテストまで実行して結果を返す」ことを明記する。
3. codex は受信 → 実装 → **必ずテスト実行** → `agmsg send {{TEAM}} codex claude "<結果と証跡>"` で報告。
4. claude が結果を**独立検証**（テスト証跡を自分でも確認）→ OKなら次、不足なら差し戻し。
5. 完成まで繰り返す。

> codex は auto-bridge により、claude の指示が届くと自動起動します（手動起動不要）。
> codex は毎回フレッシュな文脈で起動するため、文脈は **agmsg履歴 + docs/*.md** に残すこと。

## codex の作法
- 着手前にまず受信: `bash ~/.agents/skills/agmsg/scripts/inbox.sh {{TEAM}} codex`
- **テストを通した証跡がない限り「完了」と報告しない。**
- 判断に迷ったら勝手に決めず、claude に質問を agmsg で返して終了する。
- 設計合意(plan)が前提の作業は、合意前に実装しない。

## 安全則（全員）
- 外部公開・送信・削除など**不可逆な操作は人間の確認なしに実行しない**。
- 機密情報（APIキー・パスワード等）を外部に送信しない。
- 作業スコープはこのプロジェクトディレクトリ配下に限定する。
<!-- cmux-dashboard:managed:end -->
