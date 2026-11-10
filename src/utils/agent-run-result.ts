/** Where an agent conversation stands, as far as its events tell. */
export type AgentRunStatus =
  "running" | "finished" | "error" | "rate_limited" | "unknown";

export interface AgentRunSummary {
  status: AgentRunStatus;
  /**
   * What the agent reported: the message of its latest `finish` action, else
   * (once it is no longer running) its latest message. Narration between tool
   * calls of a run in progress is never a result.
   */
  result: string | null;
  /** The error text of a run that stopped, when it came after the user's last message. */
  error: string | null;
  /** When a usage limit ends ("1pm (America/Regina)"), as the provider words it. */
  resumesAt: string | null;
}

const RATE_LIMIT = /rate.?limit|session limit|usage limit/i;
const RESETS = /resets\s+([^:{]+?)\s*(?::|\{|$)/i;

const EXECUTION_STATUS: Record<string, AgentRunStatus> = {
  running: "running",
  finished: "finished",
  idle: "finished",
  error: "error",
};

/**
 * Reads a conversation's events (chronological) and reports its status and
 * result. A run that failed on a usage limit is told apart from other errors
 * because it can simply be resumed later.
 */
export function analyzeAgentRun(events: readonly unknown[]): AgentRunSummary {
  let executionStatus: string | null = null;
  let finish: string | null = null;
  let lastMessage: string | null = null;
  let error: string | null = null;

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;

    if (e.kind === "ConversationStateUpdateEvent") {
      if (e.key === "execution_status" && typeof e.value === "string") {
        executionStatus = e.value;
      }
    } else if (e.kind === "ConversationErrorEvent") {
      error = typeof e.detail === "string" ? e.detail : "error";
    } else if (e.source === "user") {
      // A new user message starts a new turn: an earlier failure is history.
      error = null;
    } else {
      const text = textOf(e);
      if (text?.isFinish) finish = text.text;
      else if (text) lastMessage = text.text;
    }
  }

  let status: AgentRunStatus =
    (executionStatus && EXECUTION_STATUS[executionStatus]) || "unknown";
  if (status === "error" && error && RATE_LIMIT.test(error)) {
    status = "rate_limited";
  }

  return {
    status,
    result: finish ?? (status === "running" ? null : lastMessage),
    error: status === "error" || status === "rate_limited" ? error : null,
    resumesAt: error ? (RESETS.exec(error)?.[1] ?? null) : null,
  };
}

/** The agent's reported result (see {@link AgentRunSummary.result}). */
export function extractAgentResult(events: readonly unknown[]): string | null {
  return analyzeAgentRun(events).result;
}

function textOf(
  event: Record<string, unknown>,
): { text: string; isFinish: boolean } | null {
  if (event.source !== "agent") return null;

  const message = event.llm_message as
    { role?: string; content?: unknown } | undefined;
  if (message && message.role !== "user" && Array.isArray(message.content)) {
    const text = message.content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : "",
      )
      .join("")
      .trim();
    if (text) return { text, isFinish: false };
  }

  const action = event.action as
    { kind?: string; message?: unknown } | undefined;
  if (
    event.tool_name === "finish" &&
    action &&
    typeof action.message === "string" &&
    action.message.trim()
  ) {
    return { text: action.message.trim(), isFinish: true };
  }
  return null;
}

export interface ParsedReviewComment {
  path: string;
  line: number;
  body: string;
}

const FENCED_JSON = /```json\s*\n([\s\S]*?)\n```/g;

function asReviewComments(value: unknown): ParsedReviewComment[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const comments: ParsedReviewComment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { path, line, body } = entry as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      !path.trim() ||
      typeof body !== "string" ||
      !body.trim() ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 1
    ) {
      return null;
    }
    comments.push({ path: path.trim(), line, body: body.trim() });
  }
  return comments;
}

/**
 * Splits a review into its text and the line comments the agent listed in a
 * final fenced `json` block (see REVIEW_COMMENTS_BLOCK). A block that is not a
 * well-formed list is left in the text untouched.
 */
export function parseReviewComments(result: string): {
  text: string;
  comments: ParsedReviewComment[];
} {
  let found: {
    comments: ParsedReviewComment[];
    start: number;
    end: number;
  } | null = null;
  for (const match of result.matchAll(FENCED_JSON)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const comments = asReviewComments(parsed);
    if (comments) {
      found = {
        comments,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      };
    }
  }
  if (!found) return { text: result, comments: [] };
  return {
    text: `${result.slice(0, found.start)}${result.slice(found.end)}`.trim(),
    comments: found.comments,
  };
}
