import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_EFFORT_SECRET,
  effortFromSecrets,
} from "#/api/claude-code-effort";
import { parseUsageCapture } from "#/api/claude-code-usage";
import { SecretsService } from "#/api/secrets-service";
import { ClaudeCodeControls } from "#/components/features/chat/components/claude-code-controls";
import { renderWithProviders } from "test-utils";

// Only the edges are faked: the agent-server's command API (the file Claude
// Code's status line writes), the saved secrets, and which backend is active.

const mocks = vi.hoisted(() => ({
  kind: "local" as "local" | "cloud",
  commands: [] as string[],
  capture: null as string | null,
  installOutput: "installed",
  secrets: [] as { name: string; description?: string }[],
}));

vi.mock("@openhands/typescript-client/clients", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@openhands/typescript-client/clients")
  >()),
  BashClient: class {
    close() {}

    async executeCommand({ command }: { command: string }) {
      mocks.commands.push(command);
      if (command.includes("canvas-usage.json")) {
        return mocks.capture === null
          ? { exit_code: 1, stdout: "", stderr: "" }
          : { exit_code: 0, stdout: mocks.capture, stderr: "" };
      }
      return { exit_code: 0, stdout: mocks.installOutput, stderr: "" };
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

const capture = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    capturedAt: Date.now(),
    fiveHour: { usedPercentage: 42, resetsAt: NOW_SECONDS + 3600 },
    sevenDay: { usedPercentage: 95, resetsAt: NOW_SECONDS + 86_400 },
    ...overrides,
  });

beforeEach(() => {
  mocks.kind = "local";
  mocks.commands = [];
  mocks.capture = null;
  mocks.installOutput = "installed";
  mocks.secrets = [];
  vi.spyOn(SecretsService, "getSecrets").mockImplementation(async () =>
    mocks.secrets.map((secret) => ({
      name: secret.name,
      description: secret.description ?? "",
    })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const render = () =>
  renderWithProviders(
    <ul>
      <ClaudeCodeControls />
    </ul>,
  );

describe("ClaudeCodeControls usage limits", () => {
  it("shows how much of each window is used", async () => {
    mocks.capture = capture();
    render();

    const fiveHour = await screen.findByTestId("claude-code-usage-five-hour");
    expect(fiveHour.querySelector("[role=progressbar]")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(
      screen
        .getByTestId("claude-code-usage-weekly")
        .querySelector("[role=progressbar]"),
    ).toHaveAttribute("aria-valuenow", "95");
  });

  it("shows a window that has reset since the last report as empty", async () => {
    mocks.capture = capture({
      fiveHour: { usedPercentage: 99, resetsAt: NOW_SECONDS - 60 },
    });
    render();

    const fiveHour = await screen.findByTestId("claude-code-usage-five-hour");
    expect(fiveHour.querySelector("[role=progressbar]")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("offers to set up the helper when nothing has been reported, then does so on request", async () => {
    render();

    await userEvent.click(await screen.findByTestId("claude-code-usage-setup"));

    expect(
      await screen.findByText("CLAUDE_CODE$USAGE_INSTALLED"),
    ).toBeInTheDocument();
    const install = mocks.commands.find((command) =>
      command.includes("--install"),
    );
    expect(install).toContain("canvas-statusline.mjs");
  });

  it("leaves a status line the user already has alone and says so", async () => {
    mocks.installOutput = "occupied";
    render();

    await userEvent.click(await screen.findByTestId("claude-code-usage-setup"));

    expect(
      await screen.findByText("CLAUDE_CODE$USAGE_OCCUPIED"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("claude-code-usage-setup")).toBeNull();
  });

  it("is not offered on a cloud backend, and reads nothing", async () => {
    mocks.kind = "cloud";
    render();

    expect(screen.queryByTestId("claude-code-controls")).toBeNull();
    expect(mocks.commands).toHaveLength(0);
  });
});

describe("ClaudeCodeControls effort", () => {
  it("saves the chosen level as a secret Claude Code reads from its environment", async () => {
    const create = vi.spyOn(SecretsService, "createSecret").mockResolvedValue();
    render();

    await userEvent.click(await screen.findByTestId("claude-code-effort-high"));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toBe(CLAUDE_CODE_EFFORT_SECRET);
    expect(create.mock.calls[0][1]).toBe("high");
  });

  it("shows the saved level, and removes the secret to return to the default", async () => {
    const remove = vi.spyOn(SecretsService, "deleteSecret").mockResolvedValue();
    mocks.secrets = [
      {
        name: CLAUDE_CODE_EFFORT_SECRET,
        description: "Claude Code effort level set from Agent Canvas: xhigh",
      },
    ];
    render();

    await waitFor(() =>
      expect(screen.getByTestId("claude-code-effort-xhigh")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await userEvent.click(screen.getByTestId("claude-code-effort-default"));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(remove.mock.calls[0][0]).toBe(CLAUDE_CODE_EFFORT_SECRET);
  });
});

describe("parsing", () => {
  it("ignores a report without any window and one that is not JSON", () => {
    expect(
      parseUsageCapture(
        JSON.stringify({ capturedAt: 1, fiveHour: null, sevenDay: null }),
      ),
    ).toBeNull();
    expect(parseUsageCapture("not json")).toBeNull();
  });

  it("does not take another secret's description for an effort level", () => {
    expect(
      effortFromSecrets([
        { name: "OTHER", description: "high" },
        {
          name: CLAUDE_CODE_EFFORT_SECRET,
          description: "set by hand: max",
        },
      ]),
    ).toBeNull();
  });
});
