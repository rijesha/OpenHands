import { RfbClient } from "../../desktop/rfb.mjs";
import { QmpClient } from "./qmp.mjs";
import {
  charToKeysym,
  charToQcodes,
  comboToKeysyms,
  comboToQcodes,
} from "./keys.mjs";

const DEFAULT_SCREEN = { width: 1280, height: 800 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One wheel notch in the shared desktop_scroll units (Windows convention). */
const NOTCH = 120;

function checkXY(x, y, screen) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= screen.width ||
    y >= screen.height
  ) {
    throw new Error(
      `coordinates (${x},${y}) are outside the ${screen.width}x${screen.height} screen`,
    );
  }
}

function notches(delta) {
  return Math.max(1, Math.round(Math.abs(delta) / NOTCH));
}

/**
 * Keeps one live connection and reopens it once when it has dropped (the guest rebooted, QEMU restarted the display).
 * @template T
 */
class Reconnecting {
  /** @param {() => Promise<T>} open */
  constructor(open) {
    this.open = open;
    /** @type {Promise<T> | null} */
    this.conn = null;
  }

  /** @param {(c: T) => Promise<any> | any} fn */
  async use(fn) {
    for (let attempt = 0; ; attempt++) {
      this.conn ??= this.open();
      let c;
      try {
        c = await this.conn;
        return await fn(c);
      } catch (e) {
        /** @type {any} */ (c)?.close?.();
        this.conn = null;
        if (attempt >= 1) throw e;
      }
    }
  }

  close() {
    this.conn
      ?.then((c) => /** @type {any} */ (c).close?.())
      .catch(() => undefined);
    this.conn = null;
  }
}

/**
 * Desktop of a QEMU guest under UTM: screenshots from QEMU's own VNC display (no guest software), input through QMP.
 * VNC pointer events are not usable here: UTM attaches a relative usb-mouse after the usb-tablet, so QEMU treats VNC as
 * a relative pointer. QMP input-send-event with absolute axes reaches the tablet and is pixel-exact.
 */
export class QemuDesktop {
  /** @param {{ vncPort: number, qmpPort: number, host?: string }} o */
  constructor({ vncPort, qmpPort, host = "127.0.0.1" }) {
    this.screen = { ...DEFAULT_SCREEN };
    this.vnc = new Reconnecting(() =>
      new RfbClient({ host, port: vncPort }).connect(),
    );
    this.qmp = new Reconnecting(() =>
      new QmpClient({ host, port: qmpPort }).connect(),
    );
  }

  screenSize() {
    return this.screen;
  }

  async screenshot() {
    const shot = await this.vnc.use((c) => c.screenshot());
    this.screen = { width: shot.width, height: shot.height };
    return shot;
  }

  #send(events) {
    return this.qmp.use((q) => q.execute("input-send-event", { events }));
  }

  #abs(x, y) {
    const { width, height } = this.screen;
    const scale = (v, max) => Math.round((v * 0x7fff) / Math.max(1, max - 1));
    return [
      { type: "abs", data: { axis: "x", value: scale(x, width) } },
      { type: "abs", data: { axis: "y", value: scale(y, height) } },
    ];
  }

  async move(x, y) {
    checkXY(x, y, this.screen);
    await this.#send(this.#abs(x, y));
  }

  async click(x, y, button = "left", count = 1) {
    checkXY(x, y, this.screen);
    await this.#send(this.#abs(x, y));
    await sleep(60);
    for (let i = 0; i < count; i++) {
      await this.#send([{ type: "btn", data: { down: true, button } }]);
      await sleep(40);
      await this.#send([{ type: "btn", data: { down: false, button } }]);
      if (i < count - 1) await sleep(80);
    }
  }

  async #hold(qcodes) {
    const key = (q, down) => ({
      type: "key",
      data: { down, key: { type: "qcode", data: q } },
    });
    await this.#send([
      ...qcodes.map((q) => key(q, true)),
      ...[...qcodes].reverse().map((q) => key(q, false)),
    ]);
  }

  async type(text) {
    const strokes = [...text].map(charToQcodes); // validate everything before typing anything
    for (const qcodes of strokes) {
      await this.#hold(qcodes);
      await sleep(15);
    }
  }

  async key(combo) {
    await this.#hold(comboToQcodes(combo));
  }

  async scroll(x, y, delta) {
    await this.move(x, y);
    const button = delta > 0 ? "wheel-up" : "wheel-down";
    for (let i = 0; i < notches(delta); i++) {
      await this.#send([{ type: "btn", data: { down: true, button } }]);
      await this.#send([{ type: "btn", data: { down: false, button } }]);
      await sleep(30);
    }
  }

  close() {
    this.vnc.close();
    this.qmp.close();
  }
}

/**
 * Desktop over a guest's own VNC server (macOS Screen Sharing for Apple Virtualization guests, which UTM gives no
 * display or input API for). Everything goes over one RFB connection.
 */
export class VncDesktop {
  /** @param {{ host: string, port?: number, password?: string }} o */
  constructor({ host, port = 5900, password }) {
    this.screen = { ...DEFAULT_SCREEN };
    this.buttons = 0;
    this.pos = { x: 0, y: 0 };
    this.vnc = new Reconnecting(() =>
      new RfbClient({ host, port, password }).connect(),
    );
  }

  screenSize() {
    return this.screen;
  }

  async screenshot() {
    const shot = await this.vnc.use((c) => c.screenshot());
    this.screen = { width: shot.width, height: shot.height };
    return shot;
  }

  async move(x, y) {
    checkXY(x, y, this.screen);
    this.pos = { x, y };
    await this.vnc.use((c) => c.pointer(x, y, 0));
  }

  async click(x, y, button = "left", count = 1) {
    checkXY(x, y, this.screen);
    const mask = { left: 1, middle: 2, right: 4 }[button] ?? 1;
    await this.vnc.use(async (c) => {
      c.pointer(x, y, 0);
      await sleep(60);
      for (let i = 0; i < count; i++) {
        c.pointer(x, y, mask);
        await sleep(40);
        c.pointer(x, y, 0);
        if (i < count - 1) await sleep(80);
      }
    });
    this.pos = { x, y };
  }

  async #hold(keysyms) {
    await this.vnc.use(async (c) => {
      for (const k of keysyms) c.key(k, true);
      await sleep(20);
      for (const k of [...keysyms].reverse()) c.key(k, false);
    });
  }

  async type(text) {
    const keysyms = [...text].map(charToKeysym);
    for (const k of keysyms) {
      await this.#hold([k]);
      await sleep(15);
    }
  }

  async key(combo) {
    await this.#hold(comboToKeysyms(combo));
  }

  async scroll(x, y, delta) {
    checkXY(x, y, this.screen);
    const mask = delta > 0 ? 8 : 16;
    await this.vnc.use(async (c) => {
      for (let i = 0; i < notches(delta); i++) {
        c.pointer(x, y, mask);
        c.pointer(x, y, 0);
        await sleep(30);
      }
    });
  }

  close() {
    this.vnc.close();
  }
}
