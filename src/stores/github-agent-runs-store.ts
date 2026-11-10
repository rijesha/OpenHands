import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { GithubAgentAction } from "#/utils/github-agent-prompts";

export const MAX_RUNS_PER_ITEM = 10;

/** One agent conversation started from the GitHub page for an issue or pull request. */
export interface GithubAgentRun {
  conversationId: string;
  action: GithubAgentAction;
  startedAt: string;
}

interface GithubAgentRunsState {
  /** Keyed by {@link githubRunKey}; newest run first. */
  runs: Record<string, GithubAgentRun[]>;
  record: (key: string, run: GithubAgentRun) => void;
  forget: (key: string, conversationId: string) => void;
}

/**
 * Identifies one issue or pull request on one backend. Conversation ids belong
 * to a backend, so the key includes it.
 */
export function githubRunKey(
  backendId: string,
  repository: string,
  number: number,
): string {
  return `${backendId}|${repository.toLowerCase()}#${number}`;
}

/**
 * Which conversations were started for which issue or pull request, so the
 * GitHub page can show what the agent found next to the item. Kept per browser
 * (the conversations themselves live on the backend).
 */
export const useGithubAgentRunsStore = create<GithubAgentRunsState>()(
  persist(
    (set) => ({
      runs: {},
      record: (key, run) =>
        set((state) => ({
          runs: {
            ...state.runs,
            [key]: [
              run,
              ...(state.runs[key] ?? []).filter(
                (existing) => existing.conversationId !== run.conversationId,
              ),
            ].slice(0, MAX_RUNS_PER_ITEM),
          },
        })),
      forget: (key, conversationId) =>
        set((state) => ({
          runs: {
            ...state.runs,
            [key]: (state.runs[key] ?? []).filter(
              (run) => run.conversationId !== conversationId,
            ),
          },
        })),
    }),
    {
      name: "github-agent-runs",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
