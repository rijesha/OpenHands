import { useTranslation } from "react-i18next";
import type { VmHarnessRun } from "#/api/vm-harness-service";
import {
  useVmHarnessBootFailureShot,
  useVmHarnessRun,
} from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { VmRunReport } from "./vm-run-report";
import { VmScreenshotGallery } from "./vm-screenshot-gallery";

/** Why a VM did not start, with the screen it stalled on when the harness kept one. */
export function VmBootFailure({ run }: { run: VmHarnessRun }) {
  const { t } = useTranslation("openhands");
  const shot = useVmHarnessBootFailureShot(run.id, {
    enabled: run.hasBootFailureShot,
  });

  return (
    <div data-testid="vm-boot-failure" className="flex flex-col gap-2">
      <p className="text-sm text-danger wrap-anywhere">
        {t(I18nKey.GITHUB$VM_RUN_BOOT_FAILED, { stage: run.stage ?? "" })}
        {run.error ? `: ${run.error}` : ""}
      </p>
      {shot.data?.url ? (
        <img
          src={shot.data.url}
          alt={t(I18nKey.VM_HARNESS$BOOT_SCREEN_ALT, { id: run.id })}
          className="max-h-80 w-auto max-w-full rounded-md border border-border"
        />
      ) : null}
      {shot.data?.details && !shot.data.url ? (
        <pre className="whitespace-pre-wrap text-xs text-muted wrap-anywhere">
          {shot.data.details}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * The evidence of one finished VM run: the agent's report, its steps and every
 * screenshot. A run whose VM never started shows why instead.
 */
export function VmRunEvidence({ run }: { run: VmHarnessRun }) {
  const { t } = useTranslation("openhands");
  const detail = useVmHarnessRun(run.id);

  if (detail.isLoading) {
    return <p className="text-sm text-muted">{t(I18nKey.HOME$LOADING)}</p>;
  }
  if (detail.isError || !detail.data) {
    return (
      <p role="alert" className="text-sm text-danger">
        {t(I18nKey.VM_HARNESS$RUN_LOAD_FAILED)}
      </p>
    );
  }

  const { report, steps, screenshots } = detail.data;
  return (
    <div className="flex flex-col gap-4">
      {!report && run.status === "failed" ? <VmBootFailure run={run} /> : null}
      <VmRunReport report={report} steps={steps ?? []} />
      <VmScreenshotGallery
        runId={run.id}
        screenshots={screenshots ?? []}
        steps={steps ?? []}
      />
    </div>
  );
}
