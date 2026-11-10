import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  GitProviderApiError,
  GitProviderItemsService,
  type GithubMergeMethod,
  type GithubWorkItemDetail,
  type GithubWorkflowRun,
} from "#/api/git-provider-items-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useGithubWorkflowRuns } from "#/hooks/query/use-github-work-items";
import { GITHUB_WORK_ITEMS_QUERY_KEYS } from "#/hooks/query/query-keys";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

const MERGE_METHODS: ReadonlyArray<{
  method: GithubMergeMethod;
  label: I18nKey;
}> = [
  { method: "merge", label: I18nKey.GITHUB$MERGE_METHOD_MERGE },
  { method: "squash", label: I18nKey.GITHUB$MERGE_METHOD_SQUASH },
  { method: "rebase", label: I18nKey.GITHUB$MERGE_METHOD_REBASE },
];

/** A merge confirmation that is not clicked within this time is dropped. */
const CONFIRM_WINDOW_MS = 6000;

/** GitHub's `mergeable_state` values that mean a merge will probably go through. */
const MERGEABLE_STATES = new Set(["clean", "has_hooks", "unstable"]);

function useErrorText() {
  const { t } = useTranslation("openhands");
  return (error: unknown): string => {
    const status = error instanceof GitProviderApiError ? error.status : 0;
    if (status === 405) return t(I18nKey.GITHUB$ACTION_ERROR_NOT_MERGEABLE);
    if (status === 409) return t(I18nKey.GITHUB$ACTION_ERROR_CHANGED);
    return t(I18nKey.GITHUB$ACTION_ERROR, { status: status || "?" });
  };
}

/** Approve and merge an open pull request. Merging asks for a second click. */
export function GithubPullRequestActions({
  repository,
  item,
}: {
  repository: string;
  item: GithubWorkItemDetail;
}) {
  const { t } = useTranslation("openhands");
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [method, setMethod] = React.useState<GithubMergeMethod>("squash");
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.all,
    });

  const approve = useMutation({
    mutationFn: () =>
      GitProviderItemsService.postGithubReview(repository, item.number, "", {
        event: "APPROVE",
      }),
    onSuccess: refresh,
  });
  const merge = useMutation({
    mutationFn: () =>
      GitProviderItemsService.mergeGithubPullRequest(repository, item.number, {
        method,
        sha: item.headSha,
      }),
    onSuccess: refresh,
    onSettled: () => setArmed(false),
  });

  if (item.kind !== "pull_request" || item.state !== "open" || item.merged) {
    return null;
  }

  const conflicted = item.mergeable === false;
  const blockedState =
    item.mergeableState &&
    !MERGEABLE_STATES.has(item.mergeableState) &&
    item.mergeableState !== "dirty" &&
    item.mergeableState !== "draft" &&
    item.mergeableState !== "unknown"
      ? item.mergeableState
      : null;
  const cannotMerge = item.draft || conflicted || merge.isSuccess;

  return (
    <section
      aria-labelledby="github-pr-actions-heading"
      data-testid="github-pr-actions"
      className="flex flex-col gap-3 rounded-lg border border-border bg-base-secondary p-4"
    >
      <h3
        id="github-pr-actions-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$PR_ACTIONS)}
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <BrandButton
          type="button"
          variant="secondary"
          testId="github-pr-approve"
          isDisabled={approve.isPending || approve.isSuccess}
          onClick={() => approve.mutate()}
        >
          {t(I18nKey.GITHUB$APPROVE_PR)}
        </BrandButton>

        <label className="sr-only" htmlFor="github-merge-method">
          {t(I18nKey.GITHUB$MERGE_METHOD_LABEL)}
        </label>
        <select
          id="github-merge-method"
          data-testid="github-merge-method"
          value={method}
          disabled={merge.isPending || merge.isSuccess}
          onChange={(event) => {
            setMethod(event.target.value as GithubMergeMethod);
            setArmed(false);
          }}
          className="h-9 rounded-md border border-border bg-canvas-base px-2 text-sm text-contrast"
        >
          {MERGE_METHODS.map((option) => (
            <option key={option.method} value={option.method}>
              {t(option.label)}
            </option>
          ))}
        </select>
        <BrandButton
          type="button"
          variant="primary"
          testId="github-pr-merge"
          isDisabled={cannotMerge || merge.isPending}
          onClick={() => {
            if (armed) merge.mutate();
            else setArmed(true);
          }}
        >
          {armed ? t(I18nKey.GITHUB$MERGE_CONFIRM) : t(I18nKey.GITHUB$MERGE_PR)}
        </BrandButton>
      </div>

      {item.draft ? (
        <p className="text-xs text-muted">
          {t(I18nKey.GITHUB$MERGE_HINT_DRAFT)}
        </p>
      ) : null}
      {conflicted && !item.draft ? (
        <p className="text-xs text-danger">
          {t(I18nKey.GITHUB$MERGE_HINT_CONFLICT)}
        </p>
      ) : null}
      {blockedState && !conflicted && !item.draft ? (
        <p className="text-xs text-muted" data-testid="github-merge-hint">
          {t(I18nKey.GITHUB$MERGE_HINT_BLOCKED, { state: blockedState })}
        </p>
      ) : null}

      {approve.isSuccess || merge.isSuccess ? (
        <p data-testid="github-pr-action-done" className="text-xs text-success">
          {t(I18nKey.GITHUB$ACTION_DONE)}
        </p>
      ) : null}
      {approve.isError || merge.isError ? (
        <p
          role="alert"
          data-testid="github-pr-action-error"
          className="text-xs text-danger"
        >
          {errorText(approve.error ?? merge.error)}
        </p>
      ) : null}
    </section>
  );
}

/** How a workflow run is shown, reusing the checks' labels and colours. */
function runPresentation(run: GithubWorkflowRun): {
  label: I18nKey;
  tone: string;
  state: string;
} {
  if (run.needsApproval) {
    return {
      label: I18nKey.GITHUB$CHECK_ACTION_REQUIRED,
      tone: "text-danger",
      state: "action_required",
    };
  }
  if (run.running) {
    return {
      label: I18nKey.GITHUB$CHECK_PENDING,
      tone: "text-muted",
      state: "pending",
    };
  }
  if (run.failed) {
    return {
      label: I18nKey.GITHUB$CHECK_FAILURE,
      tone: "text-danger",
      state: "failure",
    };
  }
  if (run.conclusion === "success") {
    return {
      label: I18nKey.GITHUB$CHECK_SUCCESS,
      tone: "text-success",
      state: "success",
    };
  }
  return {
    label: I18nKey.GITHUB$CHECK_NEUTRAL,
    tone: "text-muted",
    state: "neutral",
  };
}

/**
 * GitHub Actions runs for the pull request's latest commit, with the ways to
 * move them along: approve a run held for a first-time contributor, re-run a
 * finished one, or re-run only its failed jobs.
 */
export function GithubPipelines({
  repository,
  sha,
}: {
  repository: string;
  sha: string | null;
}) {
  const { t } = useTranslation("openhands");
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGithubWorkflowRuns(repository, sha);

  const act = useMutation({
    mutationFn: ({
      run,
      kind,
    }: {
      run: GithubWorkflowRun;
      kind: "approve" | "rerun" | "rerun_failed";
    }) => {
      if (kind === "approve") {
        return GitProviderItemsService.approveGithubWorkflowRun(
          repository,
          run.id,
        );
      }
      return GitProviderItemsService.rerunGithubWorkflowRun(
        repository,
        run.id,
        kind === "rerun_failed",
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: GITHUB_WORK_ITEMS_QUERY_KEYS.all,
      }),
  });

  if (isLoading || !data) return null;

  return (
    <section
      aria-labelledby="github-pipelines-heading"
      data-testid="github-pipelines"
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      <h3
        id="github-pipelines-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$PIPELINES)}
      </h3>
      {data.length === 0 ? (
        <p className="text-xs text-muted">{t(I18nKey.GITHUB$PIPELINES_NONE)}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.map((run) => {
            const { label, tone, state } = runPresentation(run);
            return (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
              >
                <span
                  data-testid={`github-run-${run.id}`}
                  data-state={state}
                  className={cn("font-medium", tone)}
                >
                  {t(label)}
                </span>
                <span className="min-w-0 text-contrast wrap-anywhere">
                  {run.name}
                </span>
                {run.url ? (
                  <a
                    href={run.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted hover:text-contrast"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    <span className="sr-only">{run.name}</span>
                  </a>
                ) : null}
                <span className="ml-auto flex flex-wrap gap-2">
                  {run.needsApproval ? (
                    <BrandButton
                      type="button"
                      variant="primary"
                      testId={`github-run-approve-${run.id}`}
                      isDisabled={act.isPending}
                      onClick={() => act.mutate({ run, kind: "approve" })}
                    >
                      {t(I18nKey.GITHUB$PIPELINE_APPROVE)}
                    </BrandButton>
                  ) : null}
                  {!run.needsApproval && !run.running ? (
                    <BrandButton
                      type="button"
                      variant="secondary"
                      testId={`github-run-rerun-${run.id}`}
                      isDisabled={act.isPending}
                      onClick={() => act.mutate({ run, kind: "rerun" })}
                    >
                      {t(I18nKey.GITHUB$PIPELINE_RERUN)}
                    </BrandButton>
                  ) : null}
                  {run.failed ? (
                    <BrandButton
                      type="button"
                      variant="secondary"
                      testId={`github-run-rerun-failed-${run.id}`}
                      isDisabled={act.isPending}
                      onClick={() => act.mutate({ run, kind: "rerun_failed" })}
                    >
                      {t(I18nKey.GITHUB$PIPELINE_RERUN_FAILED)}
                    </BrandButton>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {act.isSuccess ? (
        <p data-testid="github-pipeline-done" className="text-xs text-success">
          {t(I18nKey.GITHUB$ACTION_DONE)}
        </p>
      ) : null}
      {act.isError ? (
        <p
          role="alert"
          data-testid="github-pipeline-error"
          className="text-xs text-danger"
        >
          {errorText(act.error)}
        </p>
      ) : null}
    </section>
  );
}
