import type { BashCommandRunner } from "#/hooks/use-bash-command-runner";

export interface LocalGitChange {
  /** Porcelain status code, e.g. `M`, `A`, `D`, `??`. */
  status: string;
  path: string;
}

export interface LocalGitStatus {
  /** `null` on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  /** Commits on this branch that the upstream does not have. */
  ahead: number;
  behind: number;
  /** The remote's default branch (`main`), when it is known. */
  defaultBranch: string | null;
  /** Uncommitted changes, including untracked files. */
  changes: LocalGitChange[];
}

/** A git command that failed, with the step it belonged to and git's own message. */
export class LocalGitError extends Error {
  readonly step: "status" | "branch" | "commit" | "push";

  constructor(step: LocalGitError["step"], message: string) {
    super(message);
    this.name = "LocalGitError";
    this.step = step;
  }
}

const STATUS_COMMAND = [
  "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 128",
  "echo '@@branch'; git rev-parse --abbrev-ref HEAD 2>/dev/null",
  "echo '@@upstream'; git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null",
  "echo '@@counts'; git rev-list --left-right --count '@{u}...HEAD' 2>/dev/null",
  "echo '@@base'; git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null",
  "echo '@@changes'; git status --porcelain",
  "true",
].join("\n");

// Git's own prompts would hang a command nobody can answer.
const NO_PROMPT = "GIT_TERMINAL_PROMPT=0";

function sections(stdout: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let current: string[] | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      current = [];
      result[line.slice(2)] = current;
    } else if (current && line.trim()) {
      current.push(line);
    }
  }
  return result;
}

export function parseGitStatus(stdout: string): LocalGitStatus {
  const parts = sections(stdout);
  const branch = parts.branch?.[0]?.trim();
  const [behind, ahead] = (parts.counts?.[0] ?? "")
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  const base = parts.base?.[0]?.trim();
  return {
    branch: branch && branch !== "HEAD" ? branch : null,
    upstream: parts.upstream?.[0]?.trim() || null,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    defaultBranch: base ? base.replace(/^origin\//, "") : null,
    changes: (parts.changes ?? []).map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    })),
  };
}

/** Base64 of the UTF-8 text, so user text reaches the shell as inert characters. */
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

const SAFE_BRANCH = /^(?!-)[A-Za-z0-9._/-]+$/;

/** Whether `name` can be passed to git as a new branch without further quoting. */
export function isSafeBranchName(name: string): boolean {
  return SAFE_BRANCH.test(name) && !name.includes("..") && !name.endsWith("/");
}

async function runStep(
  step: LocalGitError["step"],
  run: BashCommandRunner,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<string> {
  const result = await run(command, cwd, timeoutSeconds);
  if (result.exit_code !== 0) {
    throw new LocalGitError(
      step,
      (result.stderr || result.stdout).trim() ||
        `git exited with ${result.exit_code}`,
    );
  }
  return result.stdout;
}

/**
 * Runs git in a local conversation's workspace through the agent-server's
 * command API, so the user can commit and push what the agent prepared without
 * another model turn. Nothing here forces, resets or deletes anything.
 */
export const LocalGitService = {
  /** `null` when the folder is not a git work tree. */
  async status(
    run: BashCommandRunner,
    cwd: string,
  ): Promise<LocalGitStatus | null> {
    const result = await run(STATUS_COMMAND, cwd, 15);
    if (result.exit_code === 128) return null;
    if (result.exit_code !== 0) {
      throw new LocalGitError(
        "status",
        (result.stderr || result.stdout).trim(),
      );
    }
    return parseGitStatus(result.stdout);
  },

  async createBranch(
    run: BashCommandRunner,
    cwd: string,
    name: string,
  ): Promise<void> {
    if (!isSafeBranchName(name)) {
      throw new LocalGitError("branch", `Invalid branch name: ${name}`);
    }
    await runStep("branch", run, `git switch -c ${name}`, cwd, 15);
  },

  /** Stages every change and commits it with `message`. */
  async commitAll(
    run: BashCommandRunner,
    cwd: string,
    message: string,
  ): Promise<void> {
    await runStep(
      "commit",
      run,
      `git add -A && printf '%s' '${encode(message)}' | base64 -d | git commit -F -`,
      cwd,
      60,
    );
  },

  /** Pushes the current branch to `origin` (setting its upstream), never forcing. */
  async push(run: BashCommandRunner, cwd: string): Promise<void> {
    await runStep(
      "push",
      run,
      `${NO_PROMPT} git push --set-upstream origin HEAD`,
      cwd,
      180,
    );
  },
};
