import { Gauge } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import type { ClaudeCodeUsageWindow } from "#/api/claude-code-usage";
import { UsageWindow } from "#/components/features/chat/components/claude-code-usage-window";
import { useClaudeCodeUsage } from "#/hooks/use-claude-code-controls";
import { useIsClaudeCodeUsed } from "#/hooks/use-is-claude-code-used";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

const percentOf = (window: ClaudeCodeUsageWindow, checkedAt: number) =>
  window.resetsAt !== null && window.resetsAt * 1000 <= checkedAt
    ? 0
    : Math.round(window.usedPercentage);

/**
 * Claude Code's remaining usage limits, always in the sidebar on a local
 * backend. When Claude Code is the agent in use, the helper that reports the
 * limits is set up by itself, once: until Claude Code's first message after
 * that, the meter says it is waiting. An existing status line of the user's is
 * never replaced, and the meter says so.
 */
export function SidebarClaudeCodeUsage({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation("openhands");
  const { isLocal, usage, checkedAt, isLoading, setupOutcome, install } =
    useClaudeCodeUsage(true);
  const isClaudeCodeUsed = useIsClaudeCodeUsed();

  const shouldSetUp =
    isLocal &&
    isClaudeCodeUsed &&
    !isLoading &&
    !usage &&
    setupOutcome === null &&
    install.isIdle;
  const { mutate: setUp } = install;
  React.useEffect(() => {
    if (shouldSetUp) setUp();
  }, [shouldSetUp, setUp]);

  if (!isLocal) return null;

  const label = t(I18nKey.CLAUDE_CODE$USAGE_LABEL);

  if (collapsed) {
    const windows = usage
      ? [usage.fiveHour, usage.sevenDay].filter(
          (window): window is ClaudeCodeUsageWindow => window !== null,
        )
      : [];
    const reading = [
      usage?.fiveHour
        ? `${t(I18nKey.CLAUDE_CODE$USAGE_FIVE_HOUR)} ${percentOf(usage.fiveHour, checkedAt)}%`
        : null,
      usage?.sevenDay
        ? `${t(I18nKey.CLAUDE_CODE$USAGE_WEEKLY)} ${percentOf(usage.sevenDay, checkedAt)}%`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    const title = reading ? `${label}: ${reading}` : label;
    return (
      <div
        data-testid="sidebar-claude-code-usage"
        role="img"
        aria-label={title}
        title={title}
        className="flex flex-col items-center gap-0.5 text-2xs tabular-nums"
      >
        {windows.length === 0 ? (
          <Gauge className="size-4 text-muted" aria-hidden />
        ) : (
          windows.map((window) => {
            const percent = percentOf(window, checkedAt);
            return (
              <span
                key={window.resetsAt ?? "none"}
                className={cn(percent >= 90 ? "text-danger" : "text-muted")}
              >
                {percent}%
              </span>
            );
          })
        )}
      </div>
    );
  }

  let status: React.ReactNode = null;
  if (!usage) {
    if (setupOutcome === "occupied") {
      status = t(I18nKey.CLAUDE_CODE$USAGE_OCCUPIED);
    } else if (install.isError) {
      status = (
        <>
          {t(I18nKey.CLAUDE_CODE$USAGE_ERROR)}{" "}
          <button
            type="button"
            data-testid="sidebar-claude-code-usage-retry"
            onClick={() => install.mutate()}
            className="underline"
          >
            {t(I18nKey.CLAUDE_CODE$USAGE_SETUP)}
          </button>
        </>
      );
    } else if (install.isPending || setupOutcome !== null || isClaudeCodeUsed) {
      status = t(I18nKey.CLAUDE_CODE$USAGE_WAITING);
    } else {
      status = (
        <>
          {t(I18nKey.CLAUDE_CODE$USAGE_NOT_USED)}{" "}
          <button
            type="button"
            data-testid="sidebar-claude-code-usage-setup"
            onClick={() => install.mutate()}
            className="underline"
          >
            {t(I18nKey.CLAUDE_CODE$USAGE_SETUP)}
          </button>
        </>
      );
    }
  }

  return (
    <div
      data-testid="sidebar-claude-code-usage"
      role="group"
      aria-label={label}
      className="flex flex-col gap-1.5 rounded-lg border border-border p-2"
    >
      {usage ? (
        <>
          {usage.fiveHour ? (
            <UsageWindow
              testId="sidebar-claude-code-usage-five-hour"
              label={t(I18nKey.CLAUDE_CODE$USAGE_FIVE_HOUR)}
              window={usage.fiveHour}
              checkedAt={checkedAt}
            />
          ) : null}
          {usage.sevenDay ? (
            <UsageWindow
              testId="sidebar-claude-code-usage-weekly"
              label={t(I18nKey.CLAUDE_CODE$USAGE_WEEKLY)}
              window={usage.sevenDay}
              checkedAt={checkedAt}
            />
          ) : null}
        </>
      ) : (
        <div className="flex items-start gap-2 text-xs text-muted">
          <Gauge className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span data-testid="sidebar-claude-code-usage-status">
            <span className="text-contrast">{label}. </span>
            {status}
          </span>
        </div>
      )}
    </div>
  );
}
