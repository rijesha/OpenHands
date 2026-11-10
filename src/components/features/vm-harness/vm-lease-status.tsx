import { useTranslation } from "react-i18next";
import type { VmHarnessLease } from "#/api/vm-harness-service";
import { I18nKey } from "#/i18n/declaration";

const STATUS_LABEL = {
  ready: I18nKey.VM_HARNESS$STATUS_READY,
  failed: I18nKey.VM_HARNESS$STATUS_FAILED,
  stopped: I18nKey.VM_HARNESS$STATUS_STOPPED,
} as const;

/** "Booting: waiting for SSH", "Ready", "Failed", "Stopped". */
export function VmLeaseStatusLabel({
  lease,
}: {
  lease: Pick<VmHarnessLease, "status" | "stage">;
}) {
  const { t } = useTranslation("openhands");
  if (lease.status === "booting") {
    return (
      <>{t(I18nKey.VM_HARNESS$STATUS_BOOTING, { stage: lease.stage ?? "" })}</>
    );
  }
  return <>{t(STATUS_LABEL[lease.status] ?? STATUS_LABEL.stopped)}</>;
}
