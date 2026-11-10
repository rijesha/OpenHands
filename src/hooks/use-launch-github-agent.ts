import React from "react";
import { useTranslation } from "react-i18next";
import type { GithubWorkItemDetail } from "#/api/git-provider-items-service";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useNavigation } from "#/context/navigation-context";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import { useUpdateConversation } from "#/hooks/mutation/use-update-conversation";
import { useVmHarness } from "#/hooks/query/use-vm-harness";
import { useIsCreatingConversation } from "#/hooks/use-is-creating-conversation";
import { I18nKey } from "#/i18n/declaration";
import {
  buildGithubAgentPrompt,
  buildGithubConversationTitle,
  GITHUB_BRANCH_WORK_ACTIONS,
  type GithubAgentAction,
} from "#/utils/github-agent-prompts";
import { buildGuiVmPlugin, type GuiVmTarget } from "#/utils/gui-vm-launch";
import {
  githubRunKey,
  useGithubAgentRunsStore,
} from "#/stores/github-agent-runs-store";

const GITHUB_PAGE_ENTRY_POINT = "github_page";

const ACTION_TITLE_LABEL: Record<GithubAgentAction, I18nKey> = {
  work_on_issue: I18nKey.GITHUB$ACTION_WORK_ON_ISSUE,
  create_pull_request: I18nKey.GITHUB$ACTION_CREATE_PR,
  review_pull_request: I18nKey.GITHUB$ACTION_REVIEW_PR,
  address_review_comments: I18nKey.GITHUB$ACTION_ADDRESS_REVIEW,
  fix_failing_checks: I18nKey.GITHUB$ACTION_FIX_CHECKS,
};

/**
 * The branch a conversation should start on. A pull request opened from a
 * branch of the same repository starts on that branch; one from a fork keeps
 * the default branch, and the prompt fetches `pull/N/head` instead.
 */
function startBranch(
  action: GithubAgentAction,
  repository: string,
  item: GithubWorkItemDetail,
): string | undefined {
  const startsOnBranch =
    action === "review_pull_request" ||
    GITHUB_BRANCH_WORK_ACTIONS.includes(action);
  if (!startsOnBranch || !item.headRef) return undefined;
  return item.headRepository?.toLowerCase() === repository.toLowerCase()
    ? item.headRef
    : undefined;
}

/**
 * Starts an agent conversation for a GitHub issue or pull request and opens
 * it. Cloud sandboxes clone `selected_repository`; local backends do not, so
 * there the repository is left to the prompt's clone step (a local isolated
 * workspace also rejects a selected repository).
 *
 * With `guiVm`, the conversation also gets the VM harness plugin (its tools
 * exist only in conversations that opt in) and a verification step in the
 * prompt. The option is ignored when the backend has no harness.
 */
export function useLaunchGithubAgent() {
  const { backend } = useActiveBackend();
  const { navigate } = useNavigation();
  const { t } = useTranslation("openhands");
  const { mutate: createConversation } = useCreateConversation();
  const { mutate: renameConversation } = useUpdateConversation();
  const isCreatingConversation = useIsCreatingConversation();
  const { pluginPath: vmHarnessPluginPath } = useVmHarness();
  const recordRun = useGithubAgentRunsStore((state) => state.record);
  const [pendingAction, setPendingAction] =
    React.useState<GithubAgentAction | null>(null);

  const launch = React.useCallback(
    (
      action: GithubAgentAction,
      repository: string,
      item: GithubWorkItemDetail,
      options: { guiVm?: GuiVmTarget; instructions?: string } = {},
    ) => {
      const guiVm = vmHarnessPluginPath ? options.guiVm : undefined;
      const isCloud = backend.kind === "cloud";
      const branch = startBranch(action, repository, item);

      setPendingAction(action);
      createConversation(
        {
          query: buildGithubAgentPrompt(action, {
            repository,
            item,
            needsClone: !isCloud,
            guiVm,
            instructions: options.instructions,
          }),
          ...(guiVm && vmHarnessPluginPath
            ? { plugins: [buildGuiVmPlugin(vmHarnessPluginPath)] }
            : {}),
          ...(isCloud
            ? {
                repository: {
                  name: repository,
                  gitProvider: "github" as const,
                  ...(branch ? { branch } : {}),
                },
              }
            : {}),
          entryPoint: `${GITHUB_PAGE_ENTRY_POINT}_${action}`,
        },
        {
          onSuccess: (data) => {
            // Remember which item this run was for, so the GitHub page can
            // show its result next to the issue or pull request.
            recordRun(githubRunKey(backend.id, repository, item.number), {
              conversationId: data.conversation_id,
              action,
              startedAt: new Date().toISOString(),
            });
            // The first message starts the same way for every item, so the
            // automatic name tells them apart poorly: name it by repo and item.
            renameConversation({
              conversationId: data.conversation_id,
              newTitle: buildGithubConversationTitle(
                repository,
                item,
                t(ACTION_TITLE_LABEL[action]),
              ),
            });
            navigate(`/conversations/${data.conversation_id}`);
          },
          onSettled: () => setPendingAction(null),
        },
      );
    },
    [
      backend.id,
      backend.kind,
      createConversation,
      navigate,
      recordRun,
      renameConversation,
      t,
      vmHarnessPluginPath,
    ],
  );

  return {
    launch,
    pendingAction,
    isLaunching: isCreatingConversation,
  };
}
