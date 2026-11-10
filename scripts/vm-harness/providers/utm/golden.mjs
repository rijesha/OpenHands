import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertOs,
  assertSealFields,
  goldenImageId,
  writeGoldenManifest,
} from "../../images-admin.mjs";
import { withoutHarnessArgs } from "./args.mjs";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMAGES_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../images",
);

/**
 * Makes sure `<root>/secrets` holds the guest SSH key pair and guest password the images are built with.
 * Existing files are never replaced: images sealed with them would stop working.
 * @returns {{ keyPath: string, publicKey: string, password: string, created: string[] }}
 */
export async function ensureGuestSecrets(config, run = execFileP) {
  const created = [];
  fs.mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(config.secretsDir, "guest_ed25519");
  if (!fs.existsSync(keyPath)) {
    await run("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "vm-harness-guest",
      "-f",
      keyPath,
    ]);
    created.push(keyPath);
  }
  const credsFile = path.join(config.secretsDir, "guest-creds.json");
  let creds = {};
  try {
    creds = JSON.parse(fs.readFileSync(credsFile, "utf8"));
  } catch {
    // none yet
  }
  if (!creds.password) {
    creds.password = crypto.randomBytes(12).toString("base64url");
    created.push(credsFile);
  }
  // macOS Screen Sharing ("VNC viewers may control screen with password") uses at most 8 characters.
  if (!creds.vncPassword) {
    creds.vncPassword = crypto.randomBytes(6).toString("base64url").slice(0, 8);
    if (!created.includes(credsFile)) created.push(credsFile);
  }
  fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return {
    keyPath,
    publicKey: fs.readFileSync(`${keyPath}.pub`, "utf8").trim(),
    password: creds.password,
    vncPassword: creds.vncPassword,
    created,
  };
}

/**
 * SHA-512 crypt hash for the autoinstall identity (needs OpenSSL 3, e.g. Homebrew's). The password goes in on stdin,
 * never on a command line other processes can read.
 */
export function passwordHash(password) {
  for (const bin of [
    "/opt/homebrew/bin/openssl",
    "/usr/local/bin/openssl",
    "openssl",
  ]) {
    try {
      const hash = execFileSync(bin, ["passwd", "-6", "-stdin"], {
        input: `${password}\n`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (hash.startsWith("$6$")) return hash;
    } catch {
      // try the next one
    }
  }
  throw new Error(
    "Need an OpenSSL that supports `passwd -6` (brew install openssl) to hash the guest password.",
  );
}

/**
 * Fills in the Ubuntu autoinstall template.
 * @param {string} template
 * @param {{ user: string, hostname: string, passwordHash: string, publicKey: string }} v
 */
export function renderAutoinstall(template, v) {
  return template
    .replaceAll("__USER__", v.user)
    .replaceAll("__HOSTNAME__", v.hostname)
    .replaceAll("__PASSWORD_HASH__", v.passwordHash)
    .replaceAll("__PUBKEY__", v.publicKey);
}

/** Writes a NoCloud seed (`user-data`, `meta-data`) as an ISO labelled CIDATA. */
async function buildSeedIso(dir, userData, hostname, run = execFileP) {
  const src = path.join(dir, "seed");
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "user-data"), userData, { mode: 0o600 });
  fs.writeFileSync(
    path.join(src, "meta-data"),
    `instance-id: ${hostname}\nlocal-hostname: ${hostname}\n`,
  );
  const iso = path.join(dir, "seed.iso");
  fs.rmSync(iso, { force: true });
  await run("hdiutil", [
    "makehybrid",
    "-o",
    iso,
    src,
    "-iso",
    "-joliet",
    "-default-volume-name",
    "CIDATA",
  ]);
  return iso;
}

/**
 * `images create-vm` on UTM. Ubuntu: an aarch64 QEMU VM booting the desktop installer with a cloud-init autoinstall seed,
 * so the install runs unattended; afterwards run provision.sh over SSH (see README). macOS: UTM cannot install macOS
 * from a script, so this explains the manual step instead.
 * @param {import("./utm.mjs").UtmControl} utm
 */
export async function createGolden(
  utm,
  config,
  { os, iso, name, memoryMB, cpus, diskGB, user = "zide", startInstall = true },
) {
  assertOs(os);
  if (os === "macos")
    throw new Error(
      "UTM cannot install macOS from a script. In UTM: + > Virtualize > macOS 12+ (pick an IPSW or the latest), name it 'vmh-build-macos', 8 GB RAM / 4 cores / 64 GB disk. Finish Setup Assistant with user 'zide', then follow the macOS steps in scripts/vm-harness/README.md.",
    );
  if (os === "windows")
    throw new Error(
      "Windows golden images on UTM are not scripted yet. Build one by hand in UTM (name it 'vmh-build-windows') and provision it with images/windows/provision.ps1.",
    );
  if (!iso || !fs.existsSync(iso)) throw new Error(`ISO not found: ${iso}`);
  const vmName = name ?? `vmh-build-${os}`;
  if (await utm.find(vmName))
    throw new Error(
      `UTM already has a VM named '${vmName}'. Delete it in UTM or pass --name.`,
    );
  const secrets = await ensureGuestSecrets(config);
  const hostname = `vmh-${os}`;
  const userData = renderAutoinstall(
    fs.readFileSync(
      path.join(IMAGES_SRC, "ubuntu", "autoinstall.yaml"),
      "utf8",
    ),
    {
      user,
      hostname,
      passwordHash: passwordHash(secrets.password),
      publicKey: secrets.publicKey,
    },
  );
  const buildDir = path.join(config.imagesDir, "build", vmName);
  fs.mkdirSync(buildDir, { recursive: true });
  const seed = await buildSeedIso(buildDir, userData, hostname);
  // Sandboxed UTM hangs when a script hands it a file in a protected folder (~/Downloads, ~/Desktop, ~/Documents).
  // Give it a copy next to the seed instead: an APFS clone, so it is instant and takes no space.
  const installer = path.join(buildDir, "installer.iso");
  fs.rmSync(installer, { force: true });
  try {
    fs.copyFileSync(
      path.resolve(iso),
      installer,
      fs.constants.COPYFILE_FICLONE,
    );
  } catch {
    fs.copyFileSync(path.resolve(iso), installer);
  }
  await utm.createQemuVm({
    name: vmName,
    iso: installer,
    extraIsos: [seed],
    memoryMB: memoryMB ?? 4096,
    cpus: cpus ?? 4,
    diskGB: diskGB ?? 40,
  });
  if (startInstall) await startUnattendedInstall(utm, vmName);
  return {
    name: vmName,
    seed,
    secretsCreated: secrets.created,
    started: startInstall,
  };
}

/**
 * Boots the build VM and adds `autoinstall` to the installer's kernel command line from the GRUB menu (typed through
 * QMP), so the installer uses the seed without asking for confirmation. The VM gets temporary VNC/QMP ports for this;
 * `images seal` removes them again.
 * @param {import("./utm.mjs").UtmControl} utm
 */
export async function startUnattendedInstall(
  utm,
  vmName,
  { grubDelayMs = 15_000 } = {},
) {
  const { QemuDesktop } = await import("./desktop.mjs");
  const vncPort = 5920;
  const qmpPort = 44200;
  const { qemuArgs } = await utm.readConfig(vmName);
  await utm.configure(vmName, {
    qemuArgs: [
      ...withoutHarnessArgs(qemuArgs),
      "-vnc",
      `127.0.0.1:${vncPort - 5900}`,
      "-qmp",
      `tcp:127.0.0.1:${qmpPort},server=on,wait=off`,
    ],
  });
  await utm.start(vmName);
  // GRUB shows "Try or Install Ubuntu" about 8 s after power-on and waits 30 s: edit it inside that window.
  await sleep(grubDelayMs);
  const d = new QemuDesktop({ vncPort, qmpPort });
  try {
    for (const k of ["e", "down", "down", "down", "ctrl+e"]) {
      await d.key(k);
      await sleep(300);
    }
    await d.type(" autoinstall");
    await sleep(300);
    await d.key("ctrl+x");
  } finally {
    d.close();
  }
}

/**
 * `images seal` on UTM: shuts the provisioned build VM down, removes the installer discs, renames it to
 * `vmh-golden-<imageId>` and writes the manifest. Optionally exports a copy (`--archive <dir>`, e.g. the NAS pool).
 * A sealed image is never booted again; leases boot clones of it.
 * @param {import("./utm.mjs").UtmControl} utm
 */
export async function sealGolden(utm, config, i) {
  assertOs(i.os);
  assertSealFields(i, [
    "vmName",
    "osBuild",
    "vscodeVersion",
    "vscodeCommit",
    "user",
    "sshHostKeyFingerprint",
  ]);
  const vm = await utm.find(i.vmName);
  if (!vm) throw new Error(`UTM has no VM named '${i.vmName}'`);
  if (vm.status !== "stopped") {
    await utm.stop(i.vmName).catch(() => undefined);
    for (let n = 0; n < 60; n++) {
      if ((await utm.find(i.vmName))?.status === "stopped") break;
      await sleep(1000);
    }
  }
  const backend = await utm.backend(i.vmName);
  const imageId = goldenImageId(config, i);
  const utmVm = `vmh-golden-${imageId}`;
  await utm.configure(i.vmName, {
    newName: utmVm,
    ...(backend === "qemu"
      ? {
          removeRemovableDrives: true,
          qemuArgs: withoutHarnessArgs(
            (await utm.readConfig(i.vmName)).qemuArgs,
          ),
        }
      : {}),
  });
  // The installer copy and seed are no longer attached to anything.
  fs.rmSync(path.join(config.imagesDir, "build", i.vmName), {
    recursive: true,
    force: true,
  });
  let archive;
  if (i.archiveDir) {
    fs.mkdirSync(i.archiveDir, { recursive: true });
    archive = path.join(path.resolve(i.archiveDir), `${utmVm}.utm`);
    await utm.exportTo(utmVm, archive);
  }
  return writeGoldenManifest(config, i, {
    imageId,
    utmVm,
    backend,
    ...(archive ? { archivePath: archive } : {}),
  });
}
