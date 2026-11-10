import { describe, expect, it } from "vitest";
import { extractAgentResult } from "#/utils/agent-run-result";
import { buildGithubPushPrompt } from "#/utils/github-agent-prompts";
import { parseGithubReferences } from "#/utils/github-references";

describe("parseGithubReferences", () => {
  it("finds closing and plain references, closing first, without the item itself", () => {
    expect(
      parseGithubReferences(
        "See #3 and #7. Fixes #12, also resolves acme/other#4. This is #5.",
        "acme/widgets",
        5,
      ),
    ).toEqual([
      { repository: "acme/widgets", number: 12, closing: true },
      { repository: "acme/other", number: 4, closing: true },
      { repository: "acme/widgets", number: 3, closing: false },
      { repository: "acme/widgets", number: 7, closing: false },
    ]);
  });

  it("ignores code, headings-like text and URLs", () => {
    expect(
      parseGithubReferences(
        "Use `#1` or\n```\nfixes #2\n```\nsee https://x.test/a#3 and C#9",
        "acme/widgets",
      ),
    ).toEqual([]);
  });

  it("returns nothing for an empty description", () => {
    expect(parseGithubReferences(null, "acme/widgets")).toEqual([]);
  });
});

describe("extractAgentResult", () => {
  it("returns the agent's latest message, skipping user messages and tool calls", () => {
    const events = [
      {
        source: "agent",
        llm_message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
        },
      },
      {
        source: "agent",
        llm_message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      },
      {
        source: "user",
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "thanks" }],
        },
      },
      {
        source: "agent",
        tool_name: "terminal",
        action: { kind: "ExecuteBashAction" },
      },
    ];
    expect(extractAgentResult(events)).toBe("final answer");
  });

  it("falls back to a finish action's message and to null", () => {
    expect(
      extractAgentResult([
        {
          source: "agent",
          tool_name: "finish",
          action: { kind: "FinishAction", message: "done" },
        },
      ]),
    ).toBe("done");
    expect(extractAgentResult([])).toBeNull();
  });
});

describe("buildGithubPushPrompt", () => {
  const options = {
    repository: "acme/widgets",
    item: { number: 5, title: "t", url: "u", baseRef: null, headRef: null },
  };

  it("only pushes, never force-pushes", () => {
    const text = buildGithubPushPrompt("push", options);
    expect(text).toContain("push");
    expect(text).toContain("do not force-push");
    expect(text).not.toContain("pull request");
  });

  it("opens a pull request that fixes the issue", () => {
    const text = buildGithubPushPrompt("push_and_open_pull_request", options);
    expect(text).toContain("Fixes #5");
    expect(text).toContain("acme/widgets");
  });
});
