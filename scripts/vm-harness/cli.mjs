#!/usr/bin/env node
/**
 * VM harness entry point.
 *
 *   node scripts/vm-harness/cli.mjs serve    start the harness (the launcher runs this for you with --vm-harness)
 *   node scripts/vm-harness/cli.mjs doctor   check prerequisites and list images
 *   node scripts/vm-harness/cli.mjs images list | create-vm --os windows --iso X.iso | seal --os ... (see README)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { listImages } from "./images.mjs";
import { LeaseManager } from "./leases.mjs";
import { renderPlugin } from "./plugin.mjs";
import { createGoldenVm, sealImage } from "./images-admin.mjs";
import { createServer } from "./server.mjs";

const execFileP = promisify(execFile);
const log = (m) => console.log(`[vm-harness] ${m}`);

/** Picks the provider for this host. UTM (macOS) is not implemented yet. */
export async function createProvider(config) {
  if (process.platform === "win32") {
    const { HyperVProvider } = await import("./providers/hyperv/provider.mjs");
    return new HyperVProvider({ root: config.root });
  }
  throw new Error(
    `No VM provider for ${process.platform} yet (Hyper-V on Windows is supported; UTM on macOS is planned).`,
  );
}

async function has(cmd, args = ["-V"]) {
  try {
    await execFileP(cmd, args, { windowsHide: true, timeout: 10_000 });
    return true;
  } catch (e) {
    return e?.code !== "ENOENT";
  }
}

export async function doctor(config) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add(
    "platform",
    process.platform === "win32",
    `${process.platform} (Hyper-V provider needs win32)`,
  );
  add(
    "pwsh",
    await has("pwsh", ["-NoProfile", "-Command", "exit 0"]),
    "PowerShell 7 on PATH",
  );
  add("ssh", await has("ssh", ["-V"]), "OpenSSH client");
  add(
    "guest key",
    fs.existsSync(path.join(config.secretsDir, "guest_ed25519")),
    path.join(config.secretsDir, "guest_ed25519"),
  );
  add(
    "api key",
    Boolean(config.apiKey),
    "LOCAL_BACKEND_API_KEY / OH_VM_HARNESS_API_KEY or ~/.openhands/agent-canvas/api-key.txt",
  );
  const images = listImages(config.imagesDir);
  add("images", images.length > 0, `${images.length} in ${config.imagesDir}`);
  if (
    process.platform === "win32" &&
    checks.find((c) => c.name === "pwsh").ok
  ) {
    try {
      const provider = await createProvider(config);
      const host = await provider.hostCheck();
      add(
        "hyper-v",
        host.ok,
        host.ok
          ? `free RAM ${host.freeRamMB} MB, free disk ${host.freeDiskGB} GB`
          : host.problems.join("; "),
      );
      provider.close();
    } catch (e) {
      add("hyper-v", false, String(e.message ?? e));
    }
  }
  for (const c of checks)
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(12)} ${c.detail}`);
  return checks.every((c) => c.ok);
}

/** `images list | create-vm | seal`: building the sealed golden images the harness boots run VMs from. */
export async function imagesCommand(config, argv) {
  const [sub, ...rest] = argv;
  if (sub === "list") {
    for (const i of listImages(config.imagesDir))
      console.log(`${i.imageId}	${i.os}	${i.kind}	${i.description}`);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      os: { type: "string" },
      iso: { type: "string" },
      name: { type: "string" },
      vm: { type: "string" },
      "os-build": { type: "string" },
      edition: { type: "string" },
      "vscode-version": { type: "string" },
      "vscode-commit": { type: "string" },
      user: { type: "string", default: "zide" },
      "ssh-fingerprint": { type: "string" },
      "provision-sha": { type: "string" },
      notes: { type: "string" },
    },
  });
  const provider = await createProvider(config);
  try {
    if (sub === "create-vm") {
      const r = await createGoldenVm(provider.bridge, config, {
        os: values.os,
        iso: values.iso,
        name: values.name,
      });
      console.log(
        `Created VM ${r.name} (disk ${r.vhdx}). Install the OS by hand, then provision it with scripts/vm-harness/images/${values.os}/ (see README).`,
      );
    } else if (sub === "seal") {
      const m = await sealImage(provider.bridge, config, {
        os: values.os,
        vmName: values.vm,
        osBuild: values["os-build"],
        edition: values.edition,
        vscodeVersion: values["vscode-version"],
        vscodeCommit: values["vscode-commit"],
        user: values.user,
        sshHostKeyFingerprint: values["ssh-fingerprint"],
        provisionScriptSha: values["provision-sha"],
        notes: values.notes,
      });
      console.log(`Sealed ${m.imageId} (${m.sizeBytes} bytes)`);
    } else {
      throw new Error(
        "Usage: images list | create-vm --os <windows|ubuntu> --iso <file> | seal --os ... --vm ... (see README)",
      );
    }
  } finally {
    provider.close();
  }
}

export async function serve(config = loadConfig(), opts = {}) {
  if (!config.apiKey) {
    throw new Error(
      "No session API key: set LOCAL_BACKEND_API_KEY (or OH_VM_HARNESS_API_KEY).",
    );
  }
  const provider = opts.provider ?? (await createProvider(config));
  const leases = new LeaseManager({ config, provider, log });
  const swept = await leases.sweepOrphans();
  if (swept) log(`removed ${swept} orphaned VM(s)`);

  const pluginDir =
    opts.pluginDir ??
    process.env.VM_HARNESS_PLUGIN_DIR ??
    path.join(
      os.homedir(),
      ".openhands",
      "agent-canvas",
      "vm-harness",
      "plugin",
    );
  renderPlugin({ outDir: pluginDir, port: config.port, apiKey: config.apiKey });
  config.pluginDir = pluginDir;

  const server = createServer({ config, leases, provider, log });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  const reaper = setInterval(
    () => leases.reapIdle().catch((e) => log(`reaper: ${e.message}`)),
    60_000,
  );
  reaper.unref();
  log(
    `listening on http://127.0.0.1:${config.port} (images: ${listImages(config.imagesDir).length}, plugin: ${pluginDir})`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(reaper);
    log("shutting down: stopping VMs");
    server.close();
    await leases.stopAll().catch(() => undefined);
    provider.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  return { server, leases, shutdown };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2] ?? "serve";
  const config = loadConfig();
  const run =
    cmd === "doctor"
      ? doctor(config).then((ok) => process.exit(ok ? 0 : 1))
      : cmd === "serve"
        ? serve(config)
        : cmd === "images"
          ? imagesCommand(config, process.argv.slice(3))
          : Promise.reject(
              new Error(`Unknown command '${cmd}' (serve | doctor | images)`),
            );
  run.catch((e) => {
    console.error(`[vm-harness] ${e.message}`);
    process.exit(1);
  });
}
