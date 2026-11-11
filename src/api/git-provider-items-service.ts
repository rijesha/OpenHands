import { SettingsClient } from "@openhands/typescript-client/clients";
import { getAgentServerClientOptions } from "#/api/agent-server-client-options";
import { SecretsService } from "#/api/secrets-service";
import { getActiveBackend } from "#/api/backend-registry/active-store";
import type { Provider } from "#/types/settings";
import { parseGithubReferences } from "#/utils/github-references";
import { constructPullRequestUrl, getGitProviderBaseUrl } from "#/utils/utils";

export interface GitProviderItem {
  id: number;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  updatedAt: string | null;
}

/**
 * Secret names a GitHub token may be saved under, in lookup order. A
 * conversation receives saved secrets as environment variables of the same
 * names, so agent prompts list these too.
 */
export const GITHUB_TOKEN_SECRET_NAMES: readonly string[] = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "github",
];

const PROVIDER_TOKEN_SECRET_CANDIDATES: Partial<
  Record<Provider, readonly string[]>
> = {
  github: GITHUB_TOKEN_SECRET_NAMES,
  gitlab: ["GITLAB_TOKEN", "GL_TOKEN", "gitlab"],
  bitbucket: ["BITBUCKET_TOKEN", "bitbucket"],
  forgejo: ["FORGEJO_TOKEN", "forgejo"],
};

const LIST_LIMIT = 30;

/** Which GitHub collection a work item belongs to. */
export type GithubWorkItemKind = "issue" | "pull_request";

/** The `state` filter GitHub's list endpoints accept. */
export type GithubWorkItemStateFilter = "open" | "closed" | "all";

/** Summary row for an issue or pull request in a browsable list. */
export interface GithubWorkItem {
  kind: GithubWorkItemKind;
  id: number;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  /** Pull requests only: closed by merging. Always false for issues. */
  merged: boolean;
  /** Pull requests only. Always false for issues. */
  draft: boolean;
  authorLogin: string | null;
  updatedAt: string | null;
  /** GitHub's PR list endpoint omits the count, so it can be unknown. */
  commentsCount: number | null;
  labels: string[];
  assignees: string[];
}

/** Which of the user's items a list shows. `@me` needs a token. */
export type GithubInvolvement = "all" | "assigned" | "review_requested";

/** Review verdicts GitHub accepts when a review is submitted. */
export type GithubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** How GitHub combines a pull request's commits when it is merged. */
export type GithubMergeMethod = "merge" | "squash" | "rebase";

/** One run of a GitHub Actions workflow on a commit. */
export interface GithubWorkflowRun {
  id: number;
  name: string;
  /** queued, in_progress, completed, ... */
  status: string;
  /** success, failure, action_required, ... once completed. */
  conclusion: string | null;
  url: string | null;
  /** Held until a maintainer approves it (first-time contributors' pull requests). */
  needsApproval: boolean;
  failed: boolean;
  running: boolean;
}

/** A line comment attached to a file of a pull request. */
export interface GithubInlineComment {
  path: string;
  line: number;
  body: string;
}

/** One entry of an item's discussion: a comment, a review, or a line comment. */
export interface GithubDiscussionEntry {
  id: string;
  type: "comment" | "review" | "line_comment";
  authorLogin: string | null;
  body: string;
  createdAt: string | null;
  url: string | null;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED, ... */
  reviewState: string | null;
  /** Line comments only. */
  path: string | null;
}

export type GithubCheckState =
  "success" | "failure" | "pending" | "action_required" | "neutral";

export interface GithubCheck {
  name: string;
  state: GithubCheckState;
  url: string | null;
}

export interface GithubChecksSummary {
  /** The worst state among the checks; `none` when the commit has no checks. */
  state: GithubCheckState | "none";
  checks: GithubCheck[];
}

export interface GithubChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

/** A single issue or pull request with its description and branch data. */
export interface GithubWorkItemDetail extends GithubWorkItem {
  body: string | null;
  /** Pull requests only: the branch the changes live on. */
  headRef: string | null;
  /** Pull requests only: `owner/repo` the head branch lives in (a fork differs). */
  headRepository: string | null;
  /** Pull requests only: the commit the head branch points at. */
  headSha: string | null;
  /** Pull requests only: GitHub's verdict on merging now; null while it is still computing. */
  mergeable: boolean | null;
  /** Pull requests only: clean, dirty, blocked, behind, unstable, ... */
  mergeableState: string | null;
  /** Pull requests only: the branch the changes merge into. */
  baseRef: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

/** How a linked item relates to the one being viewed. */
export type GithubLinkRelation =
  | "closes" // this item's description says "Fixes #N"
  | "closed_by" // the linked item's description says "Fixes <this item>"
  | "mentions" // this item's description mentions it
  | "mentioned_in"; // it mentions this item

/** An issue or pull request connected to the one on screen. */
export interface GithubLinkedItem {
  kind: GithubWorkItemKind;
  repository: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  relation: GithubLinkRelation;
}

export interface GithubWorkItemPage {
  items: GithubWorkItem[];
  /** The next 1-based page to request, or null when this was the last. */
  nextPage: number | null;
}

/**
 * A non-OK response from a git provider's REST API. `status` lets callers
 * explain the common cases (401/403 auth or rate limit, 404 private repo).
 */
export class GitProviderApiError extends Error {
  readonly status: number;

  constructor(provider: string, status: number) {
    super(`${provider} API ${status}`);
    this.name = "GitProviderApiError";
    this.status = status;
  }
}

async function resolveProviderToken(
  provider: Provider,
): Promise<string | null> {
  // Cloud backends keep provider tokens server-side; browser-side secret
  // lookup is only meaningful for the local agent-server secrets store.
  if (getActiveBackend().backend.kind !== "local") {
    return null;
  }

  const candidates = PROVIDER_TOKEN_SECRET_CANDIDATES[provider] ?? [];
  if (candidates.length === 0) {
    return null;
  }

  const secrets = await SecretsService.getSecrets();
  const available = new Set(secrets.map((secret) => secret.name));
  const match = candidates.find((name) => available.has(name));
  if (!match) {
    return null;
  }

  try {
    return await new SettingsClient(getAgentServerClientOptions()).getSecret(
      match,
    );
  } catch {
    return null;
  }
}

function constructIssueUrl(
  issueNumber: number,
  provider: Provider,
  repositoryName: string,
): string {
  const baseUrl = getGitProviderBaseUrl(provider);
  switch (provider) {
    case "gitlab":
      return `${baseUrl}/${repositoryName}/-/issues/${issueNumber}`;
    case "bitbucket":
      return `${baseUrl}/${repositoryName}/issues/${issueNumber}`;
    case "forgejo":
      return `${baseUrl}/${repositoryName}/issues/${issueNumber}`;
    case "github":
    default:
      return `${baseUrl}/${repositoryName}/issues/${issueNumber}`;
  }
}

function constructIssuesListUrl(
  provider: Provider,
  repositoryName: string,
): string {
  const baseUrl = getGitProviderBaseUrl(provider);
  switch (provider) {
    case "gitlab":
      return `${baseUrl}/${repositoryName}/-/issues`;
    case "bitbucket":
      return `${baseUrl}/${repositoryName}/issues`;
    case "forgejo":
      return `${baseUrl}/${repositoryName}/issues`;
    case "github":
    default:
      return `${baseUrl}/${repositoryName}/issues`;
  }
}

function constructPullRequestsListUrl(
  provider: Provider,
  repositoryName: string,
): string {
  const baseUrl = getGitProviderBaseUrl(provider);
  switch (provider) {
    case "gitlab":
      return `${baseUrl}/${repositoryName}/-/merge_requests`;
    case "bitbucket":
      return `${baseUrl}/${repositoryName}/pull-requests`;
    case "forgejo":
      return `${baseUrl}/${repositoryName}/pulls`;
    case "github":
    default:
      return `${baseUrl}/${repositoryName}/pulls`;
  }
}

async function fetchGithubJson<T>(
  path: string,
  token: string | null,
  write?: { method: "POST" | "PUT"; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (write?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`https://api.github.com${path}`, {
    headers,
    ...(write
      ? {
          method: write.method,
          ...(write.body === undefined
            ? {}
            : { body: JSON.stringify(write.body) }),
        }
      : {}),
  });
  if (!response.ok) {
    throw new GitProviderApiError("GitHub", response.status);
  }
  // Several actions endpoints answer 201/202/204 with no body.
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function fetchForgejoJson<T>(
  path: string,
  token: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) {
    // Forgejo/Gitea accept the `token` scheme on every supported version;
    // `Bearer` only landed in later releases.
    headers.Authorization = `token ${token}`;
  }

  // The provider host's own REST API (`/api/v1`), not api.github.com:
  // Forgejo speaks the Gitea API shape on the instance that hosts the repo.
  // eslint-disable-next-line local/no-direct-agent-server-fetch
  const response = await fetch(
    `${getGitProviderBaseUrl("forgejo")}/api/v1${path}`,
    {
      headers,
    },
  );
  if (!response.ok) {
    throw new Error(`Forgejo API ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchGitlabJson<T>(
  path: string,
  token: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) {
    headers["PRIVATE-TOKEN"] = token;
  }

  // gitlab.com's public REST API — an external host, not the agent-server
  // `/api` surface the rule guards (its `/api/v4` prefix just trips the
  // substring heuristic; the companion no-direct-agent-server-calls test
  // matches only relative `/api/...` URLs and is not affected).
  // eslint-disable-next-line local/no-direct-agent-server-fetch
  const response = await fetch(`https://gitlab.com/api/v4${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitLab API ${response.status}`);
  }
  return response.json() as Promise<T>;
}

type GithubIssueOrPr = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string } | null;
  updated_at?: string | null;
  pull_request?: unknown;
};

type GithubNamedLogin = { login?: string | null } | null;

type GithubTimelineEvent = {
  event?: string;
  source?: {
    issue?: GithubWorkItemResponse & {
      repository?: { full_name?: string | null } | null;
    };
  } | null;
};

const MAX_LINKED_ITEMS = 20;
const RELATION_RANK: Record<GithubLinkRelation, number> = {
  closes: 0,
  closed_by: 1,
  mentions: 2,
  mentioned_in: 3,
};

type GithubCommentResponse = {
  id: number;
  body?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  state?: string | null;
  path?: string | null;
  user?: GithubNamedLogin;
};

type GithubWorkflowRunResponse = {
  id: number;
  name?: string | null;
  display_title?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
};

type GithubCheckRunResponse = {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
};

type GithubFileResponse = {
  filename: string;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
};

const CHECK_RANK: Record<GithubCheckState | "none", number> = {
  failure: 0,
  action_required: 1,
  pending: 2,
  success: 3,
  neutral: 4,
  none: 5,
};

function toCheckState(run: GithubCheckRunResponse): GithubCheckState {
  if (run.status && run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "neutral":
    case "skipped":
      return "neutral";
    case "action_required":
      return "action_required";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "startup_failure":
    case "stale":
      return "failure";
    default:
      return "pending";
  }
}

type GithubWorkItemResponse = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  merged_at?: string | null;
  user?: GithubNamedLogin;
  updated_at?: string | null;
  comments?: number | null;
  labels?: Array<string | { name?: string | null }> | null;
  assignees?: GithubNamedLogin[] | null;
  body?: string | null;
  pull_request?: unknown;
  head?: {
    ref?: string | null;
    sha?: string | null;
    repo?: { full_name?: string | null } | null;
  } | null;
  base?: { ref?: string | null } | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
};

function splitGithubRepository(
  repository: string,
): [owner: string, repo: string] | null {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) {
    return null;
  }
  return [encodeURIComponent(owner), encodeURIComponent(repo)];
}

function toGithubWorkItem(
  item: GithubWorkItemResponse,
  kind: GithubWorkItemKind,
): GithubWorkItem {
  return {
    kind,
    id: item.id,
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: item.state === "closed" ? "closed" : "open",
    // The list endpoint reports merges only through `merged_at`; the detail
    // endpoint also sets `merged`.
    merged: kind === "pull_request" && Boolean(item.merged || item.merged_at),
    draft: kind === "pull_request" && Boolean(item.draft),
    authorLogin: item.user?.login ?? null,
    updatedAt: item.updated_at ?? null,
    commentsCount: typeof item.comments === "number" ? item.comments : null,
    labels: (item.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter((name): name is string => Boolean(name)),
    assignees: (item.assignees ?? [])
      .map((assignee) => assignee?.login)
      .filter((login): login is string => Boolean(login)),
  };
}

function toLinked(
  item: GithubWorkItemResponse,
  kind: GithubWorkItemKind,
  repository: string,
): Omit<GithubLinkedItem, "relation"> {
  return {
    kind,
    repository,
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: item.state === "closed" ? "closed" : "open",
    merged: kind === "pull_request" && Boolean(item.merged || item.merged_at),
  };
}

type GitlabMergeRequest = {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  author?: { username?: string } | null;
  updated_at?: string | null;
};

type GitlabIssue = {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  author?: { username?: string } | null;
  updated_at?: string | null;
};

/**
 * Lists open pull requests / merge requests and issues for a connected
 * repository by calling the provider's public REST API from the browser.
 * When a matching token secret exists locally (e.g. `GITHUB_TOKEN`), it is
 * used for auth so private repos work; otherwise public-repo unauthenticated
 * requests are attempted.
 */
export class GitProviderItemsService {
  static constructIssuesListUrl = constructIssuesListUrl;

  static constructPullRequestsListUrl = constructPullRequestsListUrl;

  static async listPullRequests(
    repository: string,
    provider: Provider,
  ): Promise<GitProviderItem[]> {
    const token = await resolveProviderToken(provider);

    if (provider === "gitlab") {
      const encoded = encodeURIComponent(repository);
      const items = await fetchGitlabJson<GitlabMergeRequest[]>(
        `/projects/${encoded}/merge_requests?state=opened&per_page=${LIST_LIMIT}`,
        token,
      );
      return items.map((item) => ({
        id: item.id,
        number: item.iid,
        title: item.title,
        url: item.web_url,
        authorLogin: item.author?.username ?? null,
        updatedAt: item.updated_at ?? null,
      }));
    }

    if (provider === "forgejo") {
      const [forgejoOwner, forgejoRepo] = repository.split("/");
      if (!forgejoOwner || !forgejoRepo) {
        return [];
      }
      const items = await fetchForgejoJson<GithubIssueOrPr[]>(
        `/repos/${forgejoOwner}/${forgejoRepo}/pulls?state=open&limit=${LIST_LIMIT}`,
        token,
      );
      return items.map((item) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        url:
          item.html_url ||
          constructPullRequestUrl(item.number, provider, repository),
        authorLogin: item.user?.login ?? null,
        updatedAt: item.updated_at ?? null,
      }));
    }

    if (provider !== "github") {
      return [];
    }

    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      return [];
    }

    const items = await fetchGithubJson<GithubIssueOrPr[]>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=${LIST_LIMIT}`,
      token,
    );

    return items.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      url:
        item.html_url ||
        constructPullRequestUrl(item.number, provider, repository),
      authorLogin: item.user?.login ?? null,
      updatedAt: item.updated_at ?? null,
    }));
  }

  static async listIssues(
    repository: string,
    provider: Provider,
  ): Promise<GitProviderItem[]> {
    const token = await resolveProviderToken(provider);

    if (provider === "gitlab") {
      const encoded = encodeURIComponent(repository);
      const items = await fetchGitlabJson<GitlabIssue[]>(
        `/projects/${encoded}/issues?state=opened&per_page=${LIST_LIMIT}`,
        token,
      );
      return items.map((item) => ({
        id: item.id,
        number: item.iid,
        title: item.title,
        url: item.web_url,
        authorLogin: item.author?.username ?? null,
        updatedAt: item.updated_at ?? null,
      }));
    }

    if (provider === "forgejo") {
      const [forgejoOwner, forgejoRepo] = repository.split("/");
      if (!forgejoOwner || !forgejoRepo) {
        return [];
      }
      const items = await fetchForgejoJson<GithubIssueOrPr[]>(
        `/repos/${forgejoOwner}/${forgejoRepo}/issues?state=open&type=issues&limit=${LIST_LIMIT}`,
        token,
      );
      // Forgejo's issues endpoint can still return pull requests.
      return items
        .filter((item) => !item.pull_request)
        .map((item) => ({
          id: item.id,
          number: item.number,
          title: item.title,
          url:
            item.html_url ||
            constructIssueUrl(item.number, provider, repository),
          authorLogin: item.user?.login ?? null,
          updatedAt: item.updated_at ?? null,
        }));
    }

    if (provider !== "github") {
      return [];
    }

    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      return [];
    }

    const items = await fetchGithubJson<GithubIssueOrPr[]>(
      `/repos/${owner}/${repo}/issues?state=open&per_page=${LIST_LIMIT}`,
      token,
    );

    // GitHub's issues endpoint also returns pull requests.
    return items
      .filter((item) => !item.pull_request)
      .map((item) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        url:
          item.html_url || constructIssueUrl(item.number, provider, repository),
        authorLogin: item.user?.login ?? null,
        updatedAt: item.updated_at ?? null,
      }));
  }

  /**
   * One page of a GitHub repository's issues or pull requests, most recently
   * updated first. `nextPage` follows GitHub's raw page size, so a page of
   * issues whose rows were mostly pull requests still reports more pages.
   */
  static async listGithubWorkItems(
    repository: string,
    kind: GithubWorkItemKind,
    options: {
      state: GithubWorkItemStateFilter;
      page: number;
      /** Free text searched by GitHub (title, body, comments), not just the loaded rows. */
      query?: string;
      involvement?: GithubInvolvement;
    },
  ): Promise<GithubWorkItemPage> {
    const parts = splitGithubRepository(repository);
    if (!parts) {
      return { items: [], nextPage: null };
    }
    const [owner, repo] = parts;
    const token = await resolveProviderToken("github");
    const query = options.query?.trim() ?? "";
    const involvement = options.involvement ?? "all";
    if (query || involvement !== "all") {
      return GitProviderItemsService.searchGithubWorkItems(
        repository,
        kind,
        { ...options, query, involvement },
        token,
      );
    }
    const params = new URLSearchParams({
      state: options.state,
      sort: "updated",
      direction: "desc",
      per_page: String(LIST_LIMIT),
      page: String(options.page),
    });
    const collection = kind === "issue" ? "issues" : "pulls";
    const rows = await fetchGithubJson<GithubWorkItemResponse[]>(
      `/repos/${owner}/${repo}/${collection}?${params.toString()}`,
      token,
    );

    return {
      items: rows
        // The issues endpoint also returns pull requests.
        .filter((row) => kind === "pull_request" || !row.pull_request)
        .map((row) => toGithubWorkItem(row, kind)),
      nextPage: rows.length === LIST_LIMIT ? options.page + 1 : null,
    };
  }

  /** GitHub's search API: the list with a text query and/or "assigned to me" / "review requested". */
  private static async searchGithubWorkItems(
    repository: string,
    kind: GithubWorkItemKind,
    options: {
      state: GithubWorkItemStateFilter;
      page: number;
      query: string;
      involvement: GithubInvolvement;
    },
    token: string | null,
  ): Promise<GithubWorkItemPage> {
    const terms = [
      `repo:${repository}`,
      kind === "issue" ? "is:issue" : "is:pr",
    ];
    if (options.state !== "all") terms.push(`state:${options.state}`);
    if (options.involvement === "assigned") terms.push("assignee:@me");
    if (options.involvement === "review_requested" && kind === "pull_request") {
      terms.push("review-requested:@me");
    }
    if (options.query) terms.push(options.query);
    const params = new URLSearchParams({
      q: terms.join(" "),
      sort: "updated",
      order: "desc",
      per_page: String(LIST_LIMIT),
      page: String(options.page),
    });
    const result = await fetchGithubJson<{ items: GithubWorkItemResponse[] }>(
      `/search/issues?${params.toString()}`,
      token,
    );
    const rows = result.items ?? [];
    return {
      items: rows.map((row) => toGithubWorkItem(row, kind)),
      nextPage: rows.length === LIST_LIMIT ? options.page + 1 : null,
    };
  }

  /** Comments, reviews and line comments of an item, oldest first. */
  static async getGithubDiscussion(
    repository: string,
    kind: GithubWorkItemKind,
    number: number,
  ): Promise<GithubDiscussionEntry[]> {
    const parts = splitGithubRepository(repository);
    if (!parts) return [];
    const [owner, repo] = parts;
    const token = await resolveProviderToken("github");
    const base = `/repos/${owner}/${repo}`;
    const none = [] as GithubCommentResponse[];
    const [comments, reviews, lineComments] = await Promise.all([
      fetchGithubJson<GithubCommentResponse[]>(
        `${base}/issues/${number}/comments?per_page=50`,
        token,
      ),
      kind === "pull_request"
        ? fetchGithubJson<GithubCommentResponse[]>(
            `${base}/pulls/${number}/reviews?per_page=50`,
            token,
          ).catch(() => none)
        : Promise.resolve(none),
      kind === "pull_request"
        ? fetchGithubJson<GithubCommentResponse[]>(
            `${base}/pulls/${number}/comments?per_page=50`,
            token,
          ).catch(() => none)
        : Promise.resolve(none),
    ]);
    const entry = (
      row: GithubCommentResponse,
      type: GithubDiscussionEntry["type"],
    ): GithubDiscussionEntry => ({
      id: `${type}-${row.id}`,
      type,
      authorLogin: row.user?.login ?? null,
      body: row.body ?? "",
      createdAt: row.submitted_at ?? row.created_at ?? null,
      url: row.html_url ?? null,
      reviewState: type === "review" ? (row.state ?? null) : null,
      path: type === "line_comment" ? (row.path ?? null) : null,
    });
    return [
      ...comments.map((row) => entry(row, "comment")),
      // A review with no text and only line comments is shown through those comments.
      ...reviews
        .map((row) => entry(row, "review"))
        .filter((row) => row.body.trim() || row.reviewState !== "COMMENTED"),
      ...lineComments.map((row) => entry(row, "line_comment")),
    ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /** CI check runs for a commit, with the worst state first. */
  static async getGithubChecks(
    repository: string,
    sha: string,
  ): Promise<GithubChecksSummary> {
    const parts = splitGithubRepository(repository);
    if (!parts) return { state: "none", checks: [] };
    const token = await resolveProviderToken("github");
    const result = await fetchGithubJson<{
      check_runs?: GithubCheckRunResponse[];
    }>(
      `/repos/${parts[0]}/${parts[1]}/commits/${encodeURIComponent(sha)}/check-runs?per_page=50`,
      token,
    );
    const checks = (result.check_runs ?? [])
      .map((run) => ({
        name: run.name,
        state: toCheckState(run),
        url: run.html_url ?? null,
      }))
      .sort((a, b) => CHECK_RANK[a.state] - CHECK_RANK[b.state]);
    return { state: checks[0]?.state ?? "none", checks };
  }

  /** Files a pull request changes (first 100). */
  static async getGithubChangedFiles(
    repository: string,
    number: number,
  ): Promise<GithubChangedFile[]> {
    const parts = splitGithubRepository(repository);
    if (!parts) return [];
    const token = await resolveProviderToken("github");
    const rows = await fetchGithubJson<GithubFileResponse[]>(
      `/repos/${parts[0]}/${parts[1]}/pulls/${number}/files?per_page=100`,
      token,
    );
    return rows.map((row) => ({
      filename: row.filename,
      status: row.status ?? "modified",
      additions: row.additions ?? 0,
      deletions: row.deletions ?? 0,
    }));
  }

  /** A single GitHub issue or pull request with its description. */
  static async getGithubWorkItem(
    repository: string,
    kind: GithubWorkItemKind,
    number: number,
  ): Promise<GithubWorkItemDetail> {
    const parts = splitGithubRepository(repository);
    if (!parts) {
      throw new GitProviderApiError("GitHub", 404);
    }
    const [owner, repo] = parts;
    const token = await resolveProviderToken("github");
    const collection = kind === "issue" ? "issues" : "pulls";
    const item = await fetchGithubJson<GithubWorkItemResponse>(
      `/repos/${owner}/${repo}/${collection}/${number}`,
      token,
    );

    return {
      ...toGithubWorkItem(item, kind),
      body: item.body ?? null,
      headRef: item.head?.ref ?? null,
      headRepository: item.head?.repo?.full_name ?? null,
      headSha: item.head?.sha ?? null,
      mergeable: item.mergeable ?? null,
      mergeableState: item.mergeable_state ?? null,
      baseRef: item.base?.ref ?? null,
      additions: item.additions ?? null,
      deletions: item.deletions ?? null,
      changedFiles: item.changed_files ?? null,
    };
  }

  /** The token a write needs; a missing one is reported like a rejected one. */
  private static async writeToken(): Promise<string> {
    const token = await resolveProviderToken("github");
    if (!token) throw new GitProviderApiError("GitHub", 401);
    return token;
  }

  /** Posts a comment on an issue or pull request. Returns the comment's URL. */
  static async postGithubComment(
    repository: string,
    number: number,
    body: string,
  ): Promise<{ url: string }> {
    const parts = splitGithubRepository(repository);
    if (!parts) throw new GitProviderApiError("GitHub", 404);
    const token = await GitProviderItemsService.writeToken();
    const result = await fetchGithubJson<{ html_url: string }>(
      `/repos/${parts[0]}/${parts[1]}/issues/${number}/comments`,
      token,
      { method: "POST", body: { body } },
    );
    return { url: result.html_url };
  }

  /**
   * Submits a review on a pull request: a plain comment by default, or an
   * approval / change request, optionally with comments on lines of the diff.
   */
  static async postGithubReview(
    repository: string,
    number: number,
    body: string,
    options: {
      event?: GithubReviewEvent;
      comments?: GithubInlineComment[];
    } = {},
  ): Promise<{ url: string }> {
    const parts = splitGithubRepository(repository);
    if (!parts) throw new GitProviderApiError("GitHub", 404);
    const token = await GitProviderItemsService.writeToken();
    const result = await fetchGithubJson<{ html_url: string }>(
      `/repos/${parts[0]}/${parts[1]}/pulls/${number}/reviews`,
      token,
      {
        method: "POST",
        body: {
          body,
          event: options.event ?? "COMMENT",
          ...(options.comments?.length
            ? {
                comments: options.comments.map((c) => ({
                  path: c.path,
                  line: c.line,
                  side: "RIGHT",
                  body: c.body,
                })),
              }
            : {}),
        },
      },
    );
    return { url: result.html_url };
  }

  /** Opens a pull request from `head` (a branch of this repository) into `base`. */
  static async createGithubPullRequest(
    repository: string,
    pullRequest: { title: string; body: string; head: string; base: string },
  ): Promise<{ url: string; number: number }> {
    const parts = splitGithubRepository(repository);
    if (!parts) throw new GitProviderApiError("GitHub", 404);
    const token = await GitProviderItemsService.writeToken();
    const result = await fetchGithubJson<{ html_url: string; number: number }>(
      `/repos/${parts[0]}/${parts[1]}/pulls`,
      token,
      { method: "POST", body: pullRequest },
    );
    return { url: result.html_url, number: result.number };
  }

  /** Merges a pull request. `sha` makes GitHub refuse the merge if the branch moved after it was shown. */
  static async mergeGithubPullRequest(
    repository: string,
    number: number,
    options: { method: GithubMergeMethod; sha?: string | null },
  ): Promise<void> {
    const parts = splitGithubRepository(repository);
    if (!parts) throw new GitProviderApiError("GitHub", 404);
    const token = await GitProviderItemsService.writeToken();
    await fetchGithubJson<unknown>(
      `/repos/${parts[0]}/${parts[1]}/pulls/${number}/merge`,
      token,
      {
        method: "PUT",
        body: {
          merge_method: options.method,
          ...(options.sha ? { sha: options.sha } : {}),
        },
      },
    );
  }

  /** Workflow runs GitHub Actions started for a commit, newest first. */
  static async getGithubWorkflowRuns(
    repository: string,
    sha: string,
  ): Promise<GithubWorkflowRun[]> {
    const parts = splitGithubRepository(repository);
    if (!parts) return [];
    const token = await resolveProviderToken("github");
    const result = await fetchGithubJson<{
      workflow_runs?: GithubWorkflowRunResponse[];
    }>(
      `/repos/${parts[0]}/${parts[1]}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=30`,
      token,
    );
    return (result.workflow_runs ?? []).map((run) => {
      const status = run.status ?? "queued";
      const conclusion = run.conclusion ?? null;
      return {
        id: run.id,
        name: run.name ?? run.display_title ?? String(run.id),
        status,
        conclusion,
        url: run.html_url ?? null,
        needsApproval: conclusion === "action_required",
        failed:
          conclusion === "failure" ||
          conclusion === "timed_out" ||
          conclusion === "cancelled" ||
          conclusion === "startup_failure",
        running: status !== "completed" && status !== "action_required",
      };
    });
  }

  /** Lets a workflow run held for approval (a first-time contributor's pull request) go ahead. */
  static async approveGithubWorkflowRun(
    repository: string,
    runId: number,
  ): Promise<void> {
    await GitProviderItemsService.postWorkflowRunAction(
      repository,
      runId,
      "approve",
    );
  }

  /** Runs a finished workflow again, or only its failed jobs. */
  static async rerunGithubWorkflowRun(
    repository: string,
    runId: number,
    failedOnly: boolean,
  ): Promise<void> {
    await GitProviderItemsService.postWorkflowRunAction(
      repository,
      runId,
      failedOnly ? "rerun-failed-jobs" : "rerun",
    );
  }

  private static async postWorkflowRunAction(
    repository: string,
    runId: number,
    action: "approve" | "rerun" | "rerun-failed-jobs",
  ): Promise<void> {
    const parts = splitGithubRepository(repository);
    if (!parts) throw new GitProviderApiError("GitHub", 404);
    const token = await GitProviderItemsService.writeToken();
    await fetchGithubJson<unknown>(
      `/repos/${parts[0]}/${parts[1]}/actions/runs/${runId}/${action}`,
      token,
      { method: "POST" },
    );
  }

  /**
   * The issues and pull requests connected to this one: what its description
   * references, plus what references it (GitHub's timeline cross-references).
   * A pull request that says "Fixes #N" shows up as "closed by" on issue N.
   */
  static async getGithubLinkedItems(
    repository: string,
    number: number,
    body: string | null,
  ): Promise<GithubLinkedItem[]> {
    const parts = splitGithubRepository(repository);
    if (!parts) return [];
    const [owner, repo] = parts;
    const token = await resolveProviderToken("github");
    const found = new Map<string, GithubLinkedItem>();
    const add = (item: GithubLinkedItem) => {
      const key = `${item.repository.toLowerCase()}#${item.number}`;
      const existing = found.get(key);
      if (
        !existing ||
        RELATION_RANK[item.relation] < RELATION_RANK[existing.relation]
      ) {
        found.set(key, item);
      }
    };

    const timeline = await fetchGithubJson<GithubTimelineEvent[]>(
      `/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
      token,
    ).catch(() => [] as GithubTimelineEvent[]);
    for (const entry of timeline) {
      const source = entry.source?.issue;
      if (entry.event !== "cross-referenced" || !source) continue;
      const sourceRepository = source.repository?.full_name ?? repository;
      const closesThis = parseGithubReferences(
        source.body,
        sourceRepository,
      ).some(
        (ref) =>
          ref.closing &&
          ref.number === number &&
          ref.repository.toLowerCase() === repository.toLowerCase(),
      );
      add({
        ...toLinked(
          source,
          source.pull_request ? "pull_request" : "issue",
          sourceRepository,
        ),
        relation: closesThis ? "closed_by" : "mentioned_in",
      });
    }

    const references = parseGithubReferences(body, repository, number).slice(
      0,
      MAX_LINKED_ITEMS,
    );
    const resolved = await Promise.all(
      references.map(async (ref) => {
        const refParts = splitGithubRepository(ref.repository);
        if (!refParts) return null;
        try {
          const item = await fetchGithubJson<GithubWorkItemResponse>(
            `/repos/${refParts[0]}/${refParts[1]}/issues/${ref.number}`,
            token,
          );
          const linked: GithubLinkedItem = {
            ...toLinked(
              item,
              item.pull_request ? "pull_request" : "issue",
              ref.repository,
            ),
            relation: ref.closing ? "closes" : "mentions",
          };
          return linked;
        } catch {
          // A reference to something private or deleted is simply not shown.
          return null;
        }
      }),
    );
    for (const item of resolved) if (item) add(item);

    return [...found.values()]
      .sort(
        (a, b) =>
          RELATION_RANK[a.relation] - RELATION_RANK[b.relation] ||
          b.number - a.number,
      )
      .slice(0, MAX_LINKED_ITEMS);
  }
}
