import React from "react";
import type { GithubWorkItemDetail } from "#/api/git-provider-items-service";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useNavigation } from "#/context/navigation-context";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import { useIsCreatingConversation } from "#/hooks/use-is-creating-conversation";
import {
  buildGithubAgentPrompt,
  type GithubAgentAction,
} from "#/utils/github-agent-prompts";

const GITHUB_PAGE_ENTRY_POINT = "github_page";

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
  if (action !== "review_pull_request" || !item.headRef) return undefined;
  return item.headRepository?.toLowerCase() === repository.toLowerCase()
    ? item.headRef
    : undefined;
}

/**
 * Starts an agent conversation for a GitHub issue or pull request and opens
 * it. Cloud sandboxes clone `selected_repository`; local backends do not, so
 * there the repository is left to the prompt's clone step (a local isolated
 * workspace also rejects a selected repository).
 */
export function useLaunchGithubAgent() {
  const { backend } = useActiveBackend();
  const { navigate } = useNavigation();
  const { mutate: createConversation } = useCreateConversation();
  const isCreatingConversation = useIsCreatingConversation();
  const [pendingAction, setPendingAction] =
    React.useState<GithubAgentAction | null>(null);

  const launch = React.useCallback(
    (
      action: GithubAgentAction,
      repository: string,
      item: GithubWorkItemDetail,
    ) => {
      const isCloud = backend.kind === "cloud";
      const branch = startBranch(action, repository, item);

      setPendingAction(action);
      createConversation(
        {
          query: buildGithubAgentPrompt(action, {
            repository,
            item,
            needsClone: !isCloud,
          }),
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
          onSuccess: (data) =>
            navigate(`/conversations/${data.conversation_id}`),
          onSettled: () => setPendingAction(null),
        },
      );
    },
    [backend.kind, createConversation, navigate],
  );

  return {
    launch,
    pendingAction,
    isLaunching: isCreatingConversation,
  };
}
