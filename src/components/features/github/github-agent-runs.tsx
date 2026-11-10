import { ExternalLink, RefreshCw } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import {
  GitProviderApiError,
  GitProviderItemsService,
  type GithubWorkItemDetail,
} from "#/api/git-provider-items-service";
import { MarkdownRenderer } from "#/components/features/markdown/markdown-renderer";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useNavigation } from "#/context/navigation-context";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useConversationHistory } from "#/hooks/query/use-conversation-history";
import { I18nKey } from "#/i18n/declaration";
import {
  githubRunKey,
  useGithubAgentRunsStore,
  type GithubAgentRun,
} from "#/stores/github-agent-runs-store";
import {
  analyzeAgentRun,
  parseReviewComments,
  type AgentRunStatus,
} from "#/utils/agent-run-result";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { cn } from "#/utils/utils";
import {
  buildGithubPushPrompt,
  type GithubAgentAction,
  type GithubPushMode,
} from "#/utils/github-agent-prompts";

const ACTION_LABEL: Record<GithubAgentAction, I18nKey> = {
  work_on_issue: I18nKey.GITHUB$ACTION_WORK_ON_ISSUE,
  create_pull_request: I18nKey.GITHUB$ACTION_CREATE_PR,
  review_pull_request: I18nKey.GITHUB$ACTION_REVIEW_PR,
  address_review_comments: I18nKey.GITHUB$ACTION_ADDRESS_REVIEW,
  fix_failing_checks: I18nKey.GITHUB$ACTION_FIX_CHECKS,
};

const STATUS_LABEL: Record<AgentRunStatus, I18nKey | null> = {
  running: I18nKey.GITHUB$RUN_STATUS_RUNNING,
  finished: I18nKey.GITHUB$RUN_STATUS_FINISHED,
  error: I18nKey.GITHUB$RUN_STATUS_ERROR,
  rate_limited: I18nKey.GITHUB$RUN_STATUS_RATE_LIMITED,
  unknown: null,
};

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: "text-primary",
  finished: "text-success",
  error: "text-danger",
  rate_limited: "text-danger",
  unknown: "text-muted",
};

/** How often a running agent's card re-reads its conversation. */
const RUN_REFRESH_MS = 10_000;

type PostMode = "comment" | "review" | "approve" | "request_changes";

/** Pull requests offer every verdict; the first is the default. */
const POST_MODES: readonly PostMode[] = [
  "review",
  "approve",
  "request_changes",
  "comment",
];

const POST_MODE_LABEL: Record<PostMode, I18nKey> = {
  review: I18nKey.GITHUB$POST_AS_REVIEW,
  approve: I18nKey.GITHUB$POST_AS_APPROVE,
  request_changes: I18nKey.GITHUB$POST_AS_REQUEST_CHANGES,
  comment: I18nKey.GITHUB$POST_AS_COMMENT,
};

const REVIEW_EVENT = {
  review: "COMMENT",
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
} as const;

const NO_RUNS: GithubAgentRun[] = [];

interface GithubAgentRunsProps {
  repository: string;
  item: GithubWorkItemDetail;
}

/**
 * What the agent found for this issue or pull request: the result of each
 * conversation started from this page, with the next steps a user can take
 * (post the result to GitHub, ask the agent to push its commits).
 */
export function GithubAgentRuns({ repository, item }: GithubAgentRunsProps) {
  const { t } = useTranslation("openhands");
  const { backend } = useActiveBackend();
  const key = githubRunKey(backend.id, repository, item.number);
  const runs = useGithubAgentRunsStore((state) => state.runs[key] ?? NO_RUNS);

  if (runs.length === 0) return null;

  return (
    <section
      aria-labelledby="github-agent-runs-heading"
      data-testid="github-agent-runs"
      className="flex flex-col gap-3"
    >
      <h3
        id="github-agent-runs-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$AGENT_RUNS)}
      </h3>
      {runs.map((run) => (
        <GithubAgentRunCard
          key={run.conversationId}
          run={run}
          repository={repository}
          item={item}
        />
      ))}
    </section>
  );
}

function errorMessage(
  t: (key: I18nKey, options?: Record<string, unknown>) => string,
  error: unknown,
): string {
  if (error instanceof GitProviderApiError) {
    return t(I18nKey.GITHUB$POST_ERROR, { status: error.status });
  }
  return t(I18nKey.GITHUB$POST_ERROR, { status: "?" });
}

function GithubAgentRunCard({
  run,
  repository,
  item,
}: {
  run: GithubAgentRun;
  repository: string;
  item: GithubWorkItemDetail;
}) {
  const { t, i18n } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const history = useConversationHistory(run.conversationId);
  const summary = React.useMemo(
    () => analyzeAgentRun(history.data?.events ?? []),
    [history.data],
  );
  const { result, status } = summary;
  const isRunning = status === "running";
  const { refetch: refetchHistory } = history;
  React.useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => {
      refetchHistory();
    }, RUN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isRunning, refetchHistory]);
  const [composing, setComposing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const review = React.useMemo(
    () => parseReviewComments(result ?? ""),
    [result],
  );
  const [includeInline, setIncludeInline] = React.useState(true);
  const [postMode, setPostMode] = React.useState<PostMode>(
    item.kind === "pull_request" ? "review" : "comment",
  );

  const post = useMutation({
    mutationFn: ({
      body,
      mode,
      comments,
    }: {
      body: string;
      mode: PostMode;
      comments: typeof review.comments;
    }) =>
      mode === "comment"
        ? GitProviderItemsService.postGithubComment(
            repository,
            item.number,
            body,
          )
        : GitProviderItemsService.postGithubReview(
            repository,
            item.number,
            body,
            { event: REVIEW_EVENT[mode], comments },
          ),
  });
  const push = useMutation({
    mutationFn: (mode: GithubPushMode) =>
      AgentServerConversationService.sendMessage(run.conversationId, {
        role: "user",
        content: [
          {
            type: "text",
            text: buildGithubPushPrompt(mode, { repository, item }),
          },
        ],
      }),
  });

  const resume = useMutation({
    mutationFn: () =>
      AgentServerConversationService.sendMessage(run.conversationId, {
        role: "user",
        content: [{ type: "text", text: "continue" }],
      }),
    onSuccess: () => {
      refetchHistory();
    },
  });

  const openComposer = () => {
    setDraft(review.text);
    setIncludeInline(review.comments.length > 0);
    setComposing(true);
    post.reset();
  };
  const canPush = run.action !== "review_pull_request";

  return (
    <article
      data-testid={`github-agent-run-${run.conversationId}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-base-secondary p-4"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="text-sm font-medium text-contrast">
          {t(ACTION_LABEL[run.action])}
        </span>
        <span>{formatRelativeTime(run.startedAt, i18n.language, t)}</span>
        {STATUS_LABEL[status] ? (
          <span
            data-testid="github-agent-run-status"
            data-status={status}
            className={cn("font-medium", STATUS_TONE[status])}
          >
            {t(STATUS_LABEL[status])}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => history.refetch()}
          aria-label={t(I18nKey.GITHUB$AGENT_RUN_REFRESH)}
          title={t(I18nKey.GITHUB$AGENT_RUN_REFRESH)}
          className="inline-flex items-center rounded p-1 hover:text-contrast"
        >
          <RefreshCw
            className={
              history.isFetching ? "size-3.5 animate-spin" : "size-3.5"
            }
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={() => navigate(`/conversations/${run.conversationId}`)}
          className="ml-auto inline-flex items-center gap-1.5 hover:text-contrast"
        >
          {t(I18nKey.GITHUB$AGENT_RUN_OPEN)}
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
      </header>

      {status === "rate_limited" || status === "error" ? (
        <div
          role="alert"
          data-testid="github-agent-run-notice"
          className="flex flex-wrap items-center gap-2 text-xs text-danger"
        >
          <span className="min-w-0 wrap-anywhere">
            {status === "rate_limited" && summary.resumesAt
              ? t(I18nKey.GITHUB$RUN_RESUMES, { time: summary.resumesAt })
              : summary.error}
          </span>
          <BrandButton
            type="button"
            variant="secondary"
            testId="github-run-resume"
            isDisabled={resume.isPending}
            onClick={() => resume.mutate()}
          >
            {t(I18nKey.GITHUB$RUN_RESUME)}
          </BrandButton>
          {resume.isError ? <span>{t(I18nKey.GITHUB$PUSH_ERROR)}</span> : null}
        </div>
      ) : null}

      {result ? (
        <div
          data-testid="github-agent-run-result"
          className="max-h-72 min-w-0 overflow-auto rounded-md border border-border bg-canvas-base p-3 text-sm text-contrast"
        >
          <MarkdownRenderer includeStandard includeHeadings>
            {result}
          </MarkdownRenderer>
        </div>
      ) : (
        <p className="text-sm text-muted italic">
          {t(I18nKey.GITHUB$AGENT_RUN_NO_RESULT)}
        </p>
      )}

      {composing ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor={`github-post-${run.conversationId}`}
            className="text-xs font-medium text-contrast"
          >
            {t(I18nKey.GITHUB$POST_MESSAGE_LABEL)}
          </label>
          <textarea
            id={`github-post-${run.conversationId}`}
            data-testid="github-post-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={8}
            className="w-full rounded-md border border-border bg-canvas-base p-2 font-mono text-xs text-contrast"
          />
          {item.kind === "pull_request" ? (
            <div role="radiogroup" className="flex flex-wrap gap-4 text-xs">
              {POST_MODES.map((mode) => (
                <label key={mode} className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`github-post-mode-${run.conversationId}`}
                    checked={postMode === mode}
                    onChange={() => setPostMode(mode)}
                  />
                  {t(POST_MODE_LABEL[mode])}
                </label>
              ))}
            </div>
          ) : null}
          {item.kind === "pull_request" &&
          postMode !== "comment" &&
          review.comments.length > 0 ? (
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                data-testid="github-post-inline"
                checked={includeInline}
                onChange={(event) => setIncludeInline(event.target.checked)}
              />
              {t(I18nKey.GITHUB$POST_INLINE, {
                count: review.comments.length,
              })}
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <BrandButton
              type="button"
              variant="primary"
              testId="github-post-submit"
              isDisabled={post.isPending || !draft.trim() || post.isSuccess}
              onClick={() =>
                post.mutate({
                  body: draft.trim(),
                  mode: item.kind === "pull_request" ? postMode : "comment",
                  comments: includeInline ? review.comments : [],
                })
              }
            >
              {t(I18nKey.GITHUB$POST_TO_GITHUB)}
            </BrandButton>
            <BrandButton
              type="button"
              variant="secondary"
              onClick={() => setComposing(false)}
            >
              {t(I18nKey.BUTTON$CANCEL)}
            </BrandButton>
            {post.isSuccess ? (
              <span
                data-testid="github-post-success"
                className="inline-flex items-center gap-2 text-xs text-success"
              >
                {t(I18nKey.GITHUB$POST_SUCCESS)}
                <a
                  href={post.data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {t(I18nKey.GITHUB$POST_VIEW)}
                </a>
              </span>
            ) : null}
          </div>
          {post.isError ? (
            <p
              role="alert"
              data-testid="github-post-error"
              className="text-xs text-danger"
            >
              {errorMessage(t, post.error)}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <BrandButton
            type="button"
            variant="secondary"
            testId="github-post-open"
            isDisabled={!result || isRunning}
            onClick={openComposer}
          >
            {t(I18nKey.GITHUB$POST_TO_GITHUB)}
          </BrandButton>
          {canPush ? (
            <>
              <BrandButton
                type="button"
                variant="secondary"
                testId="github-push"
                isDisabled={push.isPending || isRunning}
                onClick={() => push.mutate("push")}
              >
                {t(I18nKey.GITHUB$PUSH_COMMITS)}
              </BrandButton>
              {item.kind === "issue" ? (
                <BrandButton
                  type="button"
                  variant="secondary"
                  testId="github-push-and-pr"
                  isDisabled={push.isPending || isRunning}
                  onClick={() => push.mutate("push_and_open_pull_request")}
                >
                  {t(I18nKey.GITHUB$PUSH_AND_OPEN_PR)}
                </BrandButton>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {push.isSuccess ? (
        <p data-testid="github-push-sent" className="text-xs text-success">
          {t(I18nKey.GITHUB$PUSH_SENT)}
        </p>
      ) : null}
      {push.isError ? (
        <p role="alert" className="text-xs text-danger">
          {t(I18nKey.GITHUB$PUSH_ERROR)}
        </p>
      ) : null}
    </article>
  );
}
