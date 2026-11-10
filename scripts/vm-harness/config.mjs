import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 18010;
export const API_PREFIX = "/api/vm-harness";

/** Reads the stack's session key the way the launcher does: env first, then the generated key file. */
function resolveApiKey(env) {
  const fromEnv = env.OH_VM_HARNESS_API_KEY || env.LOCAL_BACKEND_API_KEY;
  if (fromEnv) return fromEnv;
  const file = path.join(
    os.homedir(),
    ".openhands",
    "agent-canvas",
    "api-key.txt",
  );
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_ROOT = () => path.join(os.homedir(), ".openhands", "vm-harness");

/** Where GUI-chosen settings live. Fixed (not under the root) so the root itself can be changed from the GUI. */
export function settingsFile(env = process.env) {
  return path.resolve(
    env.VM_HARNESS_SETTINGS_FILE ||
      path.join(os.homedir(), ".openhands", "vm-harness-settings.json"),
  );
}

export function readSettings(env = process.env) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(env), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

export function writeSettings(patch, env = process.env) {
  const file = settingsFile(env);
  const next = { ...readSettings(env), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

/** Derived folders for a data root. */
export function rootPaths(root) {
  return {
    root,
    imagesDir: path.join(root, "images"),
    secretsDir: path.join(root, "secrets"),
    runsDir: path.join(root, "harness-runs"),
  };
}

/**
 * Harness configuration. The data root is chosen in the Test VMs page (saved in ~/.openhands/vm-harness-settings.json);
 * VM_HARNESS_ROOT is only the fallback when nothing has been chosen there.
 *
 * VM_HARNESS_ROOT        fallback data root (default ~/.openhands/vm-harness). Point it at an existing ai-qa root
 *                        (e.g. D:/zide-ai-qa) to reuse its images/, secrets/ and vms/ folders.
 * VM_HARNESS_PORT        listen port (default 18010; always bound to 127.0.0.1)
 * VM_HARNESS_WORKSPACE_ROOTS  path-delimited allow-list for vm_put_file
 * VM_HARNESS_MAX_VMS     concurrent leases (default 2; 1 on macOS)
 * VM_HARNESS_LEASE_TTL_MIN  idle minutes before a lease is reaped (default 90)
 * VM_HARNESS_MEMORY_MB / VM_HARNESS_CPUS  per-VM sizing (defaults 6144 / 4)
 * VM_HARNESS_MEMORY_MB_UBUNTU  memory for Ubuntu guests (default 4096; 3072 on macOS hosts)
 * VM_HARNESS_MEMORY_MB_MACOS   memory for macOS guests (default 4096)
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env, platform = process.platform) {
  const saved = readSettings(env).root;
  const rootSource = saved
    ? "settings"
    : env.VM_HARNESS_ROOT
      ? "env"
      : "default";
  const root = path.resolve(saved || env.VM_HARNESS_ROOT || DEFAULT_ROOT());
  const home = os.homedir();
  const workspaceRoots = (env.VM_HARNESS_WORKSPACE_ROOTS || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((p) => path.resolve(p));
  if (!workspaceRoots.length) {
    workspaceRoots.push(
      path.join(home, "workspace"),
      path.join(home, ".openhands", "agent-canvas", "workspaces"),
    );
  }
  return {
    ...rootPaths(root),
    rootSource,
    port: Number(env.VM_HARNESS_PORT) || DEFAULT_PORT,
    apiKey: resolveApiKey(env),
    workspaceRoots,
    // A Mac shares its (unified) memory with the host, so UTM hosts default to one VM at a time.
    maxVms: Number(env.VM_HARNESS_MAX_VMS) || (platform === "darwin" ? 1 : 2),
    leaseTtlMs: (Number(env.VM_HARNESS_LEASE_TTL_MIN) || 90) * 60_000,
    memoryMB: Number(env.VM_HARNESS_MEMORY_MB) || 6144,
    // A Linux desktop with VS Code needs less than a Windows one; an image manifest's own memoryMB wins over both.
    // On a Mac the guests share unified memory with the host (often a NAS and Docker too): smaller defaults there.
    memoryMBUbuntu:
      Number(env.VM_HARNESS_MEMORY_MB_UBUNTU) ||
      (platform === "darwin" ? 3072 : 4096),
    memoryMBMacos: Number(env.VM_HARNESS_MEMORY_MB_MACOS) || 4096,
    cpus: Number(env.VM_HARNESS_CPUS) || 4,
  };
}
