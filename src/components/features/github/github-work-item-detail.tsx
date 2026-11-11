import { ArrowLeft, ExternalLink } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  GithubWorkItemDetail,
  GithubWorkItemKind,
} from "#/api/git-provider-items-service";
import { MarkdownRenderer } from "#/components/features/markdown/markdown-renderer";
import { BrandButton } from "#/components/features/settings/brand-button";
import {
  TestEnvironmentSelect,
  type TestEnvironment,
} from "#/components/features/vm-harness/test-environment-select";
import { useGithubWorkItem } from "#/hooks/query/use-github-work-items";
import { useVmHarness } from "#/hooks/query/use-vm-harness";
import { useLaunchGithubAgent } from "#/hooks/use-launch-github-agent";
import { I18nKey } from "#/i18n/declaration";
import { useActiveBackend } from "#/contexts/active-backend-context";
import {
  githubRunKey,
  useGithubAgentRunsStore,
} from "#/stores/github-agent-runs-store";
import { formatRelativeTime } from "#/utils/format-relative-time";
import {
  GITHUB_ISSUE_AGENT_ACTIONS,
  GITHUB_PULL_REQUEST_AGENT_ACTIONS,
  type GithubAgentAction,
} from "#/utils/github-agent-prompts";
import { cn, getProviderName } from "#/utils/utils";
import { GithubAgentRuns } from "./github-agent-runs";
import { GithubVmRuns } from "./github-vm-runs";
import { GithubLinkedItems } from "./github-linked-items";
import {
  GithubPipelines,
  GithubPullRequestActions,
} from "./github-pull-request-actions";
import {
  GithubChangedFiles,
  GithubChecks,
  GithubDiscussion,
} from "./github-pull-request-status";
import { GithubLoadError } from "./github-load-error";
import { GithubWorkItemState } from "./github-work-item-state";

const ACTION_COPY: Record<
  GithubAgentAction,
  { label: I18nKey; description: I18nKey }
> = {
  work_on_issue: {
    label: I18nKey.GITHUB$ACTION_WORK_ON_ISSUE,
    description: I18nKey.GITHUB$ACTION_WORK_ON_ISSUE_DESCRIPTION,
  },
  create_pull_request: {
    label: I18nKey.GITHUB$ACTION_CREATE_PR,
    description: I18nKey.GITHUB$ACTION_CREATE_PR_DESCRIPTION,
  },
  review_pull_request: {
    label: I18nKey.GITHUB$ACTION_REVIEW_PR,
    description: I18nKey.GITHUB$ACTION_REVIEW_PR_DESCRIPTION,
  },
  address_review_comments: {
    label: I18nKey.GITHUB$ACTION_ADDRESS_REVIEW,
    description: I18nKey.GITHUB$ACTION_ADDRESS_REVIEW_DESCRIPTION,
  },
  fix_failing_checks: {
    label: I18nKey.GITHUB$ACTION_FIX_CHECKS,
    description: I18nKey.GITHUB$ACTION_FIX_CHECKS_DESCRIPTION,
  },
};

interface GithubAgentActionsProps {
  repository: string;
  item: GithubWorkItemDetail;
}

function GithubAgentActions({ repository, item }: GithubAgentActionsProps) {
  const { t } = useTranslation("openhands");
  const { launch, pendingAction, isLaunching } = useLaunchGithubAgent();
  const { isAvailable: hasVmHarness } = useVmHarness();
  const [testEnvironment, setTestEnvironment] = useState<TestEnvironment>();
  const [instructions, setInstructions] = useState("");
  const actions =
    item.kind === "issue"
      ? GITHUB_ISSUE_AGENT_ACTIONS
      : GITHUB_PULL_REQUEST_AGENT_ACTIONS;

  return (
    <section
      aria-labelledby="github-agent-actions-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-base-secondary p-4"
    >
      <h3
        id="github-agent-actions-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$AGENT_ACTIONS)}
      </h3>
      {hasVmHarness ? (
        <TestEnvironmentSelect
          value={testEnvironment}
          onChange={setTestEnvironment}
          isDisabled={isLaunching}
        />
      ) : null}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="github-agent-instructions"
          className="text-xs font-medium text-contrast"
        >
          {t(I18nKey.GITHUB$INSTRUCTIONS_LABEL)}
        </label>
        <textarea
          id="github-agent-instructions"
          data-testid="github-agent-instructions"
          value={instructions}
          rows={2}
          disabled={isLaunching}
          placeholder={t(I18nKey.GITHUB$INSTRUCTIONS_PLACEHOLDER)}
          onChange={(event) => setInstructions(event.target.value)}
          className="w-full rounded-md border border-border bg-canvas-base p-2 text-sm text-contrast"
        />
      </div>
      <ul className="flex flex-col gap-3">
        {actions.map((action, index) => (
          <li
            key={action}
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4"
          >
            <BrandButton
              type="button"
              variant={index === 0 ? "primary" : "secondary"}
              testId={`github-agent-action-${action}`}
              isDisabled={isLaunching}
              aria-busy={pendingAction === action}
              onClick={() =>
                launch(action, repository, item, {
                  guiVm: testEnvironment,
                  instructions,
                })
              }
              className="shrink-0 whitespace-nowrap sm:min-w-40"
            >
              {pendingAction === action
                ? t(I18nKey.GITHUB$ACTION_STARTING)
                : t(ACTION_COPY[action].label)}
            </BrandButton>
            <p className="text-xs text-muted">
              {t(ACTION_COPY[action].description)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GithubWorkItemMeta({ item }: { item: GithubWorkItemDetail }) {
  const { t, i18n } = useTranslation("openhands");

  return (
    <div className="flex flex-col gap-2 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {item.authorLogin ? (
          <span>
            {t(I18nKey.GITHUB$OPENED_BY, { author: item.authorLogin })}
          </span>
        ) : null}
        {item.updatedAt ? (
          <span>
            {t(I18nKey.GITHUB$UPDATED_AT, {
              date: formatRelativeTime(item.updatedAt, i18n.language, t),
            })}
          </span>
        ) : null}
        {item.commentsCount !== null ? (
          <span>
            {t(I18nKey.GITHUB$COMMENTS_COUNT, { total: item.commentsCount })}
          </span>
        ) : null}
      </div>
      {item.kind === "pull_request" && item.headRef && item.baseRef ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span data-testid="github-work-item-branches">
            {t(I18nKey.GITHUB$BRANCHES, {
              head: item.headRef,
              base: item.baseRef,
            })}
          </span>
          {item.changedFiles !== null ? (
            <span>
              {t(I18nKey.GITHUB$FILES_CHANGED, { total: item.changedFiles })}
            </span>
          ) : null}
          {item.additions !== null && item.deletions !== null ? (
            <span className="tabular-nums">
              <span className="text-success">
                {t(I18nKey.CONVERSATION$OVERVIEW_DIFF_ADDITIONS, {
                  count: item.additions,
                })}
              </span>{" "}
              <span className="text-danger">
                {t(I18nKey.CONVERSATION$OVERVIEW_DIFF_DELETIONS, {
                  count: item.deletions,
                })}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
      {item.assignees.length > 0 ? (
        <span>
          {t(I18nKey.GITHUB$ASSIGNEES, { names: item.assignees.join(", ") })}
        </span>
      ) : null}
      {item.labels.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {item.labels.map((label) => (
            <li
              key={label}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-contrast"
            >
              {label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type DetailTab = "overview" | "runs" | "checks" | "files" | "discussion";

const DETAIL_TAB_LABEL: Record<DetailTab, I18nKey> = {
  overview: I18nKey.GITHUB$TAB_OVERVIEW,
  runs: I18nKey.GITHUB$AGENT_RUNS,
  checks: I18nKey.GITHUB$CHECKS,
  files: I18nKey.GITHUB$CHANGED_FILES,
  discussion: I18nKey.GITHUB$DISCUSSION,
};

const ISSUE_TABS: readonly DetailTab[] = ["overview", "runs", "discussion"];
const PULL_REQUEST_TABS: readonly DetailTab[] = [
  "overview",
  "runs",
  "checks",
  "files",
  "discussion",
];

interface GithubWorkItemDetailPanelProps {
  repository: string;
  kind: GithubWorkItemKind;
  number: number;
  onBack: () => void;
  /** Opens a linked issue or pull request of this repository. */
  onOpenItem: (kind: GithubWorkItemKind, number: number) => void;
}

export function GithubWorkItemDetailPanel({
  repository,
  kind,
  number,
  onBack,
  onOpenItem,
}: GithubWorkItemDetailPanelProps) {
  const { t } = useTranslation("openhands");
  const { backend } = useActiveBackend();
  const [tab, setTab] = useState<DetailTab>("overview");
  const runCount = useGithubAgentRunsStore(
    (state) => state.runs[githubRunKey(backend.id, repository, number)]?.length,
  );
  const {
    data: item,
    isLoading,
    error,
    refetch,
  } = useGithubWorkItem(repository, kind, number);
  const tabs = kind === "pull_request" ? PULL_REQUEST_TABS : ISSUE_TABS;

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    setTab(next);
    document.getElementById(`github-detail-tab-${next}`)?.focus();
  };

  return (
    <div data-testid="github-work-item-detail" className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 self-start text-sm text-muted hover:text-contrast lg:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t(I18nKey.GITHUB$BACK_TO_LIST)}
      </button>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted">
          {t(I18nKey.HOME$LOADING)}
        </p>
      ) : null}

      {!isLoading && (error || !item) ? (
        <GithubLoadError
          error={error}
          onRetry={() => refetch()}
          testId="github-work-item-detail-error"
        />
      ) : null}

      {item ? (
        <>
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <GithubWorkItemState item={item} variant="badge" />
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                data-testid="github-work-item-external-link"
                className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted hover:text-contrast"
              >
                {t(I18nKey.CONVERSATION$OVERVIEW_VIEW_ON_PROVIDER, {
                  provider: getProviderName("github"),
                })}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
            <h2 className="text-lg font-semibold text-contrast wrap-anywhere">
              {item.title}{" "}
              <span className="font-normal text-muted tabular-nums">
                #{item.number}
              </span>
            </h2>
            <GithubWorkItemMeta item={item} />
          </header>

          <div
            role="tablist"
            aria-label={t(I18nKey.GITHUB$DETAIL_TABS_LABEL)}
            className="flex flex-wrap gap-1 border-b border-border"
          >
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`github-detail-tab-${id}`}
                data-testid={`github-detail-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="github-detail-panel"
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={moveTab}
                className={cn(
                  "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:text-contrast",
                  tab === id
                    ? "border-primary text-contrast"
                    : "border-transparent text-muted hover:text-contrast",
                )}
              >
                {t(DETAIL_TAB_LABEL[id])}
                {id === "runs" && runCount ? (
                  <span className="ml-1.5 rounded-full bg-interactive-selected px-1.5 text-xs tabular-nums">
                    {runCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id="github-detail-panel"
            aria-labelledby={`github-detail-tab-${tab}`}
            className="flex flex-col gap-4"
          >
            {tab === "overview" ? (
              <>
                <GithubAgentActions repository={repository} item={item} />

                <GithubLinkedItems
                  repository={repository}
                  number={item.number}
                  body={item.body}
                  onOpenItem={onOpenItem}
                />

                <div
                  data-testid="github-work-item-body"
                  className={cn(
                    "rounded-lg border border-border p-4 text-sm text-contrast",
                    "min-w-0 overflow-x-auto",
                  )}
                >
                  {item.body?.trim() ? (
                    <MarkdownRenderer includeStandard includeHeadings>
                      {item.body}
                    </MarkdownRenderer>
                  ) : (
                    <p className="text-muted italic">
                      {t(I18nKey.GITHUB$NO_DESCRIPTION)}
                    </p>
                  )}
                </div>
              </>
            ) : null}

            {tab === "runs" ? (
              <>
                <GithubAgentRuns repository={repository} item={item} />
                <GithubVmRuns repository={repository} number={item.number} />
              </>
            ) : null}

            {tab === "checks" && item.kind === "pull_request" ? (
              <>
                <GithubPullRequestActions repository={repository} item={item} />
                <GithubChecks repository={repository} sha={item.headSha} />
                <GithubPipelines repository={repository} sha={item.headSha} />
              </>
            ) : null}

            {tab === "files" && item.kind === "pull_request" ? (
              <GithubChangedFiles
                repository={repository}
                number={item.number}
              />
            ) : null}

            {tab === "discussion" ? (
              <GithubDiscussion
                repository={repository}
                kind={item.kind}
                number={item.number}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
