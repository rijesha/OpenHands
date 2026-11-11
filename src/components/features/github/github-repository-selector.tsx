import React from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GitRepoDropdown } from "#/components/features/home/git-repo-dropdown";
import { BrandButton } from "#/components/features/settings/brand-button";
import { GitProviderIcon } from "#/components/shared/git-provider-icon";
import { useUserProviders } from "#/hooks/use-user-providers";
import { I18nKey } from "#/i18n/declaration";
import { useGithubRecentRepositoriesStore } from "#/stores/github-recent-repositories-store";
import { useHomeStore } from "#/stores/home-store";
import { formControlFieldClassName } from "#/utils/form-control-classes";
import { parseGithubRepository } from "#/utils/parse-github-repository";
import { cn, constructRepositoryUrl } from "#/utils/utils";

function GithubRepositoryInput({
  onSubmit,
}: {
  onSubmit: (repository: string) => void;
}) {
  const { t } = useTranslation("openhands");
  const [value, setValue] = React.useState("");
  const [isInvalid, setIsInvalid] = React.useState(false);
  const errorId = React.useId();

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const repository = parseGithubRepository(value);
        if (!repository) {
          setIsInvalid(true);
          return;
        }
        onSubmit(repository);
      }}
    >
      <div className="flex max-w-125 gap-2">
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setIsInvalid(false);
          }}
          data-testid="github-repository-input"
          aria-label={t(I18nKey.GITHUB$REPOSITORY_LABEL)}
          aria-invalid={isInvalid}
          aria-describedby={isInvalid ? errorId : undefined}
          placeholder={t(I18nKey.GITHUB$REPOSITORY_INPUT_PLACEHOLDER)}
          className={cn(formControlFieldClassName, "flex-1")}
        />
        <BrandButton
          type="submit"
          variant="primary"
          testId="github-repository-open"
          isDisabled={!value.trim()}
        >
          {t(I18nKey.GITHUB$OPEN_REPOSITORY)}
        </BrandButton>
      </div>
      {isInvalid ? (
        <p id={errorId} role="alert" className="text-xs text-feedback-error">
          {t(I18nKey.GITHUB$REPOSITORY_INVALID)}
        </p>
      ) : null}
    </form>
  );
}

interface GithubRepositorySelectorProps {
  repository: string | null;
  /** `null` when the last saved repository was removed. */
  onChange: (repository: string | null) => void;
}

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

export function GithubRepositorySelector({
  repository,
  onChange,
}: GithubRepositorySelectorProps) {
  const { t } = useTranslation("openhands");
  const { providers } = useUserProviders();
  const { addRecentRepository } = useHomeStore();
  const { repositories, add, remove } = useGithubRecentRepositoriesStore();
  const [isAdding, setIsAdding] = React.useState(false);
  const isGithubConnected = providers.includes("github");

  const isSaved =
    !!repository &&
    repositories.some((saved) => sameRepository(saved, repository));
  // Nothing to choose from yet: the add form is the page's first step.
  const showAddForm = isAdding || (!repository && repositories.length === 0);

  const addAndSelect = (next: string) => {
    add(next);
    setIsAdding(false);
    onChange(next);
  };

  const removeRepository = (target: string) => {
    const index = repositories.findIndex((saved) =>
      sameRepository(saved, target),
    );
    remove(target);
    if (repository && sameRepository(repository, target)) {
      const rest = repositories.filter(
        (saved) => !sameRepository(saved, target),
      );
      onChange(rest[index] ?? rest[index - 1] ?? null);
    }
  };

  return (
    <div
      data-testid="github-repository-selector"
      className="flex flex-col gap-2"
    >
      {repositories.length > 0 ? (
        <ul
          data-testid="github-saved-repositories"
          aria-label={t(I18nKey.GITHUB$SAVED_REPOSITORIES)}
          className="flex flex-wrap items-center gap-2"
        >
          {repositories.map((saved) => {
            const isCurrent = !!repository && sameRepository(saved, repository);
            return (
              <li
                key={saved}
                className={cn(
                  "flex items-center rounded-full border text-xs",
                  isCurrent
                    ? "border-primary bg-interactive-selected text-contrast"
                    : "border-border text-muted",
                )}
              >
                <button
                  type="button"
                  data-testid={`github-repository-option-${saved}`}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => {
                    setIsAdding(false);
                    onChange(saved);
                  }}
                  className="rounded-l-full py-1 pl-2.5 pr-1.5 transition-colors hover:text-contrast"
                >
                  {saved}
                </button>
                <button
                  type="button"
                  data-testid={`github-remove-repository-${saved}`}
                  aria-label={t(I18nKey.GITHUB$REMOVE_REPOSITORY, {
                    repository: saved,
                  })}
                  onClick={() => removeRepository(saved)}
                  className="rounded-r-full py-1 pl-1 pr-2 transition-colors hover:text-contrast"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            );
          })}
          <li>
            <BrandButton
              type="button"
              variant="secondary"
              testId="github-add-repository"
              onClick={() => setIsAdding((open) => !open)}
            >
              <Plus className="size-3.5" aria-hidden />
              {t(I18nKey.GITHUB$ADD_REPOSITORY)}
            </BrandButton>
          </li>
        </ul>
      ) : null}

      {repository && !isSaved ? (
        // Opened from a link, so not on the list yet.
        <div
          data-testid="github-repository-unsaved"
          className="flex flex-wrap items-center gap-3 text-sm text-muted"
        >
          <span className="min-w-0 truncate text-contrast">{repository}</span>
          <BrandButton
            type="button"
            variant="secondary"
            testId="github-save-repository"
            onClick={() => add(repository)}
          >
            {t(I18nKey.GITHUB$SAVE_REPOSITORY)}
          </BrandButton>
        </div>
      ) : null}

      {repository ? (
        <a
          data-testid="github-repository-current"
          href={constructRepositoryUrl("github", repository)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-2 self-start text-base font-medium text-contrast hover:underline"
        >
          <GitProviderIcon gitProvider="github" />
          <span className="truncate">{repository}</span>
          <ExternalLink className="size-3.5 shrink-0 text-muted" aria-hidden />
        </a>
      ) : null}

      {showAddForm ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-contrast">
            {t(I18nKey.GITHUB$REPOSITORY_LABEL)}
          </span>
          {isGithubConnected ? (
            <div className="max-w-125">
              <GitRepoDropdown
                provider="github"
                // eslint-disable-next-line i18next/no-literal-string -- example value, not translatable
                placeholder="owner/repo"
                onChange={(selected) => {
                  if (!selected) return;
                  addRecentRepository(selected);
                  addAndSelect(selected.full_name);
                }}
              />
            </div>
          ) : (
            <>
              <GithubRepositoryInput onSubmit={addAndSelect} />
              <p className="text-xs text-muted">
                {t(I18nKey.GITHUB$CONNECT_HINT)}
              </p>
            </>
          )}
          {isAdding && repositories.length > 0 ? (
            <BrandButton
              type="button"
              variant="tertiary"
              className="self-start"
              onClick={() => setIsAdding(false)}
            >
              {t(I18nKey.BUTTON$CANCEL)}
            </BrandButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
