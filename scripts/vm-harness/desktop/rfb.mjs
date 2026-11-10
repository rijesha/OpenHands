import crypto from "node:crypto";
import net from "node:net";
import { rgbToPng } from "./png.mjs";

/** RFB security types this client speaks. */
const SEC_NONE = 1;
const SEC_VNC = 2;
const ENC_RAW = 0;
const ENC_DESKTOP_SIZE = -223;

/**
 * VNC authentication: DES-encrypt the 16-byte challenge with the password (max 8 bytes, each byte bit-reversed, the
 * RFB quirk). Plain des-ecb is gone from OpenSSL 3's default provider; 3DES with the same key three times is DES.
 * @param {Buffer} challenge
 * @param {string} password
 */
export function vncAuthResponse(challenge, password) {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i];
    let r = 0;
    for (let bit = 0; bit < 8; bit++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = r;
  }
  const cipher = crypto.createCipheriv(
    "des-ede3-ecb",
    Buffer.concat([key, key, key]),
    null,
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/**
 * Minimal RFB (VNC) client: auth None or VNC password, 32-bit raw framebuffer, pointer and key events.
 * Enough to screenshot and drive a QEMU `-vnc` display or macOS Screen Sharing. No dependencies.
 */
export class RfbClient {
  /** @param {{ host: string, port: number, password?: string, timeoutMs?: number }} o */
  constructor({ host, port, password, timeoutMs = 15_000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.width = 0;
    this.height = 0;
    this.name = "";
    /** @type {Buffer | null} BGRX, 4 bytes per pixel */
    this.fb = null;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    /** @type {{ n: number, resolve: (b: Buffer) => void, reject: (e: Error) => void }[]} */
    this.waiters = [];
    this.closedError = null;
    /** Serializes framebuffer reads so two screenshots never interleave on the wire. */
    this.chain = Promise.resolve();
  }

  #pump() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift();
      const b = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(b);
    }
  }

  #read(n) {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(
          `VNC ${this.host}:${this.port} timed out waiting for data`,
        );
        this.#fail(err);
      }, this.timeoutMs);
      this.waiters.push({
        n,
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#pump();
    });
  }

  #fail(err) {
    if (!this.closedError) this.closedError = err;
    for (const w of this.waiters.splice(0)) w.reject(this.closedError);
    this.sock?.destroy();
  }

  async connect() {
    this.sock = await new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`VNC connect to ${this.host}:${this.port} timed out`));
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
    this.sock.setNoDelay(true);
    this.sock.on("data", (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.#pump();
    });
    this.sock.on("error", (e) => this.#fail(e));
    this.sock.on("close", () =>
      this.#fail(new Error(`VNC ${this.host}:${this.port} closed`)),
    );

    const version = (await this.#read(12)).toString("latin1");
    if (!version.startsWith("RFB "))
      throw new Error(`Not a VNC server: ${JSON.stringify(version)}`);
    const serverMinor = Number(version.slice(8, 11));
    // Never claim more than the server: 3.8 (also for Apple's 3.889), 3.7, else 3.3, where the server picks security.
    const minor = serverMinor >= 8 ? 8 : serverMinor === 7 ? 7 : 3;
    const legacy = minor === 3;
    this.sock.write(`RFB 003.00${minor}\n`);

    let type;
    if (legacy) {
      type = (await this.#read(4)).readUInt32BE(0);
      if (type === 0) throw new Error(await this.#reason());
    } else {
      const count = (await this.#read(1))[0];
      if (count === 0) throw new Error(await this.#reason());
      const offered = [...(await this.#read(count))];
      if (this.password && offered.includes(SEC_VNC)) type = SEC_VNC;
      else if (offered.includes(SEC_NONE)) type = SEC_NONE;
      else if (offered.includes(SEC_VNC)) type = SEC_VNC;
      else
        throw new Error(
          `VNC server offers no supported security type (offered ${offered.join(", ")})`,
        );
      this.sock.write(Buffer.from([type]));
    }
    if (type === SEC_VNC) {
      if (!this.password)
        throw new Error("VNC server requires a password and none is set");
      const challenge = await this.#read(16);
      this.sock.write(vncAuthResponse(challenge, this.password));
    }
    // RFB 3.8 always sends a SecurityResult; 3.3/3.7 only after VNC auth.
    if (type === SEC_VNC || minor >= 8) {
      const result = (await this.#read(4)).readUInt32BE(0);
      if (result !== 0)
        throw new Error(
          `VNC authentication failed${minor >= 8 ? `: ${await this.#reason().catch(() => "")}` : ""}`,
        );
    }

    this.sock.write(Buffer.from([1])); // ClientInit: shared session
    const init = await this.#read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    this.name = (await this.#read(init.readUInt32BE(20))).toString("utf8");

    // SetPixelFormat: 32 bpp, depth 24, little-endian, true colour, BGRX in memory.
    const pf = Buffer.alloc(20);
    pf[0] = 0;
    pf[4] = 32;
    pf[5] = 24;
    pf[6] = 0;
    pf[7] = 1;
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf[14] = 16;
    pf[15] = 8;
    pf[16] = 0;
    this.sock.write(pf);
    const encodings = [ENC_RAW, ENC_DESKTOP_SIZE];
    const se = Buffer.alloc(4 + encodings.length * 4);
    se[0] = 2;
    se.writeUInt16BE(encodings.length, 2);
    encodings.forEach((e, i) => se.writeInt32BE(e, 4 + i * 4));
    this.sock.write(se);
    this.fb = Buffer.alloc(this.width * this.height * 4);
    return this;
  }

  async #reason() {
    const len = (await this.#read(4)).readUInt32BE(0);
    return (await this.#read(len)).toString("utf8");
  }

  /** Requests the whole screen and reads messages until that update has arrived. */
  async #refresh() {
    const req = Buffer.alloc(10);
    req[0] = 3;
    req[1] = 0; // not incremental: send everything
    req.writeUInt16BE(this.width, 6);
    req.writeUInt16BE(this.height, 8);
    this.sock.write(req);
    for (;;) {
      const type = (await this.#read(1))[0];
      if (type === 0) {
        const head = await this.#read(3);
        const rects = head.readUInt16BE(1);
        let resized = false;
        for (let i = 0; i < rects; i++) {
          const r = await this.#read(12);
          const x = r.readUInt16BE(0);
          const y = r.readUInt16BE(2);
          const w = r.readUInt16BE(4);
          const h = r.readUInt16BE(6);
          const enc = r.readInt32BE(8);
          if (enc === ENC_DESKTOP_SIZE) {
            this.width = w;
            this.height = h;
            this.fb = Buffer.alloc(w * h * 4);
            resized = true;
            continue;
          }
          if (enc !== ENC_RAW)
            throw new Error(`VNC server sent unsupported encoding ${enc}`);
          const px = await this.#read(w * h * 4);
          for (let row = 0; row < h; row++) {
            px.copy(
              this.fb,
              ((y + row) * this.width + x) * 4,
              row * w * 4,
              (row + 1) * w * 4,
            );
          }
        }
        // After a resize the server owes us the new screen: ask again.
        if (resized) return this.#refresh();
        return;
      }
      if (type === 1) {
        const head = await this.#read(5);
        await this.#read(head.readUInt16BE(3) * 6);
      } else if (type === 2) {
        // Bell
      } else if (type === 3) {
        await this.#read(3);
        await this.#read((await this.#read(4)).readUInt32BE(0));
      } else {
        throw new Error(`VNC server sent unknown message ${type}`);
      }
    }
  }

  /** @returns {Promise<{ png: Buffer, width: number, height: number }>} */
  screenshot() {
    const run = this.chain.then(async () => {
      await this.#refresh();
      const { width, height, fb } = this;
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0, j = 0; i < width * height; i++, j += 4) {
        rgb[i * 3] = fb[j + 2];
        rgb[i * 3 + 1] = fb[j + 1];
        rgb[i * 3 + 2] = fb[j];
      }
      return { png: rgbToPng(rgb, width, height), width, height };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** PointerEvent: `mask` bit 0 left, 1 middle, 2 right, 3/4 wheel up/down. */
  pointer(x, y, mask = 0) {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this.sock.write(b);
  }

  /** KeyEvent with an X11 keysym. */
  key(keysym, down) {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym, 4);
    this.sock.write(b);
  }

  close() {
    this.closedError ??= new Error("VNC connection closed");
    this.sock?.end();
    this.sock?.destroy();
  }
}
