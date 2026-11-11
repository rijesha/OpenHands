#!/usr/bin/env node
/**
 * Claude Code status line helper for Agent Canvas.
 *
 * Claude Code runs the configured `statusLine` command after each update and
 * passes a JSON document on stdin. Its documented `rate_limits` field (the
 * 5-hour and weekly usage windows of a claude.ai subscription) is the only
 * supported way to read the remaining limits, so this script saves it next to
 * Claude Code's own files where Canvas can read it. It prints nothing, so the
 * status line stays empty.
 *
 *   node statusline.mjs             capture mode, run by Claude Code
 *   node statusline.mjs --install   add this script as the `statusLine` command
 *
 * Install never replaces an existing `statusLine` setting and keeps a backup
 * of the settings file it changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CAPTURE_FILE_NAME = "canvas-usage.json";

function windowOf(value) {
  if (!value || typeof value !== "object") return null;
  const used = Number(value.used_percentage);
  if (!Number.isFinite(used)) return null;
  const resetsAt = Number(value.resets_at);
  return {
    usedPercentage: Math.min(100, Math.max(0, used)),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/** The part of Claude Code's status line input Canvas shows. */
export function buildCapture(input, now = Date.now()) {
  const limits = input?.rate_limits ?? {};
  return {
    capturedAt: now,
    fiveHour: windowOf(limits.five_hour),
    sevenDay: windowOf(limits.seven_day),
    effort:
      typeof input?.effort?.level === "string" ? input.effort.level : null,
  };
}

function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

/**
 * Points `statusLine` at `scriptPath` in a Claude Code settings file. Returns
 * `installed`, `already` (this script is set) or `occupied` (something else
 * is, and is left alone).
 */
export function installStatusLine(settingsPath, scriptPath) {
  const command = `node "${scriptPath}"`;
  let settings = {};
  let exists = false;
  if (fs.existsSync(settingsPath)) {
    exists = true;
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
  }
  const current = settings.statusLine;
  if (current?.command === command) return "already";
  if (current) return "occupied";

  if (exists) {
    fs.copyFileSync(settingsPath, `${settingsPath}.canvas-backup`);
  }
  settings.statusLine = { type: "command", command };
  writeAtomically(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return "installed";
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const claudeDir = path.join(os.homedir(), ".claude");
  if (process.argv.includes("--install")) {
    const result = installStatusLine(
      path.join(claudeDir, "settings.json"),
      fileURLToPath(import.meta.url),
    );
    process.stdout.write(`${result}\n`);
    process.exit(result === "occupied" ? 2 : 0);
  }

  try {
    const input = JSON.parse(await readStdin());
    writeAtomically(
      path.join(claudeDir, CAPTURE_FILE_NAME),
      JSON.stringify(buildCapture(input)),
    );
  } catch {
    // A status line must never break Claude Code.
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
