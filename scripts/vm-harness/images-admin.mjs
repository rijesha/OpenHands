import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OSES = ["windows", "ubuntu", "macos"];

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export function assertOs(os) {
  if (!OSES.includes(os))
    throw new Error(`--os must be one of ${OSES.join(", ")}`);
}

/** The flags every `images seal` needs, whatever the provider. */
export function assertSealFields(i, required) {
  for (const k of required) {
    if (!i[k])
      throw new Error(
        `missing --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
  }
}

/**
 * A new golden image id: `<os>-<build>-vscode<ver>-<date>`, with `-rN` when that id is taken (sealed images are
 * immutable, so a rebuild on the same day never overwrites one).
 */
export function goldenImageId(config, i) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const baseId = `${i.os}-${i.osBuild.replace(/[^\w.]/g, "")}-vscode${i.vscodeVersion}-${date}`;
  const taken = (id) =>
    fs.existsSync(path.join(config.imagesDir, `${id}.json`)) ||
    fs.existsSync(path.join(config.imagesDir, `${id}.vhdx`));
  let imageId = baseId;
  for (let rev = 2; taken(imageId); rev++) imageId = `${baseId}-r${rev}`;
  return imageId;
}

/**
 * Writes a golden image manifest (the ai-qa format plus provider fields such as `vhdxPath` or `utmVm`).
 * @param {{ imagesDir: string }} config
 * @param {Record<string, any>} i seal options
 * @param {{ imageId: string } & Record<string, any>} disk provider-specific location fields
 * @returns {{ imageId: string } & Record<string, any>}
 */
export function writeGoldenManifest(config, i, disk) {
  const manifest = {
    os: i.os,
    kind: "golden",
    ...disk,
    createdAt: new Date().toISOString(),
    osBuild: i.osBuild,
    edition: i.edition,
    vscodeVersion: i.vscodeVersion,
    vscodeCommit: i.vscodeCommit,
    user: i.user,
    resolution: { width: 1280, height: 800 },
    sshHostKeyFingerprint: i.sshHostKeyFingerprint,
    provisionScriptSha: i.provisionScriptSha ?? "",
    notes: i.notes,
  };
  fs.mkdirSync(config.imagesDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.imagesDir, `${disk.imageId}.json`),
    JSON.stringify({ imageId: disk.imageId, ...manifest }, null, 2),
  );
  return { imageId: disk.imageId, ...manifest };
}

/**
 * Hyper-V: creates the empty Gen2 VM (under `<root>/images/build`) that you then install the OS into by hand
 * and provision with the scripts in `scripts/vm-harness/images/<os>/`.
 */
export async function createGoldenVm(
  bridge,
  config,
  { os, iso, name, memoryMB },
) {
  assertOs(os);
  if (os === "macos") throw new Error("macOS guests need the UTM provider.");
  if (!iso || !fs.existsSync(iso)) throw new Error(`ISO not found: ${iso}`);
  return bridge.call(
    "New-VmhGoldenVm",
    {
      Name: name ?? `vmh-golden-${os}`,
      Os: os,
      IsoPath: path.resolve(iso),
      Root: config.root,
      MemoryMB: memoryMB ?? 8192,
      DiskGB: os === "windows" ? 80 : 40,
    },
    300_000,
  );
}

/**
 * Hyper-V: shuts the golden VM down, moves its VHDX to `images/<id>.vhdx` (read-only: run VMs are differencing
 * children), hashes it and writes the manifest the harness reads. A sealed image is never booted again.
 */
export async function sealImage(bridge, config, i) {
  assertOs(i.os);
  assertSealFields(i, [
    "vmName",
    "osBuild",
    "edition",
    "vscodeVersion",
    "vscodeCommit",
    "user",
    "sshHostKeyFingerprint",
  ]);
  const buildDir = path.join(config.imagesDir, "build");
  const vhdx = path.join(buildDir, `${i.vmName}.vhdx`);
  if (!fs.existsSync(vhdx)) throw new Error(`Golden disk not found: ${vhdx}`);
  // The VM may already be gone, so both calls are best-effort.
  await bridge
    .call("Stop-VM", { Name: i.vmName, Force: true }, 180_000)
    .catch(() => undefined);
  await bridge
    .call("Remove-VM", { Name: i.vmName, Force: true }, 60_000)
    .catch(() => undefined);

  const imageId = goldenImageId(config, i);
  const dest = path.join(config.imagesDir, `${imageId}.vhdx`);
  fs.renameSync(vhdx, dest);
  fs.chmodSync(dest, 0o444);
  return writeGoldenManifest(config, i, {
    imageId,
    vhdxPath: dest,
    sha256: await sha256File(dest),
    sizeBytes: fs.statSync(dest).size,
  });
}
