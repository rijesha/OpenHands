import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { API_PREFIX, rootPaths, writeSettings } from "./config.mjs";
import { childrenOf, deleteImage, updateImage } from "./images.mjs";
import { isBaseline } from "./leases.mjs";
import { createMcpHandler, runDesktopAction } from "./mcp.mjs";
import { listRuns, readJson, readSteps } from "./report.mjs";

const MAX_BODY = 1_000_000;

/** Constant-time comparison of the presented key with the stack key. */
export function keyMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = crypto.createHash("sha256").update(String(presented)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function presentedKey(req) {
  const header = req.headers["x-session-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7).trim();
  return undefined;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(
          Object.assign(new Error("request body too large"), { status: 413 }),
        );
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/**
 * HTTP surface of the harness. Every route except GET /health requires the stack's session key: the ingress in front
 * of this service forwards requests without authenticating them.
 *
 *   POST /mcp                       MCP (streamable HTTP, JSON responses)
 *   GET  /health
 *   GET  /images, /leases, /runs, /runs/:id
 *   GET  /runs/:id/boot-failure     {pngBase64} what the VM showed when its boot stalled
 *   GET  /leases/:id/screenshot     {pngBase64, width, height} (JSON, so a browser app can use its request helper)
 *   POST /leases/:id/stop
 *
 * Both `/x` and `/api/vm-harness/x` are accepted (the ingress forwards the prefix unstripped).
 */
export function createServer({
  config,
  leases,
  provider,
  log = () => undefined,
}) {
  const mcp = createMcpHandler({ config, leases });

  async function jsonBody(req) {
    try {
      const parsed = JSON.parse((await readBody(req)) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      throw Object.assign(new Error("invalid JSON body"), { status: 400 });
    }
  }

  function settingsView() {
    const images = leases.images();
    return {
      root: config.root,
      rootSource: config.rootSource,
      imagesDir: config.imagesDir,
      imageCount: images.length,
      hasGuestKey: fs.existsSync(path.join(config.secretsDir, "guest_ed25519")),
      runningVms: leases.active().length,
    };
  }

  /** Lists sub-folders so the page can offer a folder picker (the browser cannot see the host's disk itself). */
  function browse(requested) {
    const entries = (dir) => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    };
    if (!requested) {
      if (process.platform === "win32") {
        const drives = [];
        for (let c = 65; c <= 90; c++) {
          const d = `${String.fromCharCode(c)}:\\`;
          if (fs.existsSync(d)) drives.push(d);
        }
        return { path: "", parent: null, dirs: drives, isRoot: false };
      }
      requested = os.homedir();
    }
    const dir = path.resolve(requested);
    const parent = path.dirname(dir);
    return {
      path: dir,
      parent: parent === dir ? "" : parent,
      dirs: entries(dir),
      hasImages: fs.existsSync(path.join(dir, "images")),
      isRoot: false,
    };
  }

  async function route(req, res) {
    const url = new URL(req.url ?? "/", "http://harness.local");
    let pathname = url.pathname;
    if (pathname.startsWith(API_PREFIX))
      pathname = pathname.slice(API_PREFIX.length) || "/";
    pathname = pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathname === "/health")
      return send(res, 200, { ok: true });
    if (!keyMatches(presentedKey(req), config.apiKey))
      return send(res, 401, { error: "invalid or missing session API key" });

    if (pathname === "/mcp") {
      if (req.method !== "POST")
        return send(
          res,
          405,
          { error: "MCP endpoint accepts POST only" },
          { Allow: "POST" },
        );
      let msg;
      try {
        msg = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.status) throw e;
        return send(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
      }
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => mcp(m)))).filter(Boolean);
        return out.length ? send(res, 200, out) : send(res, 202, "");
      }
      const out = await mcp(msg);
      return out ? send(res, 200, out) : send(res, 202, "");
    }

    if (req.method === "GET" && pathname === "/status") {
      return send(res, 200, {
        provider: provider.id,
        host: await provider
          .hostCheck()
          .catch((e) => ({ ok: false, problems: [String(e.message ?? e)] })),
        maxVms: config.maxVms,
        // Memory one VM of each OS needs (the host also keeps 512 MB free), so a UI can warn before launching.
        memoryMB: {
          windows: config.memoryMB,
          ubuntu: config.memoryMBUbuntu ?? config.memoryMB,
        },
        root: config.root,
        rootSource: config.rootSource,
        imagesDir: config.imagesDir,
        pluginDir: config.pluginDir ?? null,
      });
    }

    if (pathname === "/settings") {
      if (req.method === "GET") return send(res, 200, settingsView());
      if (req.method === "POST") {
        const body = await jsonBody(req);
        const root = typeof body.root === "string" ? body.root.trim() : "";
        if (!root || !path.isAbsolute(root))
          return send(res, 400, {
            error: "Enter an absolute folder path, for example D:\\zide-ai-qa.",
          });
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
          return send(res, 400, { error: `Folder not found: ${root}` });
        try {
          leases.setRoot(rootPaths(path.resolve(root)));
        } catch (e) {
          return send(res, 409, { error: String(e.message ?? e) });
        }
        config.rootSource = "settings";
        writeSettings({ root: config.root });
        log(`data folder is now ${config.root}`);
        return send(res, 200, settingsView());
      }
    }

    if (req.method === "GET" && pathname === "/browse") {
      return send(res, 200, browse(url.searchParams.get("path") ?? ""));
    }

    if (req.method === "GET" && pathname === "/images") {
      const images = leases.images();
      const inUse = leases.imagesInUse();
      return send(
        res,
        200,
        images.map((i) => ({
          imageId: i.imageId,
          os: i.os,
          kind: i.kind,
          description: i.description,
          createdAt: i.createdAt,
          label: i.label,
          notes: i.notes,
          parentImageId: i.parentImageId,
          role: i.role,
          baselineRoot: i.baselineRoot,
          sizeBytes: i.sizeBytes,
          children: childrenOf(images, i.imageId),
          inUse: inUse.includes(i.imageId),
          locked: isBaseline(i) && !leases.unlockedUntil(i.imageId),
          unlockedUntil:
            isBaseline(i) ? leases.unlockedUntil(i.imageId) : null,
        })),
      );
    }
    const imageRoute = pathname.match(/^\/images\/([\w.-]+)$/);
    const lockRoute = pathname.match(/^\/images\/([\w.-]+)\/(unlock|lock)$/);
    if (lockRoute && req.method === "POST") {
      try {
        if (lockRoute[2] === "lock") leases.lock(lockRoute[1]);
        else
          leases.unlock(
            lockRoute[1],
            Number((await jsonBody(req)).minutes) || 60,
          );
      } catch (e) {
        return send(res, 404, { error: String(e.message ?? e) });
      }
      return send(res, 200, { ok: true });
    }
    const protectedBase = (id) => {
      const img = leases.images().find((i) => i.imageId === id);
      return img && isBaseline(img) && !leases.unlockedUntil(id);
    };
    if (
      imageRoute &&
      ["PATCH", "DELETE"].includes(req.method ?? "") &&
      protectedBase(imageRoute[1])
    ) {
      return send(res, 403, {
        error:
          "This base image is locked. Use Change this base in the Test VMs window; it opens the base for a limited time.",
      });
    }
    if (imageRoute && req.method === "PATCH") {
      const body = await jsonBody(req);
      try {
        updateImage(leases.images(), imageRoute[1], body);
      } catch (e) {
        return send(res, 404, { error: String(e.message ?? e) });
      }
      return send(res, 200, { ok: true });
    }
    if (imageRoute && req.method === "DELETE") {
      try {
        return send(
          res,
          200,
          deleteImage(
            config,
            leases.images(),
            imageRoute[1],
            leases.imagesInUse(),
          ),
        );
      } catch (e) {
        return send(res, 409, { error: String(e.message ?? e) });
      }
    }

    if (req.method === "GET" && pathname === "/leases") {
      return send(
        res,
        200,
        [...leases.leases.values()].map((l) => leases.summary(l)),
      );
    }
    if (req.method === "POST" && pathname === "/leases") {
      const body = await jsonBody(req);
      try {
        const lease = await leases.startChecked({
          image: String(body.image ?? ""),
          app: body.app,
        });
        return send(res, 200, leases.summary(lease));
      } catch (e) {
        return send(res, 409, { error: String(e.message ?? e) });
      }
    }
    const snap = pathname.match(/^\/leases\/(l[0-9a-f]{6})\/snapshot$/);
    if (req.method === "POST" && snap) {
      const body = await jsonBody(req);
      try {
        const m = await leases.snapshot(snap[1], {
          name: String(body.name ?? ""),
          notes: body.notes,
        });
        return send(res, 200, { imageId: m.imageId });
      } catch (e) {
        return send(res, 409, { error: String(e.message ?? e) });
      }
    }
    if (req.method === "GET" && pathname === "/runs")
      return send(res, 200, listRuns(config.runsDir));

    const run = pathname.match(/^\/runs\/(l[0-9a-f]{6})$/);
    if (req.method === "GET" && run) {
      const dir = path.join(config.runsDir, run[1]);
      const lease = readJson(path.join(dir, "lease.json"));
      if (!lease) return send(res, 404, { error: "unknown run" });
      const shots = fs.existsSync(path.join(dir, "screenshots"))
        ? fs.readdirSync(path.join(dir, "screenshots"))
        : [];
      return send(res, 200, {
        lease,
        report: readJson(path.join(dir, "report.json")),
        steps: readSteps(path.join(dir, "steps.jsonl")),
        screenshots: shots,
      });
    }
    if (req.method === "DELETE" && run) {
      if (
        [...leases.leases.values()].some(
          (l) =>
            l.id === run[1] && (l.status === "ready" || l.status === "booting"),
        )
      )
        return send(res, 409, { error: "That run's VM is still running." });
      fs.rmSync(path.join(config.runsDir, run[1]), {
        recursive: true,
        force: true,
      });
      return send(res, 200, { ok: true });
    }
    const bootShot = pathname.match(/^\/runs\/(l[0-9a-f]{6})\/boot-failure$/);
    if (req.method === "GET" && bootShot) {
      const file = path.join(config.runsDir, bootShot[1], "boot-failure.png");
      if (!fs.existsSync(file)) {
        const txt = path.join(config.runsDir, bootShot[1], "boot-failure.txt");
        if (fs.existsSync(txt))
          return send(res, 200, { details: fs.readFileSync(txt, "utf8") });
        return send(res, 404, { error: "no boot failure screenshot" });
      }
      const txt = path.join(config.runsDir, bootShot[1], "boot-failure.txt");
      return send(res, 200, {
        pngBase64: fs.readFileSync(file).toString("base64"),
        details: fs.existsSync(txt) ? fs.readFileSync(txt, "utf8") : undefined,
      });
    }
    const runShot = pathname.match(
      /^\/runs\/(l[0-9a-f]{6})\/screenshots\/([\w-]+\.png)$/,
    );
    if (req.method === "GET" && runShot) {
      const file = path.join(
        config.runsDir,
        runShot[1],
        "screenshots",
        runShot[2],
      );
      if (!fs.existsSync(file))
        return send(res, 404, { error: "unknown screenshot" });
      return send(res, 200, {
        pngBase64: fs.readFileSync(file).toString("base64"),
      });
    }

    const shot = pathname.match(/^\/leases\/(l[0-9a-f]{6})\/screenshot$/);
    if (req.method === "GET" && shot) {
      const lease = leases.leases.get(shot[1]);
      if (!lease || lease.status !== "ready")
        return send(res, 409, { error: "VM is not ready" });
      const s = await lease.desktop.screenshot();
      return send(res, 200, {
        pngBase64: s.png.toString("base64"),
        width: s.width,
        height: s.height,
      });
    }
    // Manual control from the Test VMs page: the same actions an agent's desktop_actions batch takes.
    const input = pathname.match(/^\/leases\/(l[0-9a-f]{6})\/input$/);
    if (req.method === "POST" && input) {
      const lease = leases.leases.get(input[1]);
      if (!lease || lease.status !== "ready" || !lease.desktop)
        return send(res, 409, { error: "VM is not ready" });
      const body = await jsonBody(req);
      lease.lastUsed = Date.now();
      try {
        await runDesktopAction(lease.desktop, body);
      } catch (e) {
        return send(res, 400, { error: String(e.message ?? e) });
      }
      return send(res, 200, { ok: true });
    }
    const extend = pathname.match(/^\/leases\/(l[0-9a-f]{6})\/extend$/);
    if (req.method === "POST" && extend) {
      try {
        leases.extend(extend[1]);
      } catch (e) {
        return send(res, 409, { error: String(e.message ?? e) });
      }
      return send(res, 200, { ok: true });
    }
    const stop = pathname.match(/^\/leases\/(l[0-9a-f]{6})\/stop$/);
    if (req.method === "POST" && stop) {
      if (!leases.leases.has(stop[1]))
        return send(res, 404, { error: "unknown lease" });
      await leases.stop(stop[1]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log(`request failed: ${e?.stack ?? e}`);
      if (!res.headersSent)
        send(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    });
  });
}
