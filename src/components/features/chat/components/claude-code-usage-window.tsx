import { useTranslation } from "react-i18next";
import type { ClaudeCodeUsageWindow } from "#/api/claude-code-usage";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

export function UsageWindow({
  label,
  window: usageWindow,
  checkedAt,
  testId,
}: {
  label: string;
  window: ClaudeCodeUsageWindow;
  /** When the usage was last read (ms). */
  checkedAt: number;
  testId: string;
}) {
  const { t, i18n } = useTranslation("openhands");
  // A window that has reset since Claude Code last reported is empty again.
  const hasReset =
    usageWindow.resetsAt !== null && usageWindow.resetsAt * 1000 <= checkedAt;
  const percent = hasReset ? 0 : Math.round(usageWindow.usedPercentage);
  const resets =
    usageWindow.resetsAt === null
      ? null
      : new Date(usageWindow.resetsAt * 1000).toLocaleString(i18n.language, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        });

  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-contrast">{label}</span>
        <span className="text-muted">
          {hasReset || !resets
            ? t(I18nKey.CLAUDE_CODE$USAGE_WINDOW_RESET)
            : t(I18nKey.CLAUDE_CODE$USAGE_LINE, { percent, time: resets })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-interactive-selected"
      >
        <div
          className={cn(
            "h-full rounded-full",
            percent >= 90 ? "bg-danger" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
