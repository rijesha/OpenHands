import { ArrowLeft } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { TEST_VMS_PATH } from "#/api/vm-harness-service";
import { BrandButton } from "#/components/features/settings/brand-button";
import { ConfirmationModal } from "#/components/shared/modals/confirmation-modal";
import { useNavigation } from "#/context/navigation-context";
import { useDeleteVmRun } from "#/hooks/mutation/use-vm-harness-mutations";
import { useVmHarnessRuns } from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { githubItemPath } from "#/utils/vm-harness";
import { VmRunEvidence } from "./vm-run-evidence";
import { VmActionError, VmCard } from "./vm-ui";

/** One finished run: the agent's report, its steps and every screenshot. */
export function VmRunPage({ runId }: { runId: string }) {
  const { t } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const runs = useVmHarnessRuns();
  const remove = useDeleteVmRun();
  const [confirming, setConfirming] = React.useState(false);

  const run = runs.data?.find((candidate) => candidate.id === runId);
  const { repository, item, kind } = run?.context ?? {};

  let body: React.ReactNode;
  if (run) {
    body = <VmRunEvidence run={run} />;
  } else if (runs.isLoading) {
    body = <p className="text-sm text-muted">{t(I18nKey.HOME$LOADING)}</p>;
  } else {
    body = (
      <p role="alert" className="text-sm text-danger">
        {t(I18nKey.VM_HARNESS$RUN_NOT_FOUND)}
      </p>
    );
  }

  return (
    <div
      data-testid="vm-run-page"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="vm-run-back"
          onClick={() => navigate(TEST_VMS_PATH)}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-contrast"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t(I18nKey.VM_HARNESS$PAGE_TITLE)}
        </button>
        <h1 className="text-xl font-semibold text-content">
          {t(I18nKey.VM_HARNESS$RUN_TITLE, { id: runId })}
        </h1>
        {repository ? (
          <button
            type="button"
            onClick={() =>
              navigate(githubItemPath(repository, item ?? "", kind))
            }
            className="text-sm text-primary underline hover:no-underline"
          >
            {`${repository}${item ? `#${item}` : ""}`}
          </button>
        ) : null}
        {run ? (
          <BrandButton
            type="button"
            variant="secondary"
            testId="vm-run-delete"
            className="ml-auto"
            isDisabled={remove.isPending}
            onClick={() => setConfirming(true)}
          >
            {t(I18nKey.VM_HARNESS$DELETE_RUN)}
          </BrandButton>
        ) : null}
      </div>
      <VmActionError error={remove.error} />
      <VmCard>{body}</VmCard>
      {confirming ? (
        <ConfirmationModal
          text={t(I18nKey.VM_HARNESS$DELETE_RUN_CONFIRM, { id: runId })}
          confirmText={t(I18nKey.BUTTON$DELETE)}
          isConfirming={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            remove.mutate(runId, {
              onSuccess: () => navigate(TEST_VMS_PATH),
              onSettled: () => setConfirming(false),
            })
          }
        />
      ) : null}
    </div>
  );
}
