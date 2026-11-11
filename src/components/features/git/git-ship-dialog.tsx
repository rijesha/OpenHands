import React from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  GitProviderApiError,
  GitProviderItemsService,
} from "#/api/git-provider-items-service";
import {
  isSafeBranchName,
  LocalGitError,
  LocalGitService,
} from "#/api/local-git-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { BaseModalTitle } from "#/components/shared/modals/confirmation-modals/base-modal";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalBody } from "#/components/shared/modals/modal-body";
import { ModalCloseButton } from "#/components/shared/modals/modal-close-button";
import { useUserConversation } from "#/hooks/query/use-user-conversation";
import { useBashCommandRunner } from "#/hooks/use-bash-command-runner";
import { I18nKey } from "#/i18n/declaration";
import type { ShipPlan } from "#/utils/agent-run-result";
import { formControlFieldClassName } from "#/utils/form-control-classes";
import { cn } from "#/utils/utils";

type StepId = "branch" | "commit" | "push" | "pull_request";
type StepState = "pending" | "running" | "done" | "failed";

const STEP_LABEL: Record<StepId, I18nKey> = {
  branch: I18nKey.GIT_SHIP$STEP_BRANCH,
  commit: I18nKey.GIT_SHIP$STEP_COMMIT,
  push: I18nKey.GIT_SHIP$STEP_PUSH,
  pull_request: I18nKey.GIT_SHIP$STEP_PR,
};

const MAX_LISTED_CHANGES = 12;

/** `agent/fix-the-login-redirect`: a branch name that is safe to hand to git. */
function suggestBranchName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `agent/${slug || "changes"}`;
}

export interface GitShipDialogProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  /** `owner/repo` on GitHub, which is what opening a pull request needs. */
  repository: string | null;
  /** What the agent prepared; the fields start from it and stay editable. */
  plan: ShipPlan | null;
  /** The issue this work resolves, so a pull request without a body still references it. */
  issueNumber?: number;
  /** The agent is mid-turn, so the workspace is still changing. */
  isAgentRunning?: boolean;
}

/**
 * Commits, pushes and (on GitHub) opens a pull request for the work a local
 * conversation did, without another model turn. Runs git in the conversation's
 * workspace and calls GitHub directly; each step shows its own result, and the
 * first failure stops the rest.
 */
export function GitShipDialog({
  isOpen,
  onClose,
  conversationId,
  repository,
  plan,
  issueNumber,
  isAgentRunning = false,
}: GitShipDialogProps) {
  const { t } = useTranslation("openhands");
  const { data: conversation } = useUserConversation(conversationId);
  const workingDir = conversation?.workspace?.working_dir?.trim() || null;
  const run = useBashCommandRunner(
    conversation?.conversation_url,
    conversation?.session_api_key,
    isOpen && !!workingDir,
    conversationId,
  );

  // The runner changes identity with the conversation's connection, which the
  // query key already covers through the conversation id.
  const runRef = React.useRef(run);
  runRef.current = run;

  const status = useQuery({
    queryKey: ["local-git-status", conversationId, workingDir],
    queryFn: () =>
      LocalGitService.status(
        (command, cwd, timeout) => runRef.current(command, cwd, timeout),
        workingDir!,
      ),
    enabled: isOpen && !!workingDir,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    meta: { disableToast: true },
  });
  const git = status.data;

  const [commitMessage, setCommitMessage] = React.useState("");
  const [openPr, setOpenPr] = React.useState(false);
  const [prTitle, setPrTitle] = React.useState("");
  const [prBody, setPrBody] = React.useState("");
  const [base, setBase] = React.useState("");
  const [newBranch, setNewBranch] = React.useState("");
  const [steps, setSteps] = React.useState<Partial<Record<StepId, StepState>>>(
    {},
  );
  const [failure, setFailure] = React.useState<string | null>(null);
  const [prUrl, setPrUrl] = React.useState<string | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);

  // Prefill once per open, from the agent's plan; edits are the user's.
  const prefilled = React.useRef(false);
  React.useEffect(() => {
    if (!isOpen) {
      prefilled.current = false;
      return;
    }
    if (prefilled.current || !git) return;
    prefilled.current = true;
    setCommitMessage(plan?.commitMessage ?? "");
    setOpenPr(!!repository && !!plan?.pullRequest);
    setPrTitle(plan?.pullRequest?.title ?? "");
    setPrBody(
      plan?.pullRequest?.body || (issueNumber ? `Fixes #${issueNumber}` : ""),
    );
    setBase(git.defaultBranch ?? "main");
    setNewBranch(suggestBranchName(plan?.pullRequest?.title ?? ""));
    setSteps({});
    setFailure(null);
    setPrUrl(null);
  }, [isOpen, git, plan, repository, issueNumber]);

  const hasChanges = (git?.changes.length ?? 0) > 0;
  const canPr = !!repository;
  const needsNewBranch =
    openPr && !!git && (git.branch === null || git.branch === base);
  const needsPush = hasChanges || !git?.upstream || (git?.ahead ?? 0) > 0;
  const plannedSteps = React.useMemo<StepId[]>(
    () => [
      ...(needsNewBranch ? (["branch"] as const) : []),
      ...(hasChanges ? (["commit"] as const) : []),
      ...(needsPush ? (["push"] as const) : []),
      ...(openPr ? (["pull_request"] as const) : []),
    ],
    [needsNewBranch, hasChanges, needsPush, openPr],
  );

  const isValid =
    !!git &&
    plannedSteps.length > 0 &&
    (!hasChanges || !!commitMessage.trim()) &&
    (!openPr || (!!prTitle.trim() && !!base.trim())) &&
    (!needsNewBranch || isSafeBranchName(newBranch));

  const submit = async () => {
    if (!git || !workingDir) return;
    setIsRunning(true);
    setFailure(null);
    setSteps(Object.fromEntries(plannedSteps.map((id) => [id, "pending"])));
    let current: StepId = plannedSteps[0];
    try {
      const mark = (id: StepId, state: StepState) =>
        setSteps((previous) => ({ ...previous, [id]: state }));
      let head = git.branch;
      for (const id of plannedSteps) {
        current = id;
        mark(id, "running");
        if (id === "branch") {
          await LocalGitService.createBranch(run, workingDir, newBranch);
          head = newBranch;
        } else if (id === "commit") {
          await LocalGitService.commitAll(run, workingDir, commitMessage);
        } else if (id === "push") {
          await LocalGitService.push(run, workingDir);
        } else if (repository && head) {
          const pr = await GitProviderItemsService.createGithubPullRequest(
            repository,
            {
              title: prTitle.trim(),
              body: prBody.trim(),
              head,
              base: base.trim(),
            },
          );
          setPrUrl(pr.url);
        }
        mark(id, "done");
      }
    } catch (error) {
      setSteps((previous) => ({ ...previous, [current]: "failed" }));
      if (error instanceof GitProviderApiError) {
        setFailure(t(I18nKey.GIT_SHIP$PR_ERROR, { status: error.status }));
      } else {
        setFailure(
          t(I18nKey.GIT_SHIP$STEP_FAILED, {
            step: t(STEP_LABEL[current]),
            message:
              error instanceof LocalGitError || error instanceof Error
                ? error.message
                : String(error),
          }),
        );
      }
    } finally {
      setIsRunning(false);
      status.refetch();
    }
  };

  if (!isOpen) return null;

  const finished =
    plannedSteps.length > 0 && plannedSteps.every((id) => steps[id] === "done");

  return (
    <ModalBackdrop onClose={isRunning ? undefined : onClose}>
      <ModalBody
        width="md"
        className="relative items-start border border-border !gap-4"
        testID="git-ship-dialog"
      >
        <ModalCloseButton
          onClose={onClose}
          disabled={isRunning}
          testId="git-ship-close"
        />
        <div className="w-full pr-6">
          <BaseModalTitle title={t(I18nKey.GIT_SHIP$TITLE)} />
        </div>

        {isAgentRunning ? (
          <p role="status" className="text-sm text-danger">
            {t(I18nKey.GIT_SHIP$AGENT_RUNNING)}
          </p>
        ) : null}

        {status.isLoading ? (
          <p className="text-sm text-muted">{t(I18nKey.HOME$LOADING)}</p>
        ) : null}

        {status.isError || (status.isSuccess && !git) ? (
          <p role="alert" className="text-sm text-danger">
            {t(I18nKey.GIT_SHIP$NOT_A_REPOSITORY)}
          </p>
        ) : null}

        {git ? (
          <div className="flex w-full flex-col gap-4">
            <p
              data-testid="git-ship-state"
              className="text-xs text-muted wrap-anywhere"
            >
              {t(I18nKey.GIT_SHIP$STATE, {
                branch: git.branch ?? "HEAD",
                ahead: git.ahead,
              })}
            </p>

            {hasChanges ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-contrast">
                  {t(I18nKey.GIT_SHIP$FILES_TO_COMMIT, {
                    count: git.changes.length,
                  })}
                </span>
                <ul
                  data-testid="git-ship-changes"
                  className="max-h-32 overflow-y-auto rounded-md border border-border p-2 font-mono text-xs text-muted"
                >
                  {git.changes.slice(0, MAX_LISTED_CHANGES).map((change) => (
                    <li key={change.path} className="wrap-anywhere">
                      <span className="mr-2 inline-block w-5 text-contrast">
                        {change.status}
                      </span>
                      {change.path}
                    </li>
                  ))}
                  {git.changes.length > MAX_LISTED_CHANGES ? <li>…</li> : null}
                </ul>
                <label
                  htmlFor="git-ship-commit-message"
                  className="mt-1 text-xs font-medium text-contrast"
                >
                  {t(I18nKey.GIT_SHIP$COMMIT_MESSAGE)}
                </label>
                <textarea
                  id="git-ship-commit-message"
                  data-testid="git-ship-commit-message"
                  rows={3}
                  value={commitMessage}
                  disabled={isRunning}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  className={cn(formControlFieldClassName, "font-mono text-xs")}
                />
              </div>
            ) : (
              <p className="text-sm text-muted">
                {t(I18nKey.GIT_SHIP$NOTHING_TO_COMMIT)}
              </p>
            )}

            {canPr ? (
              <div className="flex flex-col gap-2">
                <label className="inline-flex items-center gap-2 text-sm text-contrast">
                  <input
                    type="checkbox"
                    data-testid="git-ship-open-pr"
                    checked={openPr}
                    disabled={isRunning}
                    onChange={(event) => setOpenPr(event.target.checked)}
                  />
                  {t(I18nKey.GIT_SHIP$OPEN_PR_OPTION)}
                </label>
                {openPr ? (
                  <>
                    {needsNewBranch ? (
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor="git-ship-new-branch"
                          className="text-xs font-medium text-contrast"
                        >
                          {t(I18nKey.GIT_SHIP$NEW_BRANCH)}
                        </label>
                        <input
                          id="git-ship-new-branch"
                          data-testid="git-ship-new-branch"
                          value={newBranch}
                          disabled={isRunning}
                          aria-invalid={!isSafeBranchName(newBranch)}
                          onChange={(event) => setNewBranch(event.target.value)}
                          className={formControlFieldClassName}
                        />
                        <p className="text-xs text-muted">
                          {t(I18nKey.GIT_SHIP$NEW_BRANCH_HINT, {
                            branch: git.branch ?? "HEAD",
                          })}
                        </p>
                      </div>
                    ) : null}
                    <label
                      htmlFor="git-ship-pr-title"
                      className="text-xs font-medium text-contrast"
                    >
                      {t(I18nKey.GIT_SHIP$PR_TITLE)}
                    </label>
                    <input
                      id="git-ship-pr-title"
                      data-testid="git-ship-pr-title"
                      value={prTitle}
                      disabled={isRunning}
                      onChange={(event) => setPrTitle(event.target.value)}
                      className={formControlFieldClassName}
                    />
                    <label
                      htmlFor="git-ship-pr-body"
                      className="text-xs font-medium text-contrast"
                    >
                      {t(I18nKey.FORM$DESCRIPTION)}
                    </label>
                    <textarea
                      id="git-ship-pr-body"
                      data-testid="git-ship-pr-body"
                      rows={4}
                      value={prBody}
                      disabled={isRunning}
                      onChange={(event) => setPrBody(event.target.value)}
                      className={cn(
                        formControlFieldClassName,
                        "font-mono text-xs",
                      )}
                    />
                    <label
                      htmlFor="git-ship-pr-base"
                      className="text-xs font-medium text-contrast"
                    >
                      {t(I18nKey.GIT_SHIP$PR_BASE)}
                    </label>
                    <input
                      id="git-ship-pr-base"
                      data-testid="git-ship-pr-base"
                      value={base}
                      disabled={isRunning}
                      onChange={(event) => setBase(event.target.value)}
                      className={formControlFieldClassName}
                    />
                  </>
                ) : null}
              </div>
            ) : null}

            {Object.keys(steps).length > 0 ? (
              <ol data-testid="git-ship-steps" className="flex flex-col gap-1">
                {plannedSteps.map((id) => (
                  <li
                    key={id}
                    data-testid={`git-ship-step-${id}`}
                    data-state={steps[id] ?? "pending"}
                    className={cn(
                      "text-xs",
                      steps[id] === "failed" && "text-danger",
                      steps[id] === "done" && "text-success",
                      (steps[id] === "pending" || steps[id] === "running") &&
                        "text-muted",
                    )}
                  >
                    {t(STEP_LABEL[id])}
                  </li>
                ))}
              </ol>
            ) : null}

            {failure ? (
              <p
                role="alert"
                data-testid="git-ship-error"
                className="whitespace-pre-wrap text-xs text-danger wrap-anywhere"
              >
                {failure}
              </p>
            ) : null}

            {finished ? (
              <p
                data-testid="git-ship-done"
                className="flex flex-wrap items-center gap-2 text-xs text-success"
              >
                {t(I18nKey.GIT_SHIP$DONE)}
                {prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {t(I18nKey.GITHUB$POST_VIEW)}
                  </a>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <BrandButton type="button" variant="secondary" onClick={onClose}>
            {finished ? t(I18nKey.BUTTON$CLOSE) : t(I18nKey.BUTTON$CANCEL)}
          </BrandButton>
          {finished ? null : (
            <BrandButton
              type="button"
              variant="primary"
              testId="git-ship-submit"
              isDisabled={!isValid || isRunning || isAgentRunning}
              onClick={submit}
            >
              {openPr
                ? t(I18nKey.GIT_SHIP$SUBMIT_WITH_PR)
                : t(I18nKey.GIT_SHIP$SUBMIT)}
            </BrandButton>
          )}
        </div>
      </ModalBody>
    </ModalBackdrop>
  );
}
