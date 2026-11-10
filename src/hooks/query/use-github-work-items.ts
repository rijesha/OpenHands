import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  GitProviderApiError,
  GitProviderItemsService,
  type GithubInvolvement,
  type GithubWorkItemKind,
  type GithubWorkItemStateFilter,
} from "#/api/git-provider-items-service";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { GITHUB_WORK_ITEMS_QUERY_KEYS } from "./query-keys";

const GITHUB_WORK_ITEMS_STALE_TIME_MS = 60_000;

// Auth / not-found / rate-limit answers do not change on an immediate retry,
// and unauthenticated requests share a small hourly budget.
const retryUnlessClientError = (failureCount: number, error: Error) =>
  !(error instanceof GitProviderApiError && error.status < 500) &&
  failureCount < 2;

export function useGithubWorkItems(
  repository: string | null,
  kind: GithubWorkItemKind,
  state: GithubWorkItemStateFilter,
  filters: { search?: string; involvement?: GithubInvolvement } = {},
) {
  const { backend, orgId } = useActiveBackend();
  const search = filters.search?.trim() ?? "";
  const involvement = filters.involvement ?? "all";

  return useInfiniteQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.list(
      backend.id,
      orgId,
      repository ?? "",
      kind,
      state,
      search,
      involvement,
    ),
    queryFn: ({ pageParam }) =>
      GitProviderItemsService.listGithubWorkItems(repository!, kind, {
        state,
        page: pageParam,
        query: search,
        involvement,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage ?? undefined,
    enabled: Boolean(repository),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}

export function useGithubWorkItem(
  repository: string | null,
  kind: GithubWorkItemKind,
  number: number | null,
) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.detail(
      backend.id,
      orgId,
      repository ?? "",
      kind,
      number ?? 0,
    ),
    queryFn: () =>
      GitProviderItemsService.getGithubWorkItem(repository!, kind, number!),
    enabled: Boolean(repository && number),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}

/** Issues and pull requests connected to the given one (see getGithubLinkedItems). */
export function useGithubLinkedItems(
  repository: string | null,
  number: number | null,
  body: string | null | undefined,
) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.linked(
      backend.id,
      orgId,
      repository ?? "",
      number ?? 0,
      body ?? "",
    ),
    queryFn: () =>
      GitProviderItemsService.getGithubLinkedItems(
        repository!,
        number!,
        body ?? null,
      ),
    enabled: Boolean(repository && number && body !== undefined),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}

/** Comments, reviews and line comments of an item. A failure just hides the section. */
export function useGithubDiscussion(
  repository: string,
  kind: GithubWorkItemKind,
  number: number,
) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.discussion(
      backend.id,
      orgId,
      repository,
      kind,
      number,
    ),
    queryFn: () =>
      GitProviderItemsService.getGithubDiscussion(repository, kind, number),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}

/** CI checks of a pull request's head commit. */
export function useGithubChecks(repository: string, sha: string | null) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.checks(
      backend.id,
      orgId,
      repository,
      sha ?? "",
    ),
    queryFn: () => GitProviderItemsService.getGithubChecks(repository, sha!),
    enabled: Boolean(sha),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}

/** Files a pull request changes. */
export function useGithubChangedFiles(repository: string, number: number) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.files(
      backend.id,
      orgId,
      repository,
      number,
    ),
    queryFn: () =>
      GitProviderItemsService.getGithubChangedFiles(repository, number),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}

const WORKFLOW_RUNS_REFRESH_MS = 15_000;

/** GitHub Actions runs of a commit; refreshes while any of them is still going. */
export function useGithubWorkflowRuns(repository: string, sha: string | null) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.runs(
      backend.id,
      orgId,
      repository,
      sha ?? "",
    ),
    queryFn: () =>
      GitProviderItemsService.getGithubWorkflowRuns(repository, sha!),
    enabled: Boolean(sha),
    staleTime: GITHUB_WORK_ITEMS_STALE_TIME_MS,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.running)
        ? WORKFLOW_RUNS_REFRESH_MS
        : false,
    retry: retryUnlessClientError,
    meta: { disableToast: true },
  });
}
