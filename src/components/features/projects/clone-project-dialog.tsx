import React from "react";
import { useTranslation } from "react-i18next";
import { BrandButton } from "#/components/features/settings/brand-button";
import { BaseModalTitle } from "#/components/shared/modals/confirmation-modals/base-modal";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalBody } from "#/components/shared/modals/modal-body";
import { ModalCloseButton } from "#/components/shared/modals/modal-close-button";
import { useAddWorkspaces } from "#/hooks/mutation/use-local-workspaces-mutations";
import { useLocalWorkspaces } from "#/hooks/query/use-local-workspaces";
import { useBashCommandRunner } from "#/hooks/use-bash-command-runner";
import { I18nKey } from "#/i18n/declaration";
import { formControlFieldClassName } from "#/utils/form-control-classes";
import { parseGithubRepository } from "#/utils/parse-github-repository";
import { shellQuote } from "#/utils/project-git-info";
import { constructRepositoryUrl } from "#/utils/utils";

const CLONE_TIMEOUT_SECONDS = 600;

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, "")}/${name}`;
}

interface CloneProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new folder's path once it is cloned and saved. */
  onCloned?: (path: string) => void;
}

/**
 * Clones a GitHub repository into a folder on the agent-server's machine and
 * adds it to the project list. The folder is chosen from the saved parent
 * folders, or typed when there are none.
 */
export function CloneProjectDialog({
  isOpen,
  onClose,
  onCloned,
}: CloneProjectDialogProps) {
  const { t } = useTranslation("openhands");
  const { data: workspaces } = useLocalWorkspaces();
  const parents = workspaces?.workspaceParents ?? [];
  const { mutateAsync: addWorkspaces } = useAddWorkspaces();
  const run = useBashCommandRunner(undefined, undefined, isOpen);

  const [repositoryInput, setRepositoryInput] = React.useState("");
  const [parentChoice, setParentChoice] = React.useState("");
  const [typedParent, setTypedParent] = React.useState("");
  const [isInvalid, setIsInvalid] = React.useState(false);
  const [isCloning, setIsCloning] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  if (!isOpen) return null;

  const destination =
    parents.length > 0 ? parentChoice || parents[0].path : typedParent.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const repository = parseGithubRepository(repositoryInput);
    if (!repository) {
      setIsInvalid(true);
      return;
    }
    const name = repository.split("/")[1];
    const path = joinPath(destination, name);
    setIsCloning(true);
    setFailure(null);
    try {
      const result = await run(
        `git clone ${shellQuote(constructRepositoryUrl("github", repository))} ${shellQuote(path)}`,
        destination,
        CLONE_TIMEOUT_SECONDS,
      );
      if (result.exit_code !== 0) {
        throw new Error(
          (result.stderr || result.stdout).trim() ||
            `git exited with ${result.exit_code}`,
        );
      }
      // Under a saved parent the folder is listed on its own; elsewhere it is saved.
      const underParent = parents.some(
        (parent) => joinPath(parent.path, name) === path,
      );
      if (!underParent) {
        await addWorkspaces([{ id: path, name, path }]);
      }
      onCloned?.(path);
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCloning(false);
    }
  };

  return (
    <ModalBackdrop onClose={isCloning ? undefined : onClose}>
      <ModalBody
        width="md"
        className="relative items-start border border-border !gap-4"
        testID="clone-project-dialog"
      >
        <ModalCloseButton onClose={onClose} disabled={isCloning} />
        <div className="w-full pr-6">
          <BaseModalTitle title={t(I18nKey.PROJECTS$CLONE_TITLE)} />
        </div>
        <form className="flex w-full flex-col gap-3" onSubmit={submit}>
          <label
            htmlFor="clone-project-repository"
            className="text-xs font-medium text-contrast"
          >
            {t(I18nKey.GITHUB$REPOSITORY_LABEL)}
          </label>
          <input
            id="clone-project-repository"
            data-testid="clone-project-repository"
            value={repositoryInput}
            disabled={isCloning}
            aria-invalid={isInvalid}
            placeholder={t(I18nKey.GITHUB$REPOSITORY_INPUT_PLACEHOLDER)}
            onChange={(event) => {
              setRepositoryInput(event.target.value);
              setIsInvalid(false);
            }}
            className={formControlFieldClassName}
          />
          {isInvalid ? (
            <p role="alert" className="text-xs text-feedback-error">
              {t(I18nKey.GITHUB$REPOSITORY_INVALID)}
            </p>
          ) : null}

          <label
            htmlFor="clone-project-destination"
            className="text-xs font-medium text-contrast"
          >
            {t(I18nKey.PROJECTS$CLONE_DESTINATION)}
          </label>
          {parents.length > 0 ? (
            <select
              id="clone-project-destination"
              data-testid="clone-project-destination"
              value={destination}
              disabled={isCloning}
              onChange={(event) => setParentChoice(event.target.value)}
              className={formControlFieldClassName}
            >
              {parents.map((parent) => (
                <option key={parent.id} value={parent.path}>
                  {parent.path}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="clone-project-destination"
              data-testid="clone-project-destination"
              value={typedParent}
              disabled={isCloning}
              placeholder={t(I18nKey.PROJECTS$CLONE_DESTINATION_PLACEHOLDER)}
              onChange={(event) => setTypedParent(event.target.value)}
              className={formControlFieldClassName}
            />
          )}

          {failure ? (
            <p
              role="alert"
              data-testid="clone-project-error"
              className="whitespace-pre-wrap text-xs text-danger wrap-anywhere"
            >
              {t(I18nKey.PROJECTS$CLONE_ERROR, { message: failure })}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <BrandButton
              type="button"
              variant="secondary"
              isDisabled={isCloning}
              onClick={onClose}
            >
              {t(I18nKey.BUTTON$CANCEL)}
            </BrandButton>
            <BrandButton
              type="submit"
              variant="primary"
              testId="clone-project-submit"
              isDisabled={!repositoryInput.trim() || !destination || isCloning}
            >
              {isCloning
                ? t(I18nKey.PROJECTS$CLONE_RUNNING)
                : t(I18nKey.PROJECTS$CLONE_SUBMIT)}
            </BrandButton>
          </div>
        </form>
      </ModalBody>
    </ModalBackdrop>
  );
}
