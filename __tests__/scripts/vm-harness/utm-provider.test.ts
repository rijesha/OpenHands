// @vitest-environment node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UtmControl,
  explainUtmError,
  ipFromDhcpLeases,
  leaseMac,
  parseList,
  stateOf,
} from "../../../scripts/vm-harness/providers/utm/utm.mjs";
import {
  UtmProvider,
  availableRamMB,
  freeRamFromVmStat,
  randomMac,
} from "../../../scripts/vm-harness/providers/utm/provider.mjs";
import { withoutHarnessArgs } from "../../../scripts/vm-harness/providers/utm/args.mjs";
import {
  charToKeysym,
  charToQcodes,
  comboToKeysyms,
  comboToQcodes,
} from "../../../scripts/vm-harness/providers/utm/keys.mjs";
import {
  RfbClient,
  vncAuthResponse,
} from "../../../scripts/vm-harness/desktop/rfb.mjs";
import { QemuDesktop } from "../../../scripts/vm-harness/providers/utm/desktop.mjs";
import {
  renderAutoinstall,
  sealGolden,
} from "../../../scripts/vm-harness/providers/utm/golden.mjs";
import {
  deleteImage,
  listImages,
  registerSnapshot,
} from "../../../scripts/vm-harness/images.mjs";
import { createProvider } from "../../../scripts/vm-harness/cli.mjs";
import { vmHarnessUnsupportedReason } from "../../../scripts/dev-with-automation.mjs";

interface FakeVm {
  uuid: string;
  name: string;
  status: string;
  backend: string;
  mac: string;
  qemuArgs: string[];
}

/** A UtmControl stand-in that keeps a VM table in memory. */
function fakeUtm(initial: Partial<FakeVm>[] = []) {
  const vms: FakeVm[] = initial.map((v, i) => ({
    uuid: `00000000-0000-0000-0000-00000000000${i}`,
    status: "stopped",
    backend: "qemu",
    mac: "0E:00:00:00:00:01",
    qemuArgs: [],
    name: "x",
    ...v,
  }));
  const find = (name: string) => vms.find((v) => v.name === name);
  const utm = {
    vms,
    leases: "",
    installed: () => true,
    utmctlPath: "/fake/utmctl",
    list: vi.fn(async () =>
      vms.map(({ uuid, status, name }) => ({ uuid, status, name })),
    ),
    find: vi.fn(async (name: string) => {
      const v = find(name);
      return v ? { uuid: v.uuid, status: v.status, name: v.name } : null;
    }),
    clone: vi.fn(async (source: string, name: string) => {
      const s = find(source);
      if (!s) throw new Error(`no ${source}`);
      vms.push({ ...s, uuid: `clone-${name}`, name, status: "stopped" });
    }),
    configure: vi.fn(
      async (
        name: string,
        change: { newName?: string; mac?: string; qemuArgs?: string[] },
      ) => {
        const v = find(name);
        if (!v) throw new Error(`no ${name}`);
        if (change.mac) v.mac = change.mac;
        if (change.qemuArgs) v.qemuArgs = change.qemuArgs;
        if (change.newName) v.name = change.newName;
      },
    ),
    readConfig: vi.fn(async (name: string) => ({
      mac: find(name)?.mac ?? "",
      qemuArgs: [...(find(name)?.qemuArgs ?? [])],
    })),
    backend: vi.fn(async (name: string) => find(name)?.backend ?? "qemu"),
    start: vi.fn(async (name: string) => {
      const v = find(name);
      if (v) v.status = "started";
    }),
    stop: vi.fn(async (name: string) => {
      const v = find(name);
      if (v) v.status = "stopped";
    }),
    delete: vi.fn(async (name: string) => {
      const i = vms.findIndex((v) => v.name === name);
      if (i >= 0) vms.splice(i, 1);
    }),
    ipAddresses: vi.fn(async () => [] as string[]),
    readDhcpLeases: () => utm.leases,
  };
  return utm;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-utm-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function provider(utm: ReturnType<typeof fakeUtm>) {
  return new UtmProvider({
    root: tmp,
    utm: utm as never,
    readFreeRamMB: async () => 8000,
  });
}

describe("utmctl and host parsing", () => {
  it("parses utmctl list, including names with spaces", () => {
    expect(
      parseList(
        "UUID                                 Status   Name\n" +
          "086563C2-B584-4A73-A1A9-5755FE0334B2 stopped  Linux Orig\n" +
          "04A48195-3DEB-499B-83CE-25BEE5C77285 started  vmh-l1-ubuntu-lease\n",
      ),
    ).toEqual([
      {
        uuid: "086563C2-B584-4A73-A1A9-5755FE0334B2",
        status: "stopped",
        name: "Linux Orig",
      },
      {
        uuid: "04A48195-3DEB-499B-83CE-25BEE5C77285",
        status: "started",
        name: "vmh-l1-ubuntu-lease",
      },
    ]);
  });

  it("maps UTM states onto the harness's Off/Missing vocabulary", () => {
    expect(stateOf("stopped")).toBe("Off");
    expect(stateOf(undefined)).toBe("Missing");
    expect(stateOf("started")).toBe("Started");
  });

  it("finds a guest's IP in the vmnet DHCP leases by MAC, newest lease first", () => {
    expect(leaseMac("0E:79:89:AA:BB:01")).toBe("e:79:89:aa:bb:1");
    const leases = `{
	name=old
	ip_address=192.168.64.3
	hw_address=1,e:79:89:aa:bb:1
	lease=0x10
}
{
	name=other
	ip_address=192.168.64.4
	hw_address=1,52:54:0:12:34:56
	lease=0x30
}
{
	name=new
	ip_address=192.168.64.9
	hw_address=1,e:79:89:aa:bb:1
	lease=0x20
}`;
    expect(ipFromDhcpLeases(leases, "0E:79:89:AA:BB:01")).toBe("192.168.64.9");
    expect(ipFromDhcpLeases(leases, "02:00:00:00:00:00")).toBeNull();
  });

  it("explains why macOS refused to let the harness drive UTM", () => {
    expect(explainUtmError("OSStatus error -1743.")).toMatch(/Automation/);
    expect(
      explainUtmError("NOTE: utmctl does not work from SSH sessions"),
    ).toMatch(/GUI session/);
    expect(explainUtmError("AppleEvent timed out. (-1712)")).toMatch(/prompt/);
    expect(explainUtmError("something else")).toBe("");
  });

  it("treats utmctl's exit-0 'Apple events denied' output as a failure", async () => {
    const utm = new UtmControl({
      exec: async () => ({
        stdout: "UUID                                 Status   Name\n",
        stderr:
          "Error from event: The operation couldn’t be completed. (OSStatus error -1743.)\n",
      }),
    });
    await expect(utm.list()).rejects.toThrow(/Automation permission/);
  });

  it("changes a VM's configuration through AppleScript with quoted values", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const utm = new UtmControl({ exec });
    await utm.configure('vm "x"', {
      mac: "02:00:00:00:00:01",
      qemuArgs: ["-vnc", "127.0.0.1:10"],
      memoryMB: 4096,
    });
    const [file, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe("osascript");
    const script = args[1];
    expect(script).toContain('virtual machine named "vm \\"x\\""');
    expect(script).toContain('set address of nic to "02:00:00:00:00:01"');
    expect(script).toContain(
      '{argument string:"-vnc"}, {argument string:"127.0.0.1:10"}',
    );
    expect(script).toContain("set memory of cfg to 4096");
    expect(script).toContain("update configuration of vm with cfg");
  });

  it("reads available memory the way macOS's memory pressure does", () => {
    expect(availableRamMB(16 * 1024 ** 3, 50)).toBe(8192);
    expect(
      freeRamFromVmStat(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  64.\nPages inactive:  64.\nPages speculative:  0.\n",
      ),
    ).toBe(2);
  });

  it("strips only the harness's own QEMU arguments", () => {
    expect(
      withoutHarnessArgs([
        "-device",
        "usb-kbd",
        "-vnc",
        "127.0.0.1:12",
        "-qmp",
        "tcp:127.0.0.1:44101,server=on,wait=off",
      ]),
    ).toEqual(["-device", "usb-kbd"]);
  });

  it("makes locally administered unicast MACs", () => {
    for (let i = 0; i < 20; i++) {
      const first = Number.parseInt(randomMac().slice(0, 2), 16);
      expect(first & 0b11).toBe(0b10);
    }
  });
});

describe("UtmProvider", () => {
  const golden = { name: "vmh-golden-ubuntu-1", qemuArgs: ["-device", "x"] };

  it("boots a lease from an APFS clone with its own MAC, VNC display and QMP port", async () => {
    const utm = fakeUtm([golden]);
    const p = provider(utm);
    const vm = await p.create({
      leaseId: "l1",
      os: "ubuntu",
      image: { imageId: "ubuntu-1", utmVm: golden.name },
      memoryMB: 4096,
      cpus: 4,
    });
    expect(vm.name).toBe("vmh-l1-ubuntu-lease");
    expect(utm.clone).toHaveBeenCalledWith(golden.name, vm.name);
    const clone = utm.vms.find((v) => v.name === vm.name)!;
    expect(clone.mac).toBe(vm.mac);
    expect(clone.mac).not.toBe(utm.vms[0].mac);
    expect(clone.qemuArgs).toEqual([
      "-device",
      "x",
      "-vnc",
      `127.0.0.1:${vm.vncPort - 5900}`,
      "-qmp",
      `tcp:127.0.0.1:${vm.qmpPort},server=on,wait=off`,
    ]);
    // The golden image itself is never changed.
    expect(utm.vms[0].qemuArgs).toEqual(["-device", "x"]);

    const second = await p.create({
      leaseId: "l2",
      os: "ubuntu",
      image: { imageId: "ubuntu-1", utmVm: golden.name },
      memoryMB: 4096,
      cpus: 4,
    });
    expect(second.vncPort).not.toBe(vm.vncPort);
    expect(second.qmpPort).not.toBe(vm.qmpPort);
  });

  it("refuses images that were not built for UTM or are missing from UTM", async () => {
    const p = provider(fakeUtm([golden]));
    const base = { leaseId: "l1", os: "ubuntu", memoryMB: 1, cpus: 1 };
    await expect(
      p.create({ ...base, image: { imageId: "hyperv-image" } }),
    ).rejects.toThrow(/no utmVm/);
    await expect(
      p.create({
        ...base,
        image: { imageId: "gone", utmVm: "vmh-golden-gone" },
      }),
    ).rejects.toThrow(/not registered/);
  });

  it("deletes a half-made clone and frees its ports when configuring it fails", async () => {
    const utm = fakeUtm([golden]);
    utm.configure.mockRejectedValueOnce(new Error("AppleScript failed"));
    const p = provider(utm);
    await expect(
      p.create({
        leaseId: "l1",
        os: "ubuntu",
        image: { imageId: "u", utmVm: golden.name },
        memoryMB: 1,
        cpus: 1,
      }),
    ).rejects.toThrow(/AppleScript failed/);
    expect(utm.vms.map((v) => v.name)).toEqual([golden.name]);
    expect(p.reserved.size).toBe(0);
  });

  it("waits for the clone's MAC to appear in the DHCP leases", async () => {
    const utm = fakeUtm([golden]);
    const p = provider(utm);
    const vm = await p.create({
      leaseId: "l1",
      os: "ubuntu",
      image: { imageId: "u", utmVm: golden.name },
      memoryMB: 1,
      cpus: 1,
    });
    utm.leases = `{\n\tip_address=192.168.64.7\n\thw_address=1,${leaseMac(vm.mac)}\n\tlease=0x1\n}`;
    await expect(p.waitForIp(vm, 5)).resolves.toBe("192.168.64.7");
    expect(vm.ip).toBe("192.168.64.7");
  });

  it("sweeps only lease VMs, never goldens, builds or the user's own VMs", async () => {
    const utm = fakeUtm([
      golden,
      { name: "vmh-build-ubuntu" },
      { name: "vmh-l9-ubuntu-lease", status: "started" },
      { name: "Linux" },
    ]);
    expect(await provider(utm).listOrphans()).toEqual([
      { name: "vmh-l9-ubuntu-lease", state: "Started", dir: null },
    ]);
  });

  it("keeps a stopped lease as a new image by renaming it and dropping the harness arguments", async () => {
    const utm = fakeUtm([golden]);
    const p = provider(utm);
    const vm = await p.create({
      leaseId: "l1",
      os: "ubuntu",
      image: { imageId: "u", utmVm: golden.name },
      memoryMB: 1,
      cpus: 1,
    });
    const saved = await p.snapshot(vm, {
      imageId: "ubuntu-snap-tools-20261110",
    });
    expect(saved).toEqual({ utmVm: "vmh-golden-ubuntu-snap-tools-20261110" });
    const kept = utm.vms.find((v) => v.name === saved.utmVm)!;
    expect(kept.qemuArgs).toEqual(["-device", "x"]);
    expect(p.reserved.size).toBe(0);
  });

  it("stops, then deletes a lease VM on destroy", async () => {
    const utm = fakeUtm([
      golden,
      { name: "vmh-l1-ubuntu-lease", status: "started" },
    ]);
    await provider(utm).destroy({ name: "vmh-l1-ubuntu-lease" });
    expect(utm.stop).toHaveBeenCalledWith("vmh-l1-ubuntu-lease");
    expect(utm.vms.map((v) => v.name)).toEqual([golden.name]);
  });

  it("reports what stops the host from running VMs", async () => {
    const utm = fakeUtm();
    utm.list.mockRejectedValueOnce(new Error("utmctl list failed: denied"));
    const check = await provider(utm).hostCheck();
    expect(check.ok).toBe(false);
    expect(check.problems).toContain("utmctl list failed: denied");
    expect(check.freeRamMB).toBe(8000);
  });

  it("is the provider on macOS", async () => {
    const p = await createProvider({ root: tmp } as never, "darwin");
    expect(p.id).toBe("utm");
    await expect(
      createProvider({ root: tmp } as never, "linux"),
    ).rejects.toThrow(/No VM provider for linux/);
  });
});

describe("UTM key tables", () => {
  it("spells combos as QEMU qcodes and X11 keysyms", () => {
    expect(comboToQcodes("ctrl+shift+p")).toEqual(["ctrl", "shift", "p"]);
    expect(comboToQcodes("cmd+space")).toEqual(["meta_l", "spc"]);
    expect(comboToQcodes("F5")).toEqual(["f5"]);
    expect(comboToKeysyms("cmd+space")).toEqual([0xffeb, 0x20]);
    expect(comboToKeysyms("enter")).toEqual([0xff0d]);
    expect(() => comboToQcodes("hyper+x")).toThrow(/Not a modifier/);
  });

  it("types US-layout characters, shifting where needed", () => {
    expect(charToQcodes("a")).toEqual(["a"]);
    expect(charToQcodes("A")).toEqual(["shift", "a"]);
    expect(charToQcodes("_")).toEqual(["shift", "minus"]);
    expect(charToQcodes(">")).toEqual(["shift", "dot"]);
    expect(charToQcodes(";")).toEqual(["semicolon"]);
    expect(charToKeysym("~")).toBe(0x7e);
    expect(() => charToQcodes("é")).toThrow(/printable ASCII/);
  });
});

/** A tiny RFB 3.8 server with one 4x2 framebuffer; records client messages. */
function fakeVncServer({ password }: { password?: string } = {}) {
  const received: Buffer[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let stage = "version";
    const challenge = Buffer.alloc(16, 7);
    sock.write("RFB 003.008\n");
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === "version" && buf.length >= 12) {
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, password ? 2 : 1]));
          stage = "security";
        } else if (stage === "security" && buf.length >= 1) {
          buf = buf.subarray(1);
          if (password) {
            sock.write(challenge);
            stage = "auth";
          } else {
            sock.write(Buffer.from([0, 0, 0, 0]));
            stage = "init";
          }
        } else if (stage === "auth" && buf.length >= 16) {
          const ok = buf
            .subarray(0, 16)
            .equals(vncAuthResponse(challenge, password!));
          buf = buf.subarray(16);
          sock.write(Buffer.from([0, 0, 0, ok ? 0 : 1]));
          if (!ok) {
            const reason = Buffer.from("bad password");
            const len = Buffer.alloc(4);
            len.writeUInt32BE(reason.length);
            sock.write(Buffer.concat([len, reason]));
            sock.end();
            return;
          }
          stage = "init";
        } else if (stage === "init" && buf.length >= 1) {
          buf = buf.subarray(1);
          const init = Buffer.alloc(24);
          init.writeUInt16BE(4, 0);
          init.writeUInt16BE(2, 2);
          const name = Buffer.from("fake");
          init.writeUInt32BE(name.length, 20);
          sock.write(Buffer.concat([init, name]));
          stage = "normal";
        } else if (stage === "normal" && buf.length >= 1) {
          const type = buf[0];
          const size =
            type === 0
              ? 20
              : type === 2
                ? 4 + buf.readUInt16BE(2) * 4
                : type === 3
                  ? 10
                  : type === 4
                    ? 8
                    : 6;
          if (type === 2 && buf.length < 4) return;
          if (buf.length < size) return;
          const msg = buf.subarray(0, size);
          buf = buf.subarray(size);
          received.push(Buffer.from(msg));
          if (type === 3) {
            // Two rects: the top row red, the bottom row blue (BGRX).
            const head = Buffer.from([0, 0, 0, 2]);
            const rect = (y: number, bgrx: number[]) => {
              const r = Buffer.alloc(12);
              r.writeUInt16BE(0, 0);
              r.writeUInt16BE(y, 2);
              r.writeUInt16BE(4, 4);
              r.writeUInt16BE(1, 6);
              r.writeInt32BE(0, 8);
              return Buffer.concat([
                r,
                Buffer.from(Array(4).fill(bgrx).flat()),
              ]);
            };
            sock.write(
              Buffer.concat([
                head,
                rect(0, [0, 0, 255, 0]),
                rect(1, [255, 0, 0, 0]),
              ]),
            );
          }
        } else return;
      }
    });
  });
  return new Promise<{ port: number; received: Buffer[]; close: () => void }>(
    (resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve({
          port: (server.address() as net.AddressInfo).port,
          received,
          close: () => server.close(),
        }),
      ),
  );
}

/** Decodes the first pixel of each row of an RGB PNG made by png.mjs (filter 0). */
function pngRows(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let p = 8;
  const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString("ascii", p + 4, p + 8);
    if (type === "IDAT") idat.push(png.subarray(p + 8, p + 8 + len));
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  return {
    width,
    height,
    firstPixels: Array.from({ length: height }, (_, y) => [
      ...raw.subarray(y * stride + 1, y * stride + 4),
    ]),
  };
}

describe("RFB client", () => {
  it("authenticates with a VNC password and turns the framebuffer into a PNG", async () => {
    const server = await fakeVncServer({ password: "s3cret" });
    const c = await new RfbClient({
      host: "127.0.0.1",
      port: server.port,
      password: "s3cret",
    }).connect();
    try {
      expect(c.name).toBe("fake");
      const shot = await c.screenshot();
      expect([shot.width, shot.height]).toEqual([4, 2]);
      expect(pngRows(shot.png).firstPixels).toEqual([
        [255, 0, 0],
        [0, 0, 255],
      ]);
      c.pointer(3, 1, 1);
      c.key(0xff0d, true);
      await new Promise((r) => setTimeout(r, 50));
      const pointer = server.received.find((m) => m[0] === 5)!;
      expect([
        pointer[1],
        pointer.readUInt16BE(2),
        pointer.readUInt16BE(4),
      ]).toEqual([1, 3, 1]);
      const key = server.received.find((m) => m[0] === 4)!;
      expect([key[1], key.readUInt32BE(4)]).toEqual([1, 0xff0d]);
    } finally {
      c.close();
      server.close();
    }
  });

  it("fails with the server's reason on a wrong password", async () => {
    const server = await fakeVncServer({ password: "right" });
    try {
      await expect(
        new RfbClient({
          host: "127.0.0.1",
          port: server.port,
          password: "wrong",
        }).connect(),
      ).rejects.toThrow(/authentication failed: bad password/);
    } finally {
      server.close();
    }
  });
});

/** A QMP server that greets, accepts capabilities and records every command. */
function fakeQmpServer() {
  const commands: { execute: string; arguments?: any }[] = [];
  const server = net.createServer((sock) => {
    sock.write('{"QMP": {"version": {}, "capabilities": []}}\r\n');
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        commands.push(msg);
        sock.write('{"event": "NOISE"}\r\n{"return": {}}\r\n');
      }
    });
  });
  return new Promise<{
    port: number;
    commands: typeof commands;
    close: () => void;
  }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        commands,
        close: () => server.close(),
      }),
    ),
  );
}

describe("QEMU desktop (VNC pixels, QMP input)", () => {
  it("sends absolute clicks scaled to the screen and typed keys through QMP", async () => {
    const vnc = await fakeVncServer();
    const qmp = await fakeQmpServer();
    const d = new QemuDesktop({ vncPort: vnc.port, qmpPort: qmp.port });
    try {
      await d.screenshot(); // learns the 4x2 screen
      await d.click(3, 1, "right");
      await d.type("A");
      const input = qmp.commands
        .filter((c) => c.execute === "input-send-event")
        .map((c) => c.arguments.events);
      expect(input[0]).toEqual([
        { type: "abs", data: { axis: "x", value: 0x7fff } },
        { type: "abs", data: { axis: "y", value: 0x7fff } },
      ]);
      expect(input[1]).toEqual([
        { type: "btn", data: { down: true, button: "right" } },
      ]);
      expect(input[2]).toEqual([
        { type: "btn", data: { down: false, button: "right" } },
      ]);
      expect(input[3].map((e: any) => [e.data.key.data, e.data.down])).toEqual([
        ["shift", true],
        ["a", true],
        ["a", false],
        ["shift", false],
      ]);
      await expect(d.click(4, 0)).rejects.toThrow(/outside the 4x2 screen/);
      // Nothing is typed when any character cannot be.
      const before = qmp.commands.length;
      await expect(d.type("ok é")).rejects.toThrow(/printable ASCII/);
      expect(qmp.commands.length).toBe(before);
    } finally {
      d.close();
      vnc.close();
      qmp.close();
    }
  });
});

describe("UTM golden images", () => {
  it("fills in the autoinstall template", () => {
    const yaml = renderAutoinstall(
      "u=__USER__ h=__HOSTNAME__ p=__PASSWORD_HASH__ k=__PUBKEY__ again=__USER__",
      {
        user: "zide",
        hostname: "vmh-ubuntu",
        passwordHash: "$6$x",
        publicKey: "ssh-ed25519 AAA",
      },
    );
    expect(yaml).toBe(
      "u=zide h=vmh-ubuntu p=$6$x k=ssh-ed25519 AAA again=zide",
    );
  });

  it("the shipped autoinstall template has every placeholder it needs", () => {
    const template = fs.readFileSync(
      path.join(
        __dirname,
        "../../../scripts/vm-harness/images/ubuntu/autoinstall.yaml",
      ),
      "utf8",
    );
    for (const p of [
      "__USER__",
      "__HOSTNAME__",
      "__PASSWORD_HASH__",
      "__PUBKEY__",
    ])
      expect(template).toContain(p);
    expect(template).toContain("vmh-provision");
  });

  it("seals a build VM: renames it, detaches the installer, strips harness args, writes the manifest", async () => {
    const imagesDir = path.join(tmp, "images");
    fs.mkdirSync(path.join(imagesDir, "build", "vmh-build-ubuntu"), {
      recursive: true,
    });
    const utm = fakeUtm([
      {
        name: "vmh-build-ubuntu",
        status: "started",
        qemuArgs: ["-vnc", "127.0.0.1:20"],
      },
    ]);
    const manifest = await sealGolden(utm as never, { imagesDir } as never, {
      os: "ubuntu",
      vmName: "vmh-build-ubuntu",
      osBuild: "25.10",
      vscodeVersion: "1.106.0",
      vscodeCommit: "abc",
      user: "zide",
      sshHostKeyFingerprint: "SHA256:x",
    });
    expect(utm.stop).toHaveBeenCalledWith("vmh-build-ubuntu");
    expect(manifest.utmVm).toBe(`vmh-golden-${manifest.imageId}`);
    expect(manifest.backend).toBe("qemu");
    expect(utm.vms[0].name).toBe(manifest.utmVm);
    expect(utm.vms[0].qemuArgs).toEqual([]);
    expect(utm.configure.mock.calls[0][1]).toMatchObject({
      removeRemovableDrives: true,
    });
    expect(
      fs.existsSync(path.join(imagesDir, "build", "vmh-build-ubuntu")),
    ).toBe(false);
    const [image] = listImages(imagesDir);
    expect(image).toMatchObject({
      imageId: manifest.imageId,
      utmVm: manifest.utmVm,
      os: "ubuntu",
    });
  });
});

describe("UTM images in the image store", () => {
  it("lists, snapshots and deletes images that are UTM VMs rather than disk files", () => {
    const imagesDir = path.join(tmp, "images");
    fs.mkdirSync(imagesDir);
    fs.writeFileSync(
      path.join(imagesDir, "macos-26-golden.json"),
      JSON.stringify({
        imageId: "macos-26-golden",
        os: "macos",
        kind: "golden",
        utmVm: "vmh-golden-macos-26-golden",
        backend: "apple",
        user: "zide",
      }),
    );
    const [parent] = listImages(imagesDir);
    expect(parent.description).toMatch(/^macOS/);
    const snap = registerSnapshot({ imagesDir } as never, parent, {
      imageId: "macos-snap-tools-20261110",
      name: "tools",
      vhdxPath: path.join(imagesDir, "unused.vhdx"),
      utmVm: "vmh-golden-macos-snap-tools-20261110",
    });
    expect(snap).toMatchObject({
      utmVm: "vmh-golden-macos-snap-tools-20261110",
      backend: "apple",
    });
    expect(snap).not.toHaveProperty("vhdxPath");
    const removed = deleteImage(
      { imagesDir } as never,
      listImages(imagesDir),
      "macos-snap-tools-20261110",
    );
    expect(removed).toMatchObject({
      diskRemoved: false,
      utmVm: "vmh-golden-macos-snap-tools-20261110",
    });
  });
});

describe("launcher: which hosts can run the harness", () => {
  it("needs pwsh on Windows and UTM on macOS", () => {
    expect(
      vmHarnessUnsupportedReason({ platform: "win32", hasCommand: () => true }),
    ).toBeNull();
    expect(
      vmHarnessUnsupportedReason({
        platform: "win32",
        hasCommand: () => false,
      }),
    ).toMatch(/pwsh/);
    expect(
      vmHarnessUnsupportedReason({
        platform: "darwin",
        fileExists: () => true,
      }),
    ).toBeNull();
    expect(
      vmHarnessUnsupportedReason({
        platform: "darwin",
        fileExists: () => false,
      }),
    ).toMatch(/needs UTM/);
    expect(vmHarnessUnsupportedReason({ platform: "linux" })).toMatch(
      /no VM provider for linux/,
    );
  });
});
