import { describe, expect, it } from "vitest";
import {
  buildGithubAgentPrompt,
  type GithubAgentAction,
} from "#/utils/github-agent-prompts";

const ITEM = {
  number: 42,
  title: "Crash when saving",
  url: "https://github.com/acme/widgets/issues/42",
  baseRef: "main",
  headRef: "fix/save",
};

const prompt = (action: GithubAgentAction, needsClone = false) =>
  buildGithubAgentPrompt(action, {
    repository: "acme/widgets",
    item: ITEM,
    needsClone,
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
});
