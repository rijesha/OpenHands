import { describe, expect, it, vi } from "vitest";
import {
  isSafeBranchName,
  LocalGitError,
  LocalGitService,
  parseGitStatus,
} from "#/api/local-git-service";

const result = (exit_code: number, stdout = "", stderr = "") => ({
  exit_code,
  stdout,
  stderr,
});

describe("parseGitStatus", () => {
  it("reads branch, upstream, divergence, default branch and changes", () => {
    const status = parseGitStatus(
      [
        "@@branch",
        "fix/save",
        "@@upstream",
        "origin/fix/save",
        "@@counts",
        "1\t3",
        "@@base",
        "origin/main",
        "@@changes",
        " M src/a.ts",
        "?? notes.md",
      ].join("\n"),
    );

    expect(status).toEqual({
      branch: "fix/save",
      upstream: "origin/fix/save",
      behind: 1,
      ahead: 3,
      defaultBranch: "main",
      changes: [
        { status: "M", path: "src/a.ts" },
        { status: "??", path: "notes.md" },
      ],
    });
  });

  it("treats a detached HEAD and a branch without upstream as such", () => {
    const status = parseGitStatus(
      "@@branch\nHEAD\n@@upstream\n@@counts\n@@base\n@@changes\n",
    );

    expect(status).toMatchObject({
      branch: null,
      upstream: null,
      ahead: 0,
      defaultBranch: null,
      changes: [],
    });
  });
});

describe("LocalGitService", () => {
  it("reports a folder that is not a work tree as null", async () => {
    const run = vi.fn().mockResolvedValue(result(128));

    await expect(LocalGitService.status(run, "/w")).resolves.toBeNull();
  });

  it("sends a commit message to git as inert base64, whatever it contains", async () => {
    const run = vi.fn().mockResolvedValue(result(0));
    const message = "fix: don't `rm -rf` $HOME\n\n'; echo pwned #";

    await LocalGitService.commitAll(run, "/w", message);

    const [command] = run.mock.calls[0];
    expect(command).not.toContain("pwned");
    const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(message);
  });

  it("pushes the current branch without forcing", async () => {
    const run = vi.fn().mockResolvedValue(result(0));

    await LocalGitService.push(run, "/w");

    const [command] = run.mock.calls[0];
    expect(command).toContain("git push --set-upstream origin HEAD");
    expect(command).not.toMatch(/--force|\s-f\b/);
  });

  it("reports a failed step with git's own message", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(result(1, "", "rejected: non-fast-forward"));

    await expect(LocalGitService.push(run, "/w")).rejects.toMatchObject({
      step: "push",
      message: "rejected: non-fast-forward",
    });
    await expect(LocalGitService.push(run, "/w")).rejects.toBeInstanceOf(
      LocalGitError,
    );
  });

  it.each(["", "-D main", "a b", "x;rm", "a..b", "trailing/", "$(id)"])(
    "refuses to create the branch %j",
    async (name) => {
      const run = vi.fn();

      expect(isSafeBranchName(name)).toBe(false);
      await expect(
        LocalGitService.createBranch(run, "/w", name),
      ).rejects.toBeInstanceOf(LocalGitError);
      expect(run).not.toHaveBeenCalled();
    },
  );
});
