import fs from "node:fs";
import path from "node:path";
import { checkExecCommand } from "./guest/exec-guard.mjs";
import { keepsWorkspace } from "./images.mjs";
import { assembleReport, readSteps, STEP_STATUSES } from "./report.mjs";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_TEXT = 20_000;

const text = (t) => ({ content: [{ type: "text", text: String(t) }] });
const fail = (t) => ({
  content: [{ type: "text", text: String(t) }],
  isError: true,
});
const truncate = (s) =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n...(truncated)` : s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const int = (min, max, extra = {}) => ({
  type: "integer",
  minimum: min,
  maximum: max,
  ...extra,
});
const str = (extra = {}) => ({ type: "string", ...extra });
const VM = { vm: str({ description: "Lease id returned by vm_start" }) };
const XY = { x: int(0, 4000), y: int(0, 4000) };

const APP_ACTION_ITEM = {
  type: "object",
  description:
    "{type:'click',ref} | {type:'type',ref?,text,submit?} | {type:'press',key} | {type:'wait_for',text,timeoutSec?}",
  properties: {
    type: { type: "string", enum: ["click", "type", "press", "wait_for"] },
    ref: { type: "string" },
    text: { type: "string" },
    key: { type: "string", description: "e.g. 'ctrl+shift+p', 'Enter'" },
    submit: { type: "boolean" },
    timeoutSec: { type: "integer" },
  },
  required: ["type"],
};
const DESKTOP_ACTION_ITEM = {
  type: "object",
  description:
    "{type:'click'|'double_click'|'move',x,y} | {type:'scroll',x,y,delta} | {type:'type',text} | {type:'key',combo} | {type:'wait',ms}",
  properties: {
    type: {
      type: "string",
      enum: ["click", "double_click", "move", "scroll", "type", "key", "wait"],
    },
    x: { type: "integer" },
    y: { type: "integer" },
    button: { type: "string", enum: ["left", "right", "middle"] },
    delta: { type: "integer" },
    text: { type: "string" },
    combo: { type: "string", description: "e.g. 'ctrl+shift+p', 'enter'" },
    key: { type: "string", description: "alias of combo" },
    ms: { type: "integer" },
  },
  required: ["type"],
};

/** Validates args against the small JSON-schema subset used below. Returns the args with defaults applied. */
export function validateArgs(schema, args) {
  const out = { ...(args ?? {}) };
  for (const [key, def] of Object.entries(schema.properties ?? {})) {
    if (out[key] === undefined && def.default !== undefined)
      out[key] = def.default;
    if (out[key] === undefined) {
      if (schema.required?.includes(key))
        throw new Error(`missing required argument '${key}'`);
      continue;
    }
    const v = out[key];
    if (def.type === "integer" && !Number.isInteger(v))
      throw new Error(`'${key}' must be an integer`);
    if (def.type === "string" && typeof v !== "string")
      throw new Error(`'${key}' must be a string`);
    if (def.type === "boolean" && typeof v !== "boolean")
      throw new Error(`'${key}' must be a boolean`);
    if (def.type === "array" && !Array.isArray(v))
      throw new Error(`'${key}' must be an array`);
    if (def.minItems !== undefined && v.length < def.minItems)
      throw new Error(`'${key}' needs at least ${def.minItems} item(s)`);
    if (def.maxItems !== undefined && v.length > def.maxItems)
      throw new Error(`'${key}' allows at most ${def.maxItems} items`);
    if (def.minimum !== undefined && v < def.minimum)
      throw new Error(`'${key}' must be >= ${def.minimum}`);
    if (def.maximum !== undefined && v > def.maximum)
      throw new Error(`'${key}' must be <= ${def.maximum}`);
    if (def.minLength !== undefined && v.length < def.minLength)
      throw new Error(`'${key}' is too short`);
    if (def.maxLength !== undefined && v.length > def.maxLength)
      throw new Error(`'${key}' is too long`);
    if (def.enum && !def.enum.includes(v))
      throw new Error(`'${key}' must be one of ${def.enum.join(", ")}`);
    if (def.pattern && !new RegExp(def.pattern).test(v))
      throw new Error(`'${key}' has an invalid format`);
  }
  return out;
}

/** True when `candidate` resolves (symlinks included) inside one of `roots`. */
export function isInsideRoots(candidate, roots) {
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  return roots.some((root) => {
    let r;
    try {
      r = fs.realpathSync(root);
    } catch {
      return false;
    }
    const rel = path.relative(r, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * Builds the MCP tool table. Every tool takes the lease id except vm_images and vm_start.
 * @param {{ config: any, leases: import("./leases.mjs").LeaseManager }} ctx
 */
export function buildTools({ config, leases }) {
  const tools = [];
  const add = (name, description, properties, required, run) =>
    tools.push({
      name,
      description,
      schema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      run,
    });

  const capture = async (lease, label) => {
    const shot = await lease.desktop.screenshot();
    const file = path.join(
      lease.runDir,
      "screenshots",
      `${String(++lease.shots).padStart(3, "0")}-${label}.png`,
    );
    fs.writeFileSync(file, shot.png);
    return { file, b64: shot.png.toString("base64") };
  };
  const desktopOf = (id) => {
    const lease = leases.ready(id);
    return lease;
  };

  // ---- lifecycle
  add(
    "vm_images",
    "List the VM images you can boot. The four baselines have a role: 'windows' and 'ubuntu' (clean), 'windows-workspace' and 'ubuntu-workspace' (a prepared Zephyr workspace that VS Code opens and that must be kept). Pass a role or an image id to vm_start.",
    {},
    [],
    async () =>
      text(
        JSON.stringify(
          leases
            .images()
            .map(
              ({
                imageId,
                os,
                kind,
                description,
                role,
                label,
                parentImageId,
                notes,
              }) => ({
                imageId,
                os,
                kind,
                role,
                label,
                description,
                keepsWorkspace: keepsWorkspace({ kind }),
                parentImageId,
                notes: notes ? String(notes).slice(0, 200) : undefined,
              }),
            ),
          null,
          2,
        ),
      ),
  );

  add(
    "vm_start",
    "Boot a disposable GUI VM from a sealed image. Returns a lease id immediately while the VM boots; then call vm_wait_ready. Stop it with vm_stop when finished. app='vscode' launches VS Code on the image's workspace: empty on the clean baselines, the prepared workspace on 'windows-workspace' / 'ubuntu-workspace' and snapshots.",
    {
      image: str({
        description:
          "Baseline role ('windows', 'windows-workspace', 'ubuntu', 'ubuntu-workspace') or an image id from vm_images",
      }),
      app: str({ enum: ["vscode", "none"], default: "vscode" }),
      purpose: str({
        enum: ["test", "base-edit"],
        default: "test",
        description:
          "'base-edit' boots a BASE image to change it (install tools, settings); only allowed while the user has opened that base for changes in the Test VMs window. Finish with vm_save_base.",
      }),
      waitForRam: {
        type: "boolean",
        default: false,
        description:
          "When the host is short of memory, queue the lease (stage 'waiting for free RAM') instead of failing at once. Use it after a 'Not enough free RAM' error, once, rather than starting more VMs.",
      },
      context: {
        type: "object",
        description:
          "What this VM is for, e.g. {repository:'owner/repo', item:'650', kind:'pull_request'}. Shown next to the run on the Test VMs page.",
      },
      execPolicy: str({
        enum: ["inspect-only", "full"],
        default: "inspect-only",
        description:
          "inspect-only refuses vm_exec commands that install software or kill the app, so the test stays user-like",
      }),
    },
    ["image"],
    async (a) => {
      const lease = await leases.startChecked({
        image: a.image,
        app: a.app === "vscode" && a.purpose === "base-edit" ? "none" : a.app,
        purpose: a.purpose,
        execPolicy: a.execPolicy,
        waitForRam: a.waitForRam,
        context: a.context,
      });
      return text(
        JSON.stringify(
          {
            vm: lease.id,
            status: lease.status,
            image: lease.image.imageId,
            next: "Call vm_wait_ready with this vm id.",
          },
          null,
          2,
        ),
      );
    },
  );

  add(
    "vm_wait_ready",
    "Wait (up to timeout_s, max 55) for a VM to finish booting. Returns the status and boot stage; call again if it is still 'booting'. The harness retries VS Code itself and enforces its own deadlines, so keep calling until the status is 'ready' or 'failed'; give up early only when bootSeconds passes 600. On 'failed', report the stage and error instead of starting more VMs.",
    { ...VM, timeout_s: int(1, 55, { default: 45 }) },
    ["vm"],
    async (a) => {
      const lease = await leases.waitReady(a.vm, a.timeout_s);
      return text(JSON.stringify(leases.summary(lease), null, 2));
    },
  );

  add(
    "vm_status",
    "Show the state of one VM lease, or of the running and booting leases when vm is omitted (all:true adds finished ones).",
    { vm: str(), all: { type: "boolean", default: false } },
    [],
    async (a) =>
      text(
        JSON.stringify(
          a.vm
            ? leases.summary(leases.get(a.vm))
            : [...leases.leases.values()]
                .filter(
                  (l) =>
                    a.all || l.status === "booting" || l.status === "ready",
                )
                .map((l) => leases.summary(l)),
          null,
          2,
        ),
      ),
  );

  add(
    "vm_snapshot",
    "Save the running VM as a reusable snapshot image and end the lease. Use it after a slow one-time setup (installing the build tools, signing in) so later runs boot from vm_start image='<snapshot id>' with that work already done. Do NOT call vm_stop afterwards. Only snapshot when the user asked for it or the setup took more than a few minutes. Allowed only for a VM booted from a baseline or from a snapshot of one.",
    {
      ...VM,
      name: str({
        minLength: 1,
        maxLength: 60,
        description: "Short name, e.g. 'zephyr-tools-installed'",
      }),
      notes: str({
        maxLength: 2000,
        description: "What is installed or configured in this snapshot",
      }),
    },
    ["vm", "name"],
    async (a) => {
      const m = await leases.snapshot(a.vm, { name: a.name, notes: a.notes });
      return text(
        `Snapshot saved as image '${m.imageId}'. The VM is gone; start a new one with vm_start image='${m.imageId}'.`,
      );
    },
  );

  add(
    "vm_save_base",
    "Save a purpose='base-edit' VM as a new revision of its base image and end the lease. The previous base stays untouched and the new revision becomes the newest base for that OS. Only call it after the changes are verified and the user asked for them.",
    {
      ...VM,
      name: str({
        minLength: 1,
        maxLength: 60,
        description: "Short name of the revision, e.g. 'node-22'",
      }),
      notes: str({
        maxLength: 2000,
        description: "Exactly what changed in this revision",
      }),
    },
    ["vm", "name", "notes"],
    async (a) => {
      const m = await leases.saveBase(a.vm, { name: a.name, notes: a.notes });
      return text(
        `New base revision saved as '${m.imageId}' (parent ${m.parentImageId}). The VM is gone and the base is locked again.`,
      );
    },
  );

  add(
    "vm_stop",
    "Shut the VM down and delete it. Always call this when you are done.",
    VM,
    ["vm"],
    async (a) => {
      await leases.stop(a.vm);
      return text(
        `VM ${a.vm} stopped and removed. Evidence stays in ${leases.get(a.vm).runDir}`,
      );
    },
  );

  // ---- guest
  add(
    "vm_put_file",
    "Copy a file from this machine (the host running OpenHands) into the VM. host_path must be inside an OpenHands workspace folder. Returns the guest path.",
    {
      ...VM,
      host_path: str({ minLength: 1 }),
      guest_path: str({ description: "Defaults to the VM's inbox folder" }),
    },
    ["vm", "host_path"],
    async (a) => {
      const lease = desktopOf(a.vm);
      const abs = path.resolve(a.host_path);
      if (!isInsideRoots(abs, config.workspaceRoots)) {
        return fail(
          `host_path must be inside an allowed workspace folder (${config.workspaceRoots.join(", ")}). Copy or build the file there first (your conversation workspace is one of them), then call vm_put_file again.`,
        );
      }
      if (!fs.statSync(abs).isFile()) return fail("host_path must be a file.");
      const inbox = lease.ops.paths.inbox;
      const sep = lease.os === "windows" ? "\\" : "/";
      const dest = a.guest_path ?? `${inbox}${sep}${path.basename(abs)}`;
      await lease.ssh.exec(
        lease.os === "windows"
          ? `New-Item -ItemType Directory -Force '${inbox}' | Out-Null`
          : `mkdir -p '${inbox}'`,
        { timeoutMs: 30_000 },
      );
      await lease.ssh.putFile(abs, dest);
      return text(`copied to ${dest}`);
    },
  );

  add(
    "vm_exec",
    "Run a command in the guest to inspect state (read files, list processes, read logs). Windows runs PowerShell, Linux runs bash. With the default inspect-only policy, installs and app kills are refused: do those through the GUI like a user.",
    {
      ...VM,
      command: str({ minLength: 1 }),
      timeoutSec: int(1, 300, { default: 60 }),
    },
    ["vm", "command"],
    async (a) => {
      const lease = desktopOf(a.vm);
      const g = checkExecCommand(a.command, lease.execPolicy);
      if (!g.allowed) return fail(g.reason);
      const r = await lease.ssh.exec(a.command, {
        timeoutMs: a.timeoutSec * 1000,
      });
      return text(
        truncate(
          `exit=${r.code}${r.timedOut ? " (timed out)" : ""}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
        ),
      );
    },
  );

  add(
    "vm_read_file",
    "Read a text file from the guest (first 20000 characters).",
    { ...VM, path: str({ minLength: 1 }) },
    ["vm", "path"],
    async (a) =>
      text(
        truncate(
          (await desktopOf(a.vm).ssh.readFile(a.path, 200_000)).toString(
            "utf8",
          ),
        ),
      ),
  );

  add(
    "vm_list_dir",
    "List a folder in the guest.",
    { ...VM, path: str({ minLength: 1 }) },
    ["vm", "path"],
    async (a) => {
      const rows = await desktopOf(a.vm).ssh.listDir(a.path);
      return text(
        rows
          .map(
            (r) =>
              `${r.isDir ? "d" : "-"} ${String(r.size).padStart(10)}  ${r.name}`,
          )
          .join("\n") || "(empty)",
      );
    },
  );

  add(
    "vm_wait_for",
    "Wait (max 55 s per call) until a condition holds in the guest, without spending your turns. Returns early with INTERRUPTED if a UAC prompt (Windows) or sudo/admin password prompt (Linux, macOS) appears and you listed it in interruptOn; take a screenshot and handle it. Call again if it times out.",
    {
      ...VM,
      until: str({ enum: ["file-exists", "file-contains", "process-gone"] }),
      path: str(),
      text: str(),
      processName: str(),
      timeoutSec: int(5, 55, { default: 45 }),
      interruptOn: {
        type: "array",
        items: { type: "string", enum: ["uac", "sudo"] },
        default: [],
      },
    },
    ["vm", "until"],
    async (a) => {
      const lease = desktopOf(a.vm);
      const win = lease.os === "windows";
      const q = (v) => v.replace(/'/g, win ? "''" : "'\\''");
      const check = async () => {
        if (a.until === "file-exists" && a.path) {
          const r = await lease.ssh.exec(
            win
              ? `Test-Path -LiteralPath '${q(a.path)}'`
              : `test -e '${q(a.path)}' && echo True || echo False`,
            { timeoutMs: 20_000 },
          );
          return r.stdout.trim() === "True";
        }
        if (a.until === "file-contains" && a.path && a.text !== undefined) {
          const r = await lease.ssh.exec(
            win
              ? `if (Select-String -LiteralPath '${q(a.path)}' -SimpleMatch '${q(a.text)}' -Quiet -ErrorAction SilentlyContinue) { 'True' } else { 'False' }`
              : `grep -qF -- '${q(a.text)}' '${q(a.path)}' 2>/dev/null && echo True || echo False`,
            { timeoutMs: 20_000 },
          );
          return r.stdout.trim() === "True";
        }
        if (a.until === "process-gone" && a.processName) {
          const r = await lease.ssh.exec(
            win
              ? `if (Get-Process -Name '${q(a.processName)}' -ErrorAction SilentlyContinue) { 'False' } else { 'True' }`
              : `pgrep -x '${q(a.processName)}' >/dev/null && echo False || echo True`,
            { timeoutMs: 20_000 },
          );
          return r.stdout.trim() === "True";
        }
        throw new Error(
          `vm_wait_for(${a.until}) is missing its path/text/processName argument`,
        );
      };
      const t0 = Date.now();
      while (Date.now() - t0 < a.timeoutSec * 1000) {
        if (await check())
          return text(
            `condition met after ${Math.round((Date.now() - t0) / 1000)}s`,
          );
        const pending = await lease.ops.pendingElevation().catch(() => null);
        if (pending && a.interruptOn.includes(pending))
          return text(
            `INTERRUPTED: a ${pending === "uac" ? "UAC prompt" : "sudo password prompt"} is waiting. Take a screenshot and handle it, then wait again.`,
          );
        await sleep(5000);
      }
      return text(`TIMEOUT after ${a.timeoutSec}s: condition not met`);
    },
  );

  add(
    "vm_app_restart",
    "Close and relaunch VS Code (after an install that asks for a restart, or if the window is wedged). folder opens that guest folder instead of the default workspace: the reliable way to open a project.",
    { ...VM, folder: str({ maxLength: 500 }) },
    ["vm"],
    async (a) => {
      const lease = desktopOf(a.vm);
      if (!lease.driver) return fail("This VM was started with app='none'.");
      await lease.driver.restart(a.folder ? { folder: a.folder } : {});
      return text(
        a.folder ? `VS Code restarted on ${a.folder}` : "VS Code restarted",
      );
    },
  );

  // ---- app (VS Code over CDP: DOM-level, more reliable than pixels)
  const driverOf = (id) => {
    const lease = desktopOf(id);
    if (!lease.driver)
      throw new Error(
        "app_* tools need a VM started with app='vscode'. Use desktop_* tools instead.",
      );
    return lease.driver;
  };
  const REF = {
    ref: str({
      description: "Element ref such as 'e12' from the latest app_snapshot",
    }),
  };
  add(
    "app_snapshot",
    "Snapshot VS Code's window as an accessibility tree with [ref=eN] handles (menus, command palette, views, webviews). Take a new snapshot after every action that changes the page; refs from an older snapshot may be stale. match returns only the lines containing that text (cheap: use it when you know what you look for); maxChars caps the size. Use desktop_screenshot for native dialogs and UAC.",
    {
      ...VM,
      match: str({ maxLength: 200 }),
      maxChars: int(500, 30_000, { default: 30_000 }),
    },
    ["vm"],
    async (a) =>
      text(
        await driverOf(a.vm).snapshot({ match: a.match, maxChars: a.maxChars }),
      ),
  );
  add(
    "app_command",
    "Run a VS Code command by its EXACT title as shown in the command palette (for example 'File: Open Folder...' or 'Developer: Reload Window'). Safer than typing into the palette and pressing Enter, which runs the top fuzzy match. Fails with the closest titles if there is no exact match.",
    { ...VM, title: str({ minLength: 1, maxLength: 200 }) },
    ["vm", "title"],
    async (a) => {
      await driverOf(a.vm).runCommand(a.title);
      return text(`ran command '${a.title}'`);
    },
  );
  add(
    "app_click",
    "Click an element by its ref from the latest app_snapshot.",
    { ...VM, ...REF },
    ["vm", "ref"],
    async (a) => {
      await driverOf(a.vm).click(a.ref);
      return text(`clicked ${a.ref}`);
    },
  );
  add(
    "app_type",
    "Type into VS Code: fill the field given by ref, or type into whatever has focus when ref is omitted. submit presses Enter afterwards.",
    {
      ...VM,
      ref: str(),
      text: str({ maxLength: 2000 }),
      submit: { type: "boolean", default: false },
    },
    ["vm", "text"],
    async (a) => {
      await driverOf(a.vm).type(a.text, { ref: a.ref, submit: a.submit });
      return text(
        `typed ${a.text.length} characters${a.submit ? " and pressed Enter" : ""}`,
      );
    },
  );
  add(
    "app_press",
    "Press a key in VS Code, for example 'Enter', 'Escape', 'ctrl+shift+p', 'F1'. Same spelling as desktop_key.",
    { ...VM, key: str({ minLength: 1, maxLength: 40 }) },
    ["vm", "key"],
    async (a) => {
      await driverOf(a.vm).press(a.key);
      return text(`pressed ${a.key}`);
    },
  );
  add(
    "app_actions",
    "Run several VS Code actions in ONE call, then return a fresh app_snapshot. actions: [{type:'click',ref} | {type:'type',ref?,text,submit?} | {type:'press',key} | {type:'wait_for',text,timeoutSec?}]. Refs come from the last app_snapshot and can go stale once the page changes, so batch only steps that do not reshuffle the page (for example: type into a field, press Enter, press Escape). Stops at the first failure.",
    {
      ...VM,
      actions: {
        type: "array",
        items: APP_ACTION_ITEM,
        minItems: 1,
        maxItems: 20,
      },
      snapshot: { type: "boolean", default: true },
      maxChars: int(500, 30_000, { default: 12_000 }),
    },
    ["vm", "actions"],
    async (a) => {
      const driver = driverOf(a.vm);
      const done = [];
      let failure;
      for (const [i, act] of a.actions.entries()) {
        try {
          done.push(await runAppAction(driver, act));
        } catch (e) {
          failure = `action ${i + 1} (${JSON.stringify(act)}) failed: ${e?.message ?? e}`;
          break;
        }
      }
      const lines = done.map((d, i) => `${i + 1}. ${d}`);
      if (failure) lines.push(failure);
      const snap = a.snapshot
        ? `\n--- snapshot\n${await driver.snapshot({ maxChars: a.maxChars })}`
        : "";
      const out = text(truncate(`${lines.join("\n")}${snap}`));
      return failure ? { ...out, isError: true } : out;
    },
  );
  add(
    "app_wait_for",
    "Wait until some text is visible in VS Code (max 55 s).",
    {
      ...VM,
      text: str({ minLength: 1, maxLength: 200 }),
      timeoutSec: int(1, 55, { default: 20 }),
    },
    ["vm", "text"],
    async (a) => {
      const seen = await driverOf(a.vm).waitForText(
        a.text,
        a.timeoutSec * 1000,
      );
      return text(
        seen
          ? `'${a.text}' is visible`
          : `TIMEOUT: '${a.text}' did not appear within ${a.timeoutSec}s`,
      );
    },
  );

  // ---- desktop
  add(
    "desktop_screenshot",
    "Take a screenshot of the VM's screen (1280x800; coordinates map 1:1 to pixels). Sees everything, including UAC and OS dialogs. Also saved as evidence.",
    VM,
    ["vm"],
    async (a) => {
      const lease = desktopOf(a.vm);
      const c = await capture(lease, "screenshot");
      return {
        content: [
          { type: "image", data: c.b64, mimeType: "image/png" },
          { type: "text", text: `saved: ${c.file}` },
        ],
      };
    },
  );
  const settle = (ms) => sleep(Math.min(Math.max(ms ?? 0, 0), 5000));
  add(
    "desktop_actions",
    "Run several desktop actions in ONE call, then return a single screenshot (use this instead of click/screenshot/click/screenshot: it is several times faster). actions is an ordered list of {type:'click',x,y,button?} | {type:'double_click',x,y} | {type:'move',x,y} | {type:'scroll',x,y,delta} | {type:'type',text} | {type:'key',combo} | {type:'wait',ms}. Stops at the first failing action and says which. Only batch steps whose targets you already know from the last screenshot.",
    {
      ...VM,
      actions: {
        type: "array",
        items: DESKTOP_ACTION_ITEM,
        minItems: 1,
        maxItems: 20,
      },
      settleMs: int(0, 5000, { default: 600 }),
      screenshot: { type: "boolean", default: true },
    },
    ["vm", "actions"],
    async (a) => {
      const lease = desktopOf(a.vm);
      const done = [];
      let failure;
      for (const [i, act] of a.actions.entries()) {
        try {
          done.push(await runDesktopAction(lease.desktop, act));
        } catch (e) {
          failure = `action ${i + 1} (${JSON.stringify(act)}) failed: ${e?.message ?? e}`;
          break;
        }
      }
      const lines = done.map((d, i) => `${i + 1}. ${d}`);
      if (failure) lines.push(failure);
      if (!a.screenshot)
        return failure ? fail(lines.join("\n")) : text(lines.join("\n"));
      await settle(a.settleMs);
      const c = await capture(lease, "actions");
      return {
        content: [
          { type: "image", data: c.b64, mimeType: "image/png" },
          { type: "text", text: `${lines.join("\n")}\nsaved: ${c.file}` },
        ],
        ...(failure ? { isError: true } : {}),
      };
    },
  );
  add(
    "desktop_capture",
    "Save a screenshot as evidence WITHOUT returning the image (cheap). Returns the saved path to cite in record_step.",
    { ...VM, label: str({ pattern: "^[\\w-]{1,40}$", default: "evidence" }) },
    ["vm"],
    async (a) =>
      text(`saved: ${(await capture(desktopOf(a.vm), a.label)).file}`),
  );
  add(
    "desktop_click",
    "Click at pixel coordinates.",
    {
      ...VM,
      ...XY,
      button: str({ enum: ["left", "right", "middle"], default: "left" }),
    },
    ["vm", "x", "y"],
    async (a) => {
      await desktopOf(a.vm).desktop.click(a.x, a.y, a.button, 1);
      return text(`clicked ${a.button} at (${a.x},${a.y})`);
    },
  );
  add(
    "desktop_double_click",
    "Double-click at pixel coordinates.",
    { ...VM, ...XY },
    ["vm", "x", "y"],
    async (a) => {
      await desktopOf(a.vm).desktop.click(a.x, a.y, "left", 2);
      return text(`double-clicked at (${a.x},${a.y})`);
    },
  );
  add(
    "desktop_move",
    "Move the pointer (for example to show a tooltip).",
    { ...VM, ...XY },
    ["vm", "x", "y"],
    async (a) => {
      await desktopOf(a.vm).desktop.move(a.x, a.y);
      return text(`moved to (${a.x},${a.y})`);
    },
  );
  add(
    "desktop_scroll",
    "Scroll the mouse wheel at a position. Positive scrolls up, negative down (wheel notches * 120; unverified, check with a screenshot).",
    { ...VM, ...XY, delta: int(-1200, 1200) },
    ["vm", "x", "y", "delta"],
    async (a) => {
      await desktopOf(a.vm).desktop.scroll(a.x, a.y, a.delta);
      return text(`scrolled ${a.delta} at (${a.x},${a.y})`);
    },
  );
  add(
    "desktop_type",
    "Type printable ASCII text into whatever has keyboard focus.",
    { ...VM, text: str({ minLength: 1, maxLength: 500 }) },
    ["vm", "text"],
    async (a) => {
      await desktopOf(a.vm).desktop.type(a.text);
      return text(`typed ${a.text.length} characters`);
    },
  );
  add(
    "desktop_key",
    "Press a key or combo such as 'enter', 'alt+y', 'ctrl+shift+p', 'tab', 'esc', 'f5'.",
    { ...VM, combo: str({ minLength: 1, maxLength: 40 }) },
    ["vm", "combo"],
    async (a) => {
      await desktopOf(a.vm).desktop.key(a.combo);
      return text(`pressed ${a.combo}`);
    },
  );
  add(
    "desktop_wait",
    "Wait before the next action (max 10 s).",
    { ...VM, ms: int(100, 10_000) },
    ["vm", "ms"],
    async (a) => {
      leases.get(a.vm);
      await sleep(a.ms);
      return text(`waited ${a.ms} ms`);
    },
  );
  add(
    "desktop_type_secret",
    "Type the guest account password (for a sudo or UAC prompt) without showing it to you.",
    { ...VM, secret: str({ enum: ["sudo", "admin"] }) },
    ["vm", "secret"],
    async (a) => {
      const lease = desktopOf(a.vm);
      const file = path.join(config.secretsDir, "guest-creds.json");
      let password;
      try {
        password = JSON.parse(fs.readFileSync(file, "utf8")).password;
      } catch {
        return fail(`No guest password available (expected ${file}).`);
      }
      await lease.desktop.type(password);
      return text(`typed the ${a.secret} password`);
    },
  );

  // ---- report
  add(
    "record_step",
    "Record the result of ONE test step the moment you finish it. Calling it again with the same id replaces the earlier record. Cite evidence (paths from desktop_capture / desktop_screenshot). A step is 'pass' only if you SAW the expected result.",
    {
      ...VM,
      id: str({ pattern: "^[\\w.-]{1,40}$" }),
      title: str({ minLength: 1, maxLength: 200 }),
      status: str({ enum: STEP_STATUSES }),
      expected: str({ minLength: 1, maxLength: 1000 }),
      observed: str({ minLength: 1, maxLength: 2000 }),
      evidence: { type: "array", items: { type: "string" }, default: [] },
      capture: {
        type: "boolean",
        default: false,
        description:
          "Also take a screenshot now and add it to the evidence (saves a desktop_capture call)",
      },
    },
    ["vm", "id", "title", "status", "expected", "observed"],
    async (a) => {
      const lease = leases.get(a.vm);
      const { vm, capture: wantShot, ...rec } = a;
      if (wantShot && lease.status === "ready" && lease.desktop) {
        const c = await capture(lease, rec.id.replace(/[^\w-]/g, "-"));
        rec.evidence = [...rec.evidence, c.file];
      }
      fs.appendFileSync(
        path.join(lease.runDir, "steps.jsonl"),
        `${JSON.stringify({ ...rec, at: new Date().toISOString() })}\n`,
      );
      return text(
        `recorded ${a.id}: ${a.status} (${readSteps(path.join(lease.runDir, "steps.jsonl")).length} steps so far)`,
      );
    },
  );

  add(
    "submit_report",
    "Finish the run: call EXACTLY ONCE after recording every step, then vm_stop. passed must agree with the recorded steps.",
    {
      ...VM,
      passed: { type: "boolean" },
      confidence: str({ enum: ["high", "medium", "low"] }),
      summary: str({ minLength: 1, maxLength: 4000 }),
      regressions: { type: "array", items: { type: "object" }, default: [] },
      envProblems: { type: "array", items: { type: "string" }, default: [] },
    },
    ["vm", "passed", "confidence", "summary"],
    async (a) => {
      const lease = leases.get(a.vm);
      const reportFile = path.join(lease.runDir, "report.json");
      if (fs.existsSync(reportFile))
        return fail("A report was already submitted for this VM.");
      const report = assembleReport(
        { leaseId: lease.id, imageId: lease.image.imageId, os: lease.os },
        readSteps(path.join(lease.runDir, "steps.jsonl")),
        a,
      );
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      return text(
        `report accepted: ${report.steps.length} steps, passed=${report.verdict.passed}. Now call vm_stop.`,
      );
    },
  );

  return tools;
}

const isInt = (v) => Number.isInteger(v);

/** Runs one step of a desktop_actions batch and describes it. Throws on bad input or a failed action. */
export async function runDesktopAction(desktop, act) {
  switch (act?.type) {
    case "click":
    case "double_click": {
      if (!isInt(act.x) || !isInt(act.y))
        throw new Error("x and y must be integers");
      const button = act.button ?? "left";
      if (!["left", "right", "middle"].includes(button))
        throw new Error("bad button");
      await desktop.click(
        act.x,
        act.y,
        act.type === "click" ? button : "left",
        act.type === "click" ? 1 : 2,
      );
      return `${act.type} (${act.x},${act.y})`;
    }
    case "move":
      if (!isInt(act.x) || !isInt(act.y))
        throw new Error("x and y must be integers");
      await desktop.move(act.x, act.y);
      return `move (${act.x},${act.y})`;
    case "scroll":
      if (!isInt(act.x) || !isInt(act.y) || !isInt(act.delta))
        throw new Error("x, y and delta must be integers");
      await desktop.scroll(act.x, act.y, act.delta);
      return `scroll ${act.delta} at (${act.x},${act.y})`;
    case "type":
      if (
        typeof act.text !== "string" ||
        !act.text.length ||
        act.text.length > 500
      )
        throw new Error("text must be 1-500 characters");
      await desktop.type(act.text);
      return `type ${act.text.length} chars`;
    case "key": {
      const combo = act.combo ?? act.key;
      if (typeof combo !== "string" || !combo || combo.length > 40)
        throw new Error("combo required");
      await desktop.key(combo);
      return `key ${combo}`;
    }
    case "wait":
      if (!isInt(act.ms) || act.ms < 100 || act.ms > 10_000)
        throw new Error("ms must be 100-10000");
      await sleep(act.ms);
      return `wait ${act.ms}ms`;
    default:
      throw new Error(`unknown action type '${act?.type}'`);
  }
}

/** Runs one step of an app_actions batch and describes it. */
export async function runAppAction(driver, act) {
  switch (act?.type) {
    case "click":
      if (typeof act.ref !== "string") throw new Error("ref required");
      await driver.click(act.ref);
      return `click ${act.ref}`;
    case "type":
      if (typeof act.text !== "string" || act.text.length > 2000)
        throw new Error("text required (max 2000)");
      await driver.type(act.text, {
        ref: act.ref,
        submit: Boolean(act.submit),
      });
      return `type ${act.text.length} chars${act.submit ? " + Enter" : ""}`;
    case "press":
      if (typeof act.key !== "string" || !act.key)
        throw new Error("key required");
      await driver.press(act.key);
      return `press ${act.key}`;
    case "wait_for": {
      if (typeof act.text !== "string" || !act.text)
        throw new Error("text required");
      const secs = isInt(act.timeoutSec) ? Math.min(act.timeoutSec, 60) : 20;
      if (!(await driver.waitForText(act.text, secs * 1000)))
        throw new Error(`'${act.text}' did not appear within ${secs}s`);
      return `'${act.text}' visible`;
    }
    default:
      throw new Error(`unknown action type '${act?.type}'`);
  }
}

/** Appends one line per tool call to the lease's tool-log.jsonl (the audit trail shown next to the report). */
function auditCall(leases, name, args, result) {
  const lease = args.vm ? leases.leases.get(args.vm) : null;
  if (!lease) return;
  const summary = (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : "[image]"))
    .join(" ")
    .slice(0, 300);
  try {
    fs.appendFileSync(
      path.join(lease.runDir, "tool-log.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), tool: name, args, isError: !!result.isError, summary })}
`,
    );
  } catch {
    // Auditing must never break a tool call.
  }
}

/**
 * Minimal stateless MCP server over HTTP (JSON-RPC 2.0, plain JSON responses). Hand-rolled instead of pulling in the
 * MCP SDK: the harness needs only initialize, ping, tools/list and tools/call.
 * @returns {(message: any) => Promise<any|null>}
 */
export function createMcpHandler(ctx) {
  const tools = buildTools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));

  return async function handle(message) {
    const { id, method, params } = message ?? {};
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const error = (code, msg) => ({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message: msg },
    });

    if (id === undefined) return null; // notification
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "openhands-vm-harness", version: "0.1.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.schema,
          })),
        });
      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool) return error(-32602, `Unknown tool: ${params?.name}`);
        try {
          const args = validateArgs(tool.schema, params.arguments);
          const result = await tool.run(args);
          auditCall(ctx.leases, tool.name, args, result);
          return reply(result);
        } catch (e) {
          return reply(fail(String(e?.message ?? e)));
        }
      }
      default:
        return error(-32601, `Method not found: ${method}`);
    }
  };
}
