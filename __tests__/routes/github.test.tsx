import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { SecretsService } from "#/api/secrets-service";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { GitProviderItemsService } from "#/api/git-provider-items-service";
import {
  githubRunKey,
  useGithubAgentRunsStore,
} from "#/stores/github-agent-runs-store";
import { useGithubRecentRepositoriesStore } from "#/stores/github-recent-repositories-store";
import GithubRoute from "#/routes/github";
import { renderWithProviders } from "test-utils";
import { mockJsonResponse } from "../api/cloud/fetch-test-utils";

// Only the network edges are faked: GitHub's REST API (fetch), the
// conversation launch boundary, and which kind of backend is active.

const mocks = vi.hoisted(() => ({
  backendKind: "cloud" as "cloud" | "local",
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  navigate: vi.fn(),
  serverInfo: vi.fn(),
  harnessImages: [] as {
    imageId: string;
    os: string;
    kind: string;
    role: string;
  }[],
  historyEvents: [] as unknown[],
  harnessRuns: [] as Record<string, unknown>[],
  harnessLeases: [] as Record<string, unknown>[],
  harnessRunDetails: {} as Record<string, unknown>,
}));

const backendFor = (kind: "cloud" | "local"): Backend => ({
  id: `${kind}-backend`,
  name: kind,
  host:
    kind === "cloud" ? "https://app.all-hands.dev" : "http://localhost:8000",
  apiKey: "key",
  kind,
});

vi.mock("#/contexts/active-backend-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#/contexts/active-backend-context")
  >()),
  useActiveBackend: () => ({
    backend: backendFor(mocks.backendKind),
    orgId: null,
  }),
}));

vi.mock("#/api/conversation-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/conversation-workspace")>()),
  getConversationServerInfo: mocks.serverInfo,
}));

vi.mock("#/api/vm-harness-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/vm-harness-service")>()),
  VmHarnessService: {
    listImages: async () => mocks.harnessImages,
    listRuns: async () => mocks.harnessRuns,
    listLeases: async () => mocks.harnessLeases,
    getRun: async (id: string) => mocks.harnessRunDetails[id],
    runScreenshot: async () => ({ pngBase64: "AAAA" }),
    bootFailureShot: async () => ({ pngBase64: "AAAA", details: "stalled" }),
    status: async () => ({ host: { ok: true } }),
  },
}));

vi.mock("#/hooks/mutation/use-create-conversation", () => ({
  useCreateConversation: () => ({ mutate: mocks.createConversation }),
}));

vi.mock("#/hooks/mutation/use-update-conversation", () => ({
  useUpdateConversation: () => ({ mutate: mocks.renameConversation }),
}));

vi.mock("#/hooks/query/use-conversation-history", () => ({
  useConversationHistory: () => ({
    data: { events: mocks.historyEvents },
    refetch: vi.fn(),
    isFetching: false,
  }),
}));

vi.mock("#/hooks/use-user-providers", () => ({
  useUserProviders: () => ({ providers: [], isLoadingSettings: false }),
}));

const githubRow = (number: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + number,
  number,
  title: `Item ${number}`,
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  state: "open",
  user: { login: "octocat" },
  updated_at: "2026-09-01T10:00:00Z",
  labels: [],
  assignees: [],
  ...extra,
});

const PULL_REQUEST = githubRow(7, {
  html_url: "https://github.com/acme/widgets/pull/7",
  body: "Adds the thing",
  head: { ref: "feature/thing", repo: { full_name: "acme/widgets" } },
  base: { ref: "main" },
});

const fetchMock = vi.fn();
const originalFetch = global.fetch;

function githubResponds(routes: Record<string, unknown | Response>) {
  fetchMock.mockImplementation(async (input: string) => {
    const { pathname } = new URL(input);
    const body = routes[pathname];
    if (body === undefined) return mockJsonResponse({}, 404);
    return body instanceof Response ? body : mockJsonResponse(body);
  });
}

const renderAt = (url: string) =>
  renderWithProviders(
    <MemoryRouter initialEntries={[url]}>
      <GithubRoute />
    </MemoryRouter>,
    { navigation: { navigate: mocks.navigate } },
  );

function useBackend(kind: "cloud" | "local") {
  mocks.backendKind = kind;
  setRegisteredBackends([backendFor(kind)]);
  setActiveSelection({ backendId: backendFor(kind).id });
}

beforeEach(() => {
  __resetActiveStoreForTests();
  useBackend("cloud");
  // The local token lookup reads the backend's secrets store; none is set.
  vi.spyOn(SecretsService, "getSecrets").mockResolvedValue([]);
  mocks.createConversation.mockReset();
  mocks.renameConversation.mockReset();
  mocks.navigate.mockReset();
  useGithubRecentRepositoriesStore.setState({ repositories: [] });
  useGithubAgentRunsStore.setState({ runs: {} });
  mocks.historyEvents = [];
  mocks.harnessRuns = [];
  mocks.harnessLeases = [];
  mocks.harnessRunDetails = {};
  mocks.serverInfo.mockReset();
  mocks.serverInfo.mockResolvedValue(null);
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  __resetActiveStoreForTests();
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe("GitHub route", () => {
  it("lists the repository's issues and shows the one the user opens", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5), githubRow(6)],
      "/repos/acme/widgets/issues/5": githubRow(5, {
        body: "Steps to **reproduce**",
      }),
    });
    renderAt("/github?repo=acme/widgets");

    await userEvent.click(await screen.findByTestId("github-work-item-5"));

    const detail = await screen.findByTestId("github-work-item-detail");
    expect(
      await within(detail).findByText("reproduce", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("github-work-item-5")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("starts a cloud agent on the repository to fix the issue and opens the conversation", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    mocks.createConversation.mockImplementation((_variables, options) =>
      options.onSuccess({ conversation_id: "conv-1" }),
    );
    renderAt("/github?repo=acme/widgets&item=5");

    await userEvent.click(
      await screen.findByTestId("github-agent-action-create_pull_request"),
    );

    expect(mocks.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("Fixes #5"),
        repository: { name: "acme/widgets", gitProvider: "github" },
      }),
      expect.anything(),
    );
    expect(mocks.navigate).toHaveBeenCalledWith("/conversations/conv-1");
  });

  it("starts a cloud review on the pull request's own branch", async () => {
    githubResponds({
      "/repos/acme/widgets/pulls": [PULL_REQUEST],
      "/repos/acme/widgets/pulls/7": PULL_REQUEST,
    });
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(
      await screen.findByTestId("github-agent-action-review_pull_request"),
    );

    expect(mocks.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("pull/7/head"),
        repository: {
          name: "acme/widgets",
          gitProvider: "github",
          branch: "feature/thing",
        },
      }),
      expect.anything(),
    );
  });

  it("leaves cloning to the agent on a local backend", async () => {
    useBackend("local");
    githubResponds({
      "/repos/acme/widgets/pulls": [PULL_REQUEST],
      "/repos/acme/widgets/pulls/7": PULL_REQUEST,
    });
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(
      await screen.findByTestId("github-agent-action-review_pull_request"),
    );

    const [variables] = mocks.createConversation.mock.calls[0];
    expect(variables.repository).toBeUndefined();
    expect(variables.query).toContain("clone https://github.com/acme/widgets");
  });

  describe("recent repositories", () => {
    it("offers a repository again, without retyping, after it was opened", async () => {
      githubResponds({ "/repos/acme/widgets/issues": [githubRow(1)] });
      const first = renderAt("/github?repo=acme/widgets");
      await screen.findByText("Item 1");
      first.unmount();

      renderAt("/github");
      await userEvent.click(
        await screen.findByTestId("github-recent-repository-acme/widgets"),
      );

      expect(await screen.findByText("Item 1")).toBeInTheDocument();
    });

    it("lets the user switch to another recent repository and forget one", async () => {
      useGithubRecentRepositoriesStore.setState({
        repositories: ["acme/other", "acme/stale"],
      });
      githubResponds({ "/repos/acme/widgets/issues": [githubRow(1)] });
      renderAt("/github?repo=acme/widgets");

      await userEvent.click(
        await screen.findByTestId("github-forget-repository-acme/stale"),
      );

      expect(
        screen.queryByTestId("github-recent-repository-acme/stale"),
      ).toBeNull();
      expect(
        screen.getByTestId("github-recent-repository-acme/other"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("github-recent-repository-acme/widgets"),
      ).toBeNull();
    });
  });

  describe("GUI VM test environment", () => {
    const withHarness = () =>
      mocks.serverInfo.mockResolvedValue({
        runtime_services: {
          services: { vm_harness: { plugin_path: "/state/vm-harness/plugin" } },
        },
      });

    beforeEach(() => {
      mocks.harnessImages = [
        { imageId: "w", os: "windows", kind: "golden", role: "windows" },
        {
          imageId: "ww",
          os: "windows",
          kind: "prepared",
          role: "windows-workspace",
        },
        { imageId: "u", os: "ubuntu", kind: "golden", role: "ubuntu" },
        {
          imageId: "uw",
          os: "ubuntu",
          kind: "prepared",
          role: "ubuntu-workspace",
        },
      ];
      useBackend("local");
      githubResponds({
        "/repos/acme/widgets/pulls": [PULL_REQUEST],
        "/repos/acme/widgets/pulls/7": PULL_REQUEST,
      });
    });

    it("hides the option when the backend runs no VM harness", async () => {
      renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

      await screen.findByTestId("github-agent-action-review_pull_request");
      expect(screen.queryByTestId("test-environment-select")).toBeNull();
    });

    it("attaches the harness plugin and asks for GUI verification when a VM is chosen", async () => {
      withHarness();
      renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

      await userEvent.selectOptions(
        await screen.findByTestId("test-environment-select"),
        "windows",
      );
      await userEvent.click(
        screen.getByTestId("github-agent-action-review_pull_request"),
      );

      const [variables] = mocks.createConversation.mock.calls[0];
      expect(variables.plugins).toEqual([
        { source: "/state/vm-harness/plugin", name: "gui-vm-testing" },
      ]);
      expect(variables.query).toContain("vm_start");
      expect(variables.query).toContain('image "windows"');
    });

    it("boots the prepared workspace baseline when it is chosen", async () => {
      withHarness();
      renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

      await userEvent.selectOptions(
        await screen.findByTestId("test-environment-select"),
        "windows-workspace",
      );
      await userEvent.click(
        screen.getByTestId("github-agent-action-review_pull_request"),
      );

      const [variables] = mocks.createConversation.mock.calls[0];
      expect(variables.query).toContain('image "windows-workspace"');
      expect(variables.query).toContain("do not delete or reset it");
    });

    it("disables a baseline the harness has no image for", async () => {
      mocks.harnessImages = mocks.harnessImages.filter(
        (image) => !image.role.endsWith("-workspace"),
      );
      withHarness();
      renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

      const select = await screen.findByTestId("test-environment-select");
      const option = (value: string) =>
        select.querySelector(`option[value="${value}"]`) as HTMLOptionElement;
      await waitFor(() =>
        expect(option("windows-workspace").disabled).toBe(true),
      );
      expect(option("ubuntu-workspace").disabled).toBe(true);
      expect(option("windows").disabled).toBe(false);
      expect(option("ubuntu").disabled).toBe(false);
    });

    it("starts a plain sandbox conversation when the default is kept", async () => {
      withHarness();
      renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

      await userEvent.click(
        await screen.findByTestId("github-agent-action-review_pull_request"),
      );

      const [variables] = mocks.createConversation.mock.calls[0];
      expect(variables.plugins).toBeUndefined();
      expect(variables.query).not.toContain("vm_start");
    });
  });

  it("explains token and rate limits when GitHub refuses the repository", async () => {
    githubResponds({
      "/repos/acme/private/issues": mockJsonResponse(
        { message: "Not Found" },
        404,
      ),
    });
    renderAt("/github?repo=acme/private");

    const error = await screen.findByTestId("github-work-items-error");
    expect(error).toHaveTextContent("GITHUB$ACCESS_HINT");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

const agentMessage = (text: string) => ({
  id: "e1",
  source: "agent",
  llm_message: { role: "assistant", content: [{ type: "text", text }] },
});

const seedRun = (
  number: number,
  action: "work_on_issue" | "review_pull_request",
) =>
  useGithubAgentRunsStore
    .getState()
    .record(githubRunKey("cloud-backend", "acme/widgets", number), {
      conversationId: "conv-9",
      action,
      startedAt: "2026-09-01T10:00:00Z",
    });

describe("GitHub agent results", () => {
  it("remembers which item a launched agent was for", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    mocks.createConversation.mockImplementation((_variables, options) =>
      options.onSuccess({ conversation_id: "conv-1" }),
    );
    renderAt("/github?repo=acme/widgets&item=5");

    await userEvent.click(
      await screen.findByTestId("github-agent-action-work_on_issue"),
    );

    expect(
      useGithubAgentRunsStore.getState().runs[
        githubRunKey("cloud-backend", "acme/widgets", 5)
      ]?.[0],
    ).toMatchObject({ conversationId: "conv-1", action: "work_on_issue" });
  });

  it("names the conversation by repository and item, not by the shared first sentence", async () => {
    githubResponds({
      "/repos/acme/widgets/pulls": [PULL_REQUEST],
      "/repos/acme/widgets/pulls/7": PULL_REQUEST,
    });
    mocks.createConversation.mockImplementation((_variables, options) =>
      options.onSuccess({ conversation_id: "conv-1" }),
    );
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(
      await screen.findByTestId("github-agent-action-review_pull_request"),
    );

    expect(mocks.renameConversation).toHaveBeenCalledWith({
      conversationId: "conv-1",
      newTitle: "acme:widgets PR#7 - GITHUB$ACTION_REVIEW_PR",
    });
  });

  it("shows the agent's result next to the issue and posts the edited text as a comment", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    seedRun(5, "work_on_issue");
    mocks.historyEvents = [agentMessage("The **root cause** is a race.")];
    const post = vi
      .spyOn(GitProviderItemsService, "postGithubComment")
      .mockResolvedValue({
        url: "https://github.com/acme/widgets/issues/5#c1",
      });
    renderAt("/github?repo=acme/widgets&item=5");

    const result = await screen.findByTestId("github-agent-run-result");
    expect(within(result).getByText("root cause")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("github-post-open"));
    const box = screen.getByTestId("github-post-textarea");
    expect(box).toHaveValue("The **root cause** is a race.");
    await userEvent.clear(box);
    await userEvent.type(box, "Edited finding");
    await userEvent.click(screen.getByTestId("github-post-submit"));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("acme/widgets", 5, "Edited finding"),
    );
    expect(
      await screen.findByTestId("github-post-success"),
    ).toBeInTheDocument();
  });

  it("posts a pull request result as a review, and explains a refused write", async () => {
    githubResponds({
      "/repos/acme/widgets/pulls": [PULL_REQUEST],
      "/repos/acme/widgets/pulls/7": PULL_REQUEST,
    });
    seedRun(7, "review_pull_request");
    mocks.historyEvents = [agentMessage("Two issues found.")];
    const review = vi
      .spyOn(GitProviderItemsService, "postGithubReview")
      .mockRejectedValue(
        new (
          await import("#/api/git-provider-items-service")
        ).GitProviderApiError("GitHub", 403),
      );
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(await screen.findByTestId("github-post-open"));
    await userEvent.click(screen.getByTestId("github-post-submit"));

    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(
        "acme/widgets",
        7,
        "Two issues found.",
        { event: "COMMENT", comments: [] },
      ),
    );
    expect(await screen.findByTestId("github-post-error")).toHaveTextContent(
      "GITHUB$POST_ERROR",
    );
    // A review run has no commits to push.
    expect(screen.queryByTestId("github-push")).not.toBeInTheDocument();
  });

  it("asks the finished run to push, and to open a pull request for an issue", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    seedRun(5, "work_on_issue");
    mocks.historyEvents = [agentMessage("Fixed locally.")];
    const send = vi
      .spyOn(AgentServerConversationService, "sendMessage")
      .mockResolvedValue({} as never);
    renderAt("/github?repo=acme/widgets&item=5");

    await userEvent.click(await screen.findByTestId("github-push-and-pr"));

    await waitFor(() => expect(send).toHaveBeenCalled());
    const [conversationId, message] = send.mock.calls[0] as unknown as [
      string,
      { content: { text: string }[] },
    ];
    expect(conversationId).toBe("conv-9");
    expect(message.content[0].text).toContain("Fixes #5");
    expect(await screen.findByTestId("github-push-sent")).toBeInTheDocument();
  });
});

describe("GitHub agent run status", () => {
  const stateEvent = (value: string) => ({
    kind: "ConversationStateUpdateEvent",
    key: "execution_status",
    value,
  });

  it("shows a running agent as running, without treating its narration as the result", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    seedRun(5, "work_on_issue");
    mocks.historyEvents = [
      stateEvent("running"),
      agentMessage("Let's give the VM harness another attempt."),
    ];
    renderAt("/github?repo=acme/widgets&item=5");

    expect(
      await screen.findByTestId("github-agent-run-status"),
    ).toHaveAttribute("data-status", "running");
    expect(
      screen.queryByTestId("github-agent-run-result"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("github-post-open")).toBeDisabled();
    expect(screen.getByTestId("github-push")).toBeDisabled();
  });

  it("explains a usage limit and resumes the run with a message", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    seedRun(5, "work_on_issue");
    mocks.historyEvents = [
      stateEvent("running"),
      {
        kind: "ConversationErrorEvent",
        source: "agent",
        detail: "session limit · resets 1pm (America/Regina): rate_limit",
      },
      stateEvent("error"),
    ];
    const send = vi
      .spyOn(AgentServerConversationService, "sendMessage")
      .mockResolvedValue({} as never);
    renderAt("/github?repo=acme/widgets&item=5");

    expect(
      await screen.findByTestId("github-agent-run-notice"),
    ).toHaveTextContent("GITHUB$RUN_RESUMES");
    await userEvent.click(screen.getByTestId("github-run-resume"));

    await waitFor(() => expect(send).toHaveBeenCalled());
    const [conversationId, message] = send.mock.calls[0] as unknown as [
      string,
      { content: { text: string }[] },
    ];
    expect(conversationId).toBe("conv-9");
    expect(message.content[0].text).toBe("continue");
  });
});

describe("GitHub pull request detail", () => {
  const pullRoutes = (extra: Record<string, unknown> = {}) => ({
    "/repos/acme/widgets/pulls": [PULL_REQUEST],
    "/repos/acme/widgets/pulls/7": {
      ...PULL_REQUEST,
      head: {
        ref: "feature/thing",
        sha: "abc123",
        repo: { full_name: "acme/widgets" },
      },
    },
    ...extra,
  });

  it("shows the checks with an approval-gated run told apart from a failure, and the discussion", async () => {
    githubResponds(
      pullRoutes({
        "/repos/acme/widgets/commits/abc123/check-runs": {
          check_runs: [
            {
              name: "unit",
              status: "completed",
              conclusion: "action_required",
            },
            { name: "lint", status: "completed", conclusion: "success" },
          ],
        },
        "/repos/acme/widgets/issues/7/comments": [
          {
            id: 1,
            body: "Looks **good** overall",
            created_at: "2026-09-01T10:00:00Z",
            user: { login: "reviewer" },
          },
        ],
        "/repos/acme/widgets/pulls/7/files": [
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 3,
            deletions: 1,
          },
        ],
      }),
    );
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    expect(await screen.findByTestId("github-check-unit")).toHaveAttribute(
      "data-state",
      "action_required",
    );
    expect(screen.getByTestId("github-check-lint")).toHaveAttribute(
      "data-state",
      "success",
    );
    expect(
      await screen.findByTestId("github-discussion-comment-1"),
    ).toHaveTextContent("reviewer");
    expect(await screen.findByTestId("github-changed-files")).toHaveTextContent(
      "src/a.ts",
    );
  });

  it("starts the chosen pull request action with the user's extra instructions", async () => {
    githubResponds(pullRoutes());
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.type(
      await screen.findByTestId("github-agent-instructions"),
      "keep the API stable",
    );
    await userEvent.click(
      screen.getByTestId("github-agent-action-address_review_comments"),
    );

    const [variables] = mocks.createConversation.mock.calls[0];
    expect(variables.query).toContain("review feedback");
    expect(variables.query).toContain(
      ["Additional instructions from me:", "keep the API stable"].join("\n"),
    );
  });

  it("posts a request for changes with the findings as comments on the diff", async () => {
    githubResponds(pullRoutes());
    seedRun(7, "review_pull_request");
    mocks.historyEvents = [
      agentMessage(
        [
          "Needs work.",
          "",
          "```json",
          '[{"path":"src/a.ts","line":4,"body":"Null check"}]',
          "```",
        ].join("\n"),
      ),
    ];
    const review = vi
      .spyOn(GitProviderItemsService, "postGithubReview")
      .mockResolvedValue({ url: "https://github.com/acme/widgets/pull/7#r1" });
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(await screen.findByTestId("github-post-open"));
    expect(screen.getByTestId("github-post-textarea")).toHaveValue(
      "Needs work.",
    );
    await userEvent.click(
      screen.getByLabelText("GITHUB$POST_AS_REQUEST_CHANGES"),
    );
    await userEvent.click(screen.getByTestId("github-post-submit"));

    await waitFor(() =>
      expect(review).toHaveBeenCalledWith("acme/widgets", 7, "Needs work.", {
        event: "REQUEST_CHANGES",
        comments: [{ path: "src/a.ts", line: 4, body: "Null check" }],
      }),
    );
  });
});

describe("GitHub pull request actions", () => {
  const openPull = (extra: Record<string, unknown> = {}) => ({
    ...PULL_REQUEST,
    head: {
      ref: "feature/thing",
      sha: "abc123",
      repo: { full_name: "acme/widgets" },
    },
    mergeable: true,
    mergeable_state: "clean",
    ...extra,
  });
  const routes = (pull: unknown, extra: Record<string, unknown> = {}) => ({
    "/repos/acme/widgets/pulls": [PULL_REQUEST],
    "/repos/acme/widgets/pulls/7": pull,
    "/repos/acme/widgets/actions/runs": { workflow_runs: [] },
    ...extra,
  });

  it("merges only after a second click, with the method and commit shown", async () => {
    githubResponds(routes(openPull()));
    const merge = vi
      .spyOn(GitProviderItemsService, "mergeGithubPullRequest")
      .mockResolvedValue();
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.selectOptions(
      await screen.findByTestId("github-merge-method"),
      "rebase",
    );
    await userEvent.click(screen.getByTestId("github-pr-merge"));
    expect(merge).not.toHaveBeenCalled();
    expect(screen.getByTestId("github-pr-merge")).toHaveTextContent(
      "GITHUB$MERGE_CONFIRM",
    );
    await userEvent.click(screen.getByTestId("github-pr-merge"));

    await waitFor(() =>
      expect(merge).toHaveBeenCalledWith("acme/widgets", 7, {
        method: "rebase",
        sha: "abc123",
      }),
    );
    expect(
      await screen.findByTestId("github-pr-action-done"),
    ).toBeInTheDocument();
  });

  it("will not offer to merge a conflicted or draft pull request, and explains why", async () => {
    githubResponds(
      routes(openPull({ mergeable: false, mergeable_state: "dirty" })),
    );
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    expect(await screen.findByTestId("github-pr-merge")).toBeDisabled();
    expect(screen.getByText("GITHUB$MERGE_HINT_CONFLICT")).toBeInTheDocument();
  });

  it("offers no actions on a pull request that is already merged", async () => {
    githubResponds(routes(openPull({ state: "closed", merged: true })));
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await screen.findByTestId("github-work-item-detail");
    expect(screen.queryByTestId("github-pr-actions")).not.toBeInTheDocument();
  });

  it("approves the pull request and explains a refusal by status", async () => {
    githubResponds(routes(openPull()));
    const review = vi
      .spyOn(GitProviderItemsService, "postGithubReview")
      .mockRejectedValue(
        new (
          await import("#/api/git-provider-items-service")
        ).GitProviderApiError("GitHub", 422),
      );
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(await screen.findByTestId("github-pr-approve"));

    await waitFor(() =>
      expect(review).toHaveBeenCalledWith("acme/widgets", 7, "", {
        event: "APPROVE",
      }),
    );
    expect(
      await screen.findByTestId("github-pr-action-error"),
    ).toHaveTextContent("GITHUB$ACTION_ERROR");
  });

  it("approves a run held for approval and re-runs failed jobs of another", async () => {
    githubResponds(
      routes(openPull(), {
        "/repos/acme/widgets/actions/runs": {
          workflow_runs: [
            {
              id: 11,
              name: "CI",
              status: "completed",
              conclusion: "action_required",
            },
            {
              id: 12,
              name: "Lint",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      }),
    );
    const approve = vi
      .spyOn(GitProviderItemsService, "approveGithubWorkflowRun")
      .mockResolvedValue();
    const rerun = vi
      .spyOn(GitProviderItemsService, "rerunGithubWorkflowRun")
      .mockResolvedValue();
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    expect(await screen.findByTestId("github-run-11")).toHaveAttribute(
      "data-state",
      "action_required",
    );
    // A run waiting for approval cannot be re-run, only approved.
    expect(screen.queryByTestId("github-run-rerun-11")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("github-run-approve-11"));
    await userEvent.click(screen.getByTestId("github-run-rerun-failed-12"));

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("acme/widgets", 11),
    );
    await waitFor(() =>
      expect(rerun).toHaveBeenCalledWith("acme/widgets", 12, true),
    );
  });
});

describe("GitHub list filters", () => {
  it("searches GitHub when Enter is pressed and lists items assigned to the user", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5), githubRow(6)],
      "/search/issues": { items: [githubRow(9)] },
    });
    renderAt("/github?repo=acme/widgets");
    await screen.findByTestId("github-work-item-5");

    await userEvent.type(
      screen.getByTestId("github-work-items-filter"),
      "flaky{Enter}",
    );

    expect(await screen.findByTestId("github-work-item-9")).toBeInTheDocument();
    expect(screen.queryByTestId("github-work-item-5")).not.toBeInTheDocument();
    const searched = fetchMock.mock.calls
      .map(([url]) => new URL(url as string))
      .find((url) => url.pathname === "/search/issues");
    expect(searched?.searchParams.get("q")).toContain("flaky");

    await userEvent.selectOptions(
      screen.getByTestId("github-involvement"),
      "assigned",
    );
    await waitFor(() => {
      const last = fetchMock.mock.calls
        .map(([url]) => new URL(url as string))
        .filter((url) => url.pathname === "/search/issues")
        .pop();
      expect(last?.searchParams.get("q")).toContain("assignee:@me");
    });
  });

  it("marks items an agent already worked on", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5), githubRow(6)],
    });
    seedRun(5, "work_on_issue");
    renderAt("/github?repo=acme/widgets");

    expect(
      await screen.findByTestId("github-work-item-has-run-5"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("github-work-item-has-run-6"),
    ).not.toBeInTheDocument();
  });
});

describe("GitHub linked items", () => {
  it("links an issue to the pull request that fixes it and opens that pull request", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5, {
        body: "Related to #3. Blocks nothing.",
      }),
      "/repos/acme/widgets/issues/5/timeline": [
        {
          event: "cross-referenced",
          source: {
            issue: {
              ...githubRow(9, { pull_request: {}, body: "Fixes #5" }),
              repository: { full_name: "acme/widgets" },
            },
          },
        },
      ],
      "/repos/acme/widgets/issues/3": githubRow(3, { title: "Older issue" }),
      "/repos/acme/widgets/pulls": [githubRow(9)],
      "/repos/acme/widgets/pulls/9": githubRow(9, {
        body: "Fixes #5",
        head: { ref: "fix", repo: { full_name: "acme/widgets" } },
        base: { ref: "main" },
      }),
    });
    renderAt("/github?repo=acme/widgets&item=5");

    const linked = await screen.findByTestId("github-linked-items");
    const pr = await within(linked).findByTestId(
      "github-linked-pull_request-9",
    );
    expect(pr).toHaveTextContent("GITHUB$LINK_CLOSED_BY");
    expect(
      within(linked).getByTestId("github-linked-issue-3"),
    ).toHaveTextContent("GITHUB$LINK_MENTIONS");

    await userEvent.click(pr);

    // The page switches to the pull requests tab with that pull request open.
    expect(
      await screen.findByTestId("github-tab-pull_request"),
    ).toHaveAttribute("aria-selected", "true");
    await waitFor(() =>
      expect(screen.getByTestId("github-work-item-detail")).toHaveTextContent(
        "Item 9",
      ),
    );
  });

  it("still shows the item when GitHub cannot list its links", async () => {
    githubResponds({
      "/repos/acme/widgets/issues": [githubRow(5)],
      "/repos/acme/widgets/issues/5": githubRow(5),
    });
    renderAt("/github?repo=acme/widgets&item=5");

    expect(await screen.findByTestId("github-linked-items")).toHaveTextContent(
      "GITHUB$LINKS_NONE",
    );
  });
});

describe("GUI VM test evidence on the item", () => {
  const RUN = {
    imageId: "w",
    os: "windows",
    stage: null,
    error: null,
    hasBootFailureShot: false,
    report: { passed: true, summary: "All good", steps: 1 },
  };
  const FOR_PR = {
    repository: "acme/widgets",
    item: "7",
    kind: "pull_request",
  };

  beforeEach(() => {
    useBackend("local");
    mocks.serverInfo.mockResolvedValue({
      runtime_services: {
        services: { vm_harness: { plugin_path: "/state/vm-harness/plugin" } },
      },
    });
    githubResponds({
      "/repos/acme/widgets/pulls": [PULL_REQUEST],
      "/repos/acme/widgets/pulls/7": PULL_REQUEST,
    });
    mocks.harnessRuns = [
      {
        ...RUN,
        id: "l00002",
        startedAt: "2026-11-09T10:00:00Z",
        status: "stopped",
        context: FOR_PR,
      },
      {
        ...RUN,
        id: "l00001",
        startedAt: "2026-11-08T10:00:00Z",
        status: "stopped",
        report: { passed: false, summary: "Old failure", steps: 1 },
        context: FOR_PR,
      },
      {
        ...RUN,
        id: "l00009",
        startedAt: "2026-11-09T11:00:00Z",
        status: "stopped",
        report: { passed: true, summary: "Other item", steps: 1 },
        context: { repository: "acme/widgets", item: "8" },
      },
    ];
    mocks.harnessRunDetails = {
      l00002: {
        lease: {},
        report: { verdict: { passed: true }, summary: "All good" },
        steps: [
          {
            id: "s1",
            title: "Opens the panel",
            status: "pass",
            expected: "A panel",
            observed: "A panel",
            evidence: [String.raw`C:\runs\l00002\screenshots\001-open.png`],
          },
        ],
        screenshots: ["001-open.png", "002-saved.png"],
      },
      l00001: {
        lease: {},
        report: { verdict: { passed: false }, summary: "Old failure" },
        steps: [],
        screenshots: ["001-old.png"],
      },
    };
  });

  it("shows the runs of this item without any agent run remembered by this browser", async () => {
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    const section = await screen.findByTestId("github-vm-runs");
    expect(
      within(section).getByTestId("github-vm-run-card-l00002"),
    ).toBeVisible();
    expect(
      within(section).getByTestId("github-vm-run-card-l00001"),
    ).toBeVisible();
    expect(
      within(section).queryByTestId("github-vm-run-card-l00009"),
    ).toBeNull();
    expect(screen.queryByTestId("github-agent-runs")).toBeNull();
  });

  it("opens the newest run with its steps and screenshots, and leaves older runs closed", async () => {
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    expect(await screen.findByText("All good")).toBeInTheDocument();
    expect(screen.getByTestId("vm-step-s1")).toHaveTextContent(
      "Opens the panel",
    );
    expect(
      screen.getByTestId("vm-screenshot-001-open.png"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("vm-screenshot-002-saved.png"),
    ).toBeInTheDocument();
    // The older run's report stays closed until it is expanded.
    expect(screen.queryByTestId("vm-screenshot-001-old.png")).toBeNull();

    await userEvent.click(screen.getByTestId("github-vm-run-toggle-l00001"));
    expect(
      await screen.findByTestId("vm-screenshot-001-old.png"),
    ).toBeInTheDocument();
  });

  it("steps through a run's screenshots in a lightbox with the keyboard", async () => {
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(
      await screen.findByTestId("vm-screenshot-001-open.png"),
    );
    const lightbox = await screen.findByTestId("vm-lightbox");
    expect(
      within(lightbox).getByTestId("vm-lightbox-counter"),
    ).toHaveTextContent("1 / 2");
    // The step that cites this screenshot is its caption.
    expect(within(lightbox).getByTestId("vm-step-s1")).toBeInTheDocument();

    await userEvent.keyboard("{ArrowRight}");
    expect(
      within(lightbox).getByTestId("vm-lightbox-counter"),
    ).toHaveTextContent("2 / 2");
    expect(within(lightbox).getByTestId("vm-lightbox-next")).toBeDisabled();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("vm-lightbox")).toBeNull();
  });

  it("filters the gallery to the screenshots steps cite", async () => {
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await screen.findByTestId("vm-screenshot-002-saved.png");
    await userEvent.click(screen.getByTestId("vm-filter-evidence"));

    expect(
      screen.getByTestId("vm-screenshot-001-open.png"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("vm-screenshot-002-saved.png")).toBeNull();
  });

  it("explains a VM that never started and shows the screen it stalled on", async () => {
    mocks.harnessRuns = [
      {
        ...RUN,
        id: "l00003",
        startedAt: "2026-11-09T12:00:00Z",
        status: "failed",
        stage: "waiting for SSH",
        error: "timed out",
        hasBootFailureShot: true,
        report: null,
        context: FOR_PR,
      },
    ];
    mocks.harnessRunDetails.l00003 = {
      lease: {},
      report: null,
      steps: [],
      screenshots: [],
    };
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    const failure = await screen.findByTestId("vm-boot-failure");
    expect(failure).toHaveTextContent("timed out");
    expect(await within(failure).findByRole("img")).toBeInTheDocument();
  });

  it("shows a VM that is running for the item", async () => {
    mocks.harnessLeases = [
      {
        id: "lffff01",
        imageId: "w",
        os: "windows",
        status: "booting",
        stage: "waiting for SSH",
        startedAt: "2026-11-09T13:00:00Z",
        context: FOR_PR,
      },
    ];
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    const live = await screen.findByTestId("github-vm-live-lffff01");
    // Tests render translation keys, so the booting label stands for its text.
    expect(live).toHaveTextContent("VM_HARNESS$STATUS_BOOTING");
    await userEvent.click(within(live).getByRole("button"));
    expect(mocks.navigate).toHaveBeenCalledWith("/test-vms");
  });

  it("links a run to its page on the Test VMs route", async () => {
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await userEvent.click(await screen.findByTestId("github-vm-run-l00002"));
    expect(mocks.navigate).toHaveBeenCalledWith("/test-vms/runs/l00002");
  });

  it("offers nothing when the backend runs no VM harness", async () => {
    mocks.serverInfo.mockResolvedValue(null);
    renderAt("/github?repo=acme/widgets&tab=pulls&item=7");

    await screen.findByTestId("github-work-item-detail");
    expect(screen.queryByTestId("github-vm-runs")).toBeNull();
  });
});
