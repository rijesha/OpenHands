import React from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GitRepoDropdown } from "#/components/features/home/git-repo-dropdown";
import { BrandButton } from "#/components/features/settings/brand-button";
import { GitProviderIcon } from "#/components/shared/git-provider-icon";
import { useUserProviders } from "#/hooks/use-user-providers";
import { I18nKey } from "#/i18n/declaration";
import { useHomeStore } from "#/stores/home-store";
import { formControlFieldClassName } from "#/utils/form-control-classes";
import { parseGithubRepository } from "#/utils/parse-github-repository";
import { cn, constructRepositoryUrl } from "#/utils/utils";

const MAX_RECENT_REPOSITORIES = 5;

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
  onChange: (repository: string) => void;
}

export function GithubRepositorySelector({
  repository,
  onChange,
}: GithubRepositorySelectorProps) {
  const { t } = useTranslation("openhands");
  const { providers } = useUserProviders();
  const { recentRepositories, addRecentRepository } = useHomeStore();
  const [isEditing, setIsEditing] = React.useState(false);
  const isGithubConnected = providers.includes("github");

  const recentGithubRepositories = recentRepositories
    .filter(
      (recent) =>
        recent.git_provider === "github" && recent.full_name !== repository,
    )
    .slice(0, MAX_RECENT_REPOSITORIES);

  const select = (next: string) => {
    setIsEditing(false);
    onChange(next);
  };

  if (repository && !isEditing) {
    return (
      <div
        data-testid="github-repository-current"
        className="flex flex-wrap items-center gap-3"
      >
        <a
          href={constructRepositoryUrl("github", repository)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-2 text-base font-medium text-contrast hover:underline"
        >
          <GitProviderIcon gitProvider="github" />
          <span className="truncate">{repository}</span>
          <ExternalLink className="size-3.5 shrink-0 text-muted" aria-hidden />
        </a>
        <BrandButton
          type="button"
          variant="secondary"
          testId="github-repository-change"
          onClick={() => setIsEditing(true)}
        >
          {t(I18nKey.GITHUB$CHANGE_REPOSITORY)}
        </BrandButton>
      </div>
    );
  }

  return (
    <div
      data-testid="github-repository-selector"
      className="flex flex-col gap-2"
    >
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
              select(selected.full_name);
            }}
          />
        </div>
      ) : (
        <>
          <GithubRepositoryInput onSubmit={select} />
          <p className="text-xs text-muted">{t(I18nKey.GITHUB$CONNECT_HINT)}</p>
        </>
      )}
      {recentGithubRepositories.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {recentGithubRepositories.map((recent) => (
            <li key={recent.id}>
              <button
                type="button"
                data-testid={`github-recent-repository-${recent.full_name}`}
                onClick={() => select(recent.full_name)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-interactive-hover hover:text-contrast"
              >
                {recent.full_name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {repository && isEditing ? (
        <BrandButton
          type="button"
          variant="tertiary"
          className="self-start"
          onClick={() => setIsEditing(false)}
        >
          {t(I18nKey.BUTTON$CANCEL)}
        </BrandButton>
      ) : null}
    </div>
  );
}
