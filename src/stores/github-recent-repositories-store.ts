import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface GithubRecentRepositoriesState {
  /**
   * The repositories the user chose to keep on the GitHub page (`owner/repo`).
   * Earlier versions saved every opened repository here, so a stored list is
   * already valid as a saved one.
   */
  repositories: string[];
  /** The repository the page last showed, reopened when the page has none in its URL. */
  lastUsed: string | null;
  add: (repository: string) => void;
  remove: (repository: string) => void;
  setLastUsed: (repository: string) => void;
}

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * The GitHub page's repository list. Kept per browser, not per backend: the
 * names are public identifiers and not tied to one agent-server.
 */
export const useGithubRecentRepositoriesStore =
  create<GithubRecentRepositoriesState>()(
    persist(
      (set) => ({
        repositories: [],
        lastUsed: null,
        add: (repository) =>
          set((state) => ({
            repositories: state.repositories.some((existing) =>
              sameRepository(existing, repository),
            )
              ? state.repositories
              : [...state.repositories, repository],
          })),
        remove: (repository) =>
          set((state) => ({
            repositories: state.repositories.filter(
              (existing) => !sameRepository(existing, repository),
            ),
            lastUsed:
              state.lastUsed && sameRepository(state.lastUsed, repository)
                ? null
                : state.lastUsed,
          })),
        setLastUsed: (repository) => set({ lastUsed: repository }),
      }),
      {
        name: "github-recent-repositories",
        storage: createJSONStorage(() => localStorage),
      },
    ),
  );
