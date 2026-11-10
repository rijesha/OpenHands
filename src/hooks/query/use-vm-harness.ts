import { useQuery } from "@tanstack/react-query";
import {
  getConversationServerInfo,
  usesIsolatedWorkspace,
} from "#/api/conversation-workspace";
import {
  screenshotDataUrl,
  VmHarnessService,
  type VmHarnessLease,
  type VmHarnessRun,
} from "#/api/vm-harness-service";
import { useActiveBackend } from "#/contexts/active-backend-context";
import {
  getVmHarnessPluginPath,
  type GuiVmTarget,
} from "#/utils/gui-vm-launch";
import { VM_HARNESS_QUERY_KEYS } from "./query-keys";

const VM_HARNESS_STALE_TIME_MS = 60_000;
const VM_RUNS_REFRESH_MS = 15_000;
/** The Test VMs page watches VMs boot, so it refreshes faster than a card on the GitHub page. */
export const VM_LIVE_REFRESH_MS = 5_000;

/** Harness reads fail quietly: the page explains an unavailable harness itself. */
const QUIET = { retry: false, meta: { disableToast: true } } as const;

/**
 * Whether the active backend runs the GUI VM harness, and the plugin to attach
 * to conversations that want it.
 *
 * Local backends only: the harness drives a hypervisor on the machine that runs
 * the agent-server. A Docker-isolated server is excluded too, because the
 * harness plugin path and loopback MCP URL do not resolve inside its container.
 */
export function useVmHarness() {
  const { backend } = useActiveBackend();

  const { data, isLoading } = useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.plugin(backend.id),
    enabled: backend.kind === "local",
    staleTime: VM_HARNESS_STALE_TIME_MS,
    queryFn: async () => {
      const info = await getConversationServerInfo();
      if (!info || usesIsolatedWorkspace(info)) return null;
      return getVmHarnessPluginPath(info.runtime_services);
    },
  });

  return {
    pluginPath: data ?? null,
    isAvailable: !!data,
    /** True until the first answer, so a page can tell "not advertised" from "not asked yet". */
    isChecking: backend.kind === "local" && isLoading,
  };
}

/** Backend id plus whether harness reads should run. */
function useHarnessScope(enabled = true) {
  const { backend } = useActiveBackend();
  const { isAvailable } = useVmHarness();
  return { backendId: backend.id, enabled: isAvailable && enabled };
}

export function useVmHarnessStatus(options: { refetchMs?: number } = {}) {
  const { backendId, enabled } = useHarnessScope();
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.status(backendId),
    enabled,
    staleTime: 10_000,
    refetchInterval: options.refetchMs,
    queryFn: VmHarnessService.status,
    ...QUIET,
  });
}

export function useVmHarnessImages(options: { refetchMs?: number } = {}) {
  const { backendId, enabled } = useHarnessScope();
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.images(backendId),
    enabled,
    staleTime: VM_HARNESS_STALE_TIME_MS,
    refetchInterval: options.refetchMs,
    queryFn: VmHarnessService.listImages,
    ...QUIET,
  });
}

export function useVmHarnessSettings(options: { refetchMs?: number } = {}) {
  const { backendId, enabled } = useHarnessScope();
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.settings(backendId),
    enabled,
    refetchInterval: options.refetchMs,
    queryFn: VmHarnessService.settings,
    ...QUIET,
  });
}

export function useVmHarnessLeases(options: { refetchMs?: number } = {}) {
  const { backendId, enabled } = useHarnessScope();
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.leases(backendId),
    enabled,
    refetchInterval: options.refetchMs ?? VM_LIVE_REFRESH_MS,
    queryFn: VmHarnessService.listLeases,
    ...QUIET,
  });
}

export function useVmHarnessRuns(options: { refetchMs?: number } = {}) {
  const { backendId, enabled } = useHarnessScope();
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.runs(backendId),
    enabled,
    refetchInterval: options.refetchMs ?? VM_RUNS_REFRESH_MS,
    queryFn: VmHarnessService.listRuns,
    ...QUIET,
  });
}

/** One finished run: report, steps and the names of its screenshots. */
export function useVmHarnessRun(
  runId: string,
  options: { enabled?: boolean } = {},
) {
  const { backendId, enabled } = useHarnessScope(options.enabled);
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.run(backendId, runId),
    enabled,
    staleTime: VM_HARNESS_STALE_TIME_MS,
    queryFn: () => VmHarnessService.getRun(runId),
    ...QUIET,
  });
}

/** One screenshot of a run as a `data:` URL. A finished run never changes, so it is kept. */
export function useVmHarnessScreenshot(
  runId: string,
  name: string,
  options: { enabled?: boolean } = {},
) {
  const { backendId, enabled } = useHarnessScope(options.enabled);
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.runScreenshot(backendId, runId, name),
    enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      const url = screenshotDataUrl(
        await VmHarnessService.runScreenshot(runId, name),
      );
      if (!url) throw new Error("The harness returned no image");
      return url;
    },
    ...QUIET,
  });
}

/** What a VM showed when its boot stalled: a screenshot, or the failure text. */
export function useVmHarnessBootFailureShot(
  runId: string,
  options: { enabled?: boolean } = {},
) {
  const { backendId, enabled } = useHarnessScope(options.enabled);
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.bootShot(backendId, runId),
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const shot = await VmHarnessService.bootFailureShot(runId);
      return { url: screenshotDataUrl(shot), details: shot.details ?? null };
    },
    ...QUIET,
  });
}

/** The live screen of a ready VM, refreshed while `refetchMs` is set. */
export function useVmHarnessLeaseScreenshot(
  leaseId: string,
  options: { enabled?: boolean; refetchMs?: number } = {},
) {
  const { backendId, enabled } = useHarnessScope(options.enabled);
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.leaseShot(backendId, leaseId),
    enabled,
    staleTime: 0,
    refetchInterval: options.refetchMs,
    queryFn: async () =>
      screenshotDataUrl(await VmHarnessService.leaseScreenshot(leaseId)),
    ...QUIET,
  });
}

/** Folder listing for the data folder picker. */
export function useVmHarnessBrowse(
  path: string,
  options: { enabled?: boolean } = {},
) {
  const { backendId, enabled } = useHarnessScope(options.enabled);
  return useQuery({
    queryKey: VM_HARNESS_QUERY_KEYS.browse(backendId, path),
    enabled,
    staleTime: 0,
    queryFn: () => VmHarnessService.browse(path),
    ...QUIET,
  });
}

/** Which OSes have a base image, and whether the host has the memory to start a VM now. */
export function useVmHarnessCapacity() {
  const images = useVmHarnessImages();
  const status = useVmHarnessStatus();

  /**
   * Whether a baseline can be booted. An older harness reports no roles, so a
   * clean target then falls back to "any image of that OS".
   */
  const hasImageFor = (target: GuiVmTarget): boolean | undefined => {
    if (!images.data) return undefined;
    if (images.data.some((image) => image.role === target)) return true;
    const rolesReported = images.data.some((image) => image.role);
    if (target.endsWith("-workspace") || rolesReported) return false;
    return images.data.some((image) => image.os === target);
  };

  /** Free and needed MB when the host cannot fit a VM of this OS right now. */
  const memoryShortfall = (os: "windows" | "ubuntu") => {
    const free = status.data?.host.freeRamMB;
    const base = status.data?.memoryMB?.[os];
    if (free === undefined || base === undefined) return null;
    const needed = base + 512;
    return free < needed ? { free, needed } : null;
  };

  return { hasImageFor, memoryShortfall };
}

/** Whether a run or lease was started for this issue or pull request. */
export function isForItem(
  context: { repository?: string; item?: string } | null | undefined,
  repository: string,
  itemNumber: number,
): boolean {
  return (
    context?.repository?.toLowerCase() === repository.toLowerCase() &&
    context.item === String(itemNumber)
  );
}

/** The VM runs started for one issue or pull request, newest first. */
export function useVmHarnessRunsForItem(
  repository: string,
  itemNumber: number,
): VmHarnessRun[] {
  const { data } = useVmHarnessRuns();
  return (data ?? []).filter((run) =>
    isForItem(run.context, repository, itemNumber),
  );
}

/** The VMs running now for one issue or pull request. */
export function useVmHarnessLeasesForItem(
  repository: string,
  itemNumber: number,
): VmHarnessLease[] {
  const { data } = useVmHarnessLeases();
  return (data ?? []).filter(
    (lease) =>
      (lease.status === "booting" || lease.status === "ready") &&
      isForItem(lease.context, repository, itemNumber),
  );
}
