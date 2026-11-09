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
import GithubRoute from "#/routes/github";
import { renderWithProviders } from "test-utils";
import { mockJsonResponse } from "../api/cloud/fetch-test-utils";

// Only the network edges are faked: GitHub's REST API (fetch), the
// conversation launch boundary, and which kind of backend is active.

const mocks = vi.hoisted(() => ({
  backendKind: "cloud" as "cloud" | "local",
  createConversation: vi.fn(),
  navigate: vi.fn(),
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

vi.mock("#/hooks/mutation/use-create-conversation", () => ({
  useCreateConversation: () => ({ mutate: mocks.createConversation }),
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
  mocks.navigate.mockReset();
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
