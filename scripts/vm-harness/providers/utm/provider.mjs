import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UtmControl, ipFromDhcpLeases, stateOf } from "./utm.mjs";
import { QemuDesktop, VncDesktop } from "./desktop.mjs";
import { createGolden, sealGolden } from "./golden.mjs";
import { withoutHarnessArgs } from "./args.mjs";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every VM the harness owns starts with this; goldens and image builds are never swept as orphans. */
export const VM_PREFIX = "vmh-";
export const GOLDEN_PREFIX = "vmh-golden-";
export const BUILD_PREFIX = "vmh-build-";

export { withoutHarnessArgs };

/** A random locally administered unicast MAC, so every lease clone gets its own DHCP lease. */
export function randomMac() {
  const b = crypto.randomBytes(6);
  b[0] = (b[0] & 0xfc) | 0x02;
  return [...b]
    .map((x) => x.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/**
 * Memory macOS considers available, in MB: `kern.memorystatus_level` (the "System-wide memory free percentage" that
 * memory_pressure prints) of physical memory. It counts memory the compressor can still reclaim, unlike free pages.
 */
export function availableRamMB(memsizeBytes, levelPercent) {
  return Math.floor((memsizeBytes * (levelPercent / 100)) / (1024 * 1024));
}

async function readMemoryStatus() {
  const { stdout } = await execFileP("sysctl", [
    "-n",
    "hw.memsize",
    "kern.memorystatus_level",
  ]);
  const [memsize, level] = stdout.trim().split(/\s+/).map(Number);
  if (!memsize || !Number.isFinite(level)) throw new Error("no memorystatus");
  return availableRamMB(memsize, level);
}

/** Fallback: free + inactive + speculative pages from vm_stat. */
export function freeRamFromVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
  const pages = (label) =>
    Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const free =
    pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
  return Math.floor((free * pageSize) / (1024 * 1024));
}

/**
 * UTM VM provider (macOS host). A golden image is a registered, never-booted UTM VM (`vmh-golden-<imageId>`); a lease
 * is an APFS clone of it (`utmctl clone`, seconds and almost no disk) that is deleted on teardown.
 *
 * QEMU guests (Ubuntu, Windows): every lease gets its own MAC, a VNC display and a QMP socket on 127.0.0.1 only; the
 * desktop is VNC for pixels plus QMP for input. Apple Virtualization guests (macOS): UTM exposes no display API, so the
 * desktop is the guest's own Screen Sharing (VNC) at its IP.
 *
 * UTM only accepts commands from the logged-in GUI session, so the harness must run there (a LaunchAgent), and the
 * program running it needs the one-time Automation permission for UTM (AppleScript is used for configuration).
 */
export class UtmProvider {
  id = "utm";

  /**
   * @param {{ root: string, utm?: UtmControl, readFreeRamMB?: () => Promise<number>, credsFile?: string }} o
   *   `utm` and `readFreeRamMB` are seams for tests.
   */
  constructor({ root, utm, readFreeRamMB, credsFile }) {
    this.root = root;
    this.utm = utm ?? new UtmControl();
    this.readFreeRamMB =
      readFreeRamMB ??
      (() =>
        readMemoryStatus().catch(async () =>
          freeRamFromVmStat((await execFileP("vm_stat")).stdout),
        ));
    this.credsFile = credsFile;
    /** Ports handed to leases that have not released them yet (QEMU binds them only at start). */
    this.reserved = new Set();
    /** @type {Map<string, QemuDesktop | VncDesktop>} */
    this.desktops = new Map();
  }

  async hostCheck() {
    const problems = [];
    if (!this.utm.installed())
      problems.push(`UTM is not installed (${this.utm.utmctlPath} missing)`);
    else {
      try {
        await this.utm.list();
      } catch (e) {
        problems.push(String(e.message ?? e));
      }
    }
    let freeRamMB = 0;
    try {
      freeRamMB = await this.readFreeRamMB();
    } catch {
      freeRamMB = Math.floor(os.freemem() / (1024 * 1024));
    }
    let freeDiskGB = 0;
    try {
      const target = fs.existsSync(this.root) ? this.root : os.homedir();
      const st = fs.statfsSync(target);
      freeDiskGB = Math.floor((st.bavail * st.bsize) / 1024 ** 3);
      if (freeDiskGB < 10)
        problems.push(
          `Only ${freeDiskGB} GB free on the disk holding ${target}`,
        );
    } catch {
      // unknown
    }
    return { ok: problems.length === 0, problems, freeRamMB, freeDiskGB };
  }

  async #allocatePort(from, to) {
    for (let p = from; p <= to; p++) {
      if (this.reserved.has(p)) continue;
      if (await portFree(p)) {
        this.reserved.add(p);
        return p;
      }
    }
    throw new Error(`No free local port between ${from} and ${to}`);
  }

  #release(vm) {
    for (const p of [vm.vncPort, vm.qmpPort]) if (p) this.reserved.delete(p);
  }

  /**
   * @param {{ leaseId: string, os: string, image: { utmVm?: string, imageId: string }, memoryMB: number, cpus: number }} o
   */
  async create({ leaseId, os: guestOs, image, memoryMB, cpus }) {
    const source = image.utmVm;
    if (!source)
      throw new Error(
        `Image ${image.imageId} has no utmVm: it was not built for the UTM provider.`,
      );
    if (!(await this.utm.find(source)))
      throw new Error(
        `UTM VM '${source}' for image ${image.imageId} is not registered in UTM.`,
      );
    const backend = await this.utm.backend(source);
    if (backend === "apple" && guestOs === "macos") {
      const running = [];
      for (const v of await this.utm.list())
        if (v.status !== "stopped" && v.name.startsWith(VM_PREFIX))
          running.push(v);
      let macs = 0;
      for (const v of running)
        if ((await this.utm.backend(v.name).catch(() => "")) === "apple")
          macs++;
      if (macs >= 2)
        throw new Error(
          "macOS allows at most 2 macOS VMs at once and 2 are running. Stop one first.",
        );
    }
    const name = `${VM_PREFIX}${leaseId}-${guestOs}-lease`;
    const mac = randomMac();
    /** @type {any} */
    const vm = { name, vmId: name, os: guestOs, backend, mac, dir: null };
    let base = [];
    if (backend === "qemu") {
      base = withoutHarnessArgs((await this.utm.readConfig(source)).qemuArgs);
      vm.vncPort = await this.#allocatePort(5910, 5999);
      vm.qmpPort = await this.#allocatePort(44100, 44999);
    }
    try {
      await this.utm.clone(source, name);
      await this.utm.configure(name, {
        mac,
        memoryMB,
        cpus,
        ...(backend === "qemu"
          ? {
              qemuArgs: [
                ...base,
                "-vnc",
                `127.0.0.1:${vm.vncPort - 5900}`,
                "-qmp",
                `tcp:127.0.0.1:${vm.qmpPort},server=on,wait=off`,
              ],
            }
          : {}),
      });
    } catch (e) {
      this.#release(vm);
      await this.utm.delete(name).catch(() => undefined);
      throw e;
    }
    return vm;
  }

  async start(vm) {
    await this.utm.start(vm.name);
  }

  /** Guest agent first (QEMU guests with qemu-guest-agent), then the host's DHCP leases by the lease's MAC. */
  async waitForIp(vm, timeoutSec = 240) {
    const deadline = Date.now() + timeoutSec * 1000;
    let tries = 0;
    while (Date.now() < deadline) {
      const fromLeases = ipFromDhcpLeases(this.utm.readDhcpLeases(), vm.mac);
      if (fromLeases) {
        vm.ip = fromLeases;
        return fromLeases;
      }
      // The agent answers slowly when absent; ask it every few rounds only.
      if (vm.backend === "qemu" && tries++ % 5 === 4) {
        const ip = (await this.utm.ipAddresses(vm.name)).find(
          (a) => !a.startsWith("169.254.") && !a.startsWith("127."),
        );
        if (ip) {
          vm.ip = ip;
          return ip;
        }
      }
      await sleep(2000);
    }
    throw new Error(
      `No IP for ${vm.name} (MAC ${vm.mac}) after ${timeoutSec} s: is the guest's network up?`,
    );
  }

  async stop(vm) {
    const found = await this.utm.find(vm.name).catch(() => null);
    if (found && found.status !== "stopped") await this.utm.stop(vm.name);
  }

  async state(name) {
    return stateOf((await this.utm.find(name))?.status);
  }

  async destroy(vm) {
    this.desktops.get(vm.name)?.close();
    this.desktops.delete(vm.name);
    this.#release(vm);
    const found = await this.utm.find(vm.name);
    if (!found) return;
    if (found.status !== "stopped") {
      await this.utm.stop(vm.name).catch(() => undefined);
      for (let i = 0; i < 15; i++) {
        if ((await this.utm.find(vm.name))?.status === "stopped") break;
        await sleep(1000);
      }
    }
    await this.utm.delete(vm.name);
  }

  /**
   * Keeps a (shut down) lease VM as a new image: it is renamed to `vmh-golden-<imageId>` and the harness's QEMU
   * arguments are removed. Clones are independent APFS copies, so the result does not depend on its parent's disk.
   * @param {any} vm
   * @param {{ imageId: string }} target
   */
  async snapshot(vm, target) {
    const keepAs = `${GOLDEN_PREFIX}${target.imageId}`;
    this.desktops.get(vm.name)?.close();
    this.desktops.delete(vm.name);
    const found = await this.utm.find(vm.name);
    if (!found) throw new Error(`${vm.name} is gone; nothing to save.`);
    if (found.status !== "stopped") {
      await this.utm.stop(vm.name);
      for (let i = 0; i < 30; i++) {
        if ((await this.utm.find(vm.name))?.status === "stopped") break;
        await sleep(1000);
      }
    }
    const change = { newName: keepAs };
    if (vm.backend === "qemu")
      change.qemuArgs = withoutHarnessArgs(
        (await this.utm.readConfig(vm.name)).qemuArgs,
      );
    await this.utm.configure(vm.name, change);
    this.#release(vm);
    return { utmVm: keepAs };
  }

  /** Lease VMs left behind by an earlier harness process (goldens and builds excluded). */
  async listOrphans() {
    return (await this.utm.list())
      .filter(
        (v) =>
          v.name.startsWith(VM_PREFIX) &&
          !v.name.startsWith(GOLDEN_PREFIX) &&
          !v.name.startsWith(BUILD_PREFIX),
      )
      .map((v) => ({ name: v.name, state: stateOf(v.status), dir: null }));
  }

  #vncPassword() {
    const file =
      this.credsFile ?? path.join(this.root, "secrets", "guest-creds.json");
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      return c.vncPassword ?? c.password;
    } catch {
      return undefined;
    }
  }

  desktop(vm) {
    let d = this.desktops.get(vm.name);
    if (d) return d;
    if (vm.backend === "qemu")
      d = new QemuDesktop({ vncPort: vm.vncPort, qmpPort: vm.qmpPort });
    else {
      if (!vm.ip) throw new Error(`${vm.name} has no IP yet: no desktop.`);
      d = new VncDesktop({ host: vm.ip, password: this.#vncPassword() });
    }
    this.desktops.set(vm.name, d);
    return d;
  }

  /** `images create-vm`: an empty VM with the installer attached (see golden.mjs). */
  createGolden(config, opts) {
    return createGolden(this.utm, config, opts);
  }

  /** `images seal`: turns a provisioned build VM into a golden image and writes its manifest. */
  sealGolden(config, opts) {
    return sealGolden(this.utm, config, opts);
  }

  close() {
    for (const d of this.desktops.values()) d.close();
    this.desktops.clear();
  }
}
