import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  TEST_VMS_PATH,
  vmHarnessRunPath,
  type VmHarnessLease,
  type VmHarnessRun,
} from "#/api/vm-harness-service";
import { VmRunEvidence } from "#/components/features/vm-harness/vm-run-evidence";
import { VmLeaseStatusLabel } from "#/components/features/vm-harness/vm-lease-status";
import { useNavigation } from "#/context/navigation-context";
import {
  useVmHarnessLeaseScreenshot,
  useVmHarnessLeasesForItem,
  useVmHarnessRunsForItem,
} from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { VM_RUN_VERDICT_COPY, vmRunVerdict } from "#/utils/vm-harness";
import { cn } from "#/utils/utils";

/** Runs listed before "Show all"; older ones are rarely what a reviewer wants. */
const RUNS_PREVIEW = 3;
/** A ready VM's screen is refreshed this often while the page shows it. */
const LIVE_SCREEN_MS = 5_000;

function LiveVm({ lease }: { lease: VmHarnessLease }) {
  const { navigate } = useNavigation();
  const { t } = useTranslation("openhands");
  const screen = useVmHarnessLeaseScreenshot(lease.id, {
    enabled: lease.status === "ready",
    refetchMs: LIVE_SCREEN_MS,
  });

  return (
    <li
      data-testid={`github-vm-live-${lease.id}`}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="font-medium text-primary">
          <VmLeaseStatusLabel lease={lease} />
        </span>
        <span>{lease.os}</span>
        <button
          type="button"
          onClick={() => navigate(TEST_VMS_PATH)}
          className="ml-auto inline-flex items-center gap-1.5 hover:text-contrast"
        >
          {t(I18nKey.VM_HARNESS$WATCH)}
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
      </div>
      {screen.data ? (
        <img
          src={screen.data}
          alt={t(I18nKey.VM_HARNESS$SCREEN_ALT, { id: lease.id })}
          className="max-h-48 w-auto max-w-full self-start rounded-md border border-border"
        />
      ) : null}
    </li>
  );
}

function VmRunCard({
  run,
  isOpen,
  onToggle,
}: {
  run: VmHarnessRun;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const { label, tone } = VM_RUN_VERDICT_COPY[vmRunVerdict(run)];
  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <li
      data-testid={`github-vm-run-card-${run.id}`}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <button
          type="button"
          aria-expanded={isOpen}
          data-testid={`github-vm-run-toggle-${run.id}`}
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 hover:text-contrast"
        >
          <Chevron className="size-3.5" aria-hidden />
          <span className={cn("font-medium", tone)}>
            {t(label, { stage: run.stage ?? "" })}
          </span>
        </button>
        <span>{run.os}</span>
        <span>{formatRelativeTime(run.startedAt, i18n.language, t)}</span>
        {run.report && !isOpen ? (
          <span className="min-w-0 truncate">
            {run.report.summary.slice(0, 140)}
          </span>
        ) : null}
        <button
          type="button"
          data-testid={`github-vm-run-${run.id}`}
          onClick={() => navigate(vmHarnessRunPath(run.id))}
          className="ml-auto inline-flex items-center gap-1.5 hover:text-contrast"
        >
          {t(I18nKey.GITHUB$VM_RUN_OPEN)}
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
      </div>
      {isOpen ? <VmRunEvidence run={run} /> : null}
    </li>
  );
}

interface GithubVmRunsProps {
  repository: string;
  number: number;
}

/**
 * GUI test runs an agent linked to this item (through the `context` it passes
 * to `vm_start`): verdict, steps and screenshots, so a finished review shows
 * its evidence without leaving the pull request. The newest run starts open.
 */
export function GithubVmRuns({ repository, number }: GithubVmRunsProps) {
  const { t } = useTranslation("openhands");
  const runs = useVmHarnessRunsForItem(repository, number);
  const live = useVmHarnessLeasesForItem(repository, number);
  const [toggled, setToggled] = React.useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = React.useState(false);

  if (runs.length === 0 && live.length === 0) return null;

  const shown = showAll ? runs : runs.slice(0, RUNS_PREVIEW);
  const newestId = runs[0]?.id;

  return (
    <section
      aria-labelledby="github-vm-runs-heading"
      data-testid="github-vm-runs"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h3
        id="github-vm-runs-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$VM_RUNS)}
      </h3>
      <ul className="flex flex-col gap-3">
        {live.map((lease) => (
          <LiveVm key={lease.id} lease={lease} />
        ))}
        {shown.map((run) => (
          <VmRunCard
            key={run.id}
            run={run}
            isOpen={toggled[run.id] ?? run.id === newestId}
            onToggle={() =>
              setToggled((previous) => ({
                ...previous,
                [run.id]: !(previous[run.id] ?? run.id === newestId),
              }))
            }
          />
        ))}
      </ul>
      {runs.length > shown.length ? (
        <button
          type="button"
          data-testid="github-vm-runs-show-all"
          onClick={() => setShowAll(true)}
          className="self-start text-xs text-muted underline hover:text-contrast"
        >
          {t(I18nKey.GITHUB$SHOW_ALL_ENTRIES, { total: runs.length })}
        </button>
      ) : null}
    </section>
  );
}
