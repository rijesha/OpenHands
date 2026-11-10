import React from "react";
import { useTranslation } from "react-i18next";
import { vmHarnessRunPath, type VmHarnessRun } from "#/api/vm-harness-service";
import { useNavigation } from "#/context/navigation-context";
import {
  useVmHarnessBootFailureShot,
  useVmHarnessRuns,
} from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { formatRelativeTime } from "#/utils/format-relative-time";
import {
  githubItemPath,
  VM_RUN_VERDICT_COPY,
  vmRunVerdict,
} from "#/utils/vm-harness";
import { cn } from "#/utils/utils";
import { VmCard } from "./vm-ui";

const RUNS_PREVIEW = 20;

function BootScreenshot({ run }: { run: VmHarnessRun }) {
  const { t } = useTranslation("openhands");
  const [shown, setShown] = React.useState(false);
  const shot = useVmHarnessBootFailureShot(run.id, { enabled: shown });
  return (
    <>
      <button
        type="button"
        onClick={() => setShown((value) => !value)}
        className="text-xs text-primary underline hover:no-underline"
      >
        {t(I18nKey.VM_HARNESS$BOOT_SHOT)}
      </button>
      {shown && shot.data?.url ? (
        <img
          src={shot.data.url}
          alt={t(I18nKey.VM_HARNESS$BOOT_SCREEN_ALT, { id: run.id })}
          className="mt-1 max-h-64 w-auto max-w-full rounded-md border border-border"
        />
      ) : null}
      {shown && shot.isError ? (
        <span className="text-xs text-danger">
          {t(I18nKey.VM_HARNESS$SCREENSHOT_FAILED)}
        </span>
      ) : null}
    </>
  );
}

function VmRunRow({ run }: { run: VmHarnessRun }) {
  const { t, i18n } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const { label, tone } = VM_RUN_VERDICT_COPY[vmRunVerdict(run)];
  const { repository, item, kind } = run.context ?? {};

  return (
    <li
      data-testid={`vm-run-${run.id}`}
      className="flex flex-col gap-1 border-b border-border py-2 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <button
          type="button"
          data-testid={`vm-run-open-${run.id}`}
          onClick={() => navigate(vmHarnessRunPath(run.id))}
          className="text-sm text-primary underline hover:no-underline"
        >
          {run.id}
        </button>
        <span>{run.os}</span>
        <span>{formatRelativeTime(run.startedAt, i18n.language, t)}</span>
        <span className={cn("font-medium", tone)}>
          {t(label, { stage: run.stage ?? "" })}
        </span>
        {run.report ? (
          <span>
            {t(I18nKey.VM_HARNESS$RUN_STEPS, { count: run.report.steps })}
          </span>
        ) : null}
        {repository ? (
          <button
            type="button"
            onClick={() =>
              navigate(githubItemPath(repository, item ?? "", kind))
            }
            className="text-primary underline hover:no-underline"
          >
            {`${repository}${item ? `#${item}` : ""}`}
          </button>
        ) : null}
        {run.hasBootFailureShot ? <BootScreenshot run={run} /> : null}
      </div>
      {!run.report && run.error ? (
        <p className="text-xs text-danger wrap-anywhere">{run.error}</p>
      ) : null}
    </li>
  );
}

/** Finished VM runs, newest first, each opening its report and screenshots. */
export function VmRunsList() {
  const { t } = useTranslation("openhands");
  const { data: runs = [] } = useVmHarnessRuns();
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? runs : runs.slice(0, RUNS_PREVIEW);

  return (
    <VmCard testId="vm-runs" title={t(I18nKey.VM_HARNESS$RUNS_TITLE)}>
      {runs.length > 0 ? (
        <ul className="flex flex-col">
          {shown.map((run) => (
            <VmRunRow key={run.id} run={run} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t(I18nKey.VM_HARNESS$RUNS_NONE)}</p>
      )}
      {runs.length > shown.length ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="self-start text-xs text-muted underline hover:text-contrast"
        >
          {t(I18nKey.GITHUB$SHOW_ALL_ENTRIES, { total: runs.length })}
        </button>
      ) : null}
    </VmCard>
  );
}
