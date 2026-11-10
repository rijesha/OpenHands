import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsClient } from "@openhands/typescript-client/clients";
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
import { SecretsService } from "#/api/secrets-service";
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

    it("searches on GitHub for a text query and for items assigned to the user", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({ items: [githubRow(9)] }),
      );

      const page = await GitProviderItemsService.listGithubWorkItems(
        "acme/widgets",
        "issue",
        {
          state: "open",
          page: 1,
          query: "flaky test",
          involvement: "assigned",
        },
      );

      const url = new URL(getFetchCall(fetchMock)[0] as string);
      expect(url.pathname).toBe("/search/issues");
      expect(url.searchParams.get("q")).toBe(
        "repo:acme/widgets is:issue state:open assignee:@me flaky test",
      );
      expect(page.items.map((item) => item.number)).toEqual([9]);
    });

    it("loads a pull request's checks with the worst state first, and approval-gated runs distinct", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({
          check_runs: [
            { name: "lint", status: "completed", conclusion: "success" },
            { name: "e2e", status: "completed", conclusion: "action_required" },
            { name: "unit", status: "completed", conclusion: "failure" },
            { name: "build", status: "in_progress" },
          ],
        }),
      );

      const summary = await GitProviderItemsService.getGithubChecks(
        "acme/widgets",
        "abc123",
      );

      expect(getFetchCall(fetchMock)[0]).toContain(
        "/commits/abc123/check-runs",
      );
      expect(summary.state).toBe("failure");
      expect(summary.checks.map((c) => [c.name, c.state])).toEqual([
        ["unit", "failure"],
        ["e2e", "action_required"],
        ["build", "pending"],
        ["lint", "success"],
      ]);
    });

    it("merges comments, reviews and line comments in time order and drops empty comment-only reviews", async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockJsonResponse([
            {
              id: 1,
              body: "first",
              created_at: "2026-09-01T10:00:00Z",
              user: { login: "a" },
            },
          ]),
        )
        .mockResolvedValueOnce(
          mockJsonResponse([
            {
              id: 2,
              body: "",
              state: "COMMENTED",
              submitted_at: "2026-09-01T11:00:00Z",
            },
            {
              id: 3,
              body: "needs work",
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-09-01T12:00:00Z",
              user: { login: "b" },
            },
          ]),
        )
        .mockResolvedValueOnce(
          mockJsonResponse([
            {
              id: 4,
              body: "nit",
              path: "src/a.ts",
              created_at: "2026-09-01T11:30:00Z",
              user: { login: "b" },
            },
          ]),
        );

      const entries = await GitProviderItemsService.getGithubDiscussion(
        "acme/widgets",
        "pull_request",
        7,
      );

      expect(entries.map((e) => [e.type, e.body])).toEqual([
        ["comment", "first"],
        ["line_comment", "nit"],
        ["review", "needs work"],
      ]);
      expect(entries[2].reviewState).toBe("CHANGES_REQUESTED");
      expect(entries[1].path).toBe("src/a.ts");
    });

    it("submits a review with the chosen verdict and comments on diff lines", async () => {
      fetchMock.mockResolvedValueOnce(
        mockJsonResponse({
          html_url: "https://github.com/acme/widgets/pull/7#r1",
        }),
      );

      const localBackend: Backend = {
        id: "local",
        name: "Local",
        host: "http://localhost:8000",
        apiKey: "",
        kind: "local",
      };
      setRegisteredBackends([localBackend]);
      setActiveSelection({ backendId: localBackend.id });
      vi.spyOn(SecretsService, "getSecrets").mockResolvedValue([
        { name: "GITHUB_PERSONAL_ACCESS_TOKEN" },
      ]);
      vi.spyOn(SettingsClient.prototype, "getSecret").mockResolvedValue("pat");

      await GitProviderItemsService.postGithubReview(
        "acme/widgets",
        7,
        "Two issues",
        {
          event: "REQUEST_CHANGES",
          comments: [{ path: "src/a.ts", line: 12, body: "Null check" }],
        },
      );

      const init = getFetchCall(fetchMock)[1] as { body: string };
      expect(JSON.parse(init.body)).toEqual({
        body: "Two issues",
        event: "REQUEST_CHANGES",
        comments: [
          { path: "src/a.ts", line: 12, side: "RIGHT", body: "Null check" },
        ],
      });
    });

    describe("writes", () => {
      beforeEach(() => {
        const localBackend: Backend = {
          id: "local",
          name: "Local",
          host: "http://localhost:8000",
          apiKey: "",
          kind: "local",
        };
        setRegisteredBackends([localBackend]);
        setActiveSelection({ backendId: localBackend.id });
        vi.spyOn(SecretsService, "getSecrets").mockResolvedValue([
          { name: "GITHUB_PERSONAL_ACCESS_TOKEN" },
        ]);
        vi.spyOn(SettingsClient.prototype, "getSecret").mockResolvedValue(
          "pat",
        );
      });

      it("merges with the chosen method and the commit that was shown", async () => {
        fetchMock.mockResolvedValueOnce(mockJsonResponse({ merged: true }));

        await GitProviderItemsService.mergeGithubPullRequest(
          "acme/widgets",
          7,
          {
            method: "squash",
            sha: "abc123",
          },
        );

        const [url, init] = getFetchCall(fetchMock);
        expect(url).toBe(
          "https://api.github.com/repos/acme/widgets/pulls/7/merge",
        );
        expect(init.method).toBe("PUT");
        expect(JSON.parse(init.body as string)).toEqual({
          merge_method: "squash",
          sha: "abc123",
        });
      });

      it("reports GitHub's refusal of a merge by status", async () => {
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse({ message: "x" }, 405),
        );

        await expect(
          GitProviderItemsService.mergeGithubPullRequest("acme/widgets", 7, {
            method: "merge",
          }),
        ).rejects.toMatchObject({ status: 405 });
      });

      it("lists workflow runs, telling a run waiting for approval from a failure", async () => {
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse({
            workflow_runs: [
              {
                id: 1,
                name: "CI",
                status: "completed",
                conclusion: "action_required",
              },
              {
                id: 2,
                name: "Lint",
                status: "completed",
                conclusion: "failure",
              },
              { id: 3, name: "Docs", status: "in_progress", conclusion: null },
            ],
          }),
        );

        const runs = await GitProviderItemsService.getGithubWorkflowRuns(
          "acme/widgets",
          "abc123",
        );

        expect(getFetchCall(fetchMock)[0]).toContain(
          "/actions/runs?head_sha=abc123",
        );
        expect(
          runs.map((r) => [r.id, r.needsApproval, r.failed, r.running]),
        ).toEqual([
          [1, true, false, false],
          [2, false, true, false],
          [3, false, false, true],
        ]);
      });

      it("approves and re-runs workflow runs, accepting GitHub's empty answers", async () => {
        fetchMock
          .mockResolvedValueOnce(new Response(null, { status: 204 }))
          .mockResolvedValueOnce(new Response(null, { status: 201 }))
          .mockResolvedValueOnce(new Response(null, { status: 201 }));

        await GitProviderItemsService.approveGithubWorkflowRun(
          "acme/widgets",
          11,
        );
        await GitProviderItemsService.rerunGithubWorkflowRun(
          "acme/widgets",
          12,
          false,
        );
        await GitProviderItemsService.rerunGithubWorkflowRun(
          "acme/widgets",
          13,
          true,
        );

        expect(
          fetchMock.mock.calls.map(([url, init]) => [url, init.method]),
        ).toEqual([
          [
            "https://api.github.com/repos/acme/widgets/actions/runs/11/approve",
            "POST",
          ],
          [
            "https://api.github.com/repos/acme/widgets/actions/runs/12/rerun",
            "POST",
          ],
          [
            "https://api.github.com/repos/acme/widgets/actions/runs/13/rerun-failed-jobs",
            "POST",
          ],
        ]);
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

    it("authenticates with a GITHUB_PERSONAL_ACCESS_TOKEN secret on a local backend", async () => {
      const localBackend: Backend = {
        id: "local",
        name: "Local",
        host: "http://localhost:8000",
        apiKey: "",
        kind: "local",
      };
      setRegisteredBackends([localBackend]);
      setActiveSelection({ backendId: localBackend.id });
      vi.spyOn(SecretsService, "getSecrets").mockResolvedValue([
        { name: "GITHUB_PERSONAL_ACCESS_TOKEN" },
      ]);
      vi.spyOn(SettingsClient.prototype, "getSecret").mockResolvedValue(
        "pat-value",
      );
      fetchMock.mockResolvedValueOnce(mockJsonResponse(githubRow(7)));

      await GitProviderItemsService.getGithubWorkItem(
        "acme/private",
        "issue",
        7,
      );

      const [, init] = getFetchCall(fetchMock);
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer pat-value",
      );
    });
  });
});
