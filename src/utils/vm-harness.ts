import { I18nKey } from "#/i18n/declaration";
import type {
  VmHarnessImage,
  VmHarnessRun,
  VmHarnessStatus,
  VmHarnessStep,
} from "#/api/vm-harness-service";

/** How a finished VM run ended, as one word the UI maps to copy and colour. */
export type VmRunVerdict = "passed" | "failed" | "boot_failed" | "no_report";

export function vmRunVerdict(
  run: Pick<VmHarnessRun, "report" | "status">,
): VmRunVerdict {
  if (run.report) return run.report.passed ? "passed" : "failed";
  return run.status === "failed" ? "boot_failed" : "no_report";
}

/** Copy and colour of each verdict; the labels take the boot `stage` as a placeholder. */
export const VM_RUN_VERDICT_COPY: Record<
  VmRunVerdict,
  { label: I18nKey; tone: string }
> = {
  passed: { label: I18nKey.GITHUB$VM_RUN_PASSED, tone: "text-success" },
  failed: { label: I18nKey.GITHUB$VM_RUN_FAILED, tone: "text-danger" },
  boot_failed: {
    label: I18nKey.GITHUB$VM_RUN_BOOT_FAILED,
    tone: "text-danger",
  },
  no_report: { label: I18nKey.GITHUB$VM_RUN_NO_REPORT, tone: "text-muted" },
};

/** The baseline roles in the order the page lists them. */
export const BASELINE_ORDER = [
  "windows",
  "windows-workspace",
  "ubuntu",
  "ubuntu-workspace",
  "macos",
  "macos-workspace",
] as const;

export type BaselineRole = (typeof BASELINE_ORDER)[number];

/** Baselines are what every run and snapshot starts from: the clean bases and the prepared workspace images. */
export function isBaselineImage(
  image: Pick<VmHarnessImage, "kind" | "role">,
): boolean {
  return image.kind === "golden" || Boolean(image.role);
}

/** Splits images into baselines (in role order), snapshots descended from one, and everything else. */
export function groupImages(images: VmHarnessImage[]) {
  const bases = images.filter(isBaselineImage);
  const rank = (image: VmHarnessImage) => {
    const at = BASELINE_ORDER.indexOf(image.role as BaselineRole);
    return at < 0 ? BASELINE_ORDER.length : at;
  };
  bases.sort((a, b) => rank(a) - rank(b));
  const rest = images.filter((image) => !isBaselineImage(image));
  return {
    bases,
    snaps: rest.filter((image) => image.baselineRoot),
    other: rest.filter((image) => !image.baselineRoot),
  };
}

export interface ImageTreeRow {
  image: VmHarnessImage;
  depth: number;
}

/** Orders images as a tree: each image followed by the snapshots made from it, with their depth. */
export function orderImages(images: VmHarnessImage[]): ImageTreeRow[] {
  const ids = new Set(images.map((image) => image.imageId));
  const byParent = new Map<string, VmHarnessImage[]>();
  for (const image of images) {
    const key =
      image.parentImageId && ids.has(image.parentImageId)
        ? image.parentImageId
        : "";
    byParent.set(key, [...(byParent.get(key) ?? []), image]);
  }
  const out: ImageTreeRow[] = [];
  const walk = (parent: string, depth: number) => {
    for (const image of byParent.get(parent) ?? []) {
      out.push({ image, depth });
      walk(image.imageId, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** Evidence paths in a step are host paths; the gallery matches them to screenshot files by name. */
export function baseName(path: string | null | undefined): string {
  return String(path ?? "")
    .split(/[\\/]/)
    .pop() as string;
}

/** Maps each screenshot file name to the steps that cite it. */
export function stepsByScreenshot(
  steps: VmHarnessStep[] | undefined,
): Map<string, VmHarnessStep[]> {
  const map = new Map<string, VmHarnessStep[]>();
  for (const step of steps ?? []) {
    for (const evidence of step.evidence ?? []) {
      const key = baseName(evidence);
      map.set(key, [...(map.get(key) ?? []), step]);
    }
  }
  return map;
}

/** "1.5 GB", "320 MB", or "—" when the size is unknown. */
export function formatBytes(bytes: number | undefined | null): string {
  if (!Number.isFinite(bytes) || (bytes as number) <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let value = bytes as number;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Whole minutes until the idle reaper stops a VM, at least 1. */
export function minutesUntil(seconds: number | undefined): number | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  return Math.max(1, Math.round(seconds / 60));
}

/** Minutes left of an opened baseline (`unlockedUntil` is epoch milliseconds). */
export function minutesLeft(until: number, now = Date.now()): number {
  return Math.max(1, Math.round((until - now) / 60_000));
}

/** MB a VM needs on the host: its own memory plus the 512 MB the harness keeps free. */
export function memoryNeededMB(status: VmHarnessStatus | undefined): number[] {
  const memory = status?.memoryMB;
  if (!memory) return [];
  return [...new Set([memory.ubuntu, memory.windows, memory.macos])]
    .filter((mb): mb is number => typeof mb === "number")
    .map((mb) => mb + 512)
    .sort((a, b) => a - b);
}

/** Screen size the harness reports click coordinates in, unless a screenshot says otherwise. */
export const VM_SCREEN = { width: 1280, height: 800 } as const;

/**
 * Maps a click on the (scaled) screenshot to VM screen pixels, kept on screen. `screen` is the size the screenshot
 * came in (a macOS guest may not run at the default 1280x800).
 */
export function toScreenPoint(
  offsetX: number,
  offsetY: number,
  shownWidth: number,
  shownHeight: number,
  screen: { width: number; height: number } = VM_SCREEN,
): { x: number; y: number } {
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(Math.round(value), 0), max - 1);
  return {
    x: clamp((offsetX / shownWidth) * screen.width, screen.width),
    y: clamp((offsetY / shownHeight) * screen.height, screen.height),
  };
}

/** Path of the GitHub page for the issue or pull request a VM run was started for. */
export function githubItemPath(
  repository: string,
  item: string,
  kind: "issue" | "pull_request" | undefined,
): string {
  const params = new URLSearchParams({ repo: repository, item, state: "all" });
  // A run from before the context named its kind is most often for a pull request.
  if (kind !== "issue") params.set("tab", "pulls");
  return `/github?${params.toString()}`;
}
