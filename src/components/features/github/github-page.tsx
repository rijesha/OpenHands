import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GithubInvolvement,
  GithubWorkItem,
  GithubWorkItemKind,
  GithubWorkItemStateFilter,
} from "#/api/git-provider-items-service";
import { useGithubWorkItems } from "#/hooks/query/use-github-work-items";
import { I18nKey } from "#/i18n/declaration";
import SearchIcon from "#/icons/search.svg?react";
import { cn } from "#/utils/utils";
import { GithubRepositorySelector } from "./github-repository-selector";
import { GithubWorkItemDetailPanel } from "./github-work-item-detail";
import { GithubWorkItemList } from "./github-work-item-list";

const GITHUB_TAB_PANEL_ID = "github-work-items-panel";

const KIND_TABS: ReadonlyArray<{ kind: GithubWorkItemKind; label: I18nKey }> = [
  { kind: "issue", label: I18nKey.GITHUB$TAB_ISSUES },
  { kind: "pull_request", label: I18nKey.GITHUB$TAB_PULL_REQUESTS },
];

const STATE_FILTERS: ReadonlyArray<{
  state: GithubWorkItemStateFilter;
  label: I18nKey;
}> = [
  { state: "open", label: I18nKey.GITHUB$STATE_OPEN },
  { state: "closed", label: I18nKey.GITHUB$STATE_CLOSED },
  { state: "all", label: I18nKey.GITHUB$STATE_ALL },
];

const INVOLVEMENTS: ReadonlyArray<{
  value: GithubInvolvement;
  label: I18nKey;
}> = [
  { value: "all", label: I18nKey.GITHUB$INVOLVEMENT_ALL },
  { value: "assigned", label: I18nKey.GITHUB$INVOLVEMENT_ASSIGNED },
  {
    value: "review_requested",
    label: I18nKey.GITHUB$INVOLVEMENT_REVIEW_REQUESTED,
  },
];

/** Matches loaded rows by title, label, or `#123` / `123`. */
function matchesFilter(item: GithubWorkItem, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  if (!query) return true;
  if (query.replace(/^#/, "") === String(item.number)) return true;
  return (
    item.title.toLowerCase().includes(query) ||
    item.labels.some((label) => label.toLowerCase().includes(query))
  );
}

export interface GithubPageProps {
  repository: string | null;
  kind: GithubWorkItemKind;
  state: GithubWorkItemStateFilter;
  selectedNumber: number | null;
  onRepositoryChange: (repository: string | null) => void;
  onKindChange: (kind: GithubWorkItemKind) => void;
  onStateChange: (state: GithubWorkItemStateFilter) => void;
  onSelectItem: (number: number | null) => void;
  /** Opens an item of the current repository, switching to its tab if needed. */
  onOpenItem: (kind: GithubWorkItemKind, number: number) => void;
}

export function GithubPage({
  repository,
  kind,
  state,
  selectedNumber,
  onRepositoryChange,
  onKindChange,
  onStateChange,
  onSelectItem,
  onOpenItem,
}: GithubPageProps) {
  const { t } = useTranslation("openhands");
  const [filter, setFilter] = React.useState("");
  // Typing filters the loaded rows at once; Enter asks GitHub to search.
  const [searchQuery, setSearchQuery] = React.useState("");
  const [involvement, setInvolvement] =
    React.useState<GithubInvolvement>("all");
  // "Review requested" only exists for pull requests.
  const effectiveInvolvement =
    kind === "issue" && involvement === "review_requested"
      ? "all"
      : involvement;
  const query = useGithubWorkItems(repository, kind, state, {
    search: searchQuery,
    involvement: effectiveInvolvement,
  });

  const items = React.useMemo(() => {
    const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
    // GitHub already matched a search; the local filter would hide hits found in the body.
    return searchQuery
      ? rows
      : rows.filter((item) => matchesFilter(item, filter));
  }, [query.data, filter, searchQuery]);

  return (
    <div
      data-testid="github-page"
      className="flex h-full min-h-0 flex-col overflow-y-auto lg:overflow-hidden"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pt-6 sm:px-6 lg:min-h-0 lg:flex-1">
        <header>
          <h1 className="text-xl font-semibold text-content">
            {t(I18nKey.GITHUB$PAGE_TITLE)}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t(I18nKey.GITHUB$PAGE_SUBTITLE)}
          </p>
        </header>

        <GithubRepositorySelector
          repository={repository}
          onChange={(next) => {
            setFilter("");
            setSearchQuery("");
            onRepositoryChange(next);
          }}
        />

        {repository ? (
          <div className="grid grid-cols-1 gap-4 pb-6 lg:min-h-0 lg:flex-1 lg:grid-cols-5">
            <section
              aria-label={t(I18nKey.GITHUB$PAGE_TITLE)}
              className={cn(
                "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border lg:col-span-2 lg:min-h-0",
                selectedNumber !== null && "hidden lg:flex",
              )}
            >
              <div className="flex flex-col gap-3 border-b border-border p-3">
                <div
                  role="tablist"
                  aria-label={t(I18nKey.GITHUB$PAGE_TITLE)}
                  className="flex gap-1"
                >
                  {KIND_TABS.map((tab) => (
                    <button
                      key={tab.kind}
                      type="button"
                      role="tab"
                      id={`github-tab-${tab.kind}`}
                      data-testid={`github-tab-${tab.kind}`}
                      aria-selected={kind === tab.kind}
                      aria-controls={GITHUB_TAB_PANEL_ID}
                      tabIndex={kind === tab.kind ? 0 : -1}
                      onClick={() => {
                        if (tab.kind !== kind) onKindChange(tab.kind);
                      }}
                      className={cn(
                        "border-b-2 px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:text-contrast",
                        kind === tab.kind
                          ? "border-primary text-contrast"
                          : "border-transparent text-muted hover:text-contrast",
                      )}
                    >
                      {t(tab.label)}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    role="group"
                    aria-label={t(I18nKey.GITHUB$STATE_FILTER_LABEL)}
                    className="inline-flex rounded-lg border border-border p-0.5"
                  >
                    {STATE_FILTERS.map((option) => (
                      <button
                        key={option.state}
                        type="button"
                        data-testid={`github-state-${option.state}`}
                        aria-pressed={state === option.state}
                        onClick={() => onStateChange(option.state)}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs transition-colors",
                          state === option.state
                            ? "bg-interactive-selected text-contrast"
                            : "text-muted hover:text-contrast",
                        )}
                      >
                        {t(option.label)}
                      </button>
                    ))}
                  </div>
                  <select
                    aria-label={t(I18nKey.GITHUB$INVOLVEMENT_LABEL)}
                    data-testid="github-involvement"
                    value={effectiveInvolvement}
                    onChange={(event) =>
                      setInvolvement(event.target.value as GithubInvolvement)
                    }
                    className="h-8 rounded-lg border border-border bg-base-secondary px-2 text-xs text-contrast"
                  >
                    {INVOLVEMENTS.filter(
                      (option) =>
                        kind === "pull_request" ||
                        option.value !== "review_requested",
                    ).map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.label)}
                      </option>
                    ))}
                  </select>
                  <div className="relative flex h-8 min-w-40 flex-1 items-center rounded-lg border border-border bg-base-secondary focus-within:border-contrast/40">
                    <SearchIcon
                      className="ml-2.5 size-3.5 shrink-0 text-tertiary-alt"
                      aria-hidden
                    />
                    <input
                      type="search"
                      value={filter}
                      onChange={(event) => {
                        setFilter(event.target.value);
                        if (!event.target.value) setSearchQuery("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          setSearchQuery(filter.trim());
                        }
                      }}
                      data-testid="github-work-items-filter"
                      placeholder={t(I18nKey.GITHUB$FILTER_PLACEHOLDER)}
                      aria-label={t(I18nKey.GITHUB$FILTER_PLACEHOLDER)}
                      className="min-w-0 flex-1 border-0 bg-transparent px-2 text-xs text-contrast outline-none placeholder:text-tertiary-alt"
                    />
                  </div>
                </div>
              </div>
              <div
                role="tabpanel"
                id={GITHUB_TAB_PANEL_ID}
                aria-labelledby={`github-tab-${kind}`}
                className="min-h-0 flex-1 overflow-y-auto custom-scrollbar"
              >
                <GithubWorkItemList
                  repository={repository}
                  items={items}
                  selectedNumber={selectedNumber}
                  onSelect={onSelectItem}
                  isLoading={query.isLoading}
                  error={query.error}
                  onRetry={() => query.refetch()}
                  hasNextPage={query.hasNextPage}
                  isFetchingNextPage={query.isFetchingNextPage}
                  onLoadMore={() => query.fetchNextPage()}
                />
              </div>
            </section>

            <section
              className={cn(
                "min-w-0 lg:col-span-3 lg:min-h-0 lg:overflow-y-auto lg:custom-scrollbar lg:pr-1",
                selectedNumber === null && "hidden lg:block",
              )}
            >
              {selectedNumber !== null ? (
                <GithubWorkItemDetailPanel
                  // Remount per item so a launch in flight never shows on the
                  // next item's actions.
                  key={`${repository}:${kind}:${selectedNumber}`}
                  repository={repository}
                  kind={kind}
                  number={selectedNumber}
                  onBack={() => onSelectItem(null)}
                  onOpenItem={onOpenItem}
                />
              ) : (
                <p
                  data-testid="github-select-item-prompt"
                  className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted"
                >
                  {t(I18nKey.GITHUB$SELECT_ITEM_PROMPT)}
                </p>
              )}
            </section>
          </div>
        ) : (
          <p
            data-testid="github-select-repository-prompt"
            className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted"
          >
            {t(I18nKey.GITHUB$SELECT_REPOSITORY_PROMPT)}
          </p>
        )}
      </div>
    </div>
  );
}
