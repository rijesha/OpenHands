import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import {
  GitProviderApiError,
  GitProviderItemsService,
} from "#/api/git-provider-items-service";
import { getFetchCall, mockJsonResponse } from "./cloud/fetch-test-utils";

// A cloud backend keeps provider tokens server-side, so the service never
// touches the local secrets store and the provider REST call is the only
// fetch in play.
const cloudBackend: Backend = {
  id: "prod",
  name: "Production",
  host: "https://app.all-hands.dev",
  apiKey: "bearer-token",
  kind: "cloud",
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  setRegisteredBackends([cloudBackend]);
  setActiveSelection({ backendId: cloudBackend.id });
  fetchMock.mockReset();
  vi.restoreAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  fetchMock.mockReset();
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe("GitProviderItemsService", () => {
  it("lists Forgejo pull requests from the Forgejo host, not api.github.com", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: 11,
          number: 7,
          title: "Fix the thing",
          html_url: "https://codeberg.org/acme/widgets/pulls/7",
          user: { login: "octocat" },
          updated_at: "2026-09-01T10:00:00Z",
        },
      ]),
    );

    const items = await GitProviderItemsService.listPullRequests(
      "acme/widgets",
      "forgejo",
    );

    const [url] = getFetchCall(fetchMock);
    expect(url.startsWith("https://codeberg.org/api/v1/")).toBe(true);
    expect(url).toContain("/repos/acme/widgets/pulls");
    expect(items).toEqual([
      {
        id: 11,
        number: 7,
        title: "Fix the thing",
        url: "https://codeberg.org/acme/widgets/pulls/7",
        authorLogin: "octocat",
        updatedAt: "2026-09-01T10:00:00Z",
      },
    ]);
  });

  it("lists Forgejo issues from the Forgejo host and skips pull requests", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: 21,
          number: 3,
          title: "Real issue",
          html_url: "https://codeberg.org/acme/widgets/issues/3",
          user: { login: "octocat" },
          updated_at: null,
        },
        {
          id: 22,
          number: 4,
          title: "A PR returned by the issues endpoint",
          html_url: "https://codeberg.org/acme/widgets/pulls/4",
          pull_request: { merged: false },
        },
      ]),
    );

    const items = await GitProviderItemsService.listIssues(
      "acme/widgets",
      "forgejo",
    );

    const [url] = getFetchCall(fetchMock);
    expect(url.startsWith("https://codeberg.org/api/v1/")).toBe(true);
    expect(url).toContain("/repos/acme/widgets/issues");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Real issue");
  });

  describe("GitHub work items", () => {
    const githubRow = (
      number: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id: 1000 + number,
      number,
      title: `Item ${number}`,
      html_url: `https://github.com/acme/widgets/issues/${number}`,
      state: "open",
      user: { login: "octocat" },
      updated_at: "2026-09-01T10:00:00Z",
      labels: [{ name: "bug" }],
      assignees: [{ login: "hubot" }],
      comments: 2,
      ...extra,
    });

    it("pages issues by GitHub's raw page size and drops pull requests", async () => {
      // A full page of 30 rows, one of which is a pull request.
      const rows = Array.from({ length: 30 }, (_, index) =>
        githubRow(index + 1, index === 0 ? { pull_request: {} } : {}),
      );
      fetchMock.mockResolvedValueOnce(mockJsonResponse(rows));

      const page = await GitProviderItemsService.listGithubWorkItems(
        "acme/widgets",
        "issue",
        { state: "closed", page: 2 },
      );

      const url = new URL(getFetchCall(fetchMock)[0]);
      expect(url.origin + url.pathname).toBe(
        "https://api.github.com/repos/acme/widgets/issues",
      );
      expect(url.searchParams.get("state")).toBe("closed");
      expect(url.searchParams.get("page")).toBe("2");
      expect(page.items).toHaveLength(29);
      expect(page.items.some((item) => item.number === 1)).toBe(false);
      expect(page.items[0]).toMatchObject({
        kind: "issue",
        number: 2,
        labels: ["bug"],
        assignees: ["hubot"],
        commentsCount: 2,
        merged: false,
      });
      expect(page.nextPage).toBe(3);
    });

    it("ends paging on a short page and reports merged and draft pull requests", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse([
          githubRow(7, { state: "closed", merged_at: "2026-09-02T00:00:00Z" }),
          githubRow(8, { draft: true }),
        ]),
      );

      const page = await GitProviderItemsService.listGithubWorkItems(
        "acme/widgets",
        "pull_request",
        { state: "all", page: 1 },
      );

      expect(new URL(getFetchCall(fetchMock)[0]).pathname).toBe(
        "/repos/acme/widgets/pulls",
      );
      expect(page.nextPage).toBeNull();
      expect(
        page.items.map(({ merged, draft }) => ({ merged, draft })),
      ).toEqual([
        { merged: true, draft: false },
        { merged: false, draft: true },
      ]);
    });

    it("loads a pull request with its description and branches", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse(
          githubRow(7, {
            body: "Adds the thing",
            head: { ref: "feature/thing", repo: { full_name: "fork/widgets" } },
            base: { ref: "main" },
            additions: 10,
            deletions: 2,
            changed_files: 3,
          }),
        ),
      );

      const item = await GitProviderItemsService.getGithubWorkItem(
        "acme/widgets",
        "pull_request",
        7,
      );

      expect(getFetchCall(fetchMock)[0]).toBe(
        "https://api.github.com/repos/acme/widgets/pulls/7",
      );
      expect(item).toMatchObject({
        kind: "pull_request",
        body: "Adds the thing",
        headRef: "feature/thing",
        headRepository: "fork/widgets",
        baseRef: "main",
        additions: 10,
        deletions: 2,
        changedFiles: 3,
      });
    });

    it("rejects with the HTTP status GitHub answered", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({ message: "Not Found" }, 404),
      );

      const request = GitProviderItemsService.getGithubWorkItem(
        "acme/private",
        "issue",
        1,
      );

      await expect(request).rejects.toBeInstanceOf(GitProviderApiError);
      await expect(request).rejects.toMatchObject({ status: 404 });
    });
  });
});
