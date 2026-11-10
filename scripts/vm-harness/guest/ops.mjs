const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Throws a readable error when a guest command failed or timed out (a timeout is otherwise silent). */
function assertOk(r, what, timeoutMs) {
  if (r.code === 0 && !r.timedOut) return r;
  const why = r.timedOut
    ? ` (timed out after ${Math.round(timeoutMs / 1000)} s)`
    : "";
  throw new Error(`${what} failed${why}: ${String(r.stderr ?? "").trim()}`);
}

/** Guest paths and GUI-session helpers for a Windows guest (the ai-qa golden images: user "zide"). */
class WindowsOps {
  constructor(session, user) {
    this.s = session;
    this.user = user;
    this.paths = {
      inbox: "C:\\zide\\in",
      workspace: "C:\\zws",
      appLogs: `C:\\Users\\${user}\\AppData\\Roaming\\Code\\logs`,
    };
  }

  waitForDesktop(timeoutMs) {
    return poll(
      async () =>
        (
          await this.s.exec(
            "(Get-Process explorer -ErrorAction SilentlyContinue | Measure-Object).Count",
            { timeoutMs: 15_000 },
          )
        ).stdout.trim() !== "0",
      timeoutMs,
      "the Windows desktop (explorer)",
    );
  }

  async launchVsCode({ cdpPort, extraArgs = [], folder }) {
    const cfg = JSON.stringify({
      workspace: folder ?? this.paths.workspace,
      cdpPort,
      extraArgs,
    });
    const r = await this.s.exec(
      `Set-Content -Path C:\\zide\\run\\launch.json -Value '${cfg.replace(/'/g, "''")}' -Encoding ascii; Stop-ScheduledTask -TaskName ZideLaunchVSCode -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName ZideLaunchVSCode`,
      { timeoutMs: 30_000 },
    );
    assertOk(r, "launching VS Code", 30_000);
  }

  killApp() {
    return this.s.exec(
      "Get-Process Code -ErrorAction SilentlyContinue | Stop-Process -Force",
      { timeoutMs: 30_000 },
    );
  }

  async appRunning() {
    return (
      (
        await this.s.exec(
          "(Get-Process Code -ErrorAction SilentlyContinue | Measure-Object).Count",
          { timeoutMs: 20_000 },
        )
      ).stdout.trim() !== "0"
    );
  }

  /** `keep` leaves the workspace as the image has it (prepared images and snapshots hold a set-up workspace). */
  async resetWorkspace({ keep = false } = {}) {
    // argv.json written by Windows PowerShell with a BOM makes VS Code reject it.
    const argv = `C:\Users\${this.user}\.vscode\argv.json`;
    const clear = keep
      ? ""
      : `; Get-ChildItem '${this.paths.workspace}' -Force | Remove-Item -Recurse -Force`;
    const r = await this.s.exec(
      `[IO.File]::WriteAllText('${argv}', '{ "enable-crash-reporter": false }', (New-Object Text.UTF8Encoding $false)); New-Item -ItemType Directory -Force '${this.paths.workspace}' | Out-Null${clear}`,
      { timeoutMs: 60_000 },
    );
    assertOk(r, "resetting the workspace", 60_000);
  }

  async pendingElevation() {
    const r = await this.s.exec(
      "(Get-Process consent -ErrorAction SilentlyContinue | Measure-Object).Count",
      { timeoutMs: 15_000 },
    );
    return r.stdout.trim() !== "0" ? "uac" : null;
  }
}

class UbuntuOps {
  constructor(session, user) {
    this.s = session;
    this.user = user;
    this.paths = {
      inbox: `/home/${user}/zide-in`,
      workspace: `/home/${user}/zws`,
      appLogs: `/home/${user}/.config/Code/logs`,
    };
  }

  waitForDesktop(timeoutMs) {
    return poll(
      async () =>
        (
          await this.s.exec(
            "systemctl --user show-environment | grep -q WAYLAND_DISPLAY",
            { timeoutMs: 15_000 },
          )
        ).code === 0,
      timeoutMs,
      "the Ubuntu desktop session",
    );
  }

  async launchVsCode({ cdpPort, extraArgs = [], folder }) {
    const extra = extraArgs
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const target = (folder ?? this.paths.workspace).replace(/'/g, "'\\''");
    const r = await this.s.exec(
      `~/zide-bin/launch-vscode.sh '${target}' ${cdpPort} ${extra}`,
      { timeoutMs: 30_000 },
    );
    assertOk(r, "launching VS Code", 30_000);
  }

  killApp() {
    return this.s.exec(
      "systemctl --user stop 'zide-vscode-*' 2>/dev/null; pkill -f /usr/share/code/code || true",
      { timeoutMs: 30_000 },
    );
  }

  async appRunning() {
    return (
      (
        await this.s.exec(
          "pgrep -f /usr/share/code/code >/dev/null && echo yes || echo no",
          { timeoutMs: 20_000 },
        )
      ).stdout.trim() === "yes"
    );
  }

  async resetWorkspace({ keep = false } = {}) {
    const clear = keep
      ? ""
      : ` && find ${this.paths.workspace} -mindepth 1 -delete`;
    const r = await this.s.exec(`mkdir -p ${this.paths.workspace}${clear}`, {
      timeoutMs: 60_000,
    });
    assertOk(r, "resetting the workspace", 60_000);
  }

  async pendingElevation() {
    const r = await this.s.exec(
      "pgrep -x sudo >/dev/null && echo yes || echo no",
      { timeoutMs: 15_000 },
    );
    return r.stdout.trim() === "yes" ? "sudo" : null;
  }
}

export function opsFor(os, session, user) {
  return os === "windows"
    ? new WindowsOps(session, user)
    : new UbuntuOps(session, user);
}

/**
 * Restarts VS Code reliably: wait for every process to exit, relaunch, then give the launcher time to start it (a busy
 * guest needs far more than a few seconds; killing it early and relaunching drops the start).
 * `startWaitMs` is how long one launch may take to show a VS Code process before the next attempt.
 * @param {any} ops
 * @param {{ cdpPort: number, folder?: string, startWaitMs?: number }} o
 */
export async function restartVsCode(
  ops,
  { cdpPort, folder, startWaitMs = 45_000 },
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ops.killApp();
    for (let i = 0; i < 15 && (await ops.appRunning().catch(() => true)); i++)
      await sleep(1000);
    await sleep(1500);
    await ops.launchVsCode(folder ? { cdpPort, folder } : { cdpPort });
    for (let waited = 0; waited < startWaitMs; waited += 2000) {
      await sleep(2000);
      if (await ops.appRunning().catch(() => false)) return;
    }
  }
  throw new Error("VS Code did not come back after 3 launch attempts");
}
