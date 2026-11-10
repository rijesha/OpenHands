// @vitest-environment node
/* eslint-disable local/no-direct-agent-server-fetch -- these tests call the VM harness, not the agent-server */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseCombo,
  toPlaywrightKey,
} from "../../../scripts/vm-harness/desktop/keys.mjs";
import { rgb565ToPng } from "../../../scripts/vm-harness/desktop/rgb565.mjs";
import { checkExecCommand } from "../../../scripts/vm-harness/guest/exec-guard.mjs";
import {
  deleteImage,
  resolveImage,
} from "../../../scripts/vm-harness/images.mjs";
import { restartVsCode } from "../../../scripts/vm-harness/guest/ops.mjs";
import { decodeClixml } from "../../../scripts/vm-harness/guest/ssh.mjs";
import { VsCodeDriver } from "../../../scripts/vm-harness/app-drivers/vscode.mjs";
import { sealImage } from "../../../scripts/vm-harness/images-admin.mjs";
import { listImages } from "../../../scripts/vm-harness/images.mjs";
import { LeaseManager } from "../../../scripts/vm-harness/leases.mjs";
import {
  isInsideRoots,
  runDesktopAction,
  validateArgs,
} from "../../../scripts/vm-harness/mcp.mjs";
import { loadConfig } from "../../../scripts/vm-harness/config.mjs";
import { renderPlugin } from "../../../scripts/vm-harness/plugin.mjs";
import { assembleReport } from "../../../scripts/vm-harness/report.mjs";
import { createServer } from "../../../scripts/vm-harness/server.mjs";

const KEY = "stack-key";

/** A harness wired to a fake hypervisor and fake guest, listening on a random port. */
async function startHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-test-"));
  const imagesDir = path.join(root, "images");
  const secretsDir = path.join(root, "secrets");
  fs.mkdirSync(imagesDir);
  fs.mkdirSync(secretsDir);
  fs.writeFileSync(path.join(secretsDir, "guest_ed25519"), "key");
  fs.writeFileSync(
    path.join(secretsDir, "guest-creds.json"),
    '{"password":"hunter2"}',
  );
  fs.writeFileSync(
    path.join(imagesDir, "win.json"),
    JSON.stringify({
      imageId: "win-1",
      os: "windows",
      vhdxPath: "x.vhdx",
      user: "zide",
      sshHostKeyFingerprint: "SHA256:abc",
      createdAt: "2026-01-01",
    }),
  );
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace);

  const config = {
    root,
    imagesDir,
    secretsDir,
    runsDir: path.join(root, "runs"),
    port: 0,
    apiKey: KEY,
    workspaceRoots: [workspace],
    maxVms: 1,
    leaseTtlMs: 1000,
    memoryMB: 1024,
    cpus: 1,
  };
  const typed = { text: [] as string[] };
  const provider = {
    id: "fake",
    destroyed: [] as string[],
    orphans: [] as { name: string; dir: string }[],
    hostCheck: vi.fn(async () => ({
      ok: true,
      problems: [],
      freeRamMB: 99999,
    })),
    create: vi.fn(async ({ leaseId }: { leaseId: string }) => ({
      name: `vmh-${leaseId}`,
      vmId: "id",
      dir: "d",
    })),
    start: vi.fn(async () => undefined),
    waitForIp: vi.fn(async (): Promise<string> => "10.0.0.5"),
    stop: vi.fn(async () => undefined),
    destroy: vi.fn(async (vm: { name: string }) => {
      provider.destroyed.push(vm.name);
    }),
    listOrphans: vi.fn(async () => provider.orphans),
    state: vi.fn(async () => "Off"),
    snapshot: vi.fn(
      async (_vm: { name: string }, target: { vhdxPath: string }) => {
        fs.writeFileSync(target.vhdxPath, "disk");
        return { vhdxPath: target.vhdxPath, sizeBytes: 4 };
      },
    ),
    desktop: () => ({
      screenSize: () => ({ width: 1280, height: 800 }),
      screenshot: async () => ({
        png: Buffer.from("png"),
        width: 1280,
        height: 800,
      }),
      type: async (t: string) => {
        typed.text.push(t);
      },
      click: async (x: number, y: number) => {
        typed.text.push(`click ${x},${y}`);
      },
      key: async (combo: string) => {
        typed.text.push(`key ${combo}`);
      },
    }),
    close: vi.fn(),
  };
  const session = {
    close: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({
      code: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    })),
    putFile: vi.fn(async () => undefined),
  };
  const ops = {
    paths: { inbox: "C:\\in" },
    waitForDesktop: vi.fn(async () => undefined),
    killApp: vi.fn(async () => undefined),
    resetWorkspace: vi.fn(async () => undefined),
  };
  const driver = {
    restart: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => '- button "Extensions" [ref=e5]'),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    waitForText: vi.fn(async () => true),
  };
  const leases = new LeaseManager({
    config: config as never,
    provider,
    guest: {
      createSession: () => ({ ...session, connect: async () => undefined }),
      opsFor: () => ops,
      createDriver: () => driver,
    },
  });
  const server = createServer({ config: config as never, leases, provider });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const rpc = async (method: string, params?: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-API-Key": KEY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return res.json();
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return r.result as {
      content: { type: string; text?: string; mimeType?: string }[];
      isError?: boolean;
    };
  };
  const boot = async (app: "none" | "vscode" = "none") => {
    const started = JSON.parse(
      (await call("vm_start", { image: "windows", app })).content[0]
        .text as string,
    );
    await call("vm_wait_ready", { vm: started.vm, timeout_s: 5 });
    return started.vm as string;
  };
  return {
    base,
    config,
    provider,
    session,
    driver,
    ops,
    leases,
    workspace,
    typed,
    rpc,
    call,
    boot,
    close: () => server.close(),
  };
}

describe("vm-harness HTTP surface", () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(() => h.close());

  it("serves /health without a key but rejects everything else without a valid one", async () => {
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
    expect((await fetch(`${h.base}/images`)).status).toBe(401);
    const wrong = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: { "X-Session-API-Key": "wrong" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("accepts the ingress-prefixed path", async () => {
    const res = await fetch(`${h.base}/api/vm-harness/images`, {
      headers: { "X-Session-API-Key": KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      expect.objectContaining({ imageId: "win-1" }),
    ]);
  });

  it("lists tools and reports bad arguments as tool errors", async () => {
    const list = await h.rpc("tools/list", {});
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "vm_start",
        "desktop_screenshot",
        "submit_report",
      ]),
    );

    const r = await h.call("desktop_click", { vm: "l000000", x: "a", y: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("'x' must be an integer");
  });

  it("boots a lease, returns screenshots, and removes the VM on stop", async () => {
    const started = JSON.parse(
      (await h.call("vm_start", { image: "windows", app: "none" })).content[0]
        .text as string,
    );
    expect(started.status).toBe("booting");
    const vm = started.vm as string;

    const ready = JSON.parse(
      (await h.call("vm_wait_ready", { vm, timeout_s: 5 })).content[0]
        .text as string,
    );
    expect(ready.status).toBe("ready");

    const shot = await h.call("desktop_screenshot", { vm });
    expect(shot.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });

    await h.call("vm_stop", { vm });
    expect(h.provider.destroyed).toEqual([`vmh-${vm}`]);
    expect((await h.call("desktop_screenshot", { vm })).isError).toBe(true);
  });

  it("refuses a second VM beyond the limit", async () => {
    await h.call("vm_start", { image: "windows", app: "none" });
    const second = await h.call("vm_start", { image: "windows", app: "none" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("Limit reached");
  });

  it("only copies files from inside the workspace roots", async () => {
    const vm = await h.boot();
    const outside = path.join(h.config.root, "secret.txt");
    fs.writeFileSync(outside, "x");
    const inside = path.join(h.workspace, "a.vsix");
    fs.writeFileSync(inside, "x");

    expect(
      (await h.call("vm_put_file", { vm, host_path: outside })).isError,
    ).toBe(true);
    const ok = await h.call("vm_put_file", { vm, host_path: inside });
    expect(ok.isError).toBeUndefined();
    expect(h.session.putFile).toHaveBeenCalledWith(inside, "C:\\in\\a.vsix");
  });

  it("keeps inspect-only guest commands from installing software", async () => {
    const vm = await h.boot();
    const refused = await h.call("vm_exec", {
      vm,
      command: "winget install foo",
    });
    expect(refused.isError).toBe(true);
    expect(h.session.exec).not.toHaveBeenCalledWith(
      "winget install foo",
      expect.anything(),
    );
  });

  it("types the guest password without returning it", async () => {
    const vm = await h.boot();
    const r = await h.call("desktop_type_secret", { vm, secret: "sudo" });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(h.typed.text).toEqual(["hunter2"]);
  });

  it("only accepts a report that agrees with the recorded steps", async () => {
    const vm = await h.boot();
    await h.call("record_step", {
      vm,
      id: "s1",
      title: "Install",
      status: "fail",
      expected: "installed",
      observed: "error dialog",
    });

    const lie = await h.call("submit_report", {
      vm,
      passed: true,
      confidence: "low",
      summary: "fine",
    });
    expect(lie.isError).toBe(true);

    const honest = await h.call("submit_report", {
      vm,
      passed: false,
      confidence: "high",
      summary: "install failed",
    });
    expect(honest.isError).toBeUndefined();
    const runs = await (
      await fetch(`${h.base}/runs`, { headers: { "X-Session-API-Key": KEY } })
    ).json();
    expect(runs[0].report).toMatchObject({ passed: false, steps: 1 });
  });
});

describe("VS Code app tools", () => {
  it("drives the window through refs and closes the connection on stop", async () => {
    const h = await startHarness();
    const vm = await h.boot("vscode");
    expect(h.driver.restart).toHaveBeenCalledTimes(1);

    const snap = await h.call("app_snapshot", { vm });
    expect(snap.content[0].text).toContain("[ref=e5]");
    await h.call("app_click", { vm, ref: "e5" });
    await h.call("app_type", { vm, text: "Install from VSIX", submit: true });
    expect(h.driver.click).toHaveBeenCalledWith("e5");
    expect(h.driver.type).toHaveBeenCalledWith("Install from VSIX", {
      ref: undefined,
      submit: true,
    });

    await h.call("vm_stop", { vm });
    expect(h.driver.close).toHaveBeenCalled();
    h.close();
  });

  it("reports a timeout from app_wait_for and refuses app tools without a VS Code VM", async () => {
    const h = await startHarness();
    h.driver.waitForText.mockResolvedValueOnce(false);
    const vm = await h.boot("vscode");
    const waited = await h.call("app_wait_for", {
      vm,
      text: "Done",
      timeoutSec: 1,
    });
    expect(waited.content[0].text).toContain("TIMEOUT");
    await h.call("vm_stop", { vm });

    const plain = await h.boot("none");
    expect((await h.call("app_snapshot", { vm: plain })).isError).toBe(true);
    h.close();
  });
});

describe("VsCodeDriver", () => {
  it("connects once through an SSH forward and acts on aria refs", async () => {
    const click = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      title: async () => "Welcome - Visual Studio Code",
      ariaSnapshot: vi.fn(async () => "x".repeat(40_000)),
      locator: vi.fn(() => ({ click, fill: vi.fn() })),
      keyboard: { press: vi.fn(), type: vi.fn() },
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => ({
        contexts: () => [{ pages: () => [page] }],
        close: vi.fn(async () => undefined),
      })),
    };
    const forward = { localPort: 9444, close: vi.fn(async () => undefined) };
    const ssh = { forwardLocal: vi.fn(async () => forward) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => [
        {
          type: "page",
          url: "vscode-file://workbench.html",
          title: "Visual Studio Code",
        },
      ],
    } as unknown as Response);
    try {
      const driver = new VsCodeDriver({ ssh, ops: {}, chromium });

      const snapshot = await driver.snapshot();
      await driver.click("e7");

      expect(snapshot.length).toBeLessThan(31_000);
      expect(snapshot).toContain("truncated");
      expect(chromium.connectOverCDP).toHaveBeenCalledWith(
        "http://127.0.0.1:9444",
      );
      expect(ssh.forwardLocal).toHaveBeenCalledTimes(1);
      expect(page.locator).toHaveBeenCalledWith("aria-ref=e7");
      expect(click).toHaveBeenCalled();

      await driver.close();
      expect(forward.close).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("LeaseManager lifecycle", () => {
  it("destroys VMs left behind by an earlier process", async () => {
    const h = await startHarness();
    h.provider.orphans = [{ name: "vmh-old", dir: "d" }];
    expect(await h.leases.sweepOrphans()).toBe(1);
    expect(h.provider.destroyed).toEqual(["vmh-old"]);
    h.close();
  });

  it("reaps an idle lease and cleans up after a failed boot", async () => {
    const h = await startHarness();
    const lease = h.leases.start({ image: "windows", app: "none" });
    await lease.ready;
    await h.leases.reapIdle(Date.now() + 10_000);
    expect(lease.status).toBe("stopped");
    expect(h.provider.destroyed).toHaveLength(1);

    h.provider.waitForIp.mockRejectedValueOnce(new Error("no ip"));
    const failing = h.leases.start({ image: "windows", app: "none" });
    await expect(failing.ready).rejects.toThrow("no ip");
    expect(failing.status).toBe("failed");
    expect(h.provider.destroyed).toHaveLength(2);
    h.close();
  });
});

describe("harness helpers", () => {
  it("resolves an image by id, or the newest golden image for an OS", () => {
    const images = [
      { imageId: "p", os: "windows", kind: "prepared" },
      { imageId: "g", os: "windows", kind: "golden" },
    ] as never;
    expect(resolveImage(images, "windows").imageId).toBe("g");
    expect(resolveImage(images, "p").imageId).toBe("p");
    expect(() => resolveImage(images, "ubuntu")).toThrow(/No image matches/);
  });

  it("validates tool arguments and applies defaults", () => {
    const schema = {
      properties: {
        n: { type: "integer", minimum: 1, default: 3 },
        s: { type: "string", enum: ["a"] },
      },
      required: ["s"],
    };
    expect(validateArgs(schema, { s: "a" })).toEqual({ s: "a", n: 3 });
    expect(() => validateArgs(schema, {})).toThrow("missing required");
    expect(() => validateArgs(schema, { s: "b" })).toThrow("one of");
    expect(() => validateArgs(schema, { s: "a", n: 0 })).toThrow(">= 1");
  });

  it("treats a link escaping a root as outside it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-out-"));
    fs.writeFileSync(path.join(outside, "f"), "x");
    fs.writeFileSync(path.join(root, "own"), "x");
    expect(isInsideRoots(path.join(root, "own"), [root])).toBe(true);
    expect(isInsideRoots(path.join(outside, "f"), [root])).toBe(false);
    try {
      fs.symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      return; // links unavailable on this host
    }
    expect(isInsideRoots(path.join(root, "link", "f"), [root])).toBe(false);
  });

  it("maps key combos to virtual-key codes", () => {
    expect(parseCombo("ctrl+shift+p")).toEqual({
      press: [0x11, 0x10],
      type: [0x50],
      release: [0x10, 0x11],
    });
    expect(() => parseCombo("hyper+x")).toThrow("Not a modifier");
  });

  it("encodes RGB565 frames as a PNG", () => {
    const png = rgb565ToPng(Buffer.alloc(4 * 2 * 2, 0xff), 4, 2);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(4);
    expect(() => rgb565ToPng(Buffer.alloc(3), 4, 2)).toThrow("too small");
  });

  it("allows installs in full mode only", () => {
    expect(checkExecCommand("apt-get install -y vlc").allowed).toBe(false);
    expect(checkExecCommand("apt-get install -y vlc", "full").allowed).toBe(
      true,
    );
    expect(checkExecCommand("Get-Process Code").allowed).toBe(true);
  });

  it("rejects a high-confidence report whose passed steps lack evidence", () => {
    const steps = [{ id: "a", status: "pass", evidence: [] }];
    expect(() =>
      assembleReport({ leaseId: "l", imageId: "i", os: "windows" }, steps, {
        passed: true,
        confidence: "high",
        summary: "s",
      }),
    ).toThrow("needs evidence");
  });

  it("renders a plugin carrying the skill and an authenticated MCP server", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-plugin-"));
    renderPlugin({ outDir: out, port: 18010, apiKey: "k" });
    const mcp = JSON.parse(
      fs.readFileSync(path.join(out, ".mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers["vm-harness"]).toMatchObject({
      url: "http://127.0.0.1:18010/mcp",
      headers: { "X-Session-API-Key": "k" },
    });
    expect(
      fs.existsSync(path.join(out, "skills", "gui-vm-testing", "SKILL.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(out, ".plugin", "plugin.json"))).toBe(true);
  });
});

describe("sealImage", () => {
  const input = {
    os: "windows",
    vmName: "golden",
    osBuild: "26300.1",
    edition: "Pro",
    vscodeVersion: "1.145.2",
    vscodeCommit: "abc",
    user: "zide",
    sshHostKeyFingerprint: "SHA256:xyz",
  };

  it("moves the disk into the images folder read-only and writes a manifest the harness lists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-seal-"));
    const imagesDir = path.join(root, "images");
    fs.mkdirSync(path.join(imagesDir, "build"), { recursive: true });
    fs.writeFileSync(path.join(imagesDir, "build", "golden.vhdx"), "disk");
    const bridge = { call: vi.fn(async () => undefined) };

    const manifest = await sealImage(bridge, { imagesDir } as never, input);
    const again = await (async () => {
      fs.writeFileSync(path.join(imagesDir, "build", "golden.vhdx"), "disk2");
      return sealImage(bridge, { imagesDir } as never, input);
    })();

    expect(fs.existsSync(path.join(imagesDir, "build", "golden.vhdx"))).toBe(
      false,
    );
    expect(fs.readFileSync(manifest.vhdxPath, "utf8")).toBe("disk");
    expect(again.imageId).toBe(`${manifest.imageId}-r2`);
    expect(
      listImages(imagesDir).map((i: { imageId: string }) => i.imageId),
    ).toEqual(expect.arrayContaining([manifest.imageId, again.imageId]));
    expect(bridge.call).toHaveBeenCalledWith(
      "Stop-VM",
      expect.anything(),
      expect.anything(),
    );
  });

  it("refuses to seal without the guest host-key fingerprint", async () => {
    await expect(
      sealImage({ call: vi.fn() }, { imagesDir: "x" } as never, {
        ...input,
        sshHostKeyFingerprint: "",
      }),
    ).rejects.toThrow("--ssh-host-key-fingerprint");
  });
});

type Harness = Awaited<ReturnType<typeof startHarness>>;
const AUTH = { "X-Session-API-Key": KEY, "Content-Type": "application/json" };
const api = async (h: Harness, method: string, p: string, body?: unknown) => {
  const res = await fetch(`${h.base}${p}`, {
    method,
    headers: AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

describe("batched actions", () => {
  it("runs several desktop actions and returns one screenshot, stopping at the first failure", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      const ok = await h.call("desktop_actions", {
        vm,
        settleMs: 0,
        actions: [
          { type: "click", x: 10, y: 20 },
          { type: "type", text: "hello" },
          { type: "key", combo: "enter" },
        ],
      });
      expect(ok.isError).toBeUndefined();
      expect(ok.content[0].type).toBe("image");
      expect(ok.content[1].text).toContain("3. key enter");
      expect(h.typed.text).toEqual(["click 10,20", "hello", "key enter"]);

      const bad = await h.call("desktop_actions", {
        vm,
        settleMs: 0,
        actions: [{ type: "bogus" }, { type: "key", combo: "esc" }],
      });
      expect(bad.isError).toBe(true);
      expect(bad.content[1].text).toContain("action 1");
      expect(h.typed.text).not.toContain("key esc");
    } finally {
      h.close();
    }
  });

  it("runs VS Code actions in one call and ends with a fresh snapshot", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot("vscode");
      const r = await h.call("app_actions", {
        vm,
        actions: [
          { type: "type", ref: "e5", text: "vsix", submit: true },
          { type: "press", key: "Escape" },
        ],
      });
      expect(r.isError).toBeUndefined();
      expect(h.driver.type).toHaveBeenCalledWith("vsix", {
        ref: "e5",
        submit: true,
      });
      expect(h.driver.press).toHaveBeenCalledWith("Escape");
      expect(r.content[0].text).toContain("[ref=e5]");

      h.driver.waitForText.mockResolvedValueOnce(false);
      const miss = await h.call("app_actions", {
        vm,
        actions: [{ type: "wait_for", text: "Done", timeoutSec: 1 }],
      });
      expect(miss.isError).toBe(true);
    } finally {
      h.close();
    }
  });

  it("captures evidence inside record_step", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      await h.call("record_step", {
        vm,
        id: "s1",
        title: "t",
        status: "pass",
        expected: "e",
        observed: "o",
        capture: true,
      });
      const run = h.leases.get(vm).runDir;
      const step = JSON.parse(
        fs.readFileSync(path.join(run, "steps.jsonl"), "utf8").trim(),
      );
      expect(step.evidence).toHaveLength(1);
      expect(fs.existsSync(step.evidence[0])).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("snapshots and image management", () => {
  it("saves a running VM as a snapshot image that depends on its base", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      const r = await h.call("vm_snapshot", { vm, name: "Tools Installed!" });
      expect(r.isError).toBeUndefined();
      expect(h.provider.snapshot).toHaveBeenCalledTimes(1);

      const images = (await api(h, "GET", "/images")).body as {
        imageId: string;
        kind: string;
        parentImageId?: string;
        children: string[];
        label?: string;
      }[];
      const snap = images.find((i) => i.kind === "prepared");
      expect(snap?.imageId).toMatch(/^windows-snap-tools-installed-\d{8}$/);
      expect(snap?.parentImageId).toBe("win-1");
      expect(snap?.label).toBe("Tools Installed!");
      expect(images.find((i) => i.imageId === "win-1")?.children).toEqual([
        snap?.imageId,
      ]);
      // The lease is over, and the snapshot can be booted by id.
      expect((await h.call("desktop_screenshot", { vm })).isError).toBe(true);
      const again = await h.call("vm_start", {
        image: snap?.imageId,
        app: "none",
      });
      expect(again.isError).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("refuses to delete a base image that has snapshots, then deletes the snapshot and its disk", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      await h.call("vm_snapshot", { vm, name: "one" });
      const snapId = (
        (await api(h, "GET", "/images")).body as {
          imageId: string;
          kind: string;
        }[]
      ).find((i) => i.kind === "prepared")?.imageId as string;

      h.leases.unlock("win-1");
      const blocked = await api(h, "DELETE", "/images/win-1");
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain(snapId);

      const disk = path.join(h.config.imagesDir, `${snapId}.vhdx`);
      expect(fs.existsSync(disk)).toBe(true);
      const done = await api(h, "DELETE", `/images/${snapId}`);
      expect(done.status).toBe(200);
      expect(done.body.diskRemoved).toBe(true);
      expect(fs.existsSync(disk)).toBe(false);
      expect(((await api(h, "GET", "/images")).body as unknown[]).length).toBe(
        1,
      );
    } finally {
      h.close();
    }
  });

  it("will not delete an image a running VM booted from", async () => {
    const h = await startHarness();
    try {
      await h.boot();
      h.leases.unlock("win-1");
      const r = await api(h, "DELETE", "/images/win-1");
      expect(r.status).toBe(409);
      expect(r.body.error).toContain("running VM");
    } finally {
      h.close();
    }
  });

  it("renames an image and keeps its notes", async () => {
    const h = await startHarness();
    try {
      h.leases.unlock("win-1");
      const r = await api(h, "PATCH", "/images/win-1", {
        label: "Clean Windows",
        notes: "no tools",
      });
      expect(r.status).toBe(200);
      const img = ((await api(h, "GET", "/images")).body as unknown[])[0];
      expect(img).toMatchObject({ label: "Clean Windows", notes: "no tools" });
    } finally {
      h.close();
    }
  });

  it("tells an agent where to configure the data folder when no images exist", async () => {
    const h = await startHarness();
    try {
      fs.rmSync(path.join(h.config.imagesDir, "win.json"));
      const r = await h.call("vm_start", { image: "windows", app: "none" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Test VMs page");
    } finally {
      h.close();
    }
  });
});

describe("data folder chosen in the GUI", () => {
  let settingsFile: string;
  beforeEach(() => {
    settingsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vmh-settings-")),
      "settings.json",
    );
    process.env.VM_HARNESS_SETTINGS_FILE = settingsFile;
  });
  afterEach(() => {
    delete process.env.VM_HARNESS_SETTINGS_FILE;
  });

  it("switches the images folder, remembers it, and lets it win over VM_HARNESS_ROOT", async () => {
    const h = await startHarness();
    try {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "vmh-other-"));
      fs.mkdirSync(path.join(other, "images"));
      fs.writeFileSync(
        path.join(other, "images", "ub.json"),
        JSON.stringify({
          imageId: "ub-1",
          os: "ubuntu",
          vhdxPath: "u.vhdx",
          createdAt: "2026-02-01",
        }),
      );
      const res = await api(h, "POST", "/settings", { root: other });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        root: other,
        imageCount: 1,
        rootSource: "settings",
      });
      expect(
        h.leases.images().map((i: { imageId: string }) => i.imageId),
      ).toEqual(["ub-1"]);

      const cfg = loadConfig({
        VM_HARNESS_ROOT: "D:\\ignored",
        VM_HARNESS_SETTINGS_FILE: settingsFile,
      });
      expect(cfg.root).toBe(path.resolve(other));
      expect(cfg.imagesDir).toBe(path.join(path.resolve(other), "images"));
      expect(cfg.rootSource).toBe("settings");
    } finally {
      h.close();
    }
  });

  it("falls back to VM_HARNESS_ROOT when nothing was chosen", () => {
    const cfg = loadConfig({
      VM_HARNESS_ROOT: os.tmpdir(),
      VM_HARNESS_SETTINGS_FILE: settingsFile,
    });
    expect(cfg.root).toBe(path.resolve(os.tmpdir()));
    expect(cfg.rootSource).toBe("env");
  });

  it("rejects missing folders and refuses to switch while a VM runs", async () => {
    const h = await startHarness();
    try {
      const post = (root: string) => api(h, "POST", "/settings", { root });
      expect(
        (await post(path.join(os.tmpdir(), "does-not-exist-vmh"))).status,
      ).toBe(400);
      expect((await post("relative/path")).status).toBe(400);
      await h.boot();
      expect((await post(os.tmpdir())).status).toBe(409);
    } finally {
      h.close();
    }
  });

  it("lists sub-folders for the folder picker", async () => {
    const h = await startHarness();
    try {
      const res = await api(
        h,
        "GET",
        `/browse?path=${encodeURIComponent(h.config.root)}`,
      );
      expect(res.body.dirs).toEqual(
        expect.arrayContaining(["images", "secrets"]),
      );
      expect(res.body.hasImages).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("base images are locked", () => {
  it("lists bases as locked and refuses edits and deletes until the user opens them", async () => {
    const h = await startHarness();
    try {
      const base = (
        (await api(h, "GET", "/images")).body as { locked: boolean }[]
      )[0];
      expect(base.locked).toBe(true);
      expect(
        (await api(h, "PATCH", "/images/win-1", { label: "x" })).status,
      ).toBe(403);
      expect((await api(h, "DELETE", "/images/win-1")).status).toBe(403);

      expect(
        (await api(h, "POST", "/images/win-1/unlock", { minutes: 5 })).status,
      ).toBe(200);
      const open = (
        (await api(h, "GET", "/images")).body as {
          locked: boolean;
          unlockedUntil: number;
        }[]
      )[0];
      expect(open.locked).toBe(false);
      expect(open.unlockedUntil).toBeGreaterThan(Date.now());

      await api(h, "POST", "/images/win-1/lock");
      expect(
        (await api(h, "PATCH", "/images/win-1", { label: "x" })).status,
      ).toBe(403);
    } finally {
      h.close();
    }
  });

  it("only lets an agent edit a base the user opened, and saves a new revision instead of changing it", async () => {
    const h = await startHarness();
    try {
      const refused = await h.call("vm_start", {
        image: "win-1",
        purpose: "base-edit",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("locked");

      h.leases.unlock("win-1");
      const started = JSON.parse(
        (await h.call("vm_start", { image: "win-1", purpose: "base-edit" }))
          .content[0].text as string,
      );
      await h.call("vm_wait_ready", { vm: started.vm, timeout_s: 5 });
      // A base-edit VM cannot be saved as a snapshot, and can run installs.
      expect(
        (await h.call("vm_snapshot", { vm: started.vm, name: "x" })).isError,
      ).toBe(true);
      expect(h.leases.get(started.vm).execPolicy).toBe("full");

      const saved = await h.call("vm_save_base", {
        vm: started.vm,
        name: "Node 22",
        notes: "installed node 22",
      });
      expect(saved.isError).toBeUndefined();
      const images = (await api(h, "GET", "/images")).body as {
        imageId: string;
        kind: string;
        parentImageId?: string;
        locked: boolean;
      }[];
      const rev = images.find((i) => i.imageId !== "win-1");
      expect(rev).toMatchObject({
        kind: "golden",
        parentImageId: "win-1",
        locked: true,
      });
      expect(rev?.imageId).toMatch(/^windows-base-node-22-\d{8}$/);
      // The old base is locked again and untouched.
      expect(images.find((i) => i.imageId === "win-1")?.locked).toBe(true);
    } finally {
      h.close();
    }
  });

  it("refuses vm_save_base on an ordinary test VM and base-edit on a snapshot", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      expect(
        (await h.call("vm_save_base", { vm, name: "x", notes: "y" })).isError,
      ).toBe(true);
      await h.call("vm_snapshot", { vm, name: "snap" });
      const snap = (
        (await api(h, "GET", "/images")).body as {
          imageId: string;
          kind: string;
        }[]
      ).find((i) => i.kind === "prepared");
      const r = await h.call("vm_start", {
        image: snap?.imageId,
        purpose: "base-edit",
      });
      expect(r.isError).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("capacity and failure handling", () => {
  it("refuses vm_start at once when the host is short of RAM, and queues with waitForRam", async () => {
    const h = await startHarness();
    try {
      h.provider.hostCheck.mockResolvedValue({
        ok: true,
        problems: [],
        freeRamMB: 1000,
      });

      const refused = await h.call("vm_start", { image: "windows" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("1000 MB free");
      expect(refused.content[0].text).toContain("waitForRam");
      expect(h.leases.active()).toHaveLength(0);

      const queued = JSON.parse(
        (await h.call("vm_start", { image: "windows", waitForRam: true }))
          .content[0].text as string,
      );
      const lease = h.leases.get(queued.vm);
      await vi.waitFor(() =>
        expect(lease.stage).toContain("waiting for free RAM"),
      );
      expect(lease.stage).toContain("1000/");
      await h.call("vm_stop", { vm: queued.vm });
    } finally {
      h.close();
    }
  });

  it("sizes memory per image and keeps the failure reason and context on disk", async () => {
    const h = await startHarness();
    try {
      fs.writeFileSync(
        path.join(h.config.imagesDir, "ub.json"),
        JSON.stringify({
          imageId: "ub-1",
          os: "ubuntu",
          vhdxPath: "u.vhdx",
          user: "zide",
          sshHostKeyFingerprint: "SHA256:abc",
          createdAt: "2026-02-01",
          memoryMB: 3072,
        }),
      );
      h.provider.waitForIp.mockRejectedValueOnce(new Error("no ip"));

      const started = JSON.parse(
        (
          await h.call("vm_start", {
            image: "ub-1",
            app: "none",
            context: { repository: "o/r", item: "7", ignored: { a: 1 } },
          })
        ).content[0].text as string,
      );
      const lease = h.leases.get(started.vm);
      await lease.ready.catch(() => undefined);

      expect(h.provider.create).toHaveBeenCalledWith(
        expect.objectContaining({ memoryMB: 3072 }),
      );
      const saved = JSON.parse(
        fs.readFileSync(path.join(lease.runDir, "lease.json"), "utf8"),
      );
      expect(saved).toMatchObject({
        status: "failed",
        error: "no ip",
        context: { repository: "o/r", item: "7" },
      });
      expect(saved.context.ignored).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("lists only running leases unless all is requested", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      await h.call("vm_stop", { vm });
      await h.boot();

      const running = JSON.parse(
        (await h.call("vm_status")).content[0].text as string,
      );
      const everything = JSON.parse(
        (await h.call("vm_status", { all: true })).content[0].text as string,
      );

      expect(running).toHaveLength(1);
      expect(everything).toHaveLength(2);
    } finally {
      h.close();
    }
  });
});

describe("shared key syntax and VS Code commands", () => {
  it("spells keys the way Playwright expects and accepts key as an alias of combo", async () => {
    expect(toPlaywrightKey("ctrl+shift+P")).toBe("Control+Shift+p");
    expect(toPlaywrightKey("Return")).toBe("Enter");
    expect(toPlaywrightKey("alt+F4")).toBe("Alt+F4");

    const key = vi.fn(async () => undefined);
    await runDesktopAction({ key }, { type: "key", key: "Return" });
    expect(key).toHaveBeenCalledWith("Return");
  });

  function fakePage(rows: string[]) {
    const click = vi.fn(async () => undefined);
    const rowLoc = {
      first: () => ({ waitFor: vi.fn(async () => undefined) }),
      allTextContents: async () => rows,
      nth: vi.fn(() => ({ click })),
    };
    const page = {
      isClosed: () => false,
      title: async () => "Visual Studio Code",
      locator: vi.fn(() => rowLoc),
      keyboard: { press: vi.fn(), type: vi.fn() },
    };
    return { page, click, rowLoc };
  }

  async function driverFor(page: unknown) {
    const chromium = {
      connectOverCDP: vi.fn(async () => ({
        contexts: () => [{ pages: () => [page] }],
        close: vi.fn(async () => undefined),
      })),
    };
    const ssh = {
      forwardLocal: vi.fn(async () => ({
        localPort: 9555,
        close: vi.fn(async () => undefined),
      })),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => [
        {
          type: "page",
          url: "vscode-file://workbench.html",
          title: "Visual Studio Code",
        },
      ],
    } as unknown as Response);
    return new VsCodeDriver({ ssh, ops: {}, chromium });
  }

  it("runs the palette command whose title matches exactly, not the top fuzzy hit", async () => {
    const { page, rowLoc } = fakePage([
      "File: Open Containing Folder",
      "File: Open Folder...",
    ]);
    const driver = await driverFor(page);

    await driver.runCommand("File: Open Folder...");

    expect(rowLoc.nth).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("fails with the closest titles when no command matches exactly", async () => {
    const { page, click } = fakePage(["File: Open Containing Folder"]);
    const driver = await driverFor(page);

    await expect(driver.runCommand("File: Open Folder...")).rejects.toThrow(
      "Open Containing Folder",
    );
    expect(click).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("filters a snapshot to matching lines and retries a blocked click with force", async () => {
    const first = vi.fn().mockRejectedValueOnce(new Error("covered"));
    const click = first.mockResolvedValue(undefined);
    const page = {
      isClosed: () => false,
      title: async () => "Visual Studio Code",
      ariaSnapshot: async () =>
        '- button "Save" [ref=e1]\n- button "Open" [ref=e2]',
      locator: vi.fn(() => ({
        click,
        scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      })),
      keyboard: { press: vi.fn(), type: vi.fn() },
    };
    const driver = await driverFor(page);

    expect(await driver.snapshot({ match: "open" })).toBe(
      '- button "Open" [ref=e2]',
    );
    await driver.click("e2");

    expect(click).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true }),
    );
    vi.restoreAllMocks();
  });
});

describe("manual control and lease upkeep", () => {
  it("lets the page click and type in a ready VM, and refuses bad input", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();

      const click = await api(h, "POST", `/leases/${vm}/input`, {
        type: "click",
        x: 40,
        y: 60,
      });
      const typed = await api(h, "POST", `/leases/${vm}/input`, {
        type: "type",
        text: "hello",
      });
      const outside = await api(h, "POST", `/leases/${vm}/input`, {
        type: "click",
        x: "left",
        y: 1,
      });

      expect([click.status, typed.status, outside.status]).toEqual([
        200, 200, 400,
      ]);
      expect(h.typed.text).toEqual(["click 40,60", "hello"]);
      await h.call("vm_stop", { vm });
      expect(
        (
          await api(h, "POST", `/leases/${vm}/input`, {
            type: "key",
            combo: "a",
          })
        ).status,
      ).toBe(409);
    } finally {
      h.close();
    }
  });

  it("restarts the idle countdown when a lease is extended", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      const lease = h.leases.get(vm);
      lease.lastUsed -= 500;
      const before = h.leases.summary(lease).ttlSecondsLeft;

      expect((await api(h, "POST", `/leases/${vm}/extend`)).status).toBe(200);

      expect(h.leases.summary(lease).ttlSecondsLeft).toBeGreaterThanOrEqual(
        before,
      );
      expect(h.leases.summary(lease).ttlSecondsLeft).toBeLessThanOrEqual(1);
      await h.call("vm_stop", { vm });
      expect((await api(h, "POST", `/leases/${vm}/extend`)).status).toBe(409);
    } finally {
      h.close();
    }
  });
});

/** Writes an image manifest next to the harness's default Windows base (`win-1`). */
function addImage(
  h: { config: { imagesDir: string } },
  m: Record<string, unknown>,
) {
  fs.writeFileSync(
    path.join(h.config.imagesDir, `${m.imageId}.json`),
    JSON.stringify({
      os: "windows",
      vhdxPath: `${m.imageId}.vhdx`,
      user: "zide",
      sshHostKeyFingerprint: "SHA256:abc",
      createdAt: "2026-01-02",
      ...m,
    }),
  );
}

function setBaselines(h: { config: { imagesDir: string } }, map: object) {
  fs.writeFileSync(
    path.join(h.config.imagesDir, "current.json"),
    JSON.stringify(map),
  );
}

async function bootImage(
  h: Awaited<ReturnType<typeof startHarness>>,
  args: Record<string, unknown>,
) {
  const started = await h.call("vm_start", { app: "none", ...args });
  const vm = JSON.parse(started.content[0].text as string).vm as string;
  await h.call("vm_wait_ready", { vm, timeout_s: 5 });
  return vm;
}

describe("prepared workspaces survive boot", () => {
  it("keeps the workspace of a prepared image and wipes a clean base's", async () => {
    const h = await startHarness();
    try {
      addImage(h, {
        imageId: "win-ws",
        kind: "prepared",
        parentImageId: "win-1",
      });
      for (const image of ["win-ws", "win-1"]) {
        const vm = await bootImage(h, { image, app: "vscode" });
        await h.call("vm_stop", { vm });
      }
      expect(
        (h.ops.resetWorkspace.mock.calls as unknown[][]).map((c) => c[0]),
      ).toEqual([{ keep: true }, { keep: false }]);
    } finally {
      h.close();
    }
  });
});

describe("restartVsCode", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for a slow launcher instead of killing VS Code and relaunching", async () => {
    vi.useFakeTimers();
    let running = false;
    const ops = {
      killApp: vi.fn(async () => {
        running = false;
      }),
      appRunning: vi.fn(async () => running),
      launchVsCode: vi.fn(async () => {
        setTimeout(() => {
          running = true;
        }, 12_000);
      }),
    };
    const done = restartVsCode(ops, { cdpPort: 9333 });
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(ops.launchVsCode).toHaveBeenCalledTimes(1);
  });
});

describe("vm_stop while a VM is still booting", () => {
  it("destroys a VM created after the stop and keeps the lease stopped without an error", async () => {
    const h = await startHarness();
    try {
      let release: (v: {
        name: string;
        vmId: string;
        dir: string;
      }) => void = () => undefined;
      h.provider.create.mockImplementationOnce(
        () =>
          new Promise((r) => {
            release = r;
          }),
      );
      const lease = h.leases.start({ image: "windows", app: "none" });
      await vi.waitFor(() => expect(lease.stage).toBe("creating VM"));
      await h.leases.stop(lease.id);
      release({ name: "vmh-late", vmId: "id", dir: "d" });
      await lease.ready;
      expect(lease.status).toBe("stopped");
      expect(lease.error).toBeNull();
      expect(h.provider.destroyed).toContain("vmh-late");
    } finally {
      h.close();
    }
  });
});

describe("readable guest errors", () => {
  it("turns PowerShell CLIXML into its error text and drops progress records", () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"><TN><T>x</T></TN></Obj>' +
      '<S S="Error">Start-ScheduledTask : no such task_x000D__x000A_</S></Objs>';
    expect(decodeClixml(clixml)).toBe("Start-ScheduledTask : no such task");
    expect(decodeClixml("plain stderr")).toBe("plain stderr");
  });
});

describe("the four baselines", () => {
  it("resolves each baseline by role and says which exist when asked for another", async () => {
    const h = await startHarness();
    try {
      addImage(h, {
        imageId: "win-ws",
        kind: "prepared",
        parentImageId: "win-1",
      });
      addImage(h, { imageId: "ubu-1", os: "ubuntu", kind: "golden" });
      setBaselines(h, {
        windows: "win-1",
        "windows-prepared": "win-ws",
        ubuntu: "ubu-1",
      });
      const images = h.leases.images();
      expect(resolveImage(images, "windows-workspace").imageId).toBe("win-ws");
      expect(resolveImage(images, "windows-prepared").imageId).toBe("win-ws");
      expect(resolveImage(images, "ubuntu").imageId).toBe("ubu-1");
      expect(() => resolveImage(images, "ubuntu-workspace")).toThrow(
        /Baselines: windows, windows-workspace, ubuntu, ubuntu-workspace/,
      );
    } finally {
      h.close();
    }
  });

  it("allows snapshots of a baseline and refuses a stray image", async () => {
    const h = await startHarness();
    try {
      addImage(h, {
        imageId: "win-ws",
        kind: "prepared",
        parentImageId: "win-1",
      });
      addImage(h, {
        imageId: "win-old",
        kind: "prepared",
        createdAt: "2025-01-01",
      });
      setBaselines(h, { windows: "win-1", "windows-prepared": "win-ws" });

      const ok = await bootImage(h, { image: "win-ws" });
      expect((await h.call("vm_snapshot", { vm: ok, name: "a" })).isError).toBe(
        undefined,
      );
      const stray = await bootImage(h, { image: "win-old" });
      const refused = await h.call("vm_snapshot", { vm: stray, name: "b" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("baselines");
    } finally {
      h.close();
    }
  });

  it("allows a snapshot of a snapshot of a baseline", async () => {
    const h = await startHarness();
    try {
      setBaselines(h, { windows: "win-1" });
      const first = await bootImage(h, { image: "win-1" });
      await h.call("vm_snapshot", { vm: first, name: "one" });
      const snapId = h.leases
        .images()
        .find((i: { kind: string }) => i.kind === "prepared")?.imageId;
      const second = await bootImage(h, { image: snapId });
      const r = await h.call("vm_snapshot", { vm: second, name: "two" });
      expect(r.isError).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("will not delete the image a baseline role points at", async () => {
    const h = await startHarness();
    try {
      setBaselines(h, { windows: "win-1" });
      expect(() =>
        deleteImage(h.config as never, h.leases.images(), "win-1"),
      ).toThrow(/current windows baseline/);
    } finally {
      h.close();
    }
  });

  it("keeps a workspace baseline's workspace in its new revision and repoints the role", async () => {
    const h = await startHarness();
    try {
      addImage(h, {
        imageId: "win-ws",
        kind: "prepared",
        parentImageId: "win-1",
        preparedStage: "build",
      });
      setBaselines(h, { windows: "win-1", "windows-prepared": "win-ws" });
      h.leases.unlock("win-ws");
      const vm = await bootImage(h, { image: "win-ws", purpose: "base-edit" });
      const r = await h.call("vm_save_base", { vm, name: "rev2", notes: "n" });
      expect(r.isError).toBeUndefined();
      const rev = h.leases
        .images()
        .find((i: { imageId: string }) =>
          i.imageId.startsWith("windows-base-rev2"),
        );
      expect(rev).toMatchObject({
        kind: "prepared",
        preparedStage: "build",
        role: "windows-workspace",
      });
      const current = JSON.parse(
        fs.readFileSync(path.join(h.config.imagesDir, "current.json"), "utf8"),
      );
      expect(current["windows-prepared"]).toBe(rev?.imageId);
    } finally {
      h.close();
    }
  });
});

describe("boot timing", () => {
  it("reports how long the lease has been booting and per-stage timings", async () => {
    const h = await startHarness();
    try {
      const vm = await h.boot();
      const s = h.leases.summary(h.leases.get(vm));
      expect(s.bootSeconds).toBeGreaterThanOrEqual(0);
      expect(s.stageSeconds).toBeGreaterThanOrEqual(0);
      expect(Object.keys(s.timings)).toContain("waiting for IP");
    } finally {
      h.close();
    }
  });
});
