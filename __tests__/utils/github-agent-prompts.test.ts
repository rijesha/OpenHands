import { describe, expect, it } from "vitest";
import { GITHUB_TOKEN_SECRET_NAMES } from "#/api/git-provider-items-service";
import {
  buildGithubAgentPrompt,
  buildGithubConversationTitle,
  type GithubAgentAction,
} from "#/utils/github-agent-prompts";

const ITEM = {
  number: 42,
  title: "Crash when saving",
  url: "https://github.com/acme/widgets/issues/42",
  baseRef: "main",
  headRef: "fix/save",
};

const prompt = (
  action: GithubAgentAction,
  needsClone = false,
  guiVm?: "windows" | "ubuntu",
) =>
  buildGithubAgentPrompt(action, {
    repository: "acme/widgets",
    item: ITEM,
    needsClone,
    guiVm,
  });

describe("one-click commit and pull request", () => {
  it("asks work on an issue for a commit message and pull request, but not to push", () => {
    const text = prompt("work_on_issue");

    expect(text).toContain('"pull_request": {"title"');
    expect(text).toContain("Do not push or open the pull request yourself");
  });

  it.each<GithubAgentAction>(["address_review_comments", "fix_failing_checks"])(
    "asks %s only for a commit message, since the pull request exists",
    (action) => {
      const text = prompt(action);

      expect(text).toContain('{"commit": {"message"');
      expect(text).not.toContain('"pull_request": {"title"');
    },
  );
});

describe("buildGithubAgentPrompt", () => {
  it.each<GithubAgentAction>([
    "work_on_issue",
    "create_pull_request",
    "review_pull_request",
  ])("points %s at the work item and clones only when asked", (action) => {
    expect(prompt(action)).toContain(ITEM.url);
    expect(prompt(action)).toContain("#42");
    expect(prompt(action)).not.toContain("clone");
    expect(prompt(action, true)).toContain(
      "clone https://github.com/acme/widgets",
    );
  });

  // Saved secrets reach the agent only as environment variables under their
  // own names, so the agent must know every name the page accepts.
  it.each<GithubAgentAction>([
    "work_on_issue",
    "create_pull_request",
    "review_pull_request",
  ])("names every secret %s may find the GitHub token in", (action) => {
    for (const name of GITHUB_TOKEN_SECRET_NAMES) {
      expect(prompt(action)).toContain(name);
    }
  });

  it("keeps work on an issue local until the user asks to publish it", () => {
    expect(prompt("work_on_issue")).toMatch(
      /do not push the branch or open a pull request/i,
    );
  });

  it("opens a pull request that closes the issue", () => {
    const text = prompt("create_pull_request");
    expect(text).toMatch(/open a pull request/i);
    expect(text).toContain("Fixes #42");
  });

  it("reviews through the pull ref, so fork pull requests work, without posting", () => {
    const text = prompt("review_pull_request");
    expect(text).toContain("git fetch origin pull/42/head:pr-42");
    expect(text).toContain("against main");
    expect(text).toMatch(/do not push commits or post comments/i);
  });

  it.each<GithubAgentAction>([
    "work_on_issue",
    "create_pull_request",
    "review_pull_request",
  ])(
    "asks %s to verify in the chosen GUI VM only when one is chosen",
    (action) => {
      expect(prompt(action)).not.toContain("vm_start");

      const text = prompt(action, false, "ubuntu");
      expect(text).toContain("gui-vm-testing");
      expect(text).toContain('image "ubuntu"');
      expect(text).toContain("vm_stop");
    },
  );

  it("links the VM run to the item and tells the agent to lease before building", () => {
    const text = prompt("review_pull_request", false, "ubuntu");
    expect(text).toContain('"repository"');
    expect(text).toContain('"item":"42"');
    expect(text).toMatch(/lease the VM first/);
    expect(text).toMatch(/boot-failure rule/);
  });

  it("verifies the fix before the branch is pushed", () => {
    const text = prompt("create_pull_request", false, "windows");
    expect(text.indexOf("vm_start")).toBeLessThan(
      text.indexOf("Push the branch"),
    );
  });
});

describe("buildGithubConversationTitle", () => {
  it("leads with the repository and item so conversations stay apart in a list", () => {
    expect(
      buildGithubConversationTitle(
        "mylonics/zephyr-ide",
        { kind: "pull_request", number: 649 },
        "Review pull request",
      ),
    ).toBe("mylonics:zephyr-ide PR#649 - Review pull request");
    expect(
      buildGithubConversationTitle(
        "acme/widgets",
        { kind: "issue", number: 5 },
        "Work on issue",
      ),
    ).toBe("acme:widgets Issue#5 - Work on issue");
  });
});
