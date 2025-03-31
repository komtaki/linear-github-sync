import { LinearClient, Issue } from "@linear/sdk";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

// 環境変数から認証情報とパラメータを取得
const linearApiKey: string | undefined = process.env.LINEAR_API_KEY;
const githubToken: string | undefined = process.env.GITHUB_TOKEN;
const teamKey: string | undefined = process.env.LINEAR_TEAM_ID; // チーム識別子（key）またはチーム名
const owner: string | undefined = process.env.GITHUB_OWNER;
const repo: string | undefined = process.env.GITHUB_REPO;
const projectNumber: string | undefined = process.env.GITHUB_PROJECT_NUMBER;
const assigneeFieldName: string = "Assignees"; // GitHubの担当者フィールド名は固定

// GitHubとLinearのユーザー名マッピング
// キー: GitHubユーザー名、値: Linearユーザー名
const USER_MAPPING: Record<string, string> = {
  'github_user_name': 'linear_user_name',
  // 必要に応じて追加
};

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

使用例：
  LINEAR_API_KEY=xxx GITHUB_TOKEN=yyy LINEAR_TEAM_ID=Engineering GITHUB_OWNER=octocat GITHUB_REPO=my-repo GITHUB_PROJECT_NUMBER=1 npx tsx src/syncGithubAssigneeV2.ts
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
interface GitHubIssue {
  number: number;
  title: string;
  assignee: string | null;
  assigneeId: string | null;
  url: string;
}

interface UpdateInfo {
  linearIssue: Issue;
  githubIssue: GitHubIssue;
  newAssigneeId: string;
  oldAssigneeId: string | null;
  newAssigneeName: string;
  oldAssigneeName: string | null;
}

interface GitHubUser {
  login: string;
  id: number;
  name?: string;
  email?: string;
}

// GitHubのユーザー情報とLinearのユーザー情報を紐付けるためのマップ
const userMappingCache = new Map<string, string>();

async function getIssuesWithAssignee(): Promise<GitHubIssue[]> {
  try {
    console.log("GitHub側のイシューと担当者情報を取得しています...");

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

    const githubIssues: GitHubIssue[] = [];
    let page = 1;
    let hasMoreIssues = true;

    while (hasMoreIssues) {
      console.log(`ページ ${page} のイシューを取得中...`);

      // リポジトリのイシュー一覧を取得（一度に100件まで取得）
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner: validOwner,
        repo: validRepo,
        state: "open", // オープン状態のイシューのみを取得
        per_page: 100,
        page: page,
      });

      console.log(
        `ページ ${page} から ${issues.length} 件のイシューを取得しました`
      );

      // 取得したイシューがない場合はループを終了
      if (issues.length === 0) {
        hasMoreIssues = false;
        break;
      }

      // 各イシューを処理
      for (const issue of issues) {
        if (!issue.pull_request) {
          let assignee: string | null = null;
          let assigneeId: string | null = null;

          if (issue.assignee) {
            assignee = issue.assignee.login;
            assigneeId = issue.assignee.id.toString();
            console.log(`イシュー #${issue.number} の担当者: ${assignee}`);

            githubIssues.push({
              number: issue.number,
              title: issue.title,
              assignee: assignee,
              assigneeId: assigneeId,
              url: issue.html_url,
            });
            console.log(
              `イシューをリストに追加: #${issue.number}, 担当者: ${assignee}`
            );
          } else {
            console.log(
              `スキップ: イシュー #${issue.number} は担当者が設定されていません`
            );
          }
        }
      }

      // 次のページへ
      page++;

      // APIレート制限に近づいたら停止
      if (rateLimit.rate.remaining < 10) {
        console.warn(
          "GitHub APIのレート制限に近づいているため、取得を中断します"
        );
        break;
      }
    }

    console.log(`合計取得イシュー数: ${githubIssues.length}`);
    console.log(
      `担当者が設定されたイシュー: ${
        githubIssues.filter((issue) => issue.assignee !== null).length
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

// Linearのユーザー一覧を取得する関数
async function getLinearUsers(
  linearClient: LinearClient
): Promise<Map<string, { id: string; name: string; email: string | null }>> {
  try {
    console.log("Linearのユーザー一覧を取得中...");

    const usersResponse = await linearClient.users();

    console.log(`${usersResponse.nodes.length} 件のユーザーを取得しました`);

    const userMap = new Map<
      string,
      { id: string; name: string; email: string | null }
    >();

    for (const userNode of usersResponse.nodes) {
      const userData = await userNode;
      console.log(
        `- ${userData.name} (ID: ${userData.id}, Email: ${
          userData.email || "なし"
        })`
      );

      // メールアドレスとユーザー名でマッピングを作成
      if (userData.email) {
        userMap.set(userData.email.toLowerCase(), {
          id: userData.id,
          name: userData.name,
          email: userData.email,
        });
      }

      // ユーザー名でもマッピングを作成 (小文字に変換して照合しやすくする)
      userMap.set(userData.name.toLowerCase(), {
        id: userData.id,
        name: userData.name,
        email: userData.email,
      });
    }

    return userMap;
  } catch (error) {
    console.error("ユーザー情報の取得に失敗しました:", error);
    return new Map();
  }
}

// GitHubのユーザー情報を取得する関数
async function getGitHubUserDetails(login: string): Promise<GitHubUser | null> {
  try {
    console.log(`GitHubユーザー "${login}" の詳細情報を取得中...`);

    const { data: user } = await octokit.rest.users.getByUsername({
      username: login,
    });

    console.log(
      `ユーザー情報を取得しました: ${user.login} (名前: ${
        user.name || "不明"
      }, メール: ${user.email || "不明"})`
    );

    return {
      login: user.login,
      id: user.id,
      name: user.name || undefined,
      email: user.email || undefined,
    };
  } catch (error) {
    console.error(`ユーザー "${login}" の情報取得に失敗しました:`, error);
    return null;
  }
}

// GitHubユーザーとLinearユーザーをマッチングする関数
async function matchUserByNameOrEmail(
  githubUser: GitHubUser,
  linearUsers: Map<string, { id: string; name: string; email: string | null }>
): Promise<string | null> {
  // キャッシュをチェック
  const cachedUserId = userMappingCache.get(githubUser.login);
  if (cachedUserId) {
    return cachedUserId;
  }

  let linearUserId: string | null = null;

  // ユーザーマッピングで定義された対応関係をチェック
  if (USER_MAPPING[githubUser.login]) {
    const linearUserName = USER_MAPPING[githubUser.login];
    console.log(
      `ユーザーマッピングから "${githubUser.login}" → "${linearUserName}" の対応を見つけました`
    );

    // 名前で一致するLinearユーザーを検索
    for (const [key, userData] of linearUsers.entries()) {
      if (
        userData.name === linearUserName ||
        key === linearUserName.toLowerCase()
      ) {
        linearUserId = userData.id;
        console.log(
          `マッピングにより "${linearUserName}" (ID: ${linearUserId}) を割り当てます`
        );
        break;
      }
    }

    if (linearUserId) {
      userMappingCache.set(githubUser.login, linearUserId);
      return linearUserId;
    }
  }

  // マッピングで見つからなかった場合は通常の照合ロジックを実行

  // メールアドレスで照合
  if (githubUser.email) {
    const userByEmail = linearUsers.get(githubUser.email.toLowerCase());
    if (userByEmail) {
      console.log(
        `メールアドレス "${githubUser.email}" で ${userByEmail.name} を見つけました`
      );
      linearUserId = userByEmail.id;
    }
  }

  // 名前で照合（メールアドレスで見つからなかった場合）
  if (!linearUserId && githubUser.name) {
    const userByName = linearUsers.get(githubUser.name.toLowerCase());
    if (userByName) {
      console.log(
        `名前 "${githubUser.name}" で ${userByName.name} を見つけました`
      );
      linearUserId = userByName.id;
    }
  }

  // ユーザー名で照合（上記で見つからなかった場合）
  if (!linearUserId) {
    const userByLogin = linearUsers.get(githubUser.login.toLowerCase());
    if (userByLogin) {
      console.log(
        `ログイン名 "${githubUser.login}" で ${userByLogin.name} を見つけました`
      );
      linearUserId = userByLogin.id;
    }
  }

  // マッチングしたユーザーIDをキャッシュに保存
  if (linearUserId) {
    userMappingCache.set(githubUser.login, linearUserId);
  }

  return linearUserId;
}

async function syncAssignees(): Promise<void> {
  try {
    // Linearクライアントを初期化
    const linearClient = new LinearClient({ apiKey: linearApiKey });

    // チームIDを取得（チーム名またはキーから）
    const teamId = await getTeamIdByKeyOrName(linearClient, validTeamKey);

    // Linearのユーザー一覧を取得
    const linearUsers = await getLinearUsers(linearClient);

    // GitHubプロジェクト情報を取得
    console.log(
      `GitHubプロジェクト (${validOwner}/${validRepo} #${validProjectNumber}) を検索しています...`
    );

    // プロジェクト内のイシューと担当者を取得
    console.log("GitHub側のイシューと担当者情報を取得しています...");
    const githubIssues = await getIssuesWithAssignee();
    console.log(
      `GitHub側から ${githubIssues.length} 件のイシューを取得しました`
    );

    if (githubIssues.length === 0) {
      console.log("処理するイシューがないため、処理を終了します");
      return;
    }

    // LinearとGitHubのタスクを関連付け
    console.log("Linear側のタスクを取得しています...");

    // API呼び出し回数を減らすために一度にLinearタスクを取得
    console.log("Linearからタスクをバッチ取得します...");
    const issueNumberPatterns = githubIssues
      .map((issue) => `${validOwner}/${validRepo}/issues/${issue.number}`)
      .join("|");

    // LinearのAPIはcontainsAnyをサポートしていないため、個別に取得
    console.log("GitHub Issue IDに基づいてLinearタスクを取得します...");
    const allLinearIssues = await linearClient.issues({
      filter: {
        team: { id: { eq: teamId } },
        description: { contains: issueNumberPatterns },
      },
      first: 100,
    });

    console.log(
      `Linear側から ${allLinearIssues.nodes.length} 件のタスクを取得しました`
    );

    // Linearタスクをマッピング
    const linearTaskMap = new Map<string, Issue[]>();
    for (const linearIssue of allLinearIssues.nodes) {
      for (const githubIssue of githubIssues) {
        const issuePattern = `${validOwner}/${validRepo}/issues/${githubIssue.number}`;
        if (
          linearIssue.description &&
          linearIssue.description.includes(issuePattern)
        ) {
          const key = issuePattern;
          if (!linearTaskMap.has(key)) {
            linearTaskMap.set(key, []);
          }
          linearTaskMap.get(key)?.push(linearIssue);
        }
      }
    }

    // GitHubイシューとLinearタスクを名前でマッチング
    const updates: UpdateInfo[] = [];
    for (const githubIssue of githubIssues) {
      if (!githubIssue.assignee) {
        continue; // 担当者がない場合はスキップ
      }

      console.log(
        `GitHubイシュー #${githubIssue.number} (${githubIssue.title}) に対応するLinearタスクを検索中...`
      );

      // 説明に「View original issue in GitHub」リンクと同じイシュー番号があるタスクを検索
      const issueNumberPattern = `${validOwner}/${validRepo}/issues/${githubIssue.number}`;
      const allMatchingIssues = await linearClient.issues({
        filter: {
          team: { id: { eq: teamId } },
          title: { eq: githubIssue.title.trim() },
          description: { contains: issueNumberPattern },
        },
      });

      // ここで更新処理を行う
      if (allMatchingIssues.nodes.length > 0) {
        // GitHubのユーザー情報を取得
        const githubUserDetails = await getGitHubUserDetails(
          githubIssue.assignee
        );

        if (githubUserDetails) {
          // LinearユーザーとGitHubユーザーをマッチング
          const linearUserId = await matchUserByNameOrEmail(
            githubUserDetails,
            linearUsers
          );

          if (linearUserId) {
            for (const linearIssue of allMatchingIssues.nodes) {
              // 現在の担当者を取得
              const currentAssignee = linearIssue.assignee;
              const currentAssigneeName = currentAssignee
                ? (await currentAssignee).name
                : null;
              const currentAssigneeId = currentAssignee
                ? (await currentAssignee).id
                : null;

              // 担当者が異なる場合のみ更新対象に追加
              if (currentAssigneeId !== linearUserId) {
                const linearUserInfo = Array.from(linearUsers.values()).find(
                  (user) => user.id === linearUserId
                );

                updates.push({
                  linearIssue,
                  githubIssue,
                  newAssigneeId: linearUserId,
                  oldAssigneeId: currentAssigneeId,
                  newAssigneeName: linearUserInfo
                    ? linearUserInfo.name
                    : "不明",
                  oldAssigneeName: currentAssigneeName,
                });
              }
            }
          } else {
            console.log(
              `GitHubユーザー "${githubIssue.assignee}" に対応するLinearユーザーが見つかりませんでした`
            );
          }
        } else {
          console.log(
            `GitHubユーザー "${githubIssue.assignee}" の詳細情報を取得できませんでした`
          );
        }
      } else {
        console.log(
          `GitHubイシュー #${githubIssue.number} (${githubIssue.title}) に一致するLinearタスクが見つかりませんでした`
        );
      }
    }

    console.log(`更新対象のタスク: ${updates.length}件`);

    // 担当者の更新を実行
    for (const update of updates) {
      try {
        const {
          linearIssue,
          newAssigneeId,
          oldAssigneeName,
          newAssigneeName,
          githubIssue,
        } = update;

        // Linear SDK v2以降では、issueUpdateではなくissueオブジェクトを取得して更新する
        const issue = await linearClient.issue(linearIssue.id);
        await issue.update({ assigneeId: newAssigneeId });

        console.log(
          `更新完了: ${linearIssue.identifier} - "${linearIssue.title}"`
        );
        console.log(
          `  担当者: ${
            oldAssigneeName || "未割り当て"
          } -> ${newAssigneeName} (GitHub側の値: ${githubIssue.assignee})`
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

syncAssignees();
