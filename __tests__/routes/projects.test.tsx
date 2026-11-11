import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import WorkspacesService from "#/api/workspaces-service/workspaces-service.api";
import ProjectsRoute from "#/routes/projects";
import { renderWithProviders } from "test-utils";

// Only the edges are faked: the saved workspaces, the agent-server's command
// API (the git probe), the conversation launch, and which backend is active.

const mocks = vi.hoisted(() => ({
  kind: "local" as "local" | "cloud",
  createConversation: vi.fn(),
  navigate: vi.fn(),
  commands: [] as string[],
}));

const PROBE = [
  "@@/code/widgets",
  "git",
  "https://github.com/acme/widgets.git",
  "main",
  "2",
  "@@/code/notes",
  "local",
].join("\n");

vi.mock("@openhands/typescript-client/clients", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@openhands/typescript-client/clients")
  >()),
  BashClient: class {
    close() {}

    async executeCommand({ command }: { command: string }) {
      mocks.commands.push(command);
      return { exit_code: 0, stdout: PROBE, stderr: "" };
    }
  },
}));

vi.mock("#/api/agent-server-client-options", () => ({
  getAgentServerClientOptions: () => ({}),
}));

vi.mock("#/contexts/active-backend-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#/contexts/active-backend-context")
  >()),
  useActiveBackend: () => ({
    backend: {
      id: `${mocks.kind}-backend`,
      name: mocks.kind,
      host: "http://localhost:8000",
      apiKey: "key",
      kind: mocks.kind,
    },
    orgId: null,
  }),
}));

vi.mock("#/hooks/mutation/use-create-conversation", () => ({
  useCreateConversation: () => ({
    mutate: mocks.createConversation,
    isPending: false,
  }),
}));

const render = () =>
  renderWithProviders(<ProjectsRoute />, {
    navigation: { navigate: mocks.navigate },
  });

beforeEach(() => {
  __resetActiveStoreForTests();
  mocks.kind = "local";
  mocks.commands = [];
  mocks.createConversation.mockReset();
  mocks.navigate.mockReset();
  setRegisteredBackends([
    {
      id: "local-backend",
      name: "local",
      host: "http://localhost:8000",
      apiKey: "key",
      kind: "local",
    },
  ]);
  setActiveSelection({ backendId: "local-backend" });
  vi.spyOn(WorkspacesService, "listWorkspaces").mockResolvedValue({
    workspaces: [
      { id: "w", name: "widgets", path: "/code/widgets" },
      { id: "n", name: "notes", path: "/code/notes" },
    ],
    workspaceParents: [],
  });
});

afterEach(() => {
  __resetActiveStoreForTests();
  vi.restoreAllMocks();
});

describe("Projects page", () => {
  it("marks each folder as git-backed or local only, with its repository and changes", async () => {
    render();

    const widgets = await screen.findByTestId("project-/code/widgets");
    await waitFor(() => expect(widgets).toHaveAttribute("data-kind", "git"));
    expect(widgets).toHaveTextContent("acme/widgets");
    expect(widgets).toHaveTextContent("main");
    expect(widgets).toHaveTextContent("PROJECTS$DIRTY");
    expect(screen.getByTestId("project-/code/notes")).toHaveAttribute(
      "data-kind",
      "local",
    );
    expect(mocks.commands).toHaveLength(1);
  });

  it("filters to git-backed or local-only folders", async () => {
    render();
    await waitFor(() =>
      expect(screen.getByTestId("project-/code/widgets")).toHaveAttribute(
        "data-kind",
        "git",
      ),
    );

    await userEvent.click(screen.getByTestId("projects-filter-local"));
    expect(screen.queryByTestId("project-/code/widgets")).toBeNull();
    expect(screen.getByTestId("project-/code/notes")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("projects-filter-git"));
    expect(screen.getByTestId("project-/code/widgets")).toBeInTheDocument();
    expect(screen.queryByTestId("project-/code/notes")).toBeNull();
  });

  it("starts a conversation in the folder and opens its GitHub items", async () => {
    mocks.createConversation.mockImplementation((_variables, options) =>
      options.onSuccess({ conversation_id: "conv-1" }),
    );
    render();
    await screen.findByTestId("project-github-/code/widgets");

    await userEvent.click(screen.getByTestId("project-start-/code/widgets"));
    expect(mocks.createConversation.mock.calls[0][0]).toMatchObject({
      workingDir: "/code/widgets",
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/conversations/conv-1");

    await userEvent.click(screen.getByTestId("project-github-/code/widgets"));
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      "/github?repo=acme%2Fwidgets",
    );
    // A folder without a GitHub remote has no such action.
    const notes = screen.getByTestId("project-/code/notes");
    expect(within(notes).queryByText("PROJECTS$OPEN_GITHUB")).toBeNull();
  });

  it("removes a saved folder from the list", async () => {
    const remove = vi
      .spyOn(WorkspacesService, "removeWorkspace")
      .mockResolvedValue();
    render();

    await userEvent.click(
      await screen.findByTestId("project-remove-/code/notes"),
    );

    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(remove.mock.calls[0][0]).toBe("/code/notes");
  });

  it("explains that projects need a local backend, and probes nothing", async () => {
    mocks.kind = "cloud";
    render();

    expect(
      await screen.findByTestId("projects-local-only"),
    ).toBeInTheDocument();
    expect(mocks.commands).toHaveLength(0);
  });
});
