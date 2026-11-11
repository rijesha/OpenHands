import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useResolvedWorkspaces } from "#/hooks/query/use-resolved-workspaces";
import {
  useBashCommandRunner,
  type BashCommandRunner,
} from "#/hooks/use-bash-command-runner";
import type { LocalWorkspace, LocalWorkspaceParent } from "#/types/workspace";
import {
  buildProjectProbeCommand,
  LOCAL_ONLY_PROJECT,
  parseProjectProbe,
  type ProjectGitInfo,
} from "#/utils/project-git-info";

export interface Project extends ProjectGitInfo {
  workspace: LocalWorkspace;
  /** The saved parent folder this project was found under, if any. */
  parent: LocalWorkspaceParent | null;
}

const PROJECTS_STALE_TIME_MS = 30_000;

async function probe(
  run: BashCommandRunner,
  paths: string[],
): Promise<Record<string, ProjectGitInfo>> {
  const result = await run(buildProjectProbeCommand(paths), paths[0], 60);
  if (result.exit_code !== 0) return {};
  return parseProjectProbe(result.stdout);
}

/**
 * The folders the agent can work in on a local backend (saved workspaces and
 * the folders found under saved parents), each with whether it is a git work
 * tree and what its remote is. A failed probe still lists the folders, just
 * without git details.
 */
export function useProjects() {
  const { backend } = useActiveBackend();
  const isLocal = backend.kind === "local";
  const {
    workspaces,
    parents,
    isLoading: isLoadingWorkspaces,
  } = useResolvedWorkspaces();
  const paths = React.useMemo(
    () => workspaces.map((workspace) => workspace.path),
    [workspaces],
  );
  const run = useBashCommandRunner(undefined, undefined, isLocal);
  const runRef = React.useRef(run);
  runRef.current = run;

  const info = useQuery({
    queryKey: ["project-git-info", backend.id, paths],
    queryFn: () =>
      probe(
        (command, cwd, timeout) => runRef.current(command, cwd, timeout),
        paths,
      ),
    enabled: isLocal && paths.length > 0,
    staleTime: PROJECTS_STALE_TIME_MS,
    retry: false,
    meta: { disableToast: true },
  });

  const projects = React.useMemo<Project[]>(
    () =>
      workspaces.map((workspace) => ({
        ...(info.data?.[workspace.path] ?? LOCAL_ONLY_PROJECT),
        workspace,
        parent:
          parents.find((parent) => parent.path === workspace.parentPath) ??
          null,
      })),
    [workspaces, parents, info.data],
  );

  return {
    projects,
    isLoading: isLoadingWorkspaces,
    /** Git details are still being read. */
    isProbing: info.isFetching && !info.data,
    refetch: info.refetch,
  };
}
