import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CLAUDE_CODE_EFFORT_SECRET,
  effortFromSecrets,
  effortSecretDescription,
  type ClaudeCodeEffort,
} from "#/api/claude-code-effort";
import {
  installClaudeCodeStatusline,
  readClaudeCodeUsage,
} from "#/api/claude-code-usage";
import { SecretsService } from "#/api/secrets-service";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useSearchSecrets } from "#/hooks/query/use-get-secrets";
import { useBashCommandRunner } from "#/hooks/use-bash-command-runner";
import { useClaudeCodeUsageSetupStore } from "#/stores/claude-code-usage-setup-store";

const USAGE_REFRESH_MS = 60_000;

/** The effort level saved for new Claude Code conversations, and how to change it. */
export function useClaudeCodeEffort(enabled: boolean) {
  const queryClient = useQueryClient();
  const { data: secrets, isLoading } = useSearchSecrets({ enabled });

  const setEffort = useMutation({
    mutationFn: async (level: ClaudeCodeEffort | null) => {
      if (level === null) {
        await SecretsService.deleteSecret(CLAUDE_CODE_EFFORT_SECRET);
      } else {
        await SecretsService.createSecret(
          CLAUDE_CODE_EFFORT_SECRET,
          level,
          effortSecretDescription(level),
        );
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["secrets"] }),
    meta: { disableToast: true },
  });

  return {
    effort: effortFromSecrets(secrets),
    isLoading,
    setEffort,
  };
}

/**
 * Claude Code's remaining usage limits, as its status line helper reported
 * them, and the one-click setup of that helper. Local backends only: the file
 * lives on the agent-server's machine.
 */
export function useClaudeCodeUsage(enabled: boolean) {
  const { backend } = useActiveBackend();
  const isLocal = backend.kind === "local";
  const active = enabled && isLocal;
  const queryClient = useQueryClient();
  const recordSetup = useClaudeCodeUsageSetupStore((state) => state.record);
  const setupOutcome = useClaudeCodeUsageSetupStore(
    (state) => state.outcomes[backend.id] ?? null,
  );
  const run = useBashCommandRunner(undefined, undefined, active);
  const runRef = React.useRef(run);
  runRef.current = run;

  const usage = useQuery({
    queryKey: ["claude-code-usage", backend.id],
    queryFn: () =>
      readClaudeCodeUsage((command, cwd, timeout) =>
        runRef.current(command, cwd, timeout),
      ),
    enabled: active,
    refetchInterval: USAGE_REFRESH_MS,
    retry: false,
    meta: { disableToast: true },
  });

  const install = useMutation({
    mutationFn: () =>
      installClaudeCodeStatusline((command, cwd, timeout) =>
        runRef.current(command, cwd, timeout),
      ),
    onSuccess: (outcome) => {
      recordSetup(backend.id, outcome);
      return queryClient.invalidateQueries({ queryKey: ["claude-code-usage"] });
    },
    meta: { disableToast: true },
  });

  return {
    isLocal,
    /** What setting up the helper came to on this backend, if it was tried. */
    setupOutcome,
    usage: usage.data ?? null,
    /** When the usage was last read (ms): the clock the windows are judged against. */
    checkedAt: usage.dataUpdatedAt,
    isLoading: usage.isLoading,
    install,
  };
}
