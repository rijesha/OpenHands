import type { CustomSecretWithoutValue } from "#/api/secrets-service.types";

/**
 * Claude Code reads its effort level from this environment variable, and the
 * agent-server exports saved secrets into a conversation's environment. So the
 * level is kept as a saved secret, and it applies to conversations started
 * afterwards.
 */
export const CLAUDE_CODE_EFFORT_SECRET = "CLAUDE_CODE_EFFORT_LEVEL";

/** The levels Claude Code accepts in that variable; a model without one falls back to the nearest lower. */
export const CLAUDE_CODE_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_LEVELS)[number];

// A secret's value cannot be read back, so the chosen level is also written
// into its description, which can.
const DESCRIPTION_PREFIX = "Claude Code effort level set from Agent Canvas: ";

export function effortSecretDescription(level: ClaudeCodeEffort): string {
  return `${DESCRIPTION_PREFIX}${level}`;
}

/** The level saved from Canvas, or `null` for Claude Code's own default. */
export function effortFromSecrets(
  secrets: readonly CustomSecretWithoutValue[],
): ClaudeCodeEffort | null {
  const secret = secrets.find(
    (candidate) => candidate.name === CLAUDE_CODE_EFFORT_SECRET,
  );
  const level = secret?.description?.startsWith(DESCRIPTION_PREFIX)
    ? secret.description.slice(DESCRIPTION_PREFIX.length).trim()
    : null;
  return CLAUDE_CODE_EFFORT_LEVELS.find((known) => known === level) ?? null;
}
