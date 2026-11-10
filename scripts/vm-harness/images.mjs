import fs from "node:fs";
import path from "node:path";

/**
 * Lists sealed image manifests (`<imagesDir>/*.json`, the ai-qa format) except `current.json`.
 * Only fields the harness needs are kept.
 * @param {string} imagesDir
 */
export function listImages(imagesDir) {
  let names;
  try {
    names = fs.readdirSync(imagesDir);
  } catch {
    return [];
  }
  const roleOf = new Map(
    Object.entries(readBaselines(imagesDir)).map(([role, id]) => [id, role]),
  );
  const images = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "current.json") continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(imagesDir, name), "utf8"));
      if (!m.imageId || !m.os || !m.vhdxPath) continue;
      images.push({
        imageId: m.imageId,
        os: m.os,
        kind: m.kind ?? "golden",
        user: m.user,
        vhdxPath: m.vhdxPath,
        sshHostKeyFingerprint: m.sshHostKeyFingerprint,
        resolution: m.resolution ?? { width: 1280, height: 800 },
        memoryMB:
          Number.isInteger(m.memoryMB) && m.memoryMB >= 1024
            ? m.memoryMB
            : undefined,
        createdAt: m.createdAt,
        notes: m.notes,
        label: m.label,
        role: roleOf.get(m.imageId) ?? null,
        parentImageId: m.parentImageId,
        preparedStage: m.preparedStage,
        sizeBytes: m.sizeBytes ?? sizeOf(m.vhdxPath),
        manifestFile: path.join(imagesDir, name),
        description: describe(m),
      });
    } catch {
      // Skip unreadable manifests.
    }
  }
  const byId = new Map(images.map((i) => [i.imageId, i]));
  for (const img of images) img.baselineRoot = findBaselineRoot(img, byId);
  return images.sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
}

/** The four baseline roles, in the order the GUI shows them. */
export const BASELINE_ROLES = [
  "windows",
  "windows-workspace",
  "ubuntu",
  "ubuntu-workspace",
];

/** ai-qa wrote `<os>-prepared`; the harness calls the same role `<os>-workspace`. */
function canonicalRole(key) {
  return key.endsWith("-prepared")
    ? `${key.slice(0, -"-prepared".length)}-workspace`
    : key;
}

/**
 * Reads `current.json` (ai-qa's role -> image id map) into the four baseline roles. Missing or unreadable: no roles.
 * @param {string} imagesDir
 * @returns {Record<string, string>}
 */
export function readBaselines(imagesDir) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(imagesDir, "current.json"), "utf8"),
    );
    const out = {};
    for (const [key, id] of Object.entries(raw)) {
      const role = canonicalRole(key);
      if (BASELINE_ROLES.includes(role) && typeof id === "string")
        out[role] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** Points a baseline role at another image (a new base revision), keeping the key spelling ai-qa used. */
export function writeBaseline(imagesDir, role, imageId) {
  const file = path.join(imagesDir, "current.json");
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // none yet
  }
  const key =
    Object.keys(raw).find((k) => canonicalRole(k) === role) ?? role;
  raw[key] = imageId;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

/** The baseline image an image is, or descends from through `parentImageId`; null for a stray image. */
function findBaselineRoot(img, byId) {
  const seen = new Set();
  for (let cur = img; cur && !seen.has(cur.imageId); cur = byId.get(cur.parentImageId)) {
    if (cur.role) return cur.imageId;
    seen.add(cur.imageId);
  }
  return null;
}

/** A prepared image or snapshot keeps the workspace it was saved with; only a clean base starts empty. */
export function keepsWorkspace(image) {
  return image.kind !== "golden";
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

function describe(m) {
  const parts = [
    m.os === "windows"
      ? `Windows ${m.osBuild ?? ""}`
      : `Ubuntu ${m.osBuild ?? ""}`.trim(),
  ];
  if (m.vscodeVersion) parts.push(`VS Code ${m.vscodeVersion}`);
  if (m.kind === "prepared")
    parts.push(`prepared (${m.preparedStage ?? "custom"})`);
  return parts.join(", ");
}

/**
 * Resolves an image by id, or the newest golden image for an OS name ("windows" / "ubuntu").
 * @param {ReturnType<typeof listImages>} images
 * @param {string} ref
 */
export function resolveImage(images, ref) {
  const exact = images.find((i) => i.imageId === ref);
  if (exact) return exact;
  const role = canonicalRole(ref);
  const byRole = images.find((i) => i.role === role);
  if (byRole) return byRole;
  // Without a current.json entry, a clean OS name still means that OS's newest golden image.
  if (!images.some((i) => i.role === role)) {
    const byOs = images.find((i) => i.os === ref && i.kind === "golden");
    if (byOs) return byOs;
  }
  throw new Error(
    `No image matches '${ref}'. Baselines: ${BASELINE_ROLES.join(", ")}. Available: ${images.map((i) => i.imageId).join(", ") || "none"}`,
  );
}

/** Ids of the images made from `id` (their disks depend on it and must outlive it). */
export function childrenOf(images, id) {
  return images.filter((i) => i.parentImageId === id).map((i) => i.imageId);
}

export function isInsideDir(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function find(images, id) {
  const img = images.find((i) => i.imageId === id);
  if (!img) throw new Error(`Unknown image '${id}'`);
  return img;
}

/**
 * Edits the user-facing fields of an image (label, notes). Disk and identity fields never change.
 * @param {ReturnType<typeof listImages>} images
 */
export function updateImage(images, id, { label, notes }) {
  const img = find(images, id);
  const m = JSON.parse(fs.readFileSync(img.manifestFile, "utf8"));
  if (label !== undefined) m.label = String(label).slice(0, 80);
  if (notes !== undefined) m.notes = String(notes).slice(0, 4000);
  fs.writeFileSync(img.manifestFile, JSON.stringify(m, null, 2));
  return { ...img, label: m.label, notes: m.notes };
}

/**
 * Deletes an image: its manifest and, when it lives in the images folder, its disk. Refuses while another image is
 * built on it or a running VM booted from it, because a differencing disk is useless without its parent.
 * @param {{ imagesDir: string }} config
 * @param {ReturnType<typeof listImages>} images
 * @param {string[]} inUseIds image ids of the running leases
 */
export function deleteImage(config, images, id, inUseIds = []) {
  const img = find(images, id);
  const kids = childrenOf(images, id);
  if (kids.length)
    throw new Error(
      `Image ${id} is the base of: ${kids.join(", ")}. Delete those first.`,
    );
  if (img.role)
    throw new Error(
      `Image ${id} is the current ${img.role} baseline. Make a newer revision the baseline first.`,
    );
  if (inUseIds.includes(id))
    throw new Error(`Image ${id} is used by a running VM. Stop it first.`);
  let diskRemoved = false;
  if (
    isInsideDir(img.vhdxPath, config.imagesDir) &&
    fs.existsSync(img.vhdxPath)
  ) {
    fs.chmodSync(img.vhdxPath, 0o666);
    fs.rmSync(img.vhdxPath);
    diskRemoved = true;
  }
  fs.rmSync(img.manifestFile);
  return {
    imageId: id,
    diskRemoved,
    freedBytes: diskRemoved ? (img.sizeBytes ?? 0) : 0,
  };
}

/** Snapshot names become part of an image id, so keep them file-name safe. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** The image id and disk path a snapshot named `name` of `parent` would get. */
export function snapshotTarget(
  config,
  parent,
  name,
  kind = "prepared",
  asBase = false,
) {
  const slug = slugify(name);
  if (!slug) throw new Error("A snapshot needs a name (letters and digits).");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const imageId = `${parent.os}-${kind === "golden" || asBase ? "base" : "snap"}-${slug}-${date}`;
  if (fs.existsSync(path.join(config.imagesDir, `${imageId}.json`)))
    throw new Error(
      `An image named ${imageId} already exists. Pick another name.`,
    );
  return { imageId, vhdxPath: path.join(config.imagesDir, `${imageId}.vhdx`) };
}

/**
 * Registers a snapshot: a read-only differencing disk saved from a lease, as a "prepared" image whose parent is the
 * image the lease booted from.
 */
export function registerSnapshot(
  config,
  parent,
  {
    imageId,
    name,
    notes,
    vhdxPath,
    sizeBytes,
    kind = "prepared",
    preparedStage,
  },
) {
  const manifest = {
    imageId,
    os: parent.os,
    kind,
    label: String(name).slice(0, 80),
    vhdxPath,
    sizeBytes,
    createdAt: new Date().toISOString(),
    user: parent.user,
    resolution: parent.resolution,
    sshHostKeyFingerprint: parent.sshHostKeyFingerprint,
    parentImageId: parent.imageId,
    ...(kind === "prepared"
      ? { preparedStage: preparedStage ?? "snapshot" }
      : {}),
    notes: notes ? String(notes).slice(0, 4000) : undefined,
  };
  fs.writeFileSync(
    path.join(config.imagesDir, `${imageId}.json`),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
