import { useTranslation } from "react-i18next";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffort,
} from "#/api/claude-code-effort";
import {
  useClaudeCodeEffort,
  useClaudeCodeUsage,
} from "#/hooks/use-claude-code-controls";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";
import { UsageWindow } from "./claude-code-usage-window";

const EFFORT_LABEL: Record<ClaudeCodeEffort, I18nKey> = {
  low: I18nKey.CLAUDE_CODE$EFFORT_LOW,
  medium: I18nKey.CLAUDE_CODE$EFFORT_MEDIUM,
  high: I18nKey.CLAUDE_CODE$EFFORT_HIGH,
  xhigh: I18nKey.CLAUDE_CODE$EFFORT_XHIGH,
  max: I18nKey.CLAUDE_CODE$EFFORT_MAX,
};

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-2xs font-medium uppercase leading-4 tracking-wide text-text-dim">
      {children}
    </span>
  );
}

/**
 * Claude Code's effort level and remaining usage limits, in the model menu.
 * Both live on the agent-server's machine, so they are offered on a local
 * backend only.
 */
export function ClaudeCodeControls() {
  const { t } = useTranslation("openhands");
  const { isLocal, usage, checkedAt, isLoading, install } =
    useClaudeCodeUsage(true);
  const { effort, setEffort } = useClaudeCodeEffort(isLocal);

  if (!isLocal) return null;

  const levels: Array<{ level: ClaudeCodeEffort | null; label: I18nKey }> = [
    { level: null, label: I18nKey.CLAUDE_CODE$EFFORT_DEFAULT },
    ...CLAUDE_CODE_EFFORT_LEVELS.map((level) => ({
      level,
      label: EFFORT_LABEL[level],
    })),
  ];

  return (
    <li
      role="presentation"
      data-testid="claude-code-controls"
      className="flex flex-col gap-3 border-t border-border px-2 py-2"
    >
      <div className="flex flex-col gap-1.5">
        <SectionLabel>{t(I18nKey.CLAUDE_CODE$EFFORT_LABEL)}</SectionLabel>
        <div
          role="group"
          aria-label={t(I18nKey.CLAUDE_CODE$EFFORT_LABEL)}
          className="flex flex-wrap gap-1"
        >
          {levels.map(({ level, label }) => (
            <button
              key={level ?? "default"}
              type="button"
              data-testid={`claude-code-effort-${level ?? "default"}`}
              aria-pressed={effort === level}
              disabled={setEffort.isPending}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (effort !== level) setEffort.mutate(level);
              }}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs transition-colors",
                effort === level
                  ? "border-primary bg-interactive-selected text-contrast"
                  : "border-border text-muted hover:text-contrast",
              )}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <span className="text-2xs text-muted">
          {setEffort.isError
            ? t(I18nKey.CLAUDE_CODE$EFFORT_ERROR)
            : t(I18nKey.CLAUDE_CODE$EFFORT_HINT)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>{t(I18nKey.CLAUDE_CODE$USAGE_LABEL)}</SectionLabel>
        {usage ? (
          <>
            {usage.fiveHour ? (
              <UsageWindow
                testId="claude-code-usage-five-hour"
                label={t(I18nKey.CLAUDE_CODE$USAGE_FIVE_HOUR)}
                window={usage.fiveHour}
                checkedAt={checkedAt}
              />
            ) : null}
            {usage.sevenDay ? (
              <UsageWindow
                testId="claude-code-usage-weekly"
                label={t(I18nKey.CLAUDE_CODE$USAGE_WEEKLY)}
                window={usage.sevenDay}
                checkedAt={checkedAt}
              />
            ) : null}
          </>
        ) : isLoading ? null : (
          <>
            <span className="text-2xs text-muted">
              {install.data === "installed"
                ? t(I18nKey.CLAUDE_CODE$USAGE_INSTALLED)
                : install.data === "occupied"
                  ? t(I18nKey.CLAUDE_CODE$USAGE_OCCUPIED)
                  : install.isError
                    ? t(I18nKey.CLAUDE_CODE$USAGE_ERROR)
                    : t(I18nKey.CLAUDE_CODE$USAGE_SETUP_HINT)}
            </span>
            {install.data === "installed" ||
            install.data === "occupied" ? null : (
              <button
                type="button"
                data-testid="claude-code-usage-setup"
                disabled={install.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  install.mutate();
                }}
                className="self-start rounded-md border border-border px-2 py-0.5 text-xs text-contrast transition-colors hover:bg-interactive-hover"
              >
                {t(I18nKey.CLAUDE_CODE$USAGE_SETUP)}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
