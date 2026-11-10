import fs from "node:fs";
import path from "node:path";

export const STEP_STATUSES = ["pass", "fail", "blocked", "skipped"];

/** Reads the recorded steps; a later record with the same id replaces the earlier one. */
export function readSteps(stepsFile) {
  if (!fs.existsSync(stepsFile)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(stepsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    byId.set(rec.id, rec);
  }
  return [...byId.values()];
}

/**
 * Builds the report, refusing a verdict that contradicts the recorded steps. This is what keeps an agent honest:
 * `passed: true` is only accepted when every recorded step passed (or was skipped with a reason).
 */
export function assembleReport({ leaseId, imageId, os }, steps, verdict) {
  if (!steps.length)
    throw new Error(
      "No steps were recorded. Call record_step for each step before submit_report.",
    );
  const failing = steps.filter(
    (s) => s.status === "fail" || s.status === "blocked",
  );
  if (verdict.passed && failing.length) {
    throw new Error(
      `passed=true contradicts the recorded steps: ${failing.map((s) => `${s.id}=${s.status}`).join(", ")}`,
    );
  }
  if (
    !verdict.passed &&
    !failing.length &&
    !(verdict.regressions ?? []).length
  ) {
    throw new Error(
      "passed=false but no step failed and no regression was listed; record the failing step or list the regression.",
    );
  }
  const unevidenced = steps.filter(
    (s) => s.status === "pass" && !(s.evidence ?? []).length,
  );
  if (verdict.confidence === "high" && unevidenced.length) {
    throw new Error(
      `confidence=high needs evidence for every passed step; missing: ${unevidenced.map((s) => s.id).join(", ")}`,
    );
  }
  return {
    schemaVersion: 1,
    leaseId,
    imageId,
    os,
    submittedAt: new Date().toISOString(),
    verdict: {
      passed: verdict.passed,
      confidence: verdict.confidence,
      regressions: verdict.regressions ?? [],
    },
    envProblems: verdict.envProblems ?? [],
    summary: verdict.summary,
    steps,
  };
}

/** Lists finished runs (one folder per lease) for the dashboard. */
export function listRuns(runsDir) {
  let names;
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const id of names) {
    const dir = path.join(runsDir, id);
    const meta = readJson(path.join(dir, "lease.json"));
    if (!meta) continue;
    const report = readJson(path.join(dir, "report.json"));
    runs.push({
      id,
      imageId: meta.imageId,
      os: meta.os,
      startedAt: meta.startedAt,
      // How the lease ended and what it was for: a failed boot has no report, so these explain it.
      status: meta.status ?? null,
      stage: meta.stage ?? null,
      error: meta.error ?? null,
      context: meta.context ?? null,
      hasBootFailureShot: fs.existsSync(path.join(dir, "boot-failure.png")),
      report: report
        ? {
            passed: report.verdict.passed,
            summary: report.summary,
            steps: report.steps.length,
          }
        : null,
    });
  }
  return runs.sort((a, b) =>
    String(b.startedAt).localeCompare(String(a.startedAt)),
  );
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
