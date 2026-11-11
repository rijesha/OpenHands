import type { Provider } from "#/types/settings";
import { parseGitRemoteUrl } from "#/utils/parse-git-remote-url";

/** What a project folder is: plain files on this machine, or a git work tree. */
export interface ProjectGitInfo {
  isGit: boolean;
  remoteUrl: string | null;
  /** `owner/repo`, when the origin remote names a repository of a known provider. */
  repository: string | null;
  provider: Provider | null;
  branch: string | null;
  /** Uncommitted changes, including untracked files. */
  dirtyCount: number;
}

export const LOCAL_ONLY_PROJECT: ProjectGitInfo = {
  isGit: false,
  remoteUrl: null,
  repository: null,
  provider: null,
  branch: null,
  dirtyCount: 0,
};

/** Single-quotes a path for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One shell command that describes every folder: for each, a `@@<path>` line,
 * then `local`, or `git` followed by origin URL, branch and the number of
 * changed files (a missing value is an empty line). A folder only counts as
 * git when it is the root of the work tree, not merely inside someone else's.
 */
export function buildProjectProbeCommand(paths: string[]): string {
  const list = paths.map(shellQuote).join(" ");
  return [
    `for d in ${list}; do`,
    `printf '@@%s\\n' "$d"`,
    `if [ -z "$(git -C "$d" rev-parse --show-prefix 2>/dev/null)" ] && git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `printf 'git\\n'`,
    `git -C "$d" remote get-url origin 2>/dev/null || echo`,
    `git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo`,
    `git -C "$d" status --porcelain 2>/dev/null | wc -l`,
    `else`,
    `printf 'local\\n'`,
    `fi`,
    `done`,
  ].join("\n");
}

/** Reads the output of {@link buildProjectProbeCommand}, keyed by path. */
export function parseProjectProbe(
  stdout: string,
): Record<string, ProjectGitInfo> {
  const result: Record<string, ProjectGitInfo> = {};
  let path: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    if (path === null) return;
    if (lines[0]?.trim() !== "git") {
      result[path] = LOCAL_ONLY_PROJECT;
      return;
    }
    const remoteUrl = lines[1]?.trim() || null;
    const branch = lines[2]?.trim();
    const parsed = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
    const dirty = Number.parseInt(lines[3] ?? "", 10);
    result[path] = {
      isGit: true,
      remoteUrl,
      repository: parsed?.repository ?? null,
      provider: parsed?.provider ?? null,
      branch: branch && branch !== "HEAD" ? branch : null,
      dirtyCount: Number.isFinite(dirty) ? dirty : 0,
    };
  };

  stdout.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("@@")) {
      flush();
      path = line.slice(2);
      lines = [];
    } else {
      lines.push(line);
    }
  });
  flush();
  return result;
}
