import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCapture,
  installStatusLine,
} from "../../scripts/claude-code-info/statusline.mjs";

describe("buildCapture", () => {
  it("keeps the usage windows and the effort level from Claude Code's status line input", () => {
    const capture = buildCapture(
      {
        rate_limits: {
          five_hour: { used_percentage: 41.5, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 130, resets_at: 1_800_500_000 },
        },
        effort: { level: "high" },
        unrelated: "dropped",
      },
      123,
    );

    expect(capture).toEqual({
      capturedAt: 123,
      fiveHour: { usedPercentage: 41.5, resetsAt: 1_800_000_000 },
      // Never beyond a full window.
      sevenDay: { usedPercentage: 100, resetsAt: 1_800_500_000 },
      effort: "high",
    });
  });

  it("leaves out whatever Claude Code did not report", () => {
    expect(buildCapture({ rate_limits: { five_hour: {} } }, 1)).toEqual({
      capturedAt: 1,
      fiveHour: null,
      sevenDay: null,
      effort: null,
    });
  });
});

describe("installStatusLine", () => {
  let dir: string;
  let settings: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-statusline-"));
    settings = path.join(dir, "settings.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds the status line, keeps the other settings, and backs up the file", () => {
    fs.writeFileSync(settings, JSON.stringify({ model: "opus" }));

    expect(installStatusLine(settings, "/home/me/.claude/s.mjs")).toBe(
      "installed",
    );

    expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({
      model: "opus",
      statusLine: {
        type: "command",
        command: 'node "/home/me/.claude/s.mjs"',
      },
    });
    expect(
      JSON.parse(fs.readFileSync(`${settings}.canvas-backup`, "utf8")),
    ).toEqual({ model: "opus" });
  });

  it("creates the settings file when there is none", () => {
    expect(installStatusLine(settings, "/s.mjs")).toBe("installed");
    expect(fs.existsSync(`${settings}.canvas-backup`)).toBe(false);
  });

  it("is a no-op the second time", () => {
    installStatusLine(settings, "/s.mjs");

    expect(installStatusLine(settings, "/s.mjs")).toBe("already");
  });

  it("never replaces a status line the user already has", () => {
    const original = JSON.stringify({
      statusLine: { type: "command", command: "my-own-line" },
    });
    fs.writeFileSync(settings, original);

    expect(installStatusLine(settings, "/s.mjs")).toBe("occupied");
    expect(fs.readFileSync(settings, "utf8")).toBe(original);
    expect(fs.existsSync(`${settings}.canvas-backup`)).toBe(false);
  });
});
