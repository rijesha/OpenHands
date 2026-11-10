import path from "node:path";
import { rgb565ToPng } from "../../desktop/rgb565.mjs";
import { parseCombo } from "../../desktop/keys.mjs";
import { HyperVBridge } from "./bridge.mjs";

const SCREEN = { width: 1280, height: 800 };

/** Hyper-V desktop I/O through WMI (thumbnail + Msvm_Keyboard + Msvm_SyntheticMouse). */
export class WmiDesktop {
  /** @param {HyperVBridge} bridge @param {string} vmId */
  constructor(bridge, vmId) {
    this.bridge = bridge;
    this.vmId = vmId;
  }

  screenSize() {
    return SCREEN;
  }

  async screenshot() {
    const b64 = await this.bridge.call(
      "Get-VmhThumbnail",
      { VmId: this.vmId, Width: SCREEN.width, Height: SCREEN.height },
      30_000,
    );
    return {
      png: rgb565ToPng(Buffer.from(b64, "base64"), SCREEN.width, SCREEN.height),
      ...SCREEN,
    };
  }

  #check(x, y) {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= SCREEN.width ||
      y >= SCREEN.height
    ) {
      throw new Error(
        `coordinates (${x},${y}) are outside the ${SCREEN.width}x${SCREEN.height} screen`,
      );
    }
  }

  async move(x, y) {
    this.#check(x, y);
    await this.bridge.call("Send-VmhMouse", {
      VmId: this.vmId,
      X: x,
      Y: y,
      Button: "none",
    });
  }

  async click(x, y, button = "left", count = 1) {
    this.#check(x, y);
    await this.bridge.call("Send-VmhMouse", {
      VmId: this.vmId,
      X: x,
      Y: y,
      Button: button,
      Count: count,
    });
  }

  async type(text) {
    if (!/^[\x20-\x7e]*$/.test(text))
      throw new Error("desktop_type supports printable ASCII only");
    // TypeText garbled text on the Ubuntu guest; typing key by key is reliable on both OSes.
    await this.bridge.call(
      "Send-VmhChars",
      { VmId: this.vmId, Text: text },
      Math.max(120_000, text.length * 1500),
    );
  }

  async key(combo) {
    const k = parseCombo(combo);
    await this.bridge.call("Send-VmhKeys", {
      VmId: this.vmId,
      Press: k.press,
      Type: k.type,
      Release: k.release,
    });
  }

  async scroll(x, y, delta) {
    await this.move(x, y);
    await this.bridge.call("Send-VmhScroll", { VmId: this.vmId, Delta: delta });
  }
}

/**
 * Hyper-V VM provider: every lease is a differencing VHDX child of a sealed image.
 * Provider contract (shared with future providers): id, os list, hostCheck, create, start, waitForIp, stop,
 * destroy, state, listOrphans, desktop.
 */
export class HyperVProvider {
  id = "hyperv";

  /** @param {{ root: string, bridge?: HyperVBridge }} opts */
  constructor({ root, bridge }) {
    this.root = root;
    this.bridge = bridge ?? new HyperVBridge();
  }

  hostCheck() {
    return this.bridge.call("Test-VmhHost", { Root: this.root }, 30_000);
  }

  async create({ leaseId, os, image, memoryMB, cpus }) {
    const r = await this.bridge.call(
      "New-VmhRunVm",
      {
        RunId: leaseId,
        Os: os,
        Role: "lease",
        ParentVhdx: image.vhdxPath,
        Root: this.root,
        MemoryMB: memoryMB,
        Cpus: cpus,
      },
      120_000,
    );
    return { ...r, os };
  }

  start(vm) {
    return this.bridge.call("Start-VM", { Name: vm.name }, 120_000);
  }

  waitForIp(vm, timeoutSec = 240) {
    return this.bridge.call(
      "Get-VmhVmIp",
      { Name: vm.name, TimeoutSec: timeoutSec },
      (timeoutSec + 30) * 1000,
    );
  }

  stop(vm) {
    return this.bridge.call(
      "Stop-VM",
      { Name: vm.name, TurnOff: true, Force: true },
      120_000,
    );
  }

  state(name) {
    return this.bridge.call("Get-VmhVmState", { Name: name }, 30_000);
  }

  destroy(vm) {
    return this.bridge.call(
      "Remove-VmhRunVm",
      { Name: vm.name, Dir: path.win32.resolve(vm.dir) },
      180_000,
    );
  }

  /** Powers the VM off, removes it and keeps its disk at `destVhdx` as a read-only child of the image it booted from. */
  snapshot(vm, destVhdx) {
    return this.bridge.call(
      "Save-VmhSnapshot",
      {
        Name: vm.name,
        Dir: path.win32.resolve(vm.dir),
        Dest: path.win32.resolve(destVhdx),
      },
      600_000,
    );
  }

  /** VMs left behind by an earlier harness process. */
  async listOrphans() {
    const r = await this.bridge.call("Get-VmhRunVms", {}, 30_000);
    return r == null ? [] : Array.isArray(r) ? r : [r];
  }

  desktop(vm) {
    return new WmiDesktop(this.bridge, vm.vmId);
  }

  close() {
    this.bridge.close();
  }
}
