import { LinearClient, Issue, Team } from "@linear/sdk";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

// 環境変数から認証情報とパラメータを取得
const linearApiKey: string | undefined = process.env.LINEAR_API_KEY;
const githubToken: string | undefined = process.env.GITHUB_TOKEN;
const teamKey: string | undefined = process.env.LINEAR_TEAM_ID; // チーム識別子（key）またはチーム名
const owner: string | undefined = process.env.GITHUB_OWNER;
const repo: string | undefined = process.env.GITHUB_REPO;
const projectNumber: string | undefined = process.env.GITHUB_PROJECT_NUMBER;
const priorityFieldName: string =
  process.env.GITHUB_PRIORITY_FIELD || "Priority"; // デフォルト値としてPriorityフィールド名を設定

// 必須パラメータの検証
if (!linearApiKey || !githubToken) {
  console.error("LINEAR_API_KEY と GITHUB_TOKEN 環境変数が必要です");
  process.exit(1);
}

if (!teamKey || !owner || !repo || !projectNumber) {
  console.error(`
必須環境変数が設定されていません。以下の環境変数をすべて設定してください：
  LINEAR_TEAM_ID: Linearのチームの識別子またはチーム名
  GITHUB_OWNER: GitHubのオーナー名（ユーザーまたは組織）
  GITHUB_REPO: GitHubのリポジトリ名
  GITHUB_PROJECT_NUMBER: GitHubプロジェクトの番号

オプションの環境変数：
  GITHUB_PRIORITY_FIELD: 優先度を示すフィールド名（デフォルト：Priority）

使用例：
  LINEAR_API_KEY=xxx GITHUB_TOKEN=yyy LINEAR_TEAM_ID=Engineering GITHUB_OWNER=octocat GITHUB_REPO=my-repo GITHUB_PROJECT_NUMBER=1 GITHUB_PRIORITY_FIELD=優先度 npx tsx src/syncGithubPriorityV2.ts
`);
  process.exit(1);
}

// ここまでチェックされている変数は string として扱える
const validTeamKey: string = teamKey;
const validOwner: string = owner;
const validRepo: string = repo;
const validProjectNumber: string = projectNumber;

// GitHub REST APIクライアントの初期化
const octokit = new Octokit({
  auth: githubToken,
});

// 型定義
interface ProjectInfo {
  projectId: number;
  projectTitle: string;
  priorityFieldId: string;
  priorityOptions: PriorityOption[];
}

interface PriorityOption {
  id: string;
  name: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  priority: string;
  url: string;
}

interface UpdateInfo {
  linearIssue: Issue;
  githubIssue: GitHubIssue;
  newPriority: number;
  oldPriority: number;
}

// GitHub Project V2用の型定義
interface ProjectV2Field {
  id: string;
  name: string;
  options?: { id: string; name: string }[];
}

interface ProjectV2FieldValue {
  field?: {
    name?: string;
  };
  name?: string;
}

interface ProjectV2Item {
  id: string;
  content?: {
    number?: number;
    title?: string;
    repository?: {
      name?: string;
    };
  };
  fieldValues: {
    nodes: ProjectV2FieldValue[];
  };
}

interface ProjectV2Response {
  organization: {
    projectV2: {
      id: string;
      title: string;
      fields: {
        nodes: ProjectV2Field[];
      };
      items: {
        nodes: ProjectV2Item[];
      };
    };
  };
}

// GitHub優先度をLinear優先度に変換する関数
function mapGithubPriorityToLinear(githubPriority: string | null): number {
  if (!githubPriority) return 0;

  const priorityLower = githubPriority.toLowerCase();

  if (priorityLower.includes("p1")) {
    return 1; // 緊急
  } else if (priorityLower.includes("p2")) {
    return 2; // 高
  } else if (priorityLower.includes("p3")) {
    return 3; // 中
  } else {
    return 0; // 優先度なし
  }
}

async function getIssuesWithPriority(): Promise<GitHubIssue[]> {
  try {
    console.log("GitHub側のイシューと優先度情報を取得しています...");

    // テスト用にAPIリクエストを表示
    console.log("GitHub GraphQLクエリでプロジェクトを取得します");

    try {
      // プロジェクト情報をGraphQL APIで取得
      const graphqlWithAuth = graphql.defaults({
        headers: {
          authorization: `token ${githubToken}`,
        },
      });

      // プロジェクトのIDを取得
      const projectInfo = await graphqlWithAuth<ProjectV2Response>(`
        query {
          organization(login: "${validOwner}") {
            projectV2(number: ${validProjectNumber}) {
              id
              title
              fields(first: 20) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
              }
              items(first: 50) {
                nodes {
                  id
                  content {
                    ... on Issue {
                      number
                      title
                      url
                      repository {
                        name
                      }
                    }
                  }
                  fieldValues(first: 10) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        field {
                          ... on ProjectV2SingleSelectField {
                            name
                          }
                        }
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);

      console.log(
        `GitHub Project V2を取得しました: ${projectInfo.organization.projectV2.title}`
      );

      // 優先度フィールドを探す
      const priorityField =
        projectInfo.organization.projectV2.fields.nodes.find(
          (field: ProjectV2Field) => field.name === priorityFieldName
        );

      if (!priorityField) {
        console.error(
          `プロジェクトに「${priorityFieldName}」フィールドが見つかりません。フィールド名を確認してください。`
        );
        const availableFields = projectInfo.organization.projectV2.fields.nodes
          .filter((node: ProjectV2Field) => node.name)
          .map((node: ProjectV2Field) => node.name)
          .join(", ");
        console.log(`利用可能なフィールド: ${availableFields}`);
        return [];
      }

      console.log(`優先度フィールドを見つけました: ${priorityField.name}`);

      const githubIssues: GitHubIssue[] = [];

      // 各イシューを処理
      for (const item of projectInfo.organization.projectV2.items.nodes) {
        if (
          item.content &&
          item.content.repository &&
          item.content.repository.name === validRepo
        ) {
          const issueNumber = item.content.number;
          const issueTitle = item.content.title;

          // issueNumberとissueTitleがundefinedでないことを確認
          if (issueNumber === undefined || issueTitle === undefined) {
            console.log(`スキップ: イシュー情報が不完全です`);
            continue;
          }

          console.log(
            `プロジェクト内のイシュー見つかりました: #${issueNumber} - ${issueTitle}`
          );

          // 優先度フィールドの値を取得
          const priorityValue = item.fieldValues.nodes.find(
            (value: ProjectV2FieldValue) =>
              value.field && value.field.name === priorityFieldName
          );

          let priority = "none";
          if (priorityValue && priorityValue.name) {
            priority = priorityValue.name;
            console.log(`イシュー #${issueNumber} の優先度: ${priority}`);

            // 優先度が設定されている場合のみ処理
            if (
              priority.toLowerCase().includes("p1") ||
              priority.toLowerCase().includes("p2") ||
              priority.toLowerCase().includes("p3")
            ) {
              githubIssues.push({
                number: issueNumber,
                title: issueTitle,
                priority: priority,
                url: `https://github.com/${validOwner}/${validRepo}/issues/${issueNumber}`,
              });
              console.log(
                `イシューをリストに追加: #${issueNumber}, 優先度: ${priority}`
              );
            } else {
              console.log(
                `スキップ: イシュー #${issueNumber} はプロジェクトに登録されていますが、有効な優先度が設定されていません`
              );
            }
          } else {
            console.log(
              `スキップ: イシュー #${issueNumber} は優先度が設定されていません`
            );
          }
        }
      }

      console.log(`取得したイシュー数: ${githubIssues.length}`);
      console.log(
        `優先度が設定されたイシュー: ${
          githubIssues.filter((issue) => issue.priority !== "none").length
        } 件`
      );

      return githubIssues;
    } catch (error) {
      console.error("GraphQL APIエラー:", error);
      // エラーが発生した場合は、従来のRESTメソッドにフォールバック
      console.log("従来のREST APIメソッドにフォールバックします");
      const githubIssues = await getIssuesWithPriorityREST();
      return githubIssues;
    }
  } catch (error) {
    console.error("イシュー取得エラー:", error);
    return [];
  }
}

// 従来のREST APIを使用してイシューと優先度を取得する関数
async function getIssuesWithPriorityREST(): Promise<GitHubIssue[]> {
  try {
    console.log(
      "REST APIを使用してGitHub側のイシューと優先度情報を取得しています..."
    );

    // レート制限状況を取得
    const { data: rateLimit } = await octokit.rest.rateLimit.get();
    console.log(
      `GitHub API レート制限状況: ${rateLimit.rate.remaining}/${rateLimit.rate.limit} リクエスト残り`
    );

    if (rateLimit.rate.remaining < 50) {
      console.warn(
        `警告: GitHubのAPIレート制限が少なくなっています (残り ${rateLimit.rate.remaining} リクエスト)`
      );
      const resetDate = new Date(rateLimit.rate.reset * 1000);
      console.warn(`リセット時間: ${resetDate.toLocaleString()}`);
    }

    // リポジトリのイシュー一覧を取得（一度に100件まで取得）
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner: validOwner,
      repo: validRepo,
      state: "open",
      per_page: 100, // 100件に減らす
    });

    console.log(`リポジトリから ${issues.length} 件のイシューを取得しました`);

    // プロジェクトの情報を取得
    console.log(`プロジェクト #${validProjectNumber} の情報を取得中...`);
    const { data: project } = await octokit.rest.projects.get({
      project_id: parseInt(validProjectNumber, 10),
    });
    console.log(`プロジェクト名: ${project.name}`);

    // プロジェクトのカード一覧を取得
    console.log("プロジェクトのカード情報を取得中...");
    const projectCards: { issueNumber: number; priority: string }[] = [];

    // プロジェクトのカラム一覧を取得
    const { data: columns } = await octokit.rest.projects.listColumns({
      project_id: project.id,
    });

    // 各カラムのカードを取得（カラムの数を制限）
    for (const column of columns.slice(0, 5)) {
      console.log(`カラム "${column.name}" のカード情報を取得中...`);

      // APIリクエスト間の遅延を増やす
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // カードを最大50件ずつ取得（数を減らす）
      const { data: cards } = await octokit.rest.projects.listCards({
        column_id: column.id,
        per_page: 50,
        page: 1,
      });

      console.log(
        `カラム "${column.name}" から ${cards.length} 件のカードを取得しました`
      );

      // カードに関連するイシュー情報を取得
      for (const card of cards) {
        if (card.content_url) {
          const match = card.content_url.match(/\/issues\/(\d+)$/);
          if (match) {
            const issueNumber = parseInt(match[1], 10);

            // カードのメタデータから優先度を取得
            let priority = "none";

            // カラム名をチェックして優先度を判定
            const columnNameLower = column.name.toLowerCase();
            if (columnNameLower.includes("p1")) {
              priority = "P1";
            } else if (columnNameLower.includes("p2")) {
              priority = "P2";
            } else if (columnNameLower.includes("p3")) {
              priority = "P3";
            }

            // 既存のカードがあれば上書きせず、なければ追加
            const existingCard = projectCards.find(
              (c) => c.issueNumber === issueNumber
            );
            if (existingCard) {
              if (existingCard.priority === "none" && priority !== "none") {
                existingCard.priority = priority;
                console.log(
                  `イシュー #${issueNumber} の優先度を更新: ${priority} (カラム: ${column.name})`
                );
              }
            } else {
              projectCards.push({ issueNumber, priority });
              console.log(
                `イシュー #${issueNumber} の優先度: ${priority} (カラム: ${column.name})`
              );
            }
          }
        }
      }
    }

    console.log(
      `プロジェクトから ${projectCards.length} 件のカード情報を取得しました`
    );
    console.log(
      `優先度が設定されたカード: ${
        projectCards.filter((card) => card.priority !== "none").length
      } 件`
    );

    const githubIssues: GitHubIssue[] = [];

    // 各イシューを処理
    for (const issue of issues) {
      if (!issue.pull_request) {
        // PRではなくイシューのみを処理
        console.log(
          `イシュー見つかりました: #${issue.number} - ${issue.title}`
        );

        // プロジェクトから優先度を取得
        let priority = "none";
        const projectCard = projectCards.find(
          (card) => card.issueNumber === issue.number
        );

        if (projectCard) {
          priority = projectCard.priority;
          console.log(
            `プロジェクトから優先度を取得: ${priority} (イシュー #${issue.number})`
          );

          // プロジェクトで優先度が設定されている場合のみ処理
          if (priority !== "none") {
            githubIssues.push({
              number: issue.number,
              title: issue.title,
              priority: priority,
              url: issue.html_url,
            });

            console.log(
              `イシューをリストに追加: #${issue.number}, 優先度: ${priority}`
            );
          } else {
            console.log(
              `スキップ: イシュー #${issue.number} はプロジェクトに登録されていますが、優先度が設定されていません`
            );
          }
        } else {
          console.log(
            `スキップ: イシュー #${issue.number} はプロジェクトに登録されていないため処理しません`
          );
        }
      }
    }

    console.log(`取得したイシュー数: ${githubIssues.length}`);
    console.log(
      `優先度が設定されたイシュー: ${
        githubIssues.filter((issue) => issue.priority !== "none").length
      } 件`
    );

    return githubIssues;
  } catch (error) {
    console.error("イシュー取得エラー:", error);
    return [];
  }
}

// チームIDをチーム名またはキーから取得する関数
async function getTeamIdByKeyOrName(
  linearClient: LinearClient,
  teamKeyOrName: string
): Promise<string> {
  try {
    console.log(
      `Linearからチーム「${teamKeyOrName}」の情報を取得しています...`
    );

    // チームの一覧を取得
    console.log("LinearのAPI呼び出し: 全チーム取得を開始");
    const teams = await linearClient.teams();
    console.log(
      `LinearのAPI呼び出し: 全チーム取得完了 (${teams.nodes.length}件)`
    );

    console.log("利用可能なチームリスト:");
    teams.nodes.forEach((team) => {
      console.log(`- ${team.name} (key: ${team.key}, id: ${team.id})`);
    });

    // チーム名またはキーに一致するチームを探す
    const team = teams.nodes.find(
      (team) => team.name === teamKeyOrName || team.key === teamKeyOrName
    );

    if (!team) {
      console.error(
        `チーム「${teamKeyOrName}」が見つかりません。利用可能なチーム: ${teams.nodes
          .map((t) => `${t.name} (${t.key})`)
          .join(", ")}`
      );
      process.exit(1);
    }

    console.log(
      `チームが見つかりました: ${team.name} (${team.key}), ID: ${team.id}`
    );
    return team.id;
  } catch (error) {
    console.error("チーム情報の取得に失敗しました:", error);
    console.log("エラーの詳細:");
    console.log(JSON.stringify(error, null, 2));
    process.exit(1);
  }
}

async function syncPriorities(): Promise<void> {
  try {
    // Linearクライアントを初期化
    const linearClient = new LinearClient({ apiKey: linearApiKey });

    // チームIDを取得（チーム名またはキーから）
    const teamId = await getTeamIdByKeyOrName(linearClient, validTeamKey);

    // GitHubプロジェクト情報を取得
    console.log(
      `GitHubプロジェクト (${validOwner}/${validRepo} #${validProjectNumber}) を検索しています...`
    );

    // プロジェクト内のイシューと優先度を取得
    console.log("GitHub側のイシューと優先度情報を取得しています...");
    const githubIssues = await getIssuesWithPriority();
    console.log(
      `GitHub側から ${githubIssues.length} 件のイシューを取得しました`
    );

    if (githubIssues.length === 0) {
      console.log("処理するイシューがないため、処理を終了します");
      return;
    }

    // GitHubイシューとLinearタスクを名前でマッチング
    const updates: UpdateInfo[] = [];
    for (const githubIssue of githubIssues) {
      console.log(
        `GitHubイシュー #${githubIssue.number} (${githubIssue.title}) に対応するLinearタスクを検索中...`
      );

      // 説明に「View original issue in GitHub」リンクと同じイシュー番号があるタスクを検索
      const issueNumberPattern = `${validOwner}/${validRepo}/issues/${githubIssue.number}`;
      const allMatchingIssues = await linearClient.issues({
        filter: {
          team: { id: { eq: teamId } },
          state: { type: { neq: "completed" } },
          title: { eq: githubIssue.title.trim() },
          description: { contains: issueNumberPattern },
        },
      });
      // ここで更新処理を行う
      if (allMatchingIssues.nodes.length > 0) {
        const linearPriority = mapGithubPriorityToLinear(githubIssue.priority);

        console.log(
          `GitHubイシュー: #${githubIssue.number} - ${githubIssue.url} - ${githubIssue.priority}`,
          `Linearタスク: ${allMatchingIssues.nodes[0].identifier} - "${allMatchingIssues.nodes[0].title}" - ${linearPriority}`
        );

        for (const linearIssue of allMatchingIssues.nodes) {
          if (linearIssue.priority !== linearPriority) {
            updates.push({
              linearIssue,
              githubIssue,
              newPriority: linearPriority,
              oldPriority: linearIssue.priority,
            });
          }
        }
      } else {
        console.log(
          `GitHubイシュー #${githubIssue.number} (${githubIssue.title}) に一致するLinearタスクが見つかりませんでした`
        );
      }
    }

    console.log(`更新対象のタスク: ${updates.length}件`);

    // 優先度の更新を実行
    for (const update of updates) {
      try {
        const { linearIssue, newPriority, oldPriority, githubIssue } = update;

        // Linear SDK v2以降では、issueUpdateではなくissueオブジェクトを取得して更新する
        const issue = await linearClient.issue(linearIssue.id);
        await issue.update({ priority: newPriority });

        console.log(
          `更新完了: ${linearIssue.identifier} - "${linearIssue.title}"`
        );
        console.log(
          `  優先度: ${oldPriority} -> ${newPriority} (GitHub側の値: ${githubIssue.priority})`
        );
        console.log(
          `  GitHubイシュー: #${githubIssue.number} - ${githubIssue.url}`
        );
      } catch (error) {
        console.error(
          `エラー: ${update.linearIssue.identifier} の更新に失敗しました`,
          error
        );
      }
    }

    console.log("同期処理が完了しました");
  } catch (error) {
    console.error("エラーが発生しました:", error);
  }
}

syncPriorities();
