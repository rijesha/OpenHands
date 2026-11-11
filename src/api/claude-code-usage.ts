import statuslineSource from "../../scripts/claude-code-info/statusline.mjs?raw";
import type { BashCommandRunner } from "#/hooks/use-bash-command-runner";

/** One of Claude Code's usage windows, as its status line reports it. */
export interface ClaudeCodeUsageWindow {
  /** 0 to 100, how much of the window is used. */
  usedPercentage: number;
  /** Unix seconds when the window resets. */
  resetsAt: number | null;
}

export interface ClaudeCodeUsage {
  /** Unix milliseconds when Claude Code last reported. */
  capturedAt: number;
  fiveHour: ClaudeCodeUsageWindow | null;
  sevenDay: ClaudeCodeUsageWindow | null;
}

// The agent-server runs commands through whatever shell its host has (cmd.exe
// on Windows), so these are plain `node -e` programs with no shell syntax:
// double quotes outside, single quotes inside, no `$`, pipes or redirects.
// Asks Anthropic's usage endpoint (the one Claude Code's own /usage reads) with
// the login Claude Code keeps in ~/.claude, so the figures are live even when
// Claude Code is idle. The token is read and used on the agent-server's host
// only; the output is just the two windows. Falls back to the file the status
// line helper writes (see below). It does not refresh an expired token: Claude
// Code does that itself the next time it runs.
const READ_CAPTURE = `node -e "const f=require('fs'),p=require('path'),h=p.join(require('os').homedir(),'.claude');const w=function(x){return x&&typeof x.utilization==='number'?{usedPercentage:x.utilization,resetsAt:x.resets_at?Date.parse(x.resets_at)/1000:null}:null};(async function(){try{const o=JSON.parse(f.readFileSync(p.join(h,'.credentials.json'),'utf8')).claudeAiOauth;const r=await fetch('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:'Bearer '+o.accessToken,'anthropic-beta':'oauth-2025-04-20'},signal:AbortSignal.timeout(8000)});if(!r.ok)throw 0;const j=await r.json();process.stdout.write(JSON.stringify({capturedAt:Date.now(),fiveHour:w(j.five_hour),sevenDay:w(j.seven_day)}));return}catch(e){}try{process.stdout.write(f.readFileSync(p.join(h,'canvas-usage.json'),'utf8'))}catch(e){process.exit(1)}})()"`;
const INSTALL_HELPER = `node -e "const f=require('fs'),p=require('path'),d=p.join(require('os').homedir(),'.claude'),s=p.join(d,'canvas-statusline.mjs');f.mkdirSync(d,{recursive:true});f.writeFileSync(s,Buffer.from(process.argv[1],'base64'));const r=require('child_process').spawnSync(process.execPath,[s,'--install'],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status===null?1:r.status)"`;

function asWindow(value: unknown): ClaudeCodeUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const { usedPercentage, resetsAt } = value as Record<string, unknown>;
  if (typeof usedPercentage !== "number") return null;
  return {
    usedPercentage,
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
  };
}

/** Reads the file the status line helper writes; anything else gives `null`. */
export function parseUsageCapture(text: string): ClaudeCodeUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { capturedAt, fiveHour, sevenDay } = parsed as Record<string, unknown>;
  if (typeof capturedAt !== "number") return null;
  const usage = {
    capturedAt,
    fiveHour: asWindow(fiveHour),
    sevenDay: asWindow(sevenDay),
  };
  // A report without either window (an API-key account) has nothing to show.
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

/** `null` when Claude Code has not reported limits yet (or the helper is not installed). */
export async function readClaudeCodeUsage(
  run: BashCommandRunner,
): Promise<ClaudeCodeUsage | null> {
  const result = await run(READ_CAPTURE, undefined, 15);
  return result.exit_code === 0 ? parseUsageCapture(result.stdout) : null;
}

export type StatuslineInstallResult = "installed" | "already" | "occupied";

/**
 * Copies the helper into `~/.claude` and points Claude Code's `statusLine` at
 * it. An existing `statusLine` of the user's is never replaced.
 */
export async function installClaudeCodeStatusline(
  run: BashCommandRunner,
): Promise<StatuslineInstallResult> {
  const bytes = new TextEncoder().encode(statuslineSource);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const result = await run(`${INSTALL_HELPER} ${btoa(binary)}`, undefined, 30);
  const outcome = result.stdout.trim().split(/\s+/).pop();
  if (outcome === "installed" || outcome === "already") return outcome;
  if (outcome === "occupied") return "occupied";
  throw new Error((result.stderr || result.stdout).trim() || "install failed");
}
