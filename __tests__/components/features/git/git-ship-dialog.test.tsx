import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { GitProviderItemsService } from "#/api/git-provider-items-service";
import { GitShipDialog } from "#/components/features/git/git-ship-dialog";
import { renderWithProviders } from "test-utils";

// Only the edges are faked: the agent-server's command API, the conversation
// record, and GitHub.

const mocks = vi.hoisted(() => ({
  commands: [] as string[],
  failOn: null as string | null,
  status: "",
}));

vi.mock("@openhands/typescript-client/clients", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@openhands/typescript-client/clients")
  >()),
  BashClient: class {
    close() {}

    async executeCommand({ command }: { command: string }) {
      mocks.commands.push(command);
      if (command.includes("@@branch")) {
        return { exit_code: 0, stdout: mocks.status, stderr: "" };
      }
      if (mocks.failOn && command.includes(mocks.failOn)) {
        return { exit_code: 1, stdout: "", stderr: "remote rejected" };
      }
      return { exit_code: 0, stdout: "", stderr: "" };
    }
  },
}));

vi.mock("#/contexts/active-backend-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#/contexts/active-backend-context")
  >()),
  useActiveBackend: () => ({ backend: LOCAL_BACKEND, orgId: null }),
}));

vi.mock("#/api/agent-server-client-options", () => ({
  getAgentServerClientOptions: () => ({}),
}));

const LOCAL_BACKEND = vi.hoisted(() => ({
  id: "local",
  name: "local",
  host: "http://localhost:8000",
  apiKey: "key",
  kind: "local" as const,
}));

const statusOn = (branch: string, changes = " M src/a.ts") =>
  [
    "@@branch",
    branch,
    "@@upstream",
    "@@counts",
    "@@base",
    "origin/main",
    "@@changes",
    changes,
  ].join("\n");

const PLAN = {
  commitMessage: "fix: save crash",
  pullRequest: { title: "Fix save crash", body: "Fixes #42" },
};

const renderDialog = (plan = PLAN) =>
  renderWithProviders(
    <GitShipDialog
      isOpen
      onClose={vi.fn()}
      conversationId="conv-1"
      repository="acme/widgets"
      plan={plan}
    />,
  );

beforeEach(() => {
  __resetActiveStoreForTests();
  setRegisteredBackends([LOCAL_BACKEND]);
  setActiveSelection({ backendId: LOCAL_BACKEND.id });
  mocks.commands = [];
  mocks.failOn = null;
  vi.spyOn(
    AgentServerConversationService,
    "batchGetAppConversations",
  ).mockResolvedValue([
    {
      id: "conv-1",
      workspace: { working_dir: "/work/widgets" },
      conversation_url: "http://localhost:8000/api/conversations/conv-1",
      session_api_key: "key",
    },
  ] as never);
});

afterEach(() => {
  __resetActiveStoreForTests();
  vi.restoreAllMocks();
});

describe("GitShipDialog", () => {
  it("commits, pushes and opens the pull request from the agent's plan, in that order", async () => {
    mocks.status = statusOn("fix/save");
    const create = vi
      .spyOn(GitProviderItemsService, "createGithubPullRequest")
      .mockResolvedValue({
        url: "https://github.com/acme/widgets/pull/9",
        number: 9,
      });
    renderDialog();

    expect(await screen.findByTestId("git-ship-commit-message")).toHaveValue(
      "fix: save crash",
    );
    expect(screen.getByTestId("git-ship-pr-title")).toHaveValue(
      "Fix save crash",
    );
    expect(screen.getByTestId("git-ship-pr-base")).toHaveValue("main");
    // On a feature branch, no new branch is needed.
    expect(screen.queryByTestId("git-ship-new-branch")).toBeNull();

    await userEvent.click(screen.getByTestId("git-ship-submit"));

    expect(await screen.findByTestId("git-ship-done")).toHaveTextContent(
      "GITHUB$POST_VIEW",
    );
    const git = mocks.commands.filter((c) => !c.includes("@@branch"));
    expect(git).toHaveLength(2);
    expect(git[0]).toContain("git commit -F -");
    expect(git[1]).toContain("git push --set-upstream origin HEAD");
    expect(create).toHaveBeenCalledWith("acme/widgets", {
      title: "Fix save crash",
      body: "Fixes #42",
      head: "fix/save",
      base: "main",
    });
  });

  it("moves work off the default branch before a pull request, and needs a valid name", async () => {
    mocks.status = statusOn("main");
    const create = vi
      .spyOn(GitProviderItemsService, "createGithubPullRequest")
      .mockResolvedValue({
        url: "https://github.com/acme/widgets/pull/9",
        number: 9,
      });
    renderDialog();

    const branch = await screen.findByTestId("git-ship-new-branch");
    expect(branch).toHaveValue("agent/fix-save-crash");

    await userEvent.clear(branch);
    await userEvent.type(branch, "bad name");
    expect(screen.getByTestId("git-ship-submit")).toBeDisabled();

    await userEvent.clear(branch);
    await userEvent.type(branch, "agent/save-crash");
    await userEvent.click(screen.getByTestId("git-ship-submit"));

    await screen.findByTestId("git-ship-done");
    expect(
      mocks.commands.some((c) => c === "git switch -c agent/save-crash"),
    ).toBe(true);
    expect(create).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({ head: "agent/save-crash" }),
    );
  });

  it("stops at the failed step, reports it, and opens no pull request", async () => {
    mocks.status = statusOn("fix/save");
    mocks.failOn = "git push";
    const create = vi.spyOn(GitProviderItemsService, "createGithubPullRequest");
    renderDialog();

    await screen.findByTestId("git-ship-commit-message");
    await userEvent.click(screen.getByTestId("git-ship-submit"));

    expect(await screen.findByTestId("git-ship-error")).toHaveTextContent(
      "GIT_SHIP$STEP_FAILED",
    );
    await waitFor(() =>
      expect(screen.getByTestId("git-ship-step-push")).toHaveAttribute(
        "data-state",
        "failed",
      ),
    );
    expect(screen.getByTestId("git-ship-step-commit")).toHaveAttribute(
      "data-state",
      "done",
    );
    expect(create).not.toHaveBeenCalled();
  });
});
