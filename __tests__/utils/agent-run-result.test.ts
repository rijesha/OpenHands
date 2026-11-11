import { describe, expect, it } from "vitest";
import {
  analyzeAgentRun,
  parseReviewComments,
  parseShipPlan,
} from "#/utils/agent-run-result";

const status = (value: string) => ({
  kind: "ConversationStateUpdateEvent",
  key: "execution_status",
  value,
});
const say = (text: string) => ({
  source: "agent",
  llm_message: { role: "assistant", content: [{ type: "text", text }] },
});
const finish = (message: string) => ({
  source: "agent",
  tool_name: "finish",
  action: { kind: "FinishAction", message },
});
const user = (text: string) => ({
  source: "user",
  llm_message: { role: "user", content: [{ type: "text", text }] },
});
const failure = (detail: string) => ({
  kind: "ConversationErrorEvent",
  source: "agent",
  detail,
});

describe("analyzeAgentRun", () => {
  it("takes the status from the conversation record when the events hold none", () => {
    // A long turn: only narration is left in the newest page of events.
    const run = analyzeAgentRun([say("still editing files")], "running");

    expect(run).toMatchObject({ status: "running", result: null });
  });

  it("prefers the record's status over an older one in the events", () => {
    const run = analyzeAgentRun([status("running"), say("done")], "finished");

    expect(run).toMatchObject({ status: "finished", result: "done" });
  });

  it("does not mistake narration of a running agent for its result", () => {
    const run = analyzeAgentRun([
      status("running"),
      say("Let's give the VM harness another attempt."),
    ]);

    expect(run).toMatchObject({ status: "running", result: null });
  });

  it("reports the finish message of a finished run, even after later chatter", () => {
    const run = analyzeAgentRun([
      say("working"),
      finish("## Findings\nTwo issues."),
      status("finished"),
    ]);

    expect(run).toMatchObject({
      status: "finished",
      result: "## Findings\nTwo issues.",
    });
  });

  it("keeps an earlier result visible while a follow-up turn is running", () => {
    const run = analyzeAgentRun([
      finish("first result"),
      status("finished"),
      user("try again"),
      status("running"),
      say("retrying"),
    ]);

    expect(run).toMatchObject({ status: "running", result: "first result" });
  });

  it("tells a usage limit apart from other errors and says when it resets", () => {
    const limit = analyzeAgentRun([
      status("running"),
      failure(
        '[-32603] Internal error: You\'ve hit your session limit · resets 1pm (America/Regina): {"errorKind": "rate_limit"}',
      ),
      status("error"),
    ]);
    const other = analyzeAgentRun([failure("boom"), status("error")]);

    expect(limit).toMatchObject({
      status: "rate_limited",
      resumesAt: "1pm (America/Regina)",
    });
    expect(other).toMatchObject({
      status: "error",
      error: "boom",
      resumesAt: null,
    });
  });

  it("forgets an error once the user has written again", () => {
    const run = analyzeAgentRun([
      failure("boom"),
      status("error"),
      user("continue"),
      status("running"),
    ]);

    expect(run).toMatchObject({ status: "running", error: null });
  });

  it("is unknown without a status event", () => {
    expect(analyzeAgentRun([say("hello")])).toMatchObject({
      status: "unknown",
      result: "hello",
    });
  });
});

describe("parseReviewComments", () => {
  const block = (json: string) => "```json\n" + json + "\n```";

  it("takes the final well-formed block out of the text", () => {
    const { text, comments } = parseReviewComments(
      `Two issues.\n\n${block('[{"path":"src/a.ts","line":12,"body":"Null check"}]')}`,
    );

    expect(text).toBe("Two issues.");
    expect(comments).toEqual([
      { path: "src/a.ts", line: 12, body: "Null check" },
    ]);
  });

  it.each([
    ["not json", block("nope")],
    ["a missing line", block('[{"path":"a.ts","body":"x"}]')],
    ["a non-integer line", block('[{"path":"a.ts","line":1.5,"body":"x"}]')],
    ["an empty list", block("[]")],
  ])("leaves %s in the text and reports no comments", (_name, text) => {
    expect(parseReviewComments(text)).toEqual({ text, comments: [] });
  });
});

describe("parseShipPlan", () => {
  const fence = (value: unknown) =>
    ["```json", JSON.stringify(value), "```"].join("\n");

  it("reads the commit message and pull request from the final block", () => {
    const plan = parseShipPlan(
      `Done.\n${fence({
        commit: { message: " fix: save crash " },
        pull_request: { title: "Fix save crash", body: "Fixes #42" },
      })}`,
    );

    expect(plan).toEqual({
      commitMessage: "fix: save crash",
      pullRequest: { title: "Fix save crash", body: "Fixes #42" },
    });
  });

  it("accepts a commit-only plan and ignores review-comment arrays and bad JSON", () => {
    const text = [
      fence([{ path: "a.ts", line: 1, body: "x" }]),
      "```json\n{not json\n```",
      fence({ commit: { message: "chore: tidy" } }),
    ].join("\n");

    expect(parseShipPlan(text)).toEqual({
      commitMessage: "chore: tidy",
      pullRequest: null,
    });
  });

  it("gives null when no block prepares anything", () => {
    expect(parseShipPlan("No block here")).toBeNull();
    expect(parseShipPlan(fence({ commit: { message: "  " } }))).toBeNull();
  });
});
