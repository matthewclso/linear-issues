import * as vscode from 'vscode';
import { LinearClient } from "@linear/sdk";
import { Issue } from "@linear/import";

const LINEAR_AUTHENTICATION_PROVIDER_ID = "linear";
const LINEAR_AUTHENTICATION_SCOPES = ["read"];

async function getLinearIssues(): Promise<Issue[]> {
  const session = await vscode.authentication.getSession(
    LINEAR_AUTHENTICATION_PROVIDER_ID,
    LINEAR_AUTHENTICATION_SCOPES,
    { createIfNone: true }
  );

  if (!session) {
    vscode.window.showErrorMessage(
      `We weren't able to log you into Linear when trying to open the issue.`
    );
  }

  const linearClient = new LinearClient({
    accessToken: session.accessToken,
  });

  const allIssues = [];
  // get all linear issues for the user
  const issues = await linearClient.issues(
    {
      first: 100,
    },
  );
  allIssues.push(...issues.nodes);
  let counter = 1;
  while (issues.pageInfo.hasNextPage && issues.pageInfo.endCursor) {
    const nextIssues = await linearClient.issues({
      first: 100,
      after: issues.pageInfo.endCursor,
    });
    allIssues.push(...nextIssues.nodes);
    counter++;
    if (counter > 10) {
      break;
    }
  }
  return allIssues as unknown as Issue[];
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('linear-issues.helloWorld', async () => {
		
    const issues = await getLinearIssues();
    showIssuesInTreeView(issues);

		vscode.window.showInformationMessage('Hello World from linear-issues!');
	});

	context.subscriptions.push(disposable);
}

function showIssuesInTreeView(issues: Issue[]) {
  const issueProvider = new LinearIssueProvider(issues);
  vscode.window.registerTreeDataProvider('allIssues', issueProvider);
  vscode.commands.registerCommand('linear-issues.refreshIssues', async () => {
      const updatedIssues = await getLinearIssues();
      issueProvider.refresh(updatedIssues);
  });
}

class LinearIssueProvider implements vscode.TreeDataProvider<Issue> {
  private _onDidChangeTreeData: vscode.EventEmitter<Issue | undefined> = new vscode.EventEmitter<Issue | undefined>();
  readonly onDidChangeTreeData: vscode.Event<Issue | undefined> = this._onDidChangeTreeData.event;

  private issues: Issue[];

  constructor(issues: Issue[]) {
    this.issues = issues;
  }

  // Refresh the list of issues
  refresh(updatedIssues: Issue[]): void {
    this.issues = updatedIssues;
    this._onDidChangeTreeData.fire(undefined);
  }

  // Get the tree item for a specific issue
  getTreeItem(element: Issue): vscode.TreeItem {
    const item = new vscode.TreeItem(element.title);
    item.description = element.description;
    item.tooltip = ``;
    return item;
  }

  // Get the children (issues) to be displayed in the tree
  getChildren(element?: Issue): Thenable<Issue[]> {
    return Promise.resolve(this.issues);
  }
}

export function deactivate() {}
