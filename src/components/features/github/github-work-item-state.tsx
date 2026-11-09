import {
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GithubWorkItem } from "#/api/git-provider-items-service";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

type GithubWorkItemDisplayState = "open" | "closed" | "merged" | "draft";

interface DisplayStateConfig {
  label: I18nKey;
  className: string;
  issueIcon: LucideIcon;
  pullRequestIcon: LucideIcon;
}

const DISPLAY_STATES: Record<GithubWorkItemDisplayState, DisplayStateConfig> = {
  open: {
    label: I18nKey.GITHUB$STATE_OPEN,
    className: "text-success",
    issueIcon: CircleDot,
    pullRequestIcon: GitPullRequest,
  },
  draft: {
    label: I18nKey.GITHUB$STATE_DRAFT,
    className: "text-muted",
    issueIcon: CircleDot,
    pullRequestIcon: GitPullRequestDraft,
  },
  merged: {
    label: I18nKey.GITHUB$STATE_MERGED,
    className: "text-primary",
    issueIcon: CircleCheck,
    pullRequestIcon: GitMerge,
  },
  closed: {
    label: I18nKey.GITHUB$STATE_CLOSED,
    className: "text-danger",
    issueIcon: CircleCheck,
    pullRequestIcon: GitPullRequestClosed,
  },
};

function getDisplayState(
  item: Pick<GithubWorkItem, "state" | "merged" | "draft">,
): GithubWorkItemDisplayState {
  if (item.merged) return "merged";
  if (item.state === "closed") return "closed";
  if (item.draft) return "draft";
  return "open";
}

interface GithubWorkItemStateProps {
  item: Pick<GithubWorkItem, "kind" | "state" | "merged" | "draft">;
  /** Icon only (list rows) or icon plus label (detail header). */
  variant: "icon" | "badge";
  className?: string;
}

export function GithubWorkItemState({
  item,
  variant,
  className,
}: GithubWorkItemStateProps) {
  const { t } = useTranslation("openhands");
  const displayState = getDisplayState(item);
  const config = DISPLAY_STATES[displayState];
  const Icon =
    item.kind === "pull_request" ? config.pullRequestIcon : config.issueIcon;
  const label = t(config.label);

  if (variant === "icon") {
    return (
      <Icon
        className={cn("size-4 shrink-0", config.className, className)}
        aria-label={label}
        role="img"
      />
    );
  }

  return (
    <span
      data-testid="github-work-item-state"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium",
        config.className,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
