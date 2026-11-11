import statuslineSource from "../../scripts/claude-code-info/statusline.mjs?raw";
import type { BashCommandRunner } from "#/hooks/use-bash-command-runner";
import { shellQuote } from "#/utils/project-git-info";

/** One of Claude Code's usage windows, as its status line reports it. */
export interface ClaudeCodeUsageWindow {
  /** 0 to 100, how much of the window is used. */
  usedPercentage: number;
  /** Unix seconds when the window resets. */
  resetsAt: number | null;
}

export interface ClaudeCodeUsage {
  /** Unix milliseconds when Claude Code last reported. */
  capturedAt: number;
  fiveHour: ClaudeCodeUsageWindow | null;
  sevenDay: ClaudeCodeUsageWindow | null;
}

const CAPTURE_PATH = "$HOME/.claude/canvas-usage.json";
const SCRIPT_PATH = "$HOME/.claude/canvas-statusline.mjs";

function asWindow(value: unknown): ClaudeCodeUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const { usedPercentage, resetsAt } = value as Record<string, unknown>;
  if (typeof usedPercentage !== "number") return null;
  return {
    usedPercentage,
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
  };
}

/** Reads the file the status line helper writes; anything else gives `null`. */
export function parseUsageCapture(text: string): ClaudeCodeUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { capturedAt, fiveHour, sevenDay } = parsed as Record<string, unknown>;
  if (typeof capturedAt !== "number") return null;
  const usage = {
    capturedAt,
    fiveHour: asWindow(fiveHour),
    sevenDay: asWindow(sevenDay),
  };
  // A report without either window (an API-key account) has nothing to show.
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

/** `null` when Claude Code has not reported limits yet (or the helper is not installed). */
export async function readClaudeCodeUsage(
  run: BashCommandRunner,
): Promise<ClaudeCodeUsage | null> {
  const result = await run(`cat "${CAPTURE_PATH}" 2>/dev/null`, undefined, 10);
  return result.exit_code === 0 ? parseUsageCapture(result.stdout) : null;
}

export type StatuslineInstallResult = "installed" | "already" | "occupied";

/**
 * Copies the helper into `~/.claude` and points Claude Code's `statusLine` at
 * it. An existing `statusLine` of the user's is never replaced.
 */
export async function installClaudeCodeStatusline(
  run: BashCommandRunner,
): Promise<StatuslineInstallResult> {
  const bytes = new TextEncoder().encode(statuslineSource);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const result = await run(
    [
      'mkdir -p "$HOME/.claude"',
      `printf '%s' ${shellQuote(btoa(binary))} | base64 -d > "${SCRIPT_PATH}"`,
      `node "${SCRIPT_PATH}" --install`,
    ].join(" && "),
    undefined,
    30,
  );
  const outcome = result.stdout.trim().split(/\s+/).pop();
  if (outcome === "installed" || outcome === "already") return outcome;
  if (outcome === "occupied") return "occupied";
  throw new Error((result.stderr || result.stdout).trim() || "install failed");
}
