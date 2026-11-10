import type React from "react";
import { useTranslation } from "react-i18next";
import {
  useVmHarness,
  useVmHarnessImages,
  useVmHarnessLeases,
  useVmHarnessStatus,
  VM_LIVE_REFRESH_MS,
} from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { LoadingSpinner } from "#/components/shared/loading-spinner";
import { VmDataFolderCard } from "./vm-data-folder-card";
import { VmHostStatusCard } from "./vm-host-status-card";
import { VmImagesSection } from "./vm-images-section";
import { VmLeaseCard } from "./vm-lease-card";
import { VmRunsList } from "./vm-runs-list";
import { VmCard } from "./vm-ui";

function VmHarnessUnavailable({ reason }: { reason?: string }) {
  const { t } = useTranslation("openhands");
  return (
    <VmCard
      testId="vm-harness-unavailable"
      title={t(I18nKey.VM_HARNESS$UNAVAILABLE_TITLE)}
      description={t(I18nKey.VM_HARNESS$UNAVAILABLE_BODY)}
    >
      {reason ? (
        <p className="text-xs text-muted wrap-anywhere">{reason}</p>
      ) : null}
    </VmCard>
  );
}

/** The overview: host, data folder, running VMs, images and recent runs. */
function VmHarnessOverview() {
  const { t } = useTranslation("openhands");
  const status = useVmHarnessStatus({ refetchMs: VM_LIVE_REFRESH_MS });
  const images = useVmHarnessImages({ refetchMs: VM_LIVE_REFRESH_MS });
  const leases = useVmHarnessLeases();

  if (status.isError) {
    return (
      <VmHarnessUnavailable
        reason={
          status.error instanceof Error ? status.error.message : undefined
        }
      />
    );
  }
  if (!status.data) {
    return (
      <div className="flex justify-center py-10">
        <LoadingSpinner size="large" />
      </div>
    );
  }

  const live = (leases.data ?? []).filter(
    (lease) => lease.status === "booting" || lease.status === "ready",
  );
  const canStart = live.length < (status.data.maxVms ?? 1);

  return (
    <>
      <VmHostStatusCard status={status.data} />
      <VmDataFolderCard />
      <section
        aria-labelledby="vm-running-heading"
        data-testid="vm-running"
        className="flex flex-col gap-3"
      >
        <h2
          id="vm-running-heading"
          className="text-sm font-semibold text-contrast"
        >
          {t(I18nKey.VM_HARNESS$RUNNING_TITLE, { count: live.length })}
        </h2>
        {live.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-4">
            {live.map((lease) => (
              <VmLeaseCard key={lease.id} lease={lease} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">
            {t(I18nKey.VM_HARNESS$RUNNING_NONE)}
          </p>
        )}
      </section>
      <VmImagesSection
        images={images.data ?? []}
        readAt={images.dataUpdatedAt}
        imagesDir={status.data.imagesDir}
        canStart={canStart}
      />
      <VmRunsList />
    </>
  );
}

/**
 * Test VMs: the GUI VMs agents lease to test their work, the images they start
 * from, and the reports and screenshots they leave behind. Only offered when
 * the backend runs the VM harness.
 */
export function TestVmsPage() {
  const { t } = useTranslation("openhands");
  const { isAvailable, isChecking } = useVmHarness();

  let body: React.ReactNode;
  if (isChecking) {
    body = (
      <div className="flex justify-center py-10">
        <LoadingSpinner size="large" />
      </div>
    );
  } else if (!isAvailable) {
    body = <VmHarnessUnavailable />;
  } else {
    body = <VmHarnessOverview />;
  }

  return (
    <div data-testid="test-vms-page" className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
        <header>
          <h1 className="text-xl font-semibold text-content">
            {t(I18nKey.VM_HARNESS$PAGE_TITLE)}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t(I18nKey.VM_HARNESS$PAGE_SUBTITLE)}
          </p>
        </header>
        {body}
      </div>
    </div>
  );
}
