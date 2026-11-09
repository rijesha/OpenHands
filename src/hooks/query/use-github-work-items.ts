import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  GitProviderApiError,
  GitProviderItemsService,
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
) {
  const { backend, orgId } = useActiveBackend();

  return useInfiniteQuery({
    queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.list(
      backend.id,
      orgId,
      repository ?? "",
      kind,
      state,
    ),
    queryFn: ({ pageParam }) =>
      GitProviderItemsService.listGithubWorkItems(repository!, kind, {
        state,
        page: pageParam,
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
