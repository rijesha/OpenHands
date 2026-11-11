import { FolderGit2, Folder, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { BrandButton } from "#/components/features/settings/brand-button";
import { FolderBrowserModal } from "#/components/features/home/workspace-dropdown/folder-browser-modal";
import { useNavigation } from "#/context/navigation-context";
import { useActiveBackend } from "#/contexts/active-backend-context";
import {
  useAddWorkspaceParents,
  useAddWorkspaces,
  useRemoveWorkspace,
} from "#/hooks/mutation/use-local-workspaces-mutations";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import { useProjects, type Project } from "#/hooks/query/use-projects";
import { useIsCreatingConversation } from "#/hooks/use-is-creating-conversation";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";
import { CloneProjectDialog } from "./clone-project-dialog";

type ProjectFilter = "all" | "git" | "local";

const FILTERS: ReadonlyArray<{ value: ProjectFilter; label: I18nKey }> = [
  { value: "all", label: I18nKey.PROJECTS$FILTER_ALL },
  { value: "git", label: I18nKey.PROJECTS$GIT },
  { value: "local", label: I18nKey.PROJECTS$FILTER_LOCAL },
];

function matches(project: Project, filter: ProjectFilter): boolean {
  if (filter === "git") return project.isGit;
  if (filter === "local") return !project.isGit;
  return true;
}

/** Projects in groups: saved ones first, then those found under each saved parent folder. */
function groupProjects(
  projects: Project[],
  savedLabel: string,
): Array<{ key: string; label: string; projects: Project[] }> {
  const groups = new Map<
    string,
    { key: string; label: string; projects: Project[] }
  >();
  projects.forEach((project) => {
    const key = project.parent?.path ?? "";
    const group = groups.get(key) ?? {
      key,
      label: project.parent?.name ?? savedLabel,
      projects: [],
    };
    group.projects.push(project);
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => {
    if (a.key === "") return -1;
    if (b.key === "") return 1;
    return a.label.localeCompare(b.label);
  });
}

function ProjectRow({
  project,
  isBusy,
  onStart,
  onOpenGithub,
  onRemove,
}: {
  project: Project;
  isBusy: boolean;
  onStart: () => void;
  onOpenGithub: () => void;
  onRemove: (() => void) | null;
}) {
  const { t } = useTranslation("openhands");
  const { workspace } = project;
  const hasGithub = project.provider === "github" && !!project.repository;

  return (
    <li
      data-testid={`project-${workspace.path}`}
      data-kind={project.isGit ? "git" : "local"}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
    >
      {project.isGit ? (
        <FolderGit2 className="size-5 shrink-0 text-primary" aria-hidden />
      ) : (
        <Folder className="size-5 shrink-0 text-muted" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-contrast">
          <span className="wrap-anywhere">{workspace.name}</span>
          <span
            data-testid="project-badge"
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-normal",
              project.isGit
                ? "border-primary text-primary"
                : "border-border text-muted",
            )}
          >
            {project.isGit
              ? t(I18nKey.PROJECTS$GIT)
              : t(I18nKey.PROJECTS$BADGE_LOCAL)}
          </span>
        </span>
        <span className="truncate text-xs text-muted" title={workspace.path}>
          {workspace.path}
        </span>
        {project.isGit ? (
          <span className="flex flex-wrap gap-x-3 text-xs text-muted">
            <span>{project.repository ?? t(I18nKey.PROJECTS$NO_REMOTE)}</span>
            {project.branch ? <span>{project.branch}</span> : null}
            {project.dirtyCount > 0 ? (
              <span className="text-danger">
                {t(I18nKey.PROJECTS$DIRTY, { count: project.dirtyCount })}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <BrandButton
          type="button"
          variant="primary"
          testId={`project-start-${workspace.path}`}
          isDisabled={isBusy}
          onClick={onStart}
        >
          {t(I18nKey.PROJECTS$START)}
        </BrandButton>
        {hasGithub ? (
          <BrandButton
            type="button"
            variant="secondary"
            testId={`project-github-${workspace.path}`}
            onClick={onOpenGithub}
          >
            {t(I18nKey.PROJECTS$OPEN_GITHUB)}
          </BrandButton>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            data-testid={`project-remove-${workspace.path}`}
            aria-label={t(I18nKey.PROJECTS$REMOVE, { name: workspace.name })}
            title={t(I18nKey.PROJECTS$REMOVE, { name: workspace.name })}
            onClick={onRemove}
            className="rounded p-1 text-muted hover:text-contrast"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * What the agent can work on, on this machine: the saved folders and those
 * found under saved parent folders, each marked as plain local files or a git
 * work tree, with ways to start work in one, open its GitHub items, add a
 * folder, or clone a repository.
 */
export function ProjectsPage() {
  const { t } = useTranslation("openhands");
  const { backend } = useActiveBackend();
  const { navigate } = useNavigation();
  const { projects, isLoading, isProbing } = useProjects();
  const { mutate: addWorkspaces } = useAddWorkspaces();
  const { mutate: addWorkspaceParents } = useAddWorkspaceParents();
  const { mutate: removeWorkspace } = useRemoveWorkspace();
  const { mutate: createConversation, isPending } = useCreateConversation();
  const isCreatingElsewhere = useIsCreatingConversation();
  const [filter, setFilter] = React.useState<ProjectFilter>("all");
  const [isBrowsing, setIsBrowsing] = React.useState(false);
  const [isCloning, setIsCloning] = React.useState(false);

  const visible = projects.filter((project) => matches(project, filter));
  const groups = groupProjects(visible, t(I18nKey.PROJECTS$GROUP_SAVED));

  const start = (path: string) =>
    createConversation(
      { workingDir: path, entryPoint: "projects_page" },
      {
        onSuccess: (data) => navigate(`/conversations/${data.conversation_id}`),
      },
    );

  return (
    <div data-testid="projects-page" className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 basis-72">
            <h1 className="text-xl font-semibold text-content">
              {t(I18nKey.PROJECTS$PAGE_TITLE)}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t(I18nKey.PROJECTS$PAGE_SUBTITLE)}
            </p>
          </div>
          {backend.kind === "local" ? (
            <div className="flex flex-wrap gap-2">
              <BrandButton
                type="button"
                variant="secondary"
                testId="projects-add"
                onClick={() => setIsBrowsing(true)}
              >
                {t(I18nKey.PROJECTS$ADD)}
              </BrandButton>
              <BrandButton
                type="button"
                variant="primary"
                testId="projects-clone"
                onClick={() => setIsCloning(true)}
              >
                {t(I18nKey.PROJECTS$CLONE)}
              </BrandButton>
            </div>
          ) : null}
        </header>

        {backend.kind !== "local" ? (
          <p
            data-testid="projects-local-only"
            className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted"
          >
            {t(I18nKey.PROJECTS$LOCAL_ONLY)}
          </p>
        ) : (
          <>
            <div
              role="group"
              aria-label={t(I18nKey.PROJECTS$PAGE_TITLE)}
              className="inline-flex self-start rounded-lg border border-border p-0.5"
            >
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`projects-filter-${option.value}`}
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs transition-colors",
                    filter === option.value
                      ? "bg-interactive-selected text-contrast"
                      : "text-muted hover:text-contrast",
                  )}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>

            {isLoading ? (
              <p className="py-8 text-center text-sm text-muted">
                {t(I18nKey.HOME$LOADING)}
              </p>
            ) : null}

            {!isLoading && groups.length === 0 ? (
              <p
                data-testid="projects-empty"
                className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted"
              >
                {t(I18nKey.PROJECTS$EMPTY)}
              </p>
            ) : null}

            {isProbing ? (
              <p role="status" className="text-xs text-muted">
                {t(I18nKey.HOME$LOADING)}
              </p>
            ) : null}

            {groups.map((group) => (
              <section
                key={group.key}
                aria-label={group.label}
                data-testid={`projects-group-${group.key || "saved"}`}
                className="flex flex-col gap-2"
              >
                <h2 className="text-sm font-semibold text-contrast">
                  {group.label}
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {group.projects.map((project) => (
                    <ProjectRow
                      key={project.workspace.id}
                      project={project}
                      isBusy={isPending || isCreatingElsewhere}
                      onStart={() => start(project.workspace.path)}
                      onOpenGithub={() =>
                        navigate(
                          `/github?repo=${encodeURIComponent(project.repository ?? "")}`,
                        )
                      }
                      // Folders found under a parent leave the list with the parent.
                      onRemove={
                        project.parent
                          ? null
                          : () => removeWorkspace(project.workspace.path)
                      }
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>

      <FolderBrowserModal
        isOpen={isBrowsing}
        onClose={() => setIsBrowsing(false)}
        onAdd={(items) => addWorkspaces(items)}
        onAddParent={(items) => addWorkspaceParents(items)}
      />
      <CloneProjectDialog
        isOpen={isCloning}
        onClose={() => setIsCloning(false)}
      />
    </div>
  );
}
