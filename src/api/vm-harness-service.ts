import CanvasExtensionsService from "#/api/canvas-extensions-service";

const VM_HARNESS_API = "/api/vm-harness";

/** What a VM run was started for (`context` of `vm_start`). */
export interface VmHarnessRunContext {
  repository?: string;
  item?: string;
  /** Whether `item` is an issue or a pull request (older runs do not say). */
  kind?: "issue" | "pull_request";
  conversationId?: string;
  title?: string;
}

export interface VmHarnessRun {
  id: string;
  imageId: string;
  os: string;
  startedAt: string;
  /** How the lease ended: `stopped`, `failed`; null while it is still known only from its start. */
  status: string | null;
  /** The boot stage a failed lease stopped at. */
  stage: string | null;
  error: string | null;
  context: VmHarnessRunContext | null;
  hasBootFailureShot: boolean;
  /** Null until the agent submits its report. */
  report: { passed: boolean; summary: string; steps: number } | null;
}

export interface VmHarnessImage {
  imageId: string;
  os: string;
  kind: string;
  /** Baseline role ("windows", "windows-workspace", "ubuntu", "ubuntu-workspace"), else null. */
  role?: string | null;
  label?: string | null;
  notes?: string | null;
  description?: string | null;
  createdAt?: string | null;
  parentImageId?: string | null;
  /** The baseline a snapshot descends from. */
  baselineRoot?: string | null;
  sizeBytes?: number;
  /** Ids of images made from this one. */
  children?: string[];
  inUse?: boolean;
  /** A baseline is locked unless the user opened it for changes. */
  locked?: boolean;
  /** Epoch ms until which an opened baseline stays unlocked. */
  unlockedUntil?: number | null;
}

export interface VmHarnessStatus {
  provider?: string;
  host: {
    ok: boolean;
    problems?: string[];
    freeRamMB?: number;
    freeDiskGB?: number;
  };
  maxVms?: number;
  /** Memory one VM of each OS needs. */
  memoryMB?: { windows: number; ubuntu: number };
  root?: string;
  rootSource?: string;
  imagesDir?: string;
  pluginDir?: string | null;
}

export interface VmHarnessSettings {
  root: string;
  rootSource?: string;
  imagesDir?: string;
  imageCount?: number;
  hasGuestKey?: boolean;
  runningVms?: number;
}

export interface VmHarnessBrowseListing {
  path: string;
  /** Parent folder; null when at the top of the listing. */
  parent: string | null;
  dirs: string[];
  hasImages?: boolean;
}

export type VmHarnessLeaseStatus = "booting" | "ready" | "failed" | "stopped";

export interface VmHarnessLease {
  id: string;
  imageId: string;
  os: string;
  app?: string;
  status: VmHarnessLeaseStatus;
  stage?: string;
  error?: string | null;
  ip?: string | null;
  startedAt: string;
  memoryMB?: number;
  context?: VmHarnessRunContext | null;
  ttlSecondsLeft?: number;
}

export type VmHarnessStepStatus = "pass" | "fail" | "blocked" | "skipped";

export interface VmHarnessStep {
  id: string;
  title: string;
  status: VmHarnessStepStatus;
  expected: string;
  observed: string;
  evidence?: string[];
}

export interface VmHarnessReport {
  verdict: { passed: boolean; confidence?: string };
  summary: string;
  envProblems?: string[];
}

export interface VmHarnessRunDetail {
  lease: Record<string, unknown>;
  report: VmHarnessReport | null;
  steps: VmHarnessStep[];
  /** Screenshot file names, fetched one at a time. */
  screenshots: string[];
}

export interface VmHarnessScreenshot {
  pngBase64?: string;
  width?: number;
  height?: number;
  /** Boot-failure text when no screenshot was captured. */
  details?: string;
}

/** One desktop action a user can send to a ready VM. */
export type VmHarnessDesktopAction =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; combo: string };

const id = encodeURIComponent;

const request = <T>(
  path: string,
  method?: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
) =>
  CanvasExtensionsService.requestAgentServer<T>({
    path: `${VM_HARNESS_API}${path}`,
    ...(method ? { method } : {}),
    ...(body === undefined ? {} : { body }),
  });

const asArray = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) {
    throw new Error("Unexpected response from the VM harness");
  }
  return value as T[];
};

/** The GUI VM harness's own HTTP API, reached through the agent-server ingress. */
export const VmHarnessService = {
  status: () => request<VmHarnessStatus>("/status"),
  settings: () => request<VmHarnessSettings>("/settings"),
  saveRoot: (root: string) =>
    request<VmHarnessSettings>("/settings", "POST", { root }),
  browse: (path: string) =>
    request<VmHarnessBrowseListing>(`/browse?path=${id(path)}`),

  listImages: async () => asArray<VmHarnessImage>(await request("/images")),
  updateImage: (imageId: string, patch: { label?: string; notes?: string }) =>
    request<{ ok: true }>(`/images/${id(imageId)}`, "PATCH", patch),
  deleteImage: (imageId: string) =>
    request<unknown>(`/images/${id(imageId)}`, "DELETE"),
  unlockImage: (imageId: string, minutes: number) =>
    request<{ ok: true }>(`/images/${id(imageId)}/unlock`, "POST", {
      minutes,
    }),
  lockImage: (imageId: string) =>
    request<{ ok: true }>(`/images/${id(imageId)}/lock`, "POST"),

  listLeases: async () => asArray<VmHarnessLease>(await request("/leases")),
  startLease: (image: string) =>
    request<VmHarnessLease>("/leases", "POST", { image }),
  stopLease: (leaseId: string) =>
    request<{ ok: true }>(`/leases/${id(leaseId)}/stop`, "POST"),
  extendLease: (leaseId: string) =>
    request<{ ok: true }>(`/leases/${id(leaseId)}/extend`, "POST"),
  snapshotLease: (leaseId: string, name: string, notes: string) =>
    request<{ imageId: string }>(`/leases/${id(leaseId)}/snapshot`, "POST", {
      name,
      notes,
    }),
  sendInput: (leaseId: string, action: VmHarnessDesktopAction) =>
    request<{ ok: true }>(`/leases/${id(leaseId)}/input`, "POST", action),
  leaseScreenshot: (leaseId: string) =>
    request<VmHarnessScreenshot>(`/leases/${id(leaseId)}/screenshot`),

  listRuns: async () => asArray<VmHarnessRun>(await request("/runs")),
  getRun: (runId: string) => request<VmHarnessRunDetail>(`/runs/${id(runId)}`),
  deleteRun: (runId: string) =>
    request<{ ok: true }>(`/runs/${id(runId)}`, "DELETE"),
  runScreenshot: (runId: string, name: string) =>
    request<VmHarnessScreenshot>(`/runs/${id(runId)}/screenshots/${id(name)}`),
  bootFailureShot: (runId: string) =>
    request<VmHarnessScreenshot>(`/runs/${id(runId)}/boot-failure`),
};

/** Path of the Test VMs page (a built-in route). */
export const TEST_VMS_PATH = "/test-vms";

/** The Test VMs page's path for one run. */
export const vmHarnessRunPath = (runId: string) =>
  `${TEST_VMS_PATH}/runs/${encodeURIComponent(runId)}`;

/** `data:` URL of a screenshot the harness returned as base64, or null. */
export const screenshotDataUrl = (
  shot: VmHarnessScreenshot | undefined,
): string | null =>
  shot?.pngBase64 ? `data:image/png;base64,${shot.pngBase64}` : null;
