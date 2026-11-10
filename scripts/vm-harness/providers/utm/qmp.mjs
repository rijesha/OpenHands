import net from "node:net";

/**
 * Minimal QEMU Machine Protocol client over TCP: one connection, commands answered in order, async events ignored.
 * The harness adds `-qmp tcp:127.0.0.1:<port>,server=on,wait=off` to every lease VM it boots (see provider.mjs).
 */
export class QmpClient {
  /** @param {{ host?: string, port: number, timeoutMs?: number }} o */
  constructor({ host = "127.0.0.1", port, timeoutMs = 15_000 }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.buf = "";
    /** @type {{ resolve: (m: any) => void, reject: (e: Error) => void }[]} */
    this.pending = [];
    this.closedError = null;
  }

  async connect() {
    this.sock = await new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`QMP connect to ${this.host}:${this.port} timed out`));
      }, this.timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    this.sock.setEncoding("utf8");
    this.sock.on("data", (d) => this.#onData(d));
    this.sock.on("error", (e) => this.#fail(e));
    this.sock.on("close", () => this.#fail(new Error("QMP connection closed")));
    await this.#next(); // greeting
    await this.execute("qmp_capabilities");
    return this;
  }

  #onData(d) {
    this.buf += d;
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
      if (msg.event) continue;
      this.pending.shift()?.resolve(msg);
    }
  }

  #fail(err) {
    if (!this.closedError) this.closedError = err;
    for (const p of this.pending.splice(0)) p.reject(this.closedError);
    this.sock?.destroy();
  }

  #next() {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(new Error(`QMP ${this.host}:${this.port} timed out`)),
        this.timeoutMs,
      );
      this.pending.push({
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /**
   * @param {string} command
   * @param {Record<string, unknown>} [args]
   */
  async execute(command, args) {
    const reply = this.#next();
    this.sock.write(
      `${JSON.stringify(args ? { execute: command, arguments: args } : { execute: command })}\n`,
    );
    const msg = await reply;
    if (msg.error)
      throw new Error(`QMP ${command}: ${msg.error.desc ?? msg.error.class}`);
    return msg.return;
  }

  close() {
    this.closedError ??= new Error("QMP connection closed");
    this.sock?.end();
    this.sock?.destroy();
  }
}
