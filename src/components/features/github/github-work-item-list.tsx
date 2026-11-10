import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useActiveBackend } from "#/contexts/active-backend-context";
import {
  githubRunKey,
  useGithubAgentRunsStore,
} from "#/stores/github-agent-runs-store";
import type { GithubWorkItem } from "#/api/git-provider-items-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { cn } from "#/utils/utils";
import { GithubLoadError } from "./github-load-error";
import { GithubWorkItemState } from "./github-work-item-state";

const MAX_ROW_LABELS = 3;

interface GithubWorkItemListProps {
  repository: string;
  items: GithubWorkItem[];
  selectedNumber: number | null;
  onSelect: (number: number) => void;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function GithubWorkItemList({
  repository,
  items,
  selectedNumber,
  onSelect,
  isLoading,
  error,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: GithubWorkItemListProps) {
  const { t, i18n } = useTranslation("openhands");
  const { backend } = useActiveBackend();
  const runs = useGithubAgentRunsStore((state) => state.runs);

  if (isLoading) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted">
        {t(I18nKey.HOME$LOADING)}
      </p>
    );
  }

  // A failed "load more" keeps the rows already shown.
  if (error && items.length === 0) {
    return (
      <GithubLoadError
        error={error}
        onRetry={onRetry}
        testId="github-work-items-error"
      />
    );
  }

  return (
    <div className="flex flex-col">
      {items.length === 0 ? (
        <p
          data-testid="github-work-items-empty"
          className="px-4 py-8 text-center text-sm text-muted"
        >
          {t(I18nKey.GITHUB$LIST_EMPTY)}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((item) => {
            const isSelected = item.number === selectedNumber;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`github-work-item-${item.number}`}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => onSelect(item.number)}
                  className={cn(
                    "flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left transition-colors",
                    "hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline-none",
                    isSelected && "bg-interactive-selected",
                  )}
                >
                  <GithubWorkItemState
                    item={item}
                    variant="icon"
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium text-contrast wrap-anywhere">
                      {item.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      <span className="tabular-nums">#{item.number}</span>
                      {runs[githubRunKey(backend.id, repository, item.number)]
                        ?.length ? (
                        <span
                          role="img"
                          data-testid={`github-work-item-has-run-${item.number}`}
                          aria-label={t(I18nKey.GITHUB$HAS_AGENT_RUN)}
                          title={t(I18nKey.GITHUB$HAS_AGENT_RUN)}
                          className="inline-flex"
                        >
                          <Bot className="size-3.5 text-primary" aria-hidden />
                        </span>
                      ) : null}
                      {item.authorLogin ? (
                        <span>{item.authorLogin}</span>
                      ) : null}
                      {item.updatedAt ? (
                        <span>
                          {formatRelativeTime(item.updatedAt, i18n.language, t)}
                        </span>
                      ) : null}
                      {item.labels.slice(0, MAX_ROW_LABELS).map((label) => (
                        <span
                          key={label}
                          className="rounded-full border border-border px-1.5 text-2xs text-muted"
                        >
                          {label}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasNextPage ? (
        <div className="flex justify-center border-t border-border p-3">
          <BrandButton
            type="button"
            variant="secondary"
            testId="github-work-items-load-more"
            isDisabled={isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage
              ? t(I18nKey.HOME$LOADING)
              : t(I18nKey.GITHUB$LOAD_MORE)}
          </BrandButton>
        </div>
      ) : null}
    </div>
  );
}
