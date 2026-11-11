import React from "react";
import { useTranslation } from "react-i18next";
import { GitShipDialog } from "#/components/features/git/git-ship-dialog";
import { I18nKey } from "#/i18n/declaration";
import PRIcon from "#/icons/u-pr.svg?react";
import { useEventStore } from "#/stores/use-event-store";
import { analyzeAgentRun, parseShipPlan } from "#/utils/agent-run-result";
import {
  gitControlBarActionButtonClassName,
  gitControlBarActionIconColor,
  gitControlBarActionLabelClassName,
} from "#/utils/git-control-bar-classes";
import { cn } from "#/utils/utils";

/** The dialog, mounted only while open: it reads the whole event list for the agent's plan. */
function ConversationShipDialog({
  conversationId,
  repository,
  isAgentRunning,
  onClose,
}: {
  conversationId: string;
  repository: string | null;
  isAgentRunning: boolean;
  onClose: () => void;
}) {
  const events = useEventStore((state) => state.events);
  const plan = React.useMemo(() => {
    const { result } = analyzeAgentRun(events);
    return result ? parseShipPlan(result) : null;
  }, [events]);

  return (
    <GitShipDialog
      isOpen
      onClose={onClose}
      conversationId={conversationId}
      repository={repository}
      plan={plan}
      isAgentRunning={isAgentRunning}
    />
  );
}

interface GitControlBarShipButtonProps {
  conversationId: string;
  /** `owner/repo` when the remote is on GitHub, else `null` (commit and push only). */
  repository: string | null;
  isAgentRunning: boolean;
  isConversationReady?: boolean;
}

/**
 * Commits, pushes and opens a pull request in one dialog, for local
 * conversations: the user presses it instead of asking the model to.
 */
export function GitControlBarShipButton({
  conversationId,
  repository,
  isAgentRunning,
  isConversationReady = true,
}: GitControlBarShipButtonProps) {
  const { t } = useTranslation("openhands");
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        data-testid="git-control-bar-ship-button"
        onClick={() => setIsOpen(true)}
        disabled={!isConversationReady}
        className={cn(
          gitControlBarActionButtonClassName(isConversationReady),
          "h-7 min-w-31.5 px-2 py-1",
        )}
      >
        <div className="flex h-3 w-3 items-center justify-center">
          <PRIcon
            width={12}
            height={12}
            color={gitControlBarActionIconColor(isConversationReady)}
          />
        </div>
        <div
          className={cn(gitControlBarActionLabelClassName, "max-w-31.5")}
          title={t(I18nKey.GIT_SHIP$OPEN_BUTTON)}
        >
          {t(I18nKey.GIT_SHIP$OPEN_BUTTON)}
        </div>
      </button>
      {isOpen ? (
        <ConversationShipDialog
          conversationId={conversationId}
          repository={repository}
          isAgentRunning={isAgentRunning}
          onClose={() => setIsOpen(false)}
        />
      ) : null}
    </>
  );
}
