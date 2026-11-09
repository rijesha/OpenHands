import type { GithubWorkItemDetail } from "#/api/git-provider-items-service";
import { constructRepositoryUrl } from "#/utils/utils";

/**
 * Agent tasks the GitHub page can start from an issue or pull request. These
 * are program tags (analytics + prompt selection), not UI copy.
 */
export type GithubAgentAction =
  "work_on_issue" | "create_pull_request" | "review_pull_request";

export const GITHUB_ISSUE_AGENT_ACTIONS: readonly GithubAgentAction[] = [
  "work_on_issue",
  "create_pull_request",
];

export const GITHUB_PULL_REQUEST_AGENT_ACTIONS: readonly GithubAgentAction[] = [
  "review_pull_request",
];

export interface GithubAgentPromptOptions {
  repository: string;
  item: Pick<
    GithubWorkItemDetail,
    "number" | "title" | "url" | "baseRef" | "headRef"
  >;
  /**
   * Whether the conversation starts without the repository checked out
   * (local backends do not clone `selected_repository`), so the agent must
   * clone it first.
   */
  needsClone: boolean;
}

// Agent-facing instructions, not UI copy: they are sent to the model as the
// conversation's first message, like the git prompts in `utils.ts`.

const READ_WITH_GITHUB_API =
  "Use the GitHub API with the GITHUB_TOKEN environment variable, or the `gh` CLI if it is available.";

function cloneStep(repository: string): string {
  return `If the repository is not already in your workspace, clone ${constructRepositoryUrl("github", repository)} first.`;
}

function numbered(steps: string[]): string {
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

function buildWorkOnIssuePrompt({
  repository,
  item,
  needsClone,
}: GithubAgentPromptOptions): string {
  return [
    `Please work on GitHub issue #${item.number} in ${repository}: "${item.title}".`,
    `Issue: ${item.url}`,
    "",
    numbered([
      ...(needsClone ? [cloneStep(repository)] : []),
      `Read the full issue, including its comments. ${READ_WITH_GITHUB_API}`,
      "Explore the relevant code, then briefly explain the problem and your plan.",
      "Create a new branch with a descriptive name and implement the change, adding or updating tests where appropriate.",
      "Run the relevant tests and linters.",
    ]),
    "",
    "Do not push the branch or open a pull request until I ask.",
  ].join("\n");
}

function buildCreatePullRequestPrompt({
  repository,
  item,
  needsClone,
}: GithubAgentPromptOptions): string {
  return [
    `Please resolve GitHub issue #${item.number} in ${repository} and open a pull request with the fix: "${item.title}".`,
    `Issue: ${item.url}`,
    "",
    numbered([
      ...(needsClone ? [cloneStep(repository)] : []),
      `Read the full issue, including its comments. ${READ_WITH_GITHUB_API}`,
      "Create a new branch with a descriptive name, implement the fix, and add or update tests.",
      "Run the relevant tests and linters and fix any failures.",
      `Push the branch and open a pull request against the default branch. Reference the issue in the description (for example "Fixes #${item.number}") and follow the repository's pull request template if one exists.`,
    ]),
    "",
    "Reply with the pull request URL when you are done.",
  ].join("\n");
}

function buildReviewPullRequestPrompt({
  repository,
  item,
  needsClone,
}: GithubAgentPromptOptions): string {
  const base = item.baseRef ?? "the base branch";
  return [
    `Please review GitHub pull request #${item.number} in ${repository}: "${item.title}".`,
    `Pull request: ${item.url}`,
    "",
    numbered([
      ...(needsClone ? [cloneStep(repository)] : []),
      // `pull/N/head` also resolves pull requests opened from forks, whose
      // head branch does not exist in this repository.
      `Check out the pull request with \`git fetch origin pull/${item.number}/head:pr-${item.number} && git checkout pr-${item.number}\`.`,
      `Read the description and existing review comments. ${READ_WITH_GITHUB_API}`,
      `Review the diff against ${base} for correctness, bugs, security issues, test coverage and readability. Run the relevant tests if that helps confirm a finding.`,
      "Summarize your findings in this conversation, grouped by severity, with file and line references and a suggested fix for each.",
    ]),
    "",
    "Do not push commits or post comments on the pull request unless I ask.",
  ].join("\n");
}

const PROMPT_BUILDERS: Record<
  GithubAgentAction,
  (options: GithubAgentPromptOptions) => string
> = {
  work_on_issue: buildWorkOnIssuePrompt,
  create_pull_request: buildCreatePullRequestPrompt,
  review_pull_request: buildReviewPullRequestPrompt,
};

/** The first message for a conversation started from a GitHub work item. */
export function buildGithubAgentPrompt(
  action: GithubAgentAction,
  options: GithubAgentPromptOptions,
): string {
  return PROMPT_BUILDERS[action](options);
}
