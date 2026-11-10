import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BASELINE_ROLES,
  keepsWorkspace,
  listImages,
  registerSnapshot,
  resolveImage,
  snapshotTarget,
  writeBaseline,
} from "./images.mjs";
import { SshGuestSession } from "./guest/ssh.mjs";
import { opsFor } from "./guest/ops.mjs";
import { VsCodeDriver } from "./app-drivers/vscode.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the lease is for (repo, item, conversation): short strings only, shown next to the run. */
function cleanContext(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const key of ["repository", "item", "kind", "conversationId", "title"]) {
    const v = raw[key];
    if (typeof v === "string" || typeof v === "number")
      out[key] = String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Baselines are what snapshots start from: the clean bases and the prepared workspace images, all locked. */
export function isBaseline(image) {
  return image.kind === "golden" || Boolean(image.role);
}

/** @typedef {"booting"|"ready"|"failed"|"stopped"} LeaseStatus */

/**
 * Owns every VM lease: boot, readiness, idle reaping and cleanup. State is in memory on purpose: after a crash or a
 * `taskkill /t /f` the next start destroys every VM the provider reports (see sweepOrphans), so nothing leaks.
 */
export class LeaseManager {
  /**
   * @param {{ config: ReturnType<import("./config.mjs").loadConfig>, provider: any, log?: (m: string) => void,
   *   guest?: { createSession: (o: any) => any, opsFor: (os: string, session: any, user: string) => any,
   *     createDriver?: (o: { ssh: any, ops: any }) => any } }} o
   *   `guest` is a seam for tests; by default guests are reached over SSH.
   */
  constructor({ config, provider, log, guest }) {
    this.guest = {
      createSession: (o) => new SshGuestSession(o),
      opsFor,
      createDriver: (o) => new VsCodeDriver(o),
      ...guest,
    };
    this.config = config;
    this.provider = provider;
    this.log = log ?? (() => undefined);
    /** @type {Map<string, any>} */
    this.leases = new Map();
    /** Base images the user has opened for changes in the VM manager: image id -> expiry (ms). */
    this.unlocked = new Map();
  }

  /** Destroys VMs left by a previous harness process (a lease only lives in memory). */
  async sweepOrphans() {
    const orphans = await this.provider.listOrphans();
    for (const vm of orphans) {
      if ([...this.leases.values()].some((l) => l.handle?.name === vm.name))
        continue;
      this.log(`sweeping orphan VM ${vm.name}`);
      await this.provider.stop(vm).catch(() => undefined);
      await this.provider
        .destroy(vm)
        .catch((e) =>
          this.log(`orphan cleanup failed for ${vm.name}: ${e.message}`),
        );
    }
    return orphans.length;
  }

  /** Opens a base image for changes for a limited time. Only the VM manager window calls this. */
  unlock(imageId, minutes = 60) {
    const img = this.images().find((i) => i.imageId === imageId);
    if (!img) throw new Error(`Unknown image '${imageId}'`);
    if (!isBaseline(img))
      throw new Error(
        "Only baseline images are locked; snapshots can be changed freely.",
      );
    const until = Date.now() + Math.min(Math.max(minutes, 1), 240) * 60_000;
    this.unlocked.set(imageId, until);
    return until;
  }

  lock(imageId) {
    this.unlocked.delete(imageId);
  }

  /** Expiry (ms) while the base is open for changes, else null. */
  unlockedUntil(imageId) {
    const until = this.unlocked.get(imageId);
    if (!until || until < Date.now()) {
      this.unlocked.delete(imageId);
      return null;
    }
    return until;
  }

  images() {
    return listImages(this.config.imagesDir);
  }

  /** Memory a lease of this image gets: the image's own size, else the OS default, else the global default. */
  memoryFor(image) {
    return (
      image.memoryMB ??
      (image.os === "ubuntu" ? this.config.memoryMBUbuntu : undefined) ??
      this.config.memoryMB
    );
  }

  /**
   * Fails at once, with the numbers, when the host cannot fit another VM right now, instead of leaving a lease that
   * sits in "checking host". `waitForRam` skips the check: the lease then queues for memory (see #boot).
   * @param {{ image: string, waitForRam?: boolean }} req
   */
  async preflight(req) {
    if (req.waitForRam) return;
    const known = this.images();
    if (!known.length) return; // start() explains this better
    let image;
    try {
      image = resolveImage(known, req.image);
    } catch {
      return; // start() reports the unknown image
    }
    const host = await this.provider.hostCheck();
    if (!host.ok)
      throw new Error(`Host not ready: ${host.problems.join("; ")}`);
    const need = this.memoryFor(image) + 512;
    if (host.freeRamMB < need)
      throw new Error(
        `Not enough free RAM: ${host.freeRamMB} MB free, ${need} MB needed. Do not start more VMs in a loop. Retry vm_start with waitForRam=true to queue for memory, or ask the user to close other VMs or heavy programs.`,
      );
  }

  /** preflight + start, for callers that can wait (the MCP tool and the HTTP route). */
  async startChecked(req) {
    await this.preflight(req);
    return this.start(req);
  }

  active() {
    return [...this.leases.values()].filter(
      (l) => l.status === "booting" || l.status === "ready",
    );
  }

  /**
   * Begins booting a VM and returns immediately (status "booting"). Callers poll `waitReady`.
   * @param {{ image: string, app?: "vscode"|"none", execPolicy?: "inspect-only"|"full" }} req
   */
  start(req) {
    if (this.active().length >= this.config.maxVms) {
      throw new Error(
        `Limit reached: ${this.config.maxVms} VM(s) already running. Stop one with vm_stop first.`,
      );
    }
    const known = this.images();
    if (!known.length) {
      throw new Error(
        `No VM images found in ${this.config.imagesDir}. Ask the user to choose the harness data folder on the Test VMs page (Settings), then retry.`,
      );
    }
    const image = resolveImage(known, req.image);
    const baseEdit = req.purpose === "base-edit";
    if (baseEdit) {
      if (!isBaseline(image))
        throw new Error("base-edit needs a baseline image, not a snapshot.");
      if (!this.unlockedUntil(image.imageId))
        throw new Error(
          `Base image ${image.imageId} is locked. Ask the user to open it for changes in the Test VMs window first.`,
        );
    }
    const keyPath = path.join(this.config.secretsDir, "guest_ed25519");
    if (!fs.existsSync(keyPath))
      throw new Error(`Guest SSH key not found at ${keyPath}`);
    if (!image.sshHostKeyFingerprint)
      throw new Error(`Image ${image.imageId} has no sshHostKeyFingerprint`);

    this.#pruneFinished();
    const id = `l${crypto.randomBytes(3).toString("hex")}`;
    const runDir = path.join(this.config.runsDir, id);
    fs.mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
    const lease = {
      id,
      image,
      os: image.os,
      app: req.app ?? (baseEdit ? "none" : "vscode"),
      baseEdit,
      execPolicy: baseEdit ? "full" : (req.execPolicy ?? "inspect-only"),
      waitForRam: Boolean(req.waitForRam),
      context: cleanContext(req.context),
      status: /** @type {LeaseStatus} */ ("booting"),
      stage: "queued",
      error: null,
      handle: null,
      ip: null,
      ssh: null,
      ops: null,
      driver: null,
      desktop: null,
      runDir,
      shots: 0,
      timings: {},
      stageStartedMs: Date.now(),
      ready: Promise.resolve(),
      startedAt: new Date().toISOString(),
      lastUsed: Date.now(),
    };
    lease.ready = this.#boot(lease, keyPath);
    lease.ready.catch(() => undefined);
    this.leases.set(id, lease);
    fs.writeFileSync(
      path.join(runDir, "lease.json"),
      JSON.stringify(
        {
          id,
          imageId: image.imageId,
          os: image.os,
          app: lease.app,
          startedAt: lease.startedAt,
          context: lease.context,
        },
        null,
        2,
      ),
    );
    return lease;
  }

  /** Records how long the previous stage took (like ai-qa's lap()) and appends a line to boot.log. */
  #setStage(lease, stage) {
    const now = Date.now();
    lease.timings[lease.stage] =
      (lease.timings[lease.stage] ?? 0) +
      Math.round((now - lease.stageStartedMs) / 1000);
    lease.stage = stage;
    lease.stageStartedMs = now;
    this.log(`lease ${lease.id}: ${stage}`);
    try {
      fs.appendFileSync(
        path.join(lease.runDir, "boot.log"),
        `${new Date(now).toISOString()} ${stage}\n`,
      );
    } catch {
      // The run folder is evidence only; never fail a boot over it.
    }
  }

  /**
   * False once the lease was stopped while booting. A VM created after that stop (the lease had no handle yet when it
   * was torn down) is destroyed here, so it cannot outlive the stop.
   */
  async #stillBooting(lease) {
    if (lease.status === "booting") return true;
    await lease.ssh?.close().catch(() => undefined);
    if (lease.handle) {
      await this.provider.stop(lease.handle).catch(() => undefined);
      await this.provider
        .destroy(lease.handle)
        .catch((e) =>
          this.log(`destroy failed for ${lease.id}: ${e.message}`),
        );
      lease.handle = null;
    }
    return false;
  }

  async #boot(lease, keyPath) {
    const { config, provider } = this;
    try {
      this.#setStage(lease, "checking host");
      // Headroom for the host and Hyper-V's own overhead; the VM uses static memory.
      const memoryMB = this.memoryFor(lease.image);
      const need = memoryMB + 512;
      // A queued lease (waitForRam) waits up to 15 minutes; otherwise only the race with preflight is covered.
      const maxWaitSec = lease.waitForRam ? 900 : 30;
      for (let waited = 0; ; waited += 5) {
        const host = await provider.hostCheck();
        if (!host.ok)
          throw new Error(`Host not ready: ${host.problems.join("; ")}`);
        if (host.freeRamMB >= need) break;
        if (waited >= maxWaitSec)
          throw new Error(
            `Not enough free RAM: ${host.freeRamMB} MB free, ${need} MB needed. Close other VMs or heavy programs, or lower VM_HARNESS_MEMORY_MB.`,
          );
        lease.stage = `waiting for free RAM (${host.freeRamMB}/${need} MB)`;
        await sleep(5000);
        // vm_stop while queued: do not create a VM for a lease nobody wants any more.
        if (lease.status !== "booting") return;
      }
      this.#setStage(lease, "creating VM");
      lease.handle = await provider.create({
        leaseId: lease.id,
        os: lease.os,
        image: lease.image,
        memoryMB,
        cpus: config.cpus,
      });
      if (!(await this.#stillBooting(lease))) return;
      this.#setStage(lease, "starting VM");
      await provider.start(lease.handle);
      if (!(await this.#stillBooting(lease))) return;
      this.#setStage(lease, "waiting for IP");
      lease.ip = await provider.waitForIp(lease.handle, 240);
      if (!(await this.#stillBooting(lease))) return;
      this.#setStage(lease, "waiting for SSH");
      lease.ssh = this.guest.createSession({
        os: lease.os,
        host: lease.ip,
        user: lease.image.user,
        keyPath,
        expectedFingerprint: lease.image.sshHostKeyFingerprint,
        workDir: path.join(lease.runDir, "ssh"),
      });
      await lease.ssh.connect({ timeoutMs: 300_000 });
      if (!(await this.#stillBooting(lease))) return;
      lease.ops = this.guest.opsFor(lease.os, lease.ssh, lease.image.user);
      this.#setStage(lease, "waiting for desktop");
      await lease.ops.waitForDesktop(180_000);
      if (!(await this.#stillBooting(lease))) return;
      lease.desktop = provider.desktop(lease.handle);
      if (lease.app === "vscode") {
        this.#setStage(lease, "launching VS Code");
        lease.driver = this.guest.createDriver({
          ssh: lease.ssh,
          ops: lease.ops,
        });
        await lease.ops.killApp();
        // A prepared image or snapshot holds a set-up workspace: only a clean base starts empty.
        await lease.ops.resetWorkspace({ keep: keepsWorkspace(lease.image) });
        if (!(await this.#stillBooting(lease))) return;
        await lease.driver.restart();
        if (!(await this.#stillBooting(lease))) return;
        // "Ready" means the window is usable, not just that a process exists.
        this.#setStage(lease, "waiting for VS Code window");
        await lease.driver.ensure?.();
        if (!(await this.#stillBooting(lease))) return;
      }
      this.#setStage(lease, "ready");
      lease.status = "ready";
    } catch (e) {
      // vm_stop already ended this lease: the failure is just the VM going away under the boot.
      if (lease.status !== "booting") {
        await this.#stillBooting(lease);
        return;
      }
      lease.status = "failed";
      lease.error = String(e?.message ?? e);
      this.log(`lease ${lease.id} failed at '${lease.stage}': ${lease.error}`);
      await this.#captureBootFailure(lease);
      await this.#teardown(lease);
      throw e;
    }
  }

  /** What the VM was showing (screenshot) and what the guest said about its session: the best clues to a stalled boot. */
  async #captureBootFailure(lease) {
    if (!lease.handle) return;
    try {
      const shot = await this.provider.desktop(lease.handle).screenshot();
      fs.writeFileSync(path.join(lease.runDir, "boot-failure.png"), shot.png);
    } catch {
      // Best effort: the VM may not have a framebuffer yet.
    }
    if (!lease.ssh) return;
    const workspace = lease.ops?.paths.workspace ?? "C:\\zws";
    const cmd =
      lease.os === "windows"
        ? `Get-ScheduledTaskInfo -TaskName ZideLaunchVSCode | Format-List LastRunTime,LastTaskResult; (Get-ScheduledTask -TaskName ZideLaunchVSCode).State; query user; Get-Process Code,powershell,explorer -ErrorAction SilentlyContinue | Select-Object Name,Id,SessionId | Format-Table -AutoSize; Get-ChildItem '${workspace}' -Force | Select-Object -First 30 Name | Format-Table -HideTableHeaders`
        : "systemctl --user list-units 'zide-vscode-*' --no-pager; loginctl list-sessions --no-pager; pgrep -a code | head -20; ls -la ~/zws | head -30";
    try {
      const r = await lease.ssh.exec(cmd, { timeoutMs: 20_000 });
      fs.writeFileSync(
        path.join(lease.runDir, "boot-failure.txt"),
        `stage: ${lease.stage}\nerror: ${lease.error}\n\n${r.stdout}\n${r.stderr}`,
      );
    } catch {
      // SSH may be the thing that failed.
    }
  }

  /** @param {string} id */
  get(id) {
    const lease = this.leases.get(id);
    if (!lease)
      throw new Error(`Unknown VM lease '${id}'. Use vm_start to get one.`);
    lease.lastUsed = Date.now();
    return lease;
  }

  /** A lease whose boot finished, or throws with the boot failure / stopped state. */
  ready(id) {
    const lease = this.get(id);
    if (lease.status === "failed")
      throw new Error(
        `VM ${id} failed to start at '${lease.stage}': ${lease.error}`,
      );
    if (lease.status === "stopped") throw new Error(`VM ${id} was stopped.`);
    if (lease.status === "booting")
      throw new Error(
        `VM ${id} is still booting (${lease.stage}). Call vm_wait_ready first.`,
      );
    return lease;
  }

  async waitReady(id, timeoutSec) {
    const lease = this.get(id);
    await Promise.race([
      lease.ready.catch(() => undefined),
      sleep(timeoutSec * 1000),
    ]);
    return lease;
  }

  async stop(id) {
    const lease = this.get(id);
    if (lease.status === "stopped") return lease;
    await this.#teardown(lease);
    return lease;
  }

  /** Image ids that running leases booted from (they cannot be deleted meanwhile). */
  imagesInUse() {
    return this.active().map((l) => l.image.imageId);
  }

  /**
   * Points the harness at another data folder. Refused while VMs run, because their disks live under the old root.
   * @param {ReturnType<typeof import("./config.mjs").rootPaths>} paths
   */
  setRoot(paths) {
    if (this.active().length)
      throw new Error("Stop the running VMs before changing the data folder.");
    Object.assign(this.config, paths);
    if (this.provider) this.provider.root = paths.root;
  }

  /**
   * Saves a running VM as a reusable image ("snapshot"): the guest is shut down cleanly (best effort), its disk becomes a
   * read-only child of the image it booted from, and later leases can boot from it with everything already installed.
   * The lease ends here.
   * @param {string} id
   * @param {{ name: string, notes?: string }} opts
   */
  async snapshot(id, { name, notes }) {
    if (this.get(id).baseEdit)
      throw new Error("This VM is changing a base image: use vm_save_base.");
    const image = this.get(id).image;
    if (!isBaseline(image) && !image.baselineRoot)
      throw new Error(
        `Snapshots must start from one of the baselines (${BASELINE_ROLES.join(", ")}) or from a snapshot of one. This VM booted ${image.imageId}, which is neither.`,
      );
    return this.#saveDisk(id, { name, notes, kind: "prepared" });
  }

  /**
   * Saves a base-edit VM as a NEW sealed base revision. The old base is never modified: the new image is a child of it,
   * becomes the newest base for its OS, and is locked again. Roll back by deleting the new revision.
   */
  async saveBase(id, { name, notes }) {
    const lease = this.get(id);
    if (!lease.baseEdit)
      throw new Error(
        "vm_save_base only works on a VM started with purpose='base-edit'.",
      );
    // A revision of a workspace baseline stays a prepared image, so its workspace is kept on boot.
    const manifest = await this.#saveDisk(id, {
      name,
      notes,
      kind: lease.image.kind === "golden" ? "golden" : "prepared",
      asBase: true,
      preparedStage: lease.image.preparedStage,
    });
    this.lock(lease.image.imageId);
    if (lease.image.role)
      writeBaseline(this.config.imagesDir, lease.image.role, manifest.imageId);
    return manifest;
  }

  async #saveDisk(id, { name, notes, kind, asBase, preparedStage }) {
    const lease = this.ready(id);
    const parent = lease.image;
    const target = snapshotTarget(this.config, parent, name, kind, asBase);
    if (typeof this.provider.snapshot !== "function")
      throw new Error("This VM provider cannot save snapshots.");
    lease.status = "stopped";
    lease.stage = "saving snapshot";
    lease.desktop = null;
    await lease.driver?.close().catch(() => undefined);
    // A clean guest shutdown keeps the disk consistent; a failure here just falls back to powering the VM off.
    await lease.ssh
      ?.exec(
        lease.os === "windows" ? "shutdown /s /t 0" : "sudo -n shutdown -h now",
        { timeoutMs: 15_000 },
      )
      .catch(() => undefined);
    for (let i = 0; i < 30; i++) {
      const state = await this.provider
        .state(lease.handle.name)
        .catch(() => "");
      if (state === "Off" || state === "Missing") break;
      await sleep(3000);
    }
    await lease.ssh?.close().catch(() => undefined);
    let saved;
    try {
      saved = await this.provider.snapshot(lease.handle, target.vhdxPath);
    } catch (e) {
      lease.status = "failed";
      lease.error = `snapshot failed: ${e?.message ?? e}`;
      await this.#teardown(lease);
      throw e;
    }
    const manifest = registerSnapshot(this.config, parent, {
      ...target,
      name,
      notes,
      kind,
      preparedStage,
      sizeBytes: saved?.sizeBytes,
    });
    lease.handle = null;
    lease.stage = "stopped";
    await this.#teardown(lease);
    return manifest;
  }

  /** Forgets leases that ended more than an hour ago (their run folder stays on disk). */
  #pruneFinished(now = Date.now()) {
    for (const [id, lease] of this.leases) {
      if (
        (lease.status === "failed" || lease.status === "stopped") &&
        lease.endedMs &&
        now - lease.endedMs > 3_600_000
      )
        this.leases.delete(id);
    }
  }

  async #teardown(lease) {
    if (lease.status !== "failed") lease.status = "stopped";
    lease.endedMs = Date.now();
    lease.endedAt = new Date(lease.endedMs).toISOString();
    lease.desktop = null;
    await lease.driver?.close().catch(() => undefined);
    await lease.ssh?.close().catch(() => undefined);
    if (lease.handle) {
      await this.provider.stop(lease.handle).catch(() => undefined);
      await this.provider
        .destroy(lease.handle)
        .catch((e) => this.log(`destroy failed for ${lease.id}: ${e.message}`));
      lease.handle = null;
    }
    fs.writeFileSync(
      path.join(lease.runDir, "lease.json"),
      JSON.stringify(
        {
          id: lease.id,
          imageId: lease.image.imageId,
          os: lease.os,
          app: lease.app,
          startedAt: lease.startedAt,
          endedAt: lease.endedAt,
          status: lease.status,
          // Why a boot failed survives a harness restart, so the Test VMs page can show it.
          stage: lease.stage,
          error: lease.error,
          timings: lease.timings,
          context: lease.context,
        },
        null,
        2,
      ),
    );
  }

  /** Stops leases idle longer than the TTL. */
  /** Restarts the idle countdown of a running lease (the Test VMs page's Extend button). */
  extend(id) {
    const lease = this.get(id);
    if (lease.status !== "booting" && lease.status !== "ready")
      throw new Error(`VM ${id} is not running.`);
    lease.lastUsed = Date.now();
    return lease;
  }

  async reapIdle(now = Date.now()) {
    for (const lease of this.active()) {
      if (now - lease.lastUsed > this.config.leaseTtlMs) {
        this.log(`reaping idle lease ${lease.id}`);
        await this.#teardown(lease);
      }
    }
  }

  async stopAll() {
    for (const lease of this.active()) await this.#teardown(lease);
  }

  /** @param {any} lease */
  summary(lease) {
    return {
      id: lease.id,
      imageId: lease.image.imageId,
      os: lease.os,
      app: lease.app,
      appTools: lease.app === "vscode",
      baseEdit: Boolean(lease.baseEdit),
      status: lease.status,
      stage: lease.stage,
      error: lease.error,
      ip: lease.ip,
      startedAt: lease.startedAt,
      memoryMB: this.memoryFor(lease.image),
      role: lease.image.role ?? null,
      // Time in the current stage and since the lease began: an agent decides whether to keep waiting on these.
      stageSeconds: Math.round((Date.now() - lease.stageStartedMs) / 1000),
      bootSeconds: Math.round(
        ((lease.endedMs ?? Date.now()) - Date.parse(lease.startedAt)) / 1000,
      ),
      timings: lease.timings,
      context: lease.context ?? null,
      idleSeconds: Math.round((Date.now() - lease.lastUsed) / 1000),
      // Seconds until the idle reaper stops it; any tool call or an extend resets this.
      ttlSecondsLeft: Math.max(
        0,
        Math.round((this.config.leaseTtlMs - (Date.now() - lease.lastUsed)) / 1000),
      ),
    };
  }
}
