import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { StatuslineInstallResult } from "#/api/claude-code-usage";

interface ClaudeCodeUsageSetupState {
  /**
   * What setting up the usage helper came to, per backend. A backend with an
   * outcome is not set up again by itself; a failed attempt is not recorded,
   * so it is retried next session.
   */
  outcomes: Record<string, StatuslineInstallResult>;
  record: (backendId: string, outcome: StatuslineInstallResult) => void;
}

export const useClaudeCodeUsageSetupStore = create<ClaudeCodeUsageSetupState>()(
  persist(
    (set) => ({
      outcomes: {},
      record: (backendId, outcome) =>
        set((state) => ({
          outcomes: { ...state.outcomes, [backendId]: outcome },
        })),
    }),
    {
      name: "claude-code-usage-setup",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
