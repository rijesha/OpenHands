import { useTranslation } from "react-i18next";
import type { VmHarnessStatus } from "#/api/vm-harness-service";
import { I18nKey } from "#/i18n/declaration";
import { memoryNeededMB } from "#/utils/vm-harness";
import { cn } from "#/utils/utils";
import { VmCard } from "./vm-ui";

/** Whether the host can start VMs, and how much room it has for them. */
export function VmHostStatusCard({ status }: { status: VmHarnessStatus }) {
  const { t } = useTranslation("openhands");
  const needs = memoryNeededMB(status);
  const { host } = status;

  return (
    <VmCard testId="vm-host-status">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span
          className={cn(
            "font-medium",
            host.ok ? "text-success" : "text-danger",
          )}
        >
          {t(
            host.ok
              ? I18nKey.VM_HARNESS$HOST_READY
              : I18nKey.VM_HARNESS$HOST_PROBLEM,
          )}
        </span>
        {status.provider ? (
          <span className="text-xs text-muted">
            {t(I18nKey.VM_HARNESS$HOST_PROVIDER, {
              provider: status.provider,
              count: status.maxVms ?? 1,
            })}
          </span>
        ) : null}
        {host.freeRamMB != null ? (
          <span className="text-xs text-muted">
            {needs.length > 0
              ? t(I18nKey.VM_HARNESS$HOST_FREE_RAM_NEEDS, {
                  free: host.freeRamMB,
                  needs: needs.join(" - "),
                })
              : t(I18nKey.VM_HARNESS$HOST_FREE_RAM, { free: host.freeRamMB })}
          </span>
        ) : null}
        {host.freeDiskGB ? (
          <span className="text-xs text-muted">
            {t(I18nKey.VM_HARNESS$HOST_FREE_DISK, { free: host.freeDiskGB })}
          </span>
        ) : null}
      </div>
      {(host.problems ?? []).map((problem) => (
        <p key={problem} className="text-xs text-danger wrap-anywhere">
          {problem}
        </p>
      ))}
    </VmCard>
  );
}
