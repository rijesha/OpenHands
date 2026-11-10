import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

/** PowerShell -EncodedCommand wants base64 of UTF-16LE, which avoids every quoting problem. */
export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Windows PowerShell reports errors over a non-interactive session as CLIXML ("#< CLIXML" and an XML document), which is
 * unreadable. Returns the plain error lines; text that is not CLIXML is returned unchanged.
 */
export function decodeClixml(text) {
  const raw = String(text);
  if (!raw.includes("#< CLIXML")) return text;
  const lines = [];
  for (const m of raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)) {
    const line = m[1]
      .replace(/_x000D_|_x000A_/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
    if (line) lines.push(line);
  }
  // Text outside the XML is kept; progress records carry no <S S="Error"> and drop out.
  const rest = raw
    .replace(/#< CLIXML\r?\n?/g, "")
    .replace(/<Objs[\s\S]*?<\/Objs>/g, "")
    .trim();
  return [...lines, rest].filter(Boolean).join("\n");
}

/** Parses `ssh-keygen -lf` output ("256 SHA256:xxxx comment (ED25519)") into the fingerprint. */
export function parseFingerprint(line) {
  return line.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
}

export class HostKeyMismatch extends Error {}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const c = net.connect(port, "127.0.0.1");
      c.once("connect", () => {
        c.destroy();
        resolve();
      });
      c.once("error", () => {
        c.destroy();
        if (Date.now() > deadline)
          reject(new Error(`port ${port} did not open`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile(
      "taskkill",
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true },
      () => undefined,
    );
  } else {
    child.kill("SIGKILL");
  }
}

/**
 * SSH session to a guest. The host key is pinned to the fingerprint recorded in the image manifest.
 * `os` is "windows" (PowerShell default shell) or anything else (bash).
 */
export class SshGuestSession {
  /** @param {{ os: string, host: string, user: string, keyPath: string, expectedFingerprint: string, workDir: string }} o */
  constructor(o) {
    this.o = o;
    this.os = o.os;
    this.host = o.host;
    this.user = o.user;
    fs.mkdirSync(o.workDir, { recursive: true });
    this.knownHosts = path.join(o.workDir, `known_hosts_${o.host}`);
    this.forwards = new Set();
  }

  #sshArgs(extra = []) {
    return [
      "-i",
      this.o.keyPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.knownHosts}`,
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ServerAliveInterval=15",
      ...extra,
    ];
  }

  async connect({ timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        // Learn the host key with a real ssh connection rather than ssh-keyscan: the Windows ssh-keyscan (9.5) cannot
        // negotiate the key exchange newer guests (Ubuntu 26.04, OpenSSH 10) offer, while ssh itself can. The key is
        // only trusted after its fingerprint matches the image manifest.
        const tmp = `${this.knownHosts}.scan`;
        fs.rmSync(tmp, { force: true });
        const probe = await this.#run(
          "ssh",
          [
            "-i",
            this.o.keyPath,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "HashKnownHosts=no",
            "-o",
            `UserKnownHostsFile=${tmp}`,
            "-o",
            "ConnectTimeout=8",
            `${this.user}@${this.host}`,
            "exit",
          ],
          undefined,
          { timeoutMs: 20_000 },
        );
        if (!fs.existsSync(tmp)) {
          throw new Error(
            probe.stderr.trim().split("\n").pop() || "no host key returned",
          );
        }
        const fp = parseFingerprint(
          (await execFileP("ssh-keygen", ["-lf", tmp], { windowsHide: true }))
            .stdout,
        );
        if (fp !== this.o.expectedFingerprint) {
          fs.rmSync(tmp, { force: true });
          throw new HostKeyMismatch(
            `host key ${fp} does not match the image manifest (${this.o.expectedFingerprint})`,
          );
        }
        fs.renameSync(tmp, this.knownHosts);
        const r = await this.exec("exit 0", { timeoutMs: 20_000 });
        if (r.code === 0) return;
        lastErr = r.stderr.trim().split("\n").pop() ?? "";
      } catch (e) {
        if (e instanceof HostKeyMismatch) throw e;
        // execFile errors carry the tool's own stderr, which says why (refused, timed out, no route).
        const detail = String(e?.stderr ?? "")
          .trim()
          .split("\n")
          .pop();
        lastErr = [String(e?.message ?? e).split("\n")[0], detail]
          .filter(Boolean)
          .join(" | ");
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(
      `SSH to ${this.host} not ready after ${timeoutMs} ms: ${lastErr}`,
    );
  }

  exec(cmd, opts = {}) {
    const remote =
      this.os === "windows"
        ? [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodePowerShell(`$ProgressPreference='SilentlyContinue';${cmd}`),
          ]
        : ["bash", "-s"];
    return this.#run(
      "ssh",
      [...this.#sshArgs(), `${this.user}@${this.host}`, ...remote],
      this.os === "windows" ? undefined : cmd,
      opts,
    );
  }

  #run(bin, args, stdin, opts) {
    const max = opts.maxOutputBytes ?? 1_000_000;
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, opts.timeoutMs)
        : undefined;
      child.stdout.on("data", (d) => {
        if (stdout.length < max) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < max) stderr += d.toString("utf8");
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
      child.on("error", (e) => {
        stderr += String(e);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr: decodeClixml(stderr),
          timedOut,
          durationMs: Date.now() - t0,
        });
      });
    });
  }

  async #scp(args) {
    const r = await this.#run(
      "scp",
      ["-q", ...this.#sshArgs(), ...args],
      undefined,
      { timeoutMs: 600_000 },
    );
    if (r.code !== 0)
      throw new Error(`scp failed (${r.code}): ${r.stderr.trim()}`);
  }

  #remoteSpec(remote) {
    return `${this.user}@${this.host}:${remote.replace(/\\/g, "/")}`;
  }

  putFile(local, remote) {
    return this.#scp([local, this.#remoteSpec(remote)]);
  }

  getFile(remote, local) {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    return this.#scp([this.#remoteSpec(remote), local]);
  }

  async readFile(remote, maxBytes = 5_000_000) {
    const tmp = path.join(os.tmpdir(), `vmh-get-${process.pid}-${Date.now()}`);
    try {
      await this.getFile(remote, tmp);
      const buf = fs.readFileSync(tmp);
      return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async listDir(remote) {
    if (this.os === "windows") {
      const r = await this.exec(
        `Get-ChildItem -LiteralPath '${remote.replace(/'/g, "''")}' -Force | ForEach-Object { "$($_.Name)|$($_.PSIsContainer)|$($_.Length)" }`,
        { timeoutMs: 30_000 },
      );
      if (r.code !== 0)
        throw new Error(r.stderr.trim() || `listDir failed: ${remote}`);
      return r.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [name, dir, size] = l.split("|");
          return { name, isDir: dir === "True", size: Number(size) || 0 };
        });
    }
    const q = remote.replace(/'/g, "'\\''");
    // macOS has BSD find (no -printf): use BSD stat, whose %HT says "Directory".
    const r = await this.exec(
      this.os === "macos"
        ? `find '${q}' -mindepth 1 -maxdepth 1 -exec stat -f '%N|%HT|%z' {} +`
        : `find '${q}' -mindepth 1 -maxdepth 1 -printf '%f|%y|%s\\n'`,
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0)
      throw new Error(r.stderr.trim() || `listDir failed: ${remote}`);
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, type, size] = l.split("|");
        return this.os === "macos"
          ? {
              name: path.posix.basename(name),
              isDir: type === "Directory",
              size: Number(size) || 0,
            }
          : { name, isDir: type === "d", size: Number(size) || 0 };
      });
  }

  /** Forwards a guest loopback port to a free local port (`ssh -L`). */
  async forwardLocal({ remotePort, localPort }) {
    const local = localPort ?? (await freePort());
    const child = spawn(
      "ssh",
      [
        ...this.#sshArgs([
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${local}:127.0.0.1:${remotePort}`,
        ]),
        `${this.user}@${this.host}`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const handle = { kill: () => killTree(child) };
    this.forwards.add(handle);
    try {
      await waitForPort(local, 15_000);
    } catch (e) {
      handle.kill();
      this.forwards.delete(handle);
      throw e;
    }
    return {
      localPort: local,
      close: async () => {
        handle.kill();
        this.forwards.delete(handle);
      },
    };
  }

  async close() {
    for (const f of this.forwards) f.kill();
    this.forwards.clear();
  }
}
