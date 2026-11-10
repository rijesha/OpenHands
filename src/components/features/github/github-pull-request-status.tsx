import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  GithubCheckState,
  GithubWorkItemKind,
} from "#/api/git-provider-items-service";
import { MarkdownRenderer } from "#/components/features/markdown/markdown-renderer";
import {
  useGithubChangedFiles,
  useGithubChecks,
  useGithubDiscussion,
} from "#/hooks/query/use-github-work-items";
import { I18nKey } from "#/i18n/declaration";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { cn } from "#/utils/utils";
import React from "react";

const CHECK_LABEL: Record<GithubCheckState, I18nKey> = {
  success: I18nKey.GITHUB$CHECK_SUCCESS,
  failure: I18nKey.GITHUB$CHECK_FAILURE,
  pending: I18nKey.GITHUB$CHECK_PENDING,
  action_required: I18nKey.GITHUB$CHECK_ACTION_REQUIRED,
  neutral: I18nKey.GITHUB$CHECK_NEUTRAL,
};

const CHECK_TONE: Record<GithubCheckState, string> = {
  success: "text-success",
  failure: "text-danger",
  pending: "text-muted",
  action_required: "text-danger",
  neutral: "text-muted",
};

const REVIEW_LABEL: Record<string, I18nKey> = {
  APPROVED: I18nKey.GITHUB$REVIEW_APPROVED,
  CHANGES_REQUESTED: I18nKey.GITHUB$REVIEW_CHANGES_REQUESTED,
  COMMENTED: I18nKey.GITHUB$REVIEW_COMMENTED,
};

/** Entries shown before "Show all". */
const DISCUSSION_PREVIEW = 6;

/**
 * CI checks of a pull request's latest commit. Failing checks come first, and
 * a run held for approval (common on first-time contributors' pull requests)
 * is told apart from a failure. A load failure hides the section.
 */
export function GithubChecks({
  repository,
  sha,
}: {
  repository: string;
  sha: string | null;
}) {
  const { t } = useTranslation("openhands");
  const { data, isLoading } = useGithubChecks(repository, sha);

  if (isLoading || !data) return null;

  return (
    <section
      aria-labelledby="github-checks-heading"
      data-testid="github-checks"
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      <h3
        id="github-checks-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$CHECKS)}
      </h3>
      {data.checks.length === 0 ? (
        <p className="text-xs text-muted">{t(I18nKey.GITHUB$CHECKS_NONE)}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.checks.map((check) => (
            <li
              key={check.name}
              className="flex flex-wrap items-center gap-x-3 text-xs"
            >
              <span
                data-testid={`github-check-${check.name}`}
                data-state={check.state}
                className={cn("font-medium", CHECK_TONE[check.state])}
              >
                {t(CHECK_LABEL[check.state])}
              </span>
              <span className="min-w-0 text-contrast wrap-anywhere">
                {check.name}
              </span>
              {check.url ? (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-muted hover:text-contrast"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  <span className="sr-only">{check.name}</span>
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Comments, reviews and line comments of an issue or pull request. */
export function GithubDiscussion({
  repository,
  kind,
  number,
}: {
  repository: string;
  kind: GithubWorkItemKind;
  number: number;
}) {
  const { t, i18n } = useTranslation("openhands");
  const { data, isLoading } = useGithubDiscussion(repository, kind, number);
  const [showAll, setShowAll] = React.useState(false);

  if (isLoading || !data) return null;

  // The newest entries matter most; older ones stay one click away.
  const hidden = showAll ? 0 : Math.max(0, data.length - DISCUSSION_PREVIEW);
  const entries = data.slice(hidden);

  return (
    <section
      aria-labelledby="github-discussion-heading"
      data-testid="github-discussion"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h3
        id="github-discussion-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$DISCUSSION)}
      </h3>
      {data.length === 0 ? (
        <p className="text-xs text-muted">
          {t(I18nKey.GITHUB$DISCUSSION_NONE)}
        </p>
      ) : null}
      {hidden > 0 ? (
        <button
          type="button"
          data-testid="github-discussion-show-all"
          onClick={() => setShowAll(true)}
          className="self-start text-xs text-muted underline hover:text-contrast"
        >
          {t(I18nKey.GITHUB$SHOW_ALL_ENTRIES, { total: data.length })}
        </button>
      ) : null}
      {entries.map((entry) => (
        <article
          key={entry.id}
          data-testid={`github-discussion-${entry.id}`}
          className="flex min-w-0 flex-col gap-1 border-l-2 border-border pl-3"
        >
          <header className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span className="font-medium text-contrast">
              {entry.authorLogin ?? ""}
            </span>
            {entry.reviewState && REVIEW_LABEL[entry.reviewState] ? (
              <span
                className={cn(
                  entry.reviewState === "CHANGES_REQUESTED" && "text-danger",
                  entry.reviewState === "APPROVED" && "text-success",
                )}
              >
                {t(REVIEW_LABEL[entry.reviewState])}
              </span>
            ) : null}
            {entry.path ? (
              <span className="font-mono wrap-anywhere">{entry.path}</span>
            ) : null}
            {entry.createdAt ? (
              <span>
                {formatRelativeTime(entry.createdAt, i18n.language, t)}
              </span>
            ) : null}
            {entry.url ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto hover:text-contrast"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                <span className="sr-only">{entry.authorLogin ?? ""}</span>
              </a>
            ) : null}
          </header>
          {entry.body.trim() ? (
            <div className="min-w-0 overflow-x-auto text-sm text-contrast">
              <MarkdownRenderer includeStandard>{entry.body}</MarkdownRenderer>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}

/** Files a pull request changes, with their line counts. */
export function GithubChangedFiles({
  repository,
  number,
}: {
  repository: string;
  number: number;
}) {
  const { t } = useTranslation("openhands");
  const { data, isLoading } = useGithubChangedFiles(repository, number);

  if (isLoading || !data || data.length === 0) return null;

  return (
    <section
      aria-labelledby="github-files-heading"
      data-testid="github-changed-files"
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      <h3
        id="github-files-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$CHANGED_FILES)}
      </h3>
      <ul className="flex max-h-64 flex-col gap-1 overflow-auto custom-scrollbar">
        {data.map((file) => (
          <li
            key={file.filename}
            className="flex flex-wrap items-baseline gap-x-3 text-xs"
          >
            <span className="min-w-0 flex-1 font-mono text-contrast wrap-anywhere">
              {file.filename}
            </span>
            <span className="tabular-nums">
              <span className="text-success">
                {t(I18nKey.CONVERSATION$OVERVIEW_DIFF_ADDITIONS, {
                  count: file.additions,
                })}
              </span>{" "}
              <span className="text-danger">
                {t(I18nKey.CONVERSATION$OVERVIEW_DIFF_DELETIONS, {
                  count: file.deletions,
                })}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
