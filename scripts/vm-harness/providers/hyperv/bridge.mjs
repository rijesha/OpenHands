import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_PS1 = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bridge.ps1",
);

/** Long-lived pwsh child speaking JSON lines (see bridge.ps1). */
export class HyperVBridge {
  /** @param {{ pwsh?: string, defaultTimeoutMs?: number }} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    this.child = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
  }

  start() {
    if (this.child) return;
    const child = spawn(
      this.opts.pwsh ?? "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", BRIDGE_PS1],
      { windowsHide: true },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this.#onData(d));
    child.on("error", (e) => this.#failAll(e));
    child.on("close", () => {
      this.#failAll(new Error("Hyper-V bridge exited"));
      this.child = undefined;
    });
  }

  #failAll(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error)));
    }
  }

  /**
   * @template T
   * @param {string} cmd
   * @param {Record<string, unknown>} [args]
   * @param {number} [timeoutMs]
   * @returns {Promise<T>}
   */
  call(cmd, args = {}, timeoutMs) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`Bridge call ${cmd} timed out`));
        },
        timeoutMs ?? this.opts.defaultTimeoutMs ?? 120_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  close() {
    this.child?.stdin.end();
    this.child?.kill();
  }
}
