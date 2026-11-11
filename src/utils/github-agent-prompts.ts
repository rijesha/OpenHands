import {
  GITHUB_TOKEN_SECRET_NAMES,
  type GithubWorkItemDetail,
} from "#/api/git-provider-items-service";
import {
  buildGuiVmVerification,
  type GuiVmOrigin,
  type GuiVmTarget,
} from "#/utils/gui-vm-launch";
import { constructRepositoryUrl } from "#/utils/utils";

/**
 * Agent tasks the GitHub page can start from an issue or pull request. These
 * are program tags (analytics + prompt selection), not UI copy.
 */
export type GithubAgentAction =
  | "work_on_issue"
  | "create_pull_request"
  | "review_pull_request"
  | "address_review_comments"
  | "fix_failing_checks";

export const GITHUB_ISSUE_AGENT_ACTIONS: readonly GithubAgentAction[] = [
  "work_on_issue",
  "create_pull_request",
];

export const GITHUB_PULL_REQUEST_AGENT_ACTIONS: readonly GithubAgentAction[] = [
  "review_pull_request",
  "address_review_comments",
  "fix_failing_checks",
];

/** Actions that change the pull request's branch, so they start on it and may push to it. */
export const GITHUB_BRANCH_WORK_ACTIONS: readonly GithubAgentAction[] = [
  "address_review_comments",
  "fix_failing_checks",
];

export interface GithubAgentPromptOptions {
  repository: string;
  item: Pick<
    GithubWorkItemDetail,
    "number" | "title" | "url" | "baseRef" | "headRef"
  > &
    Partial<Pick<GithubWorkItemDetail, "kind">>;
  /**
   * Whether the conversation starts without the repository checked out
   * (local backends do not clone `selected_repository`), so the agent must
   * clone it first.
   */
  needsClone: boolean;
  /**
   * Verify the change in a full-GUI VM of this OS (the gui-vm-testing plugin
   * is attached to the conversation) instead of only in the default sandbox.
   */
  guiVm?: GuiVmTarget;
  /** The user's own extra direction, appended to the generated prompt. */
  instructions?: string;
}

// Agent-facing instructions, not UI copy: they are sent to the model as the
// conversation's first message, like the git prompts in `utils.ts`.

const READ_WITH_GITHUB_API = `Use the GitHub API with a token from whichever of these environment variables is set: ${GITHUB_TOKEN_SECRET_NAMES.map((name) => `\`${name}\``).join(", ")}. Or use the \`gh\` CLI if it is available.`;

function cloneStep(repository: string): string {
  // A new local workspace is an empty git repository, so `git clone <url> .` fails there.
  return `If the repository is not already in your workspace, clone ${constructRepositoryUrl("github", repository)} first (the workspace may already contain an empty \`.git\`: fetch and check out into it, or clone into a subfolder).`;
}

function vmOrigin(
  repository: string,
  item: Pick<GithubWorkItemDetail, "number"> &
    Partial<Pick<GithubWorkItemDetail, "kind">>,
): GuiVmOrigin {
  return {
    repository,
    item: String(item.number),
    ...(item.kind ? { kind: item.kind } : {}),
  };
}

// The GitHub page reads this block to offer the findings as line comments on the diff.
export const REVIEW_COMMENTS_BLOCK =
  'End your reply with one fenced `json` block listing the findings that belong on a line of the new version of a file, as [{"path": "src/a.ts", "line": 12, "body": "what is wrong and how to fix it"}]. Leave the block out if there are none.';

/**
 * Lets the user commit, push and open a pull request with one click, without a
 * further model turn: the page reads this block from the reply.
 */
export function shipPlanBlock(includePullRequest: boolean): string {
  const example = includePullRequest
    ? '{"commit": {"message": "<commit message>"}, "pull_request": {"title": "<title>", "body": "<description that references the issue>"}}'
    : '{"commit": {"message": "<commit message>"}}';
  const what = includePullRequest ? "commit and pull request" : "commit";
  const forbidden = includePullRequest
    ? "push or open the pull request"
    : "push";
  return `End your reply with one fenced \`json\` block that prepares my one-click ${what}: ${example}. Do not ${forbidden} yourself.`;
}

function numbered(steps: string[]): string {
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

function buildWorkOnIssuePrompt({
  repository,
  item,
  needsClone,
  guiVm,
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
      ...(guiVm
        ? [
            buildGuiVmVerification(
              guiVm,
              "the change",
              vmOrigin(repository, item),
            ),
          ]
        : []),
      shipPlanBlock(true),
    ]),
    "",
    "Do not push the branch or open a pull request until I ask.",
  ].join("\n");
}

function buildCreatePullRequestPrompt({
  repository,
  item,
  needsClone,
  guiVm,
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
      ...(guiVm
        ? [buildGuiVmVerification(guiVm, "the fix", vmOrigin(repository, item))]
        : []),
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
  guiVm,
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
      `Review the diff against ${base} for correctness, bugs, security issues, test coverage and readability. Run the relevant unit tests if that helps confirm a finding, but not test runners that open GUI windows on this machine (such as \`vscode-test\`); use the virtual machine for anything that needs a real desktop.`,
      ...(guiVm
        ? [
            buildGuiVmVerification(
              guiVm,
              "the pull request build",
              vmOrigin(repository, item),
            ),
          ]
        : []),
      "Summarize your findings in this conversation, grouped by severity, with file and line references and a suggested fix for each.",
      REVIEW_COMMENTS_BLOCK,
    ]),
    "",
    "Do not push commits or post comments on the pull request unless I ask.",
  ].join("\n");
}

function buildAddressReviewCommentsPrompt({
  repository,
  item,
  needsClone,
  guiVm,
}: GithubAgentPromptOptions): string {
  return [
    `Please address the review feedback on GitHub pull request #${item.number} in ${repository}: "${item.title}".`,
    `Pull request: ${item.url}`,
    "",
    numbered([
      ...(needsClone ? [cloneStep(repository)] : []),
      `Check out the pull request branch with \`git fetch origin pull/${item.number}/head:pr-${item.number} && git checkout pr-${item.number}\`.`,
      `Read every review, review comment (including those on single lines) and comment. ${READ_WITH_GITHUB_API}`,
      "List what each reviewer asked for, then make the changes that are clearly requested. Where a request is unclear or you disagree, say so instead of guessing.",
      "Add or update tests, then run the relevant tests and linters.",
      ...(guiVm
        ? [
            buildGuiVmVerification(
              guiVm,
              "the changes",
              vmOrigin(repository, item),
            ),
          ]
        : []),
      "Commit the changes on the branch. Summarize, per comment, what you changed or why you did not.",
      shipPlanBlock(false),
    ]),
    "",
    "Do not push or reply on the pull request until I ask.",
  ].join("\n");
}

function buildFixFailingChecksPrompt({
  repository,
  item,
  needsClone,
  guiVm,
}: GithubAgentPromptOptions): string {
  return [
    `Please fix the failing checks of GitHub pull request #${item.number} in ${repository}: "${item.title}".`,
    `Pull request: ${item.url}`,
    "",
    numbered([
      ...(needsClone ? [cloneStep(repository)] : []),
      `Check out the pull request branch with \`git fetch origin pull/${item.number}/head:pr-${item.number} && git checkout pr-${item.number}\`.`,
      `Find the check runs of the head commit that failed and read their logs. ${READ_WITH_GITHUB_API} A run that is waiting for approval has not failed; report it instead of working around it.`,
      "Reproduce each failure locally, find the cause, and fix it with the smallest change. Do not weaken or skip tests to make them pass.",
      "Run the relevant tests and linters.",
      ...(guiVm
        ? [buildGuiVmVerification(guiVm, "the fix", vmOrigin(repository, item))]
        : []),
      "Commit the fix on the branch and summarize what failed, why, and what you changed.",
      shipPlanBlock(false),
    ]),
    "",
    "Do not push until I ask.",
  ].join("\n");
}

const PROMPT_BUILDERS: Record<
  GithubAgentAction,
  (options: GithubAgentPromptOptions) => string
> = {
  work_on_issue: buildWorkOnIssuePrompt,
  create_pull_request: buildCreatePullRequestPrompt,
  review_pull_request: buildReviewPullRequestPrompt,
  address_review_comments: buildAddressReviewCommentsPrompt,
  fix_failing_checks: buildFixFailingChecksPrompt,
};

/** The first message for a conversation started from a GitHub work item. */
export function buildGithubAgentPrompt(
  action: GithubAgentAction,
  options: GithubAgentPromptOptions,
): string {
  const prompt = PROMPT_BUILDERS[action](options);
  const extra = options.instructions?.trim();
  return extra
    ? `${prompt}\n\nAdditional instructions from me:\n${extra}`
    : prompt;
}

/**
 * The conversation's name: the repository and item first, so conversations
 * for different items stay apart in the list ("acme:widgets PR#7 - Review
 * pull request"). `actionLabel` is the translated name of the action.
 */
export function buildGithubConversationTitle(
  repository: string,
  item: Pick<GithubWorkItemDetail, "kind" | "number">,
  actionLabel: string,
): string {
  const kind = item.kind === "pull_request" ? "PR" : "Issue";
  return `${repository.replace("/", ":")} ${kind}#${item.number} - ${actionLabel}`;
}

/** What to ask a finished run to do with its commits. */
export type GithubPushMode = "push" | "push_and_open_pull_request";

/**
 * Follow-up message for a conversation that already did the work locally.
 * Pushing is the user's call, which is why the first prompts say not to.
 */
export function buildGithubPushPrompt(
  mode: GithubPushMode,
  options: Pick<GithubAgentPromptOptions, "repository" | "item">,
): string {
  const { repository, item } = options;
  if (mode === "push") {
    return "Please push the commits you made on your working branch to origin. Set the upstream if needed and do not force-push. Reply with the branch name and the commit SHAs you pushed.";
  }
  return [
    "Please push the commits you made on your working branch to origin (set the upstream if needed, no force-push),",
    `then open a pull request in ${repository} against the default branch that resolves issue #${item.number}.`,
    `Reference the issue in the description (for example "Fixes #${item.number}") and follow the repository's pull request template if one exists.`,
    "Reply with the pull request URL.",
  ].join(" ");
}
