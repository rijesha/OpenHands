import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export const MAX_GITHUB_RECENT_REPOSITORIES = 8;

interface GithubRecentRepositoriesState {
  /** `owner/repo`, most recently opened first. */
  repositories: string[];
  remember: (repository: string) => void;
  forget: (repository: string) => void;
}

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * The repositories the GitHub page was opened on, so a user does not have to
 * retype a name each time. Kept per browser, not per backend: the names are
 * public identifiers and not tied to one agent-server.
 */
export const useGithubRecentRepositoriesStore =
  create<GithubRecentRepositoriesState>()(
    persist(
      (set) => ({
        repositories: [],
        remember: (repository) =>
          set((state) => ({
            repositories: [
              repository,
              ...state.repositories.filter(
                (existing) => !sameRepository(existing, repository),
              ),
            ].slice(0, MAX_GITHUB_RECENT_REPOSITORIES),
          })),
        forget: (repository) =>
          set((state) => ({
            repositories: state.repositories.filter(
              (existing) => !sameRepository(existing, repository),
            ),
          })),
      }),
      {
        name: "github-recent-repositories",
        storage: createJSONStorage(() => localStorage),
      },
    ),
  );
