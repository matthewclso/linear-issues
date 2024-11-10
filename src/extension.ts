import * as vscode from 'vscode';
import { LinearClient, User } from "@linear/sdk";
import { Issue } from "@linear/sdk/dist/_generated_sdk";

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read"];

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
    { createIfNone: true }
  );

  if (!session) {
    vscode.window.showErrorMessage(
      `Linear login failed.`
    );
  }

  const linearClient = new LinearClient({
    accessToken: session.accessToken,
  });
  
  return linearClient;
}

interface ProjectsStatesResponse {
  data: {
    team: {
      projects: {
        nodes: {
          id: string;
          name: string;
        }[];
      };
      states: {
        nodes: {
          id: string;
          name: string;
        }[];
      };
    };
  };
}

async function getIssues(linearClient: LinearClient, me?: User): Promise<TeamCategory[]> {
  const groups = [];

  const teams = await linearClient.teams().then((teams) => teams.nodes);

  for (const team of teams) {
    const data = await linearClient.client.rawRequest(`
      query {
        team(id: "${team.id}") {
          projects {
            nodes {
              id
              name
            }
          }
          states {
            nodes {
              id
              name
            }
          }
        }
      }
    `) as ProjectsStatesResponse;
    const projects = data.data.team.projects.nodes;
    const states = data.data.team.states.nodes;

    for (const project of projects) {
      for (const state of states) {
        const allIssues = [];
        const filter = {
          project: { id: { eq: project.id } },
          state: { id: { eq: state.id } },
        };

        if (me) {
          let issues = await me.assignedIssues({ filter });
          allIssues.push(...issues.nodes);
          while (issues.pageInfo.hasNextPage) {
            issues = await me.assignedIssues({ filter, after: issues.pageInfo.endCursor });
            allIssues.push(...issues.nodes);
          }
        } else {
          let issues = await linearClient.issues({ filter });
          allIssues.push(...issues.nodes);
          while (issues.pageInfo.hasNextPage) {
            issues = await linearClient.issues({ filter, after: issues.pageInfo.endCursor });
            allIssues.push(...issues.nodes);
          }
        }

        if (allIssues.length > 0) {
          groups.push({
            team: team.name,
            project: project.name,
            state: state.name,
            issues: allIssues,
          });
        }
      }
    }
  }

  const groupedIssues: TeamCategory[] = [];
  for (const group of groups) {
    const teamCategory = groupedIssues.find((teamCategory) => teamCategory.team === group.team);
    if (teamCategory) {
      const projectCategory = teamCategory.projects.find((projectCategory) => projectCategory.project === group.project);
      if (projectCategory) {
        const stateCategory = projectCategory.states.find((stateCategory) => stateCategory.status === group.state);
        if (stateCategory) {
          stateCategory.issues.push(...group.issues);
        } else {
          projectCategory.states.push({
            status: group.state,
            issues: group.issues,
          });
        }
      } else {
        teamCategory.projects.push({
          project: group.project,
          states: [{
            status: group.state,
            issues: group.issues,
          }],
        });
      }
    } else {
      groupedIssues.push({
        team: group.team,
        projects: [{
          project: group.project,
          states: [{
            status: group.state,
            issues: group.issues,
          }],
        }],
      });
    }
  }

  return groupedIssues;
}

export function activate(context: vscode.ExtensionContext) {
  const allIssuesProvider = new LinearIssueProvider();
  vscode.window.registerTreeDataProvider('allIssues', allIssuesProvider);
  vscode.commands.registerCommand('linear-issues.refreshAllIssues', async () => {
    const linearClient = await getClient();
    allIssuesProvider.refresh(await getIssues(linearClient));
  });

  const myIssuesProvider = new LinearIssueProvider();
  vscode.window.registerTreeDataProvider('myIssues', myIssuesProvider);
  vscode.commands.registerCommand('linear-issues.refreshMyIssues', async () => {
    const linearClient = await getClient();
    const me = await linearClient.viewer;
    myIssuesProvider.refresh(await getIssues(linearClient, me));
  });

  vscode.commands.executeCommand('linear-issues.refreshAllIssues');
  vscode.commands.executeCommand('linear-issues.refreshMyIssues');
}

class TeamCategoryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly projects: ProjectCategory[]
  ) {
    super(label, collapsibleState);
  }
}

class ProjectCategoryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly states: IssueCategory[]
  ) {
    super(label, collapsibleState);
  }
}

class IssueCategoryNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly issues: Issue[]
  ) {
    super(label, collapsibleState);
  }
}

class IssueNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly issue: Issue
  ) {
    super(label, collapsibleState);
  }
}

type IssuesTreeNode = TeamCategoryNode | ProjectCategoryNode | IssueCategoryNode | IssueNode;

class LinearIssueProvider implements vscode.TreeDataProvider<IssuesTreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<IssuesTreeNode | undefined> = new vscode.EventEmitter<IssuesTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<IssuesTreeNode | undefined> = this._onDidChangeTreeData.event;

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
  getTreeItem(element: IssuesTreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  // Get the children (issues) to be displayed in the tree
  getChildren(element?: IssuesTreeNode): Thenable<IssuesTreeNode[]> {
    if (!element) {
      return Promise.resolve(this.categories.map((category) => new TeamCategoryNode(category.team, vscode.TreeItemCollapsibleState.Collapsed, category.projects)));
    }

    if (element instanceof TeamCategoryNode) {
      return Promise.resolve(element.projects.map((project) => new ProjectCategoryNode(project.project, vscode.TreeItemCollapsibleState.Collapsed, project.states)));
    } else if (element instanceof ProjectCategoryNode) {
      return Promise.resolve(element.states.map((state) => new IssueCategoryNode(state.status, vscode.TreeItemCollapsibleState.Collapsed, state.issues)));
    } else if (element instanceof IssueCategoryNode) {
      return Promise.resolve(element.issues.map((issue) => new IssueNode(`${issue.identifier} ${issue.title}`, vscode.TreeItemCollapsibleState.None, issue)));
    }

    return Promise.resolve([]);
  }
}

export function deactivate() {}
