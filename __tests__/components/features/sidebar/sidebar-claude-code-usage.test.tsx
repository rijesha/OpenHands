import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarClaudeCodeUsage } from "#/components/features/sidebar/sidebar-claude-code-usage";
import { renderWithProviders } from "test-utils";

// Only the edges are faked: the agent-server's command API (what it prints\n// for the usage read) and which backend is active.

const mocks = vi.hoisted(() => ({
  kind: "local" as "local" | "cloud",
  capture: null as string | null,
  commands: [] as string[],
}));

vi.mock("@openhands/typescript-client/clients", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@openhands/typescript-client/clients")
  >()),
  BashClient: class {
    close() {}

    async executeCommand({ command }: { command: string }) {
      mocks.commands.push(command);
      return mocks.capture === null
        ? { exit_code: 1, stdout: "", stderr: "" }
        : { exit_code: 0, stdout: mocks.capture, stderr: "" };
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

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const installs = () =>
  mocks.commands.filter((command) => command.includes("--install"));

beforeEach(() => {
  mocks.kind = "local";
  mocks.commands = [];
  mocks.capture = JSON.stringify({
    capturedAt: Date.now(),
    fiveHour: { usedPercentage: 42, resetsAt: NOW_SECONDS + 3600 },
    sevenDay: { usedPercentage: 95, resetsAt: NOW_SECONDS + 86_400 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SidebarClaudeCodeUsage", () => {
  it("shows both windows in the expanded sidebar", async () => {
    renderWithProviders(<SidebarClaudeCodeUsage collapsed={false} />);

    const fiveHour = await screen.findByTestId(
      "sidebar-claude-code-usage-five-hour",
    );
    expect(fiveHour.querySelector("[role=progressbar]")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(
      screen
        .getByTestId("sidebar-claude-code-usage-weekly")
        .querySelector("[role=progressbar]"),
    ).toHaveAttribute("aria-valuenow", "95");
    expect(installs()).toHaveLength(0);
  });

  it("condenses to percentages, with the full reading as its label, when collapsed", async () => {
    renderWithProviders(<SidebarClaudeCodeUsage collapsed />);

    const meter = await screen.findByTestId("sidebar-claude-code-usage");
    await waitFor(() => expect(meter).toHaveTextContent("42%"));
    expect(meter).toHaveTextContent("95%");
    expect(meter).toHaveAttribute(
      "aria-label",
      expect.stringContaining("CLAUDE_CODE$USAGE_WEEKLY 95%"),
    );
  });

  it("is there before any report, and keeps a collapsed placeholder", async () => {
    mocks.capture = null;
    const { unmount } = renderWithProviders(
      <SidebarClaudeCodeUsage collapsed={false} />,
    );

    expect(
      await screen.findByTestId("sidebar-claude-code-usage"),
    ).toBeInTheDocument();
    unmount();

    renderWithProviders(<SidebarClaudeCodeUsage collapsed />);
    expect(
      await screen.findByTestId("sidebar-claude-code-usage"),
    ).toHaveAttribute("aria-label", "CLAUDE_CODE$USAGE_LABEL");
  });

  it("says when there is nothing to show yet, and never edits Claude Code's settings", async () => {
    mocks.capture = null;
    renderWithProviders(<SidebarClaudeCodeUsage collapsed={false} />);

    expect(
      await screen.findByText("CLAUDE_CODE$USAGE_NOT_USED", { exact: false }),
    ).toBeInTheDocument();
    expect(installs()).toHaveLength(0);
  });

  it("is absent on a cloud backend, and reads nothing", async () => {
    mocks.kind = "cloud";
    renderWithProviders(<SidebarClaudeCodeUsage collapsed={false} />);

    expect(screen.queryByTestId("sidebar-claude-code-usage")).toBeNull();
    expect(mocks.commands).toHaveLength(0);
  });
});
