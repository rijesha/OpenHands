import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ClaudeCodeUsageWindow } from "#/api/claude-code-usage";
import { UsageWindow } from "#/components/features/chat/components/claude-code-usage-window";
import { useClaudeCodeUsage } from "#/hooks/use-claude-code-controls";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

const percentOf = (window: ClaudeCodeUsageWindow, checkedAt: number) =>
  window.resetsAt !== null && window.resetsAt * 1000 <= checkedAt
    ? 0
    : Math.round(window.usedPercentage);

/**
 * Claude Code's remaining usage limits, always in the sidebar on a local
 * backend, read live from the login Claude Code keeps on that machine.
 */
export function SidebarClaudeCodeUsage({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation("openhands");
  const { isLocal, usage, checkedAt } = useClaudeCodeUsage(true);

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
            {t(I18nKey.CLAUDE_CODE$USAGE_NOT_USED)}
          </span>
        </div>
      )}
    </div>
  );
}
