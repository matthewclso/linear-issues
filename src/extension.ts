import * as vscode from "vscode";
import { LinearClient, User } from "@linear/sdk";

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read"];

interface Issue {
  identifier: string;
  title: string;
  team: string;
  project: string;
  state: string;
}

interface IssueCategory {
  status: string;
  issues: Issue[];
}

interface ProjectCategory {
  project: string;
  states: IssueCategory[];
}

interface TeamCategory {
  team: string;
  projects: ProjectCategory[];
}

async function getClient(): Promise<LinearClient> {
  const session = await vscode.authentication.getSession(
    LINEAR_AUTHENTICATION_PROVIDER_ID,
    LINEAR_AUTHENTICATION_SCOPES,
    { createIfNone: true },
  );

  if (!session) {
    vscode.window.showErrorMessage(`Linear login failed.`);
  }

  const linearClient = new LinearClient({
    accessToken: session.accessToken,
  });

  return linearClient;
}

function groupBy<T, K extends keyof T>(arr: T[], key: K): Record<string, T[]> {
  return arr.reduce(
    (result, item) => {
      const groupKey = item[key];
      (result[groupKey as string] ||= []).push(item);
      return result;
    },
    {} as Record<string, T[]>,
  );
}

interface IssueResponse {
  identifier: string;
  title: string;
  team: {
    name: string;
  };
  project: {
    name: string;
  } | null;
  state: {
    name: string;
  };
}

interface IssuesResponse {
  issues: {
    nodes: IssueResponse[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string;
    };
  };
}

async function getIssues(
  linearClient: LinearClient,
  me?: User,
): Promise<TeamCategory[]> {
  const issuesResponse: IssueResponse[] = [];

  const baseQuery = `
    nodes {
      identifier
      title
      team {
        name
      }
      project {
        name
      }
      state {
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  `;

  let baseFilter = "(first: 50)";
  if (me) {
    baseFilter =
      baseFilter.slice(0, -1) +
      `, filter: { assignee: { id: { eq: "${me.id}" } } })`;
  }

  let query = `
    query {
      issues${baseFilter} {
        ${baseQuery}
      }
    }
  `;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      cancellable: false,
      title: "Fetching issues...",
    },
    async (progress) => {
      progress.report({ increment: 0 });

      let data = (await linearClient.client
        .rawRequest(query)
        .then((response) => response.data)) as IssuesResponse;
      issuesResponse.push(...data.issues.nodes);

      while (data.issues.pageInfo.hasNextPage) {
        const filter =
          baseFilter.slice(0, -1) +
          `, after: "${data.issues.pageInfo.endCursor}")`;
        query = `
        query {
          issues${filter} {
            ${baseQuery}
          }
        }
      `;
        data = (await linearClient.client
          .rawRequest(query)
          .then((response) => response.data)) as IssuesResponse;
        issuesResponse.push(...data.issues.nodes);
      }

      progress.report({ increment: 100 });
    },
  );

  let issues = issuesResponse.map((issue) => ({
    identifier: issue.identifier,
    title: issue.title,
    team: issue.team.name,
    project: issue.project ? issue.project.name : "No project",
    state: issue.state.name,
  }));

  // filter out issues that have 'Done', 'Canceled', or 'Duplicate' state
  issues = issues.filter(
    (issue) => !["Done", "Canceled", "Duplicate"].includes(issue.state),
  );

  // move 'No Project' issues to the beginning
  const noProjectIssues = issues.filter(
    (issue) => issue.project === "No project",
  );
  issues = issues.filter((issue) => issue.project !== "No project");
  issues = noProjectIssues.concat(issues);

  const groupedIssues: TeamCategory[] = [];

  let teams = groupBy(issues, "team");
  for (const team in teams) {
    const projects = groupBy(teams[team], "project");
    const teamCategory: TeamCategory = {
      team,
      projects: [],
    };
    for (const project in projects) {
      const states = groupBy(projects[project], "state");
      const projectCategory: ProjectCategory = {
        project,
        states: [],
      };
      for (const state in states) {
        projectCategory.states.push({
          status: state,
          issues: states[state],
        });
      }
      teamCategory.projects.push(projectCategory);
    }
    groupedIssues.push(teamCategory);
  }

  return groupedIssues;
}

export function activate(context: vscode.ExtensionContext) {
  const allIssuesProvider = new LinearIssueProvider();
  vscode.window.registerTreeDataProvider("allIssues", allIssuesProvider);
  vscode.commands.registerCommand(
    "linear-issues.refreshAllIssues",
    async () => {
      const linearClient = await getClient();
      allIssuesProvider.refresh(await getIssues(linearClient));
    },
  );

  const myIssuesProvider = new LinearIssueProvider();
  vscode.window.registerTreeDataProvider("myIssues", myIssuesProvider);
  vscode.commands.registerCommand("linear-issues.refreshMyIssues", async () => {
    const linearClient = await getClient();
    const me = await linearClient.viewer;
    myIssuesProvider.refresh(await getIssues(linearClient, me));
  });

  Promise.all([
    vscode.commands.executeCommand("linear-issues.refreshAllIssues"),
    vscode.commands.executeCommand("linear-issues.refreshMyIssues"),
  ]);
}

class TeamCategoryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly projects: ProjectCategory[],
  ) {
    super(label, collapsibleState);
  }
}

class ProjectCategoryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly states: IssueCategory[],
  ) {
    super(label, collapsibleState);
  }
}

class IssueCategoryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly issues: Issue[],
  ) {
    super(label, collapsibleState);
  }
}

class IssueNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly issue: Issue,
  ) {
    super(label, collapsibleState);
  }
}

type IssuesTreeNode =
  | TeamCategoryNode
  | ProjectCategoryNode
  | IssueCategoryNode
  | IssueNode;

class LinearIssueProvider implements vscode.TreeDataProvider<IssuesTreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    IssuesTreeNode | undefined
  > = new vscode.EventEmitter<IssuesTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<IssuesTreeNode | undefined> =
    this._onDidChangeTreeData.event;

  private categories: TeamCategory[];

  constructor() {
    this.categories = [];
  }

  // Refresh the list of issues
  refresh(updatedCategories: TeamCategory[]): void {
    this.categories = updatedCategories;
    this._onDidChangeTreeData.fire(undefined);
  }

  // Get the tree item for a specific issue
  getTreeItem(
    element: IssuesTreeNode,
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  // Get the children (issues) to be displayed in the tree
  getChildren(element?: IssuesTreeNode): Thenable<IssuesTreeNode[]> {
    if (!element) {
      return Promise.resolve(
        this.categories.map(
          (category) =>
            new TeamCategoryNode(
              category.team,
              vscode.TreeItemCollapsibleState.Collapsed,
              category.projects,
            ),
        ),
      );
    }

    if (element instanceof TeamCategoryNode) {
      return Promise.resolve(
        element.projects.map(
          (project) =>
            new ProjectCategoryNode(
              project.project,
              vscode.TreeItemCollapsibleState.Collapsed,
              project.states,
            ),
        ),
      );
    } else if (element instanceof ProjectCategoryNode) {
      return Promise.resolve(
        element.states.map(
          (state) =>
            new IssueCategoryNode(
              state.status,
              vscode.TreeItemCollapsibleState.Collapsed,
              state.issues,
            ),
        ),
      );
    } else if (element instanceof IssueCategoryNode) {
      return Promise.resolve(
        element.issues.map(
          (issue) =>
            new IssueNode(
              `${issue.identifier} ${issue.title}`,
              vscode.TreeItemCollapsibleState.None,
              issue,
            ),
        ),
      );
    }

    return Promise.resolve([]);
  }
}

export function deactivate() {}
