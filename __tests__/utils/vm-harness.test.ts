import { describe, expect, it } from "vitest";
import type { VmHarnessImage, VmHarnessStep } from "#/api/vm-harness-service";
import {
  formatBytes,
  githubItemPath,
  groupImages,
  memoryNeededMB,
  minutesLeft,
  minutesUntil,
  orderImages,
  stepsByScreenshot,
  toScreenPoint,
  vmRunVerdict,
} from "#/utils/vm-harness";

const image = (extra: Partial<VmHarnessImage> & { imageId: string }) =>
  ({ os: "windows", kind: "prepared", ...extra }) as VmHarnessImage;

describe("vmRunVerdict", () => {
  it("tells a failed boot apart from a run whose agent never reported", () => {
    expect(vmRunVerdict({ report: null, status: "failed" })).toBe(
      "boot_failed",
    );
    expect(vmRunVerdict({ report: null, status: "stopped" })).toBe("no_report");
    expect(vmRunVerdict({ report: null, status: null })).toBe("no_report");
  });

  it("reports the verdict of a submitted report even when the VM failed later", () => {
    const report = { passed: true, summary: "ok", steps: 2 };
    expect(vmRunVerdict({ report, status: "stopped" })).toBe("passed");
    expect(
      vmRunVerdict({ report: { ...report, passed: false }, status: "failed" }),
    ).toBe("failed");
  });
});

describe("images", () => {
  it("formats sizes and nests snapshots under their base image", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(28_273_803_264)).toBe("26 GB");
    const rows = orderImages([
      image({ imageId: "snap", parentImageId: "base" }),
      image({ imageId: "other" }),
      image({ imageId: "base" }),
      image({ imageId: "orphan", parentImageId: "gone" }),
    ]);
    expect(rows.map((row) => [row.image.imageId, row.depth])).toEqual([
      ["other", 0],
      ["base", 0],
      ["snap", 1],
      ["orphan", 0],
    ]);
  });

  it("sorts baselines in role order and keeps strays apart from snapshots", () => {
    const { bases, snaps, other } = groupImages([
      image({ imageId: "u", kind: "golden", role: "ubuntu" }),
      image({ imageId: "snap", baselineRoot: "w" }),
      image({ imageId: "stray" }),
      image({ imageId: "w", kind: "golden", role: "windows" }),
      image({ imageId: "ww", role: "windows-workspace" }),
    ]);
    expect(bases.map((b) => b.imageId)).toEqual(["w", "ww", "u"]);
    expect(snaps.map((s) => s.imageId)).toEqual(["snap"]);
    expect(other.map((s) => s.imageId)).toEqual(["stray"]);
  });
});

describe("stepsByScreenshot", () => {
  it("matches evidence paths from either OS to screenshot files", () => {
    const step = (id: string, evidence: string[]) =>
      ({ id, evidence }) as VmHarnessStep;
    const map = stepsByScreenshot([
      step("s1", [String.raw`C:\runs\l1\screenshots\001-a.png`]),
      step("s2", ["/runs/l1/screenshots/001-a.png"]),
    ]);
    expect(map.get("001-a.png")?.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("host capacity wording", () => {
  it("adds the memory the harness keeps free and lists each distinct need once", () => {
    expect(memoryNeededMB(undefined)).toEqual([]);
    expect(
      memoryNeededMB({
        host: { ok: true },
        memoryMB: { windows: 6144, ubuntu: 4096 },
      }),
    ).toEqual([4608, 6656]);
    expect(
      memoryNeededMB({
        host: { ok: true },
        memoryMB: { windows: 4096, ubuntu: 4096 },
      }),
    ).toEqual([4608]);
  });

  it("rounds idle time and open time up to a minute", () => {
    expect(minutesUntil(20)).toBe(1);
    expect(minutesUntil(47 * 60)).toBe(47);
    expect(minutesUntil(undefined)).toBeNull();
    expect(minutesLeft(1_000 + 90_000, 1_000)).toBe(2);
    expect(minutesLeft(0, 1_000)).toBe(1);
  });
});

describe("manual control", () => {
  it("maps a click on the scaled screenshot to VM pixels and stays on screen", () => {
    expect(toScreenPoint(320, 200, 640, 400)).toEqual({ x: 640, y: 400 });
    expect(toScreenPoint(-5, 9999, 640, 400)).toEqual({ x: 0, y: 799 });
  });
});

describe("githubItemPath", () => {
  it("opens the pull request tab by default and the issue list for an issue", () => {
    expect(githubItemPath("acme/widgets", "7", "pull_request")).toBe(
      "/github?repo=acme%2Fwidgets&item=7&state=all&tab=pulls",
    );
    expect(githubItemPath("acme/widgets", "7", undefined)).toContain(
      "tab=pulls",
    );
    expect(githubItemPath("acme/widgets", "7", "issue")).toBe(
      "/github?repo=acme%2Fwidgets&item=7&state=all",
    );
  });
});
