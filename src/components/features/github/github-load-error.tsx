import { useTranslation } from "react-i18next";
import { GitProviderApiError } from "#/api/git-provider-items-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

// 401/403 cover a missing or under-scoped token and the unauthenticated rate
// limit; GitHub answers 404 for a private repository the caller cannot see.
const ACCESS_ERROR_STATUSES = new Set([401, 403, 404]);

interface GithubLoadErrorProps {
  error: Error | null;
  onRetry: () => void;
  testId: string;
  className?: string;
}

export function GithubLoadError({
  error,
  onRetry,
  testId,
  className,
}: GithubLoadErrorProps) {
  const { t } = useTranslation("openhands");
  const isAccessError =
    error instanceof GitProviderApiError &&
    ACCESS_ERROR_STATUSES.has(error.status);

  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-8 text-center",
        className,
      )}
    >
      <p className="text-sm text-contrast">{t(I18nKey.GITHUB$LOAD_ERROR)}</p>
      {isAccessError ? (
        <p className="max-w-sm text-xs text-muted">
          {t(I18nKey.GITHUB$ACCESS_HINT)}
        </p>
      ) : null}
      <BrandButton type="button" variant="secondary" onClick={onRetry}>
        {t(I18nKey.GITHUB$RETRY)}
      </BrandButton>
    </div>
  );
}
