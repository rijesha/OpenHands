import { SettingsClient } from "@openhands/typescript-client/clients";
import { getAgentServerClientOptions } from "#/api/agent-server-client-options";
import { SecretsService } from "#/api/secrets-service";
import { getActiveBackend } from "#/api/backend-registry/active-store";
import type { Provider } from "#/types/settings";
import { constructPullRequestUrl, getGitProviderBaseUrl } from "#/utils/utils";

export interface GitProviderItem {
  id: number;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  updatedAt: string | null;
}

const PROVIDER_TOKEN_SECRET_CANDIDATES: Partial<Record<Provider, string[]>> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN", "github"],
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

/** A single issue or pull request with its description and branch data. */
export interface GithubWorkItemDetail extends GithubWorkItem {
  body: string | null;
  /** Pull requests only: the branch the changes live on. */
  headRef: string | null;
  /** Pull requests only: `owner/repo` the head branch lives in (a fork differs). */
  headRepository: string | null;
  /** Pull requests only: the branch the changes merge into. */
  baseRef: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
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
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new GitProviderApiError("GitHub", response.status);
  }
  return response.json() as Promise<T>;
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
    repo?: { full_name?: string | null } | null;
  } | null;
  base?: { ref?: string | null } | null;
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
    options: { state: GithubWorkItemStateFilter; page: number },
  ): Promise<GithubWorkItemPage> {
    const parts = splitGithubRepository(repository);
    if (!parts) {
      return { items: [], nextPage: null };
    }
    const [owner, repo] = parts;
    const token = await resolveProviderToken("github");
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
      baseRef: item.base?.ref ?? null,
      additions: item.additions ?? null,
      deletions: item.deletions ?? null,
      changedFiles: item.changed_files ?? null,
    };
  }
}
