# Linear-GitHub 同期ツール

このツールは、GitHub と Linear 間でイシューの情報を同期するためのスクリプトを提供します。具体的には、以下の2つの同期機能を持っています：

1. **優先度の同期 (GitHub → Linear)**
   - GitHub のイシューに設定された優先度を Linear のイシューに反映します
   - `syncGithubPriority.ts` スクリプトを使用

2. **担当者の同期 (GitHub → Linear)**
   - GitHub のイシューに設定された担当者を Linear のイシューに反映します
   - `syncGithubAssignee.ts` スクリプトを使用

## 前提条件

- Node.js v18 以上
- TypeScript
- Linear API キー
- GitHub パーソナルアクセストークン

## インストール

```bash
# パッケージのインストール
npm install
```

## 環境設定

`.env` ファイルを作成し、以下の環境変数を設定します（`.env.sample` を参考にしてください）：

```bash
# Linear API認証情報
LINEAR_API_KEY=your_linear_api_key_here

# Linear 共通設定
LINEAR_TEAM_ID=Engineering  # チーム名またはキー(例: ENG)

# GitHub設定
GITHUB_TOKEN=your_github_token_here
GITHUB_OWNER=octocat
GITHUB_REPO=my-repo
GITHUB_PROJECT_NUMBER=1
GITHUB_PRIORITY_FIELD=Priority
```

## 使用方法

### 優先度の同期

```bash
npm run build
npm run start:sync-priority
```

### 担当者の同期

```bash
npm run build
npm run start:sync-assign
```

## ユーザー名マッピング

`syncGithubAssignee.ts` スクリプト内の `USER_MAPPING` オブジェクトで、GitHub ユーザー名と Linear ユーザー名（メールアドレス）のマッピングを定義できます。

例：
```typescript
const USER_MAPPING: Record<string, string> = {
  "github-username": "linear-email@example.com",
  // 他のマッピングを追加
};
```

## 注意事項

- このツールは GitHub から Linear への一方向の同期のみをサポートしています
- API レート制限に注意してください
- 大量のイシューがある場合、同期処理に時間がかかることがあります

## ライセンス

ISC
