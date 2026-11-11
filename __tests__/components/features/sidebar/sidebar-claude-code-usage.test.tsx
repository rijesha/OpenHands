import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarClaudeCodeUsage } from "#/components/features/sidebar/sidebar-claude-code-usage";
import { renderWithProviders } from "test-utils";

// Only the edges are faked: the agent-server's command API (the file Claude
// Code's status line writes) and which backend is active.

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
  });

  it("condenses to percentages, with the full reading as its label, when collapsed", async () => {
    renderWithProviders(<SidebarClaudeCodeUsage collapsed />);

    const meter = await screen.findByTestId("sidebar-claude-code-usage");
    expect(meter).toHaveTextContent("42%");
    expect(meter).toHaveTextContent("95%");
    expect(meter).toHaveAttribute(
      "aria-label",
      expect.stringContaining("CLAUDE_CODE$USAGE_WEEKLY 95%"),
    );
  });

  it("takes no space until Claude Code has reported, and on a cloud backend", async () => {
    mocks.capture = null;
    const { unmount } = renderWithProviders(
      <SidebarClaudeCodeUsage collapsed={false} />,
    );
    await vi.waitFor(() => expect(mocks.commands).toHaveLength(1));
    expect(screen.queryByTestId("sidebar-claude-code-usage")).toBeNull();
    unmount();

    mocks.kind = "cloud";
    mocks.commands = [];
    renderWithProviders(<SidebarClaudeCodeUsage collapsed={false} />);
    expect(screen.queryByTestId("sidebar-claude-code-usage")).toBeNull();
    expect(mocks.commands).toHaveLength(0);
  });
});
