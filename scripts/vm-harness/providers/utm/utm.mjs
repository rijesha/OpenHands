import { execFile } from "node:child_process";
import fs from "node:fs";

export const UTMCTL = "/Applications/UTM.app/Contents/MacOS/utmctl";

/**
 * @typedef {(file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string, stderr: string }>} Exec
 * Runs a program; rejects with an error carrying `stdout`/`stderr` when it exits non-zero.
 */

/** @type {Exec} */
const defaultExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...opts, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
        } else resolve({ stdout, stderr });
      },
    );
  });

/** AppleScript string literal. */
export function asString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Why UTM refused a command, in words a user can act on. macOS only lets UTM be scripted from the logged-in GUI
 * session: not over SSH, not before login, and not from an IDE extension host that cannot show the consent prompt.
 * @param {string} text stderr of utmctl/osascript
 */
export function explainUtmError(text) {
  if (
    /-1743|not allowed to send Apple events|Not authorized to send Apple events/i.test(
      text,
    )
  )
    return "macOS denied control of UTM (Automation permission). Run the harness as a LaunchAgent in the logged-in user's session and allow the one-time prompt, or enable it under System Settings > Privacy & Security > Automation.";
  if (/does not work from SSH|before logging in/i.test(text))
    return "utmctl only works inside the logged-in user's GUI session (not over SSH or before login).";
  if (/-1712|AppleEvent timed out/i.test(text))
    return "UTM did not answer in time (a permission prompt may be waiting on the Mac's screen).";
  return "";
}

/** Drops UTM's harmless "Error from event ... -10004" chatter. */
function cleanStderr(s) {
  return String(s ?? "")
    .split("\n")
    .filter((l) => l.trim() && !/OSStatus error -10004/.test(l))
    .join("\n")
    .trim();
}

/**
 * UTM status names to the harness's state vocabulary ("Off" and "Missing" are the ones LeaseManager acts on).
 * @param {string | undefined} status
 */
export function stateOf(status) {
  if (!status) return "Missing";
  if (status === "stopped") return "Off";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Parses `utmctl list`. Names may contain spaces.
 * @param {string} out
 * @returns {{ uuid: string, status: string, name: string }[]}
 */
export function parseList(out) {
  const vms = [];
  for (const line of String(out).split("\n")) {
    const m = /^([0-9A-Fa-f-]{36})\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) vms.push({ uuid: m[1], status: m[2], name: m[3] });
  }
  return vms;
}

/**
 * MAC as /var/db/dhcpd_leases writes it: lower case, leading zeros dropped per octet ("0e:79:..:01" -> "e:79:..:1").
 * @param {string} mac
 */
export function leaseMac(mac) {
  return mac
    .toLowerCase()
    .split(":")
    .map((o) => o.replace(/^0(?=.)/, ""))
    .join(":");
}

/**
 * Finds the IPv4 macOS's shared-network DHCP server gave a MAC (UTM "Shared" networking uses vmnet's bootpd).
 * @param {string} text contents of /var/db/dhcpd_leases
 * @param {string} mac
 */
export function ipFromDhcpLeases(text, mac) {
  const want = leaseMac(mac);
  let best = null;
  for (const block of String(text).split("}")) {
    const hw = /hw_address=\d+,([0-9a-f:]+)/i.exec(block)?.[1];
    if (!hw || hw.toLowerCase() !== want) continue;
    const ip = /ip_address=([\d.]+)/.exec(block)?.[1];
    const lease = Number.parseInt(
      /lease=0x([0-9a-f]+)/i.exec(block)?.[1] ?? "0",
      16,
    );
    if (ip && (!best || lease > best.lease)) best = { ip, lease };
  }
  return best?.ip ?? null;
}

/** Thin, injectable wrapper over utmctl and UTM's AppleScript dictionary. */
export class UtmControl {
  /** @param {{ exec?: Exec, utmctl?: string, dhcpLeases?: string }} [o] */
  constructor({
    exec,
    utmctl = UTMCTL,
    dhcpLeases = "/var/db/dhcpd_leases",
  } = {}) {
    this.exec = exec ?? defaultExec;
    this.utmctlPath = utmctl;
    this.dhcpLeasesPath = dhcpLeases;
  }

  installed() {
    return fs.existsSync(this.utmctlPath);
  }

  async #run(file, args, timeoutMs, what) {
    try {
      const r = await this.exec(file, args, { timeout: timeoutMs });
      // utmctl exits 0 with an empty result when macOS denies Apple events: the reason is only on stderr.
      const hint = explainUtmError(r.stderr ?? "");
      if (hint) throw Object.assign(new Error(hint), { stderr: r.stderr });
      return r.stdout;
    } catch (e) {
      const stderr = cleanStderr(e.stderr);
      const hint = explainUtmError(`${stderr}\n${e.message}`);
      const err = new Error(
        `${what} failed: ${hint || stderr || e.message}`.trim(),
      );
      Object.assign(err, { stderr, hint });
      throw err;
    }
  }

  utmctl(args, timeoutMs = 120_000) {
    return this.#run(this.utmctlPath, args, timeoutMs, `utmctl ${args[0]}`);
  }

  /** Runs an AppleScript against UTM. */
  osa(script, timeoutMs = 120_000) {
    return this.#run(
      "osascript",
      ["-e", script],
      timeoutMs,
      "UTM AppleScript",
    ).then((s) => s.trim());
  }

  async list() {
    const out = await this.utmctl(["list"], 30_000);
    if (!/UUID\s+Status\s+Name/.test(out))
      throw new Error("utmctl list failed: unexpected output");
    return parseList(out);
  }

  async find(name) {
    return (await this.list()).find((v) => v.name === name) ?? null;
  }

  start(name) {
    return this.utmctl(["start", name, "--hide"], 120_000);
  }

  stop(name) {
    return this.utmctl(["stop", name, "--force"], 120_000);
  }

  delete(name) {
    return this.utmctl(["delete", name], 120_000);
  }

  clone(source, name) {
    return this.utmctl(["clone", source, "--name", name], 300_000);
  }

  /** IPv4 addresses the QEMU guest agent reports; [] when the guest has no agent. */
  async ipAddresses(name) {
    try {
      const out = await this.utmctl(["ip-address", name], 20_000);
      return out.split(/\s+/).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    } catch {
      return [];
    }
  }

  readDhcpLeases() {
    try {
      return fs.readFileSync(this.dhcpLeasesPath, "utf8");
    } catch {
      return "";
    }
  }

  /** "qemu" or "apple". */
  async backend(name) {
    const out = await this.osa(
      `tell application "UTM" to get backend of virtual machine named ${asString(name)}`,
    );
    return out.trim().toLowerCase();
  }

  /**
   * MAC of the first network card and the QEMU extra arguments (QEMU only).
   * @returns {Promise<{ mac: string, qemuArgs: string[] }>}
   */
  async readConfig(name) {
    const vm = `virtual machine named ${asString(name)}`;
    const out = await this.osa(`tell application "UTM"
  set cfg to configuration of ${vm}
  set out to ""
  try
    set out to out & "MAC=" & (address of item 1 of (network interfaces of cfg)) & linefeed
  end try
  try
    repeat with a in (qemu additional arguments of cfg)
      set out to out & "ARG=" & (argument string of a) & linefeed
    end repeat
  end try
  return out
end tell`);
    const lines = out.split(/\r?\n/);
    return {
      mac: lines.find((l) => l.startsWith("MAC="))?.slice(4) ?? "",
      qemuArgs: lines
        .filter((l) => l.startsWith("ARG="))
        .map((l) => l.slice(4)),
    };
  }

  /**
   * Changes a stopped VM's configuration in place. UTM keeps configs in memory, so editing config.plist on disk does
   * nothing; this goes through UTM itself. Unset fields are left alone.
   * @param {string} name
   * @param {{ newName?: string, mac?: string, qemuArgs?: string[], memoryMB?: number, cpus?: number,
   *   removeRemovableDrives?: boolean, dynamicResolution?: boolean }} change
   */
  async configure(name, change) {
    const lines = [
      `set vm to virtual machine named ${asString(name)}`,
      "set cfg to configuration of vm",
    ];
    if (change.newName)
      lines.push(`set name of cfg to ${asString(change.newName)}`);
    if (change.memoryMB)
      lines.push(`set memory of cfg to ${Math.trunc(change.memoryMB)}`);
    if (change.cpus)
      lines.push(`set cpu cores of cfg to ${Math.trunc(change.cpus)}`);
    if (change.mac) {
      lines.push(
        "set nics to network interfaces of cfg",
        "set nic to item 1 of nics",
        `set address of nic to ${asString(change.mac)}`,
        "set item 1 of nics to nic",
        "set network interfaces of cfg to nics",
      );
    }
    if (change.qemuArgs) {
      const list = change.qemuArgs
        .map((a) => `{argument string:${asString(a)}}`)
        .join(", ");
      lines.push(`set qemu additional arguments of cfg to {${list}}`);
    }
    if (change.removeRemovableDrives) {
      lines.push(
        "set kept to {}",
        "repeat with d in (drives of cfg)",
        "  if removable of d is false then set end of kept to (contents of d)",
        "end repeat",
        "set drives of cfg to kept",
      );
    }
    if (change.dynamicResolution !== undefined) {
      lines.push(
        "set ds to displays of cfg",
        "repeat with i from 1 to count of ds",
        "  set d to item i of ds",
        `  set dynamic resolution of d to ${change.dynamicResolution ? "true" : "false"}`,
        "  set item i of ds to d",
        "end repeat",
        "set displays of cfg to ds",
      );
    }
    lines.push("update configuration of vm with cfg");
    await this.osa(`tell application "UTM"\n${lines.join("\n")}\nend tell`);
  }

  /**
   * Creates an empty QEMU (aarch64) VM booting from an installer ISO, plus optional extra read-only discs (a cloud-init
   * seed). Used only to build golden images.
   * @param {{ name: string, iso: string, extraIsos?: string[], memoryMB: number, cpus: number, diskGB: number }} o
   */
  async createQemuVm({ name, iso, extraIsos = [], memoryMB, cpus, diskGB }) {
    const removable = [iso, ...extraIsos]
      .map((p) => `{removable:true, source:(POSIX file ${asString(p)})}`)
      .join(", ");
    await this.osa(
      `tell application "UTM"
  make new virtual machine with properties {backend:qemu, configuration:{name:${asString(name)}, architecture:"aarch64", memory:${Math.trunc(memoryMB)}, cpu cores:${Math.trunc(cpus)}, drives:{${removable}, {guest size:${Math.trunc(diskGB * 1024)}}}, network interfaces:{{mode:shared}}, displays:{{hardware:"virtio-gpu-pci", dynamic resolution:false}}}}
end tell`,
      300_000,
    );
  }

  /** Saves a VM as a self-contained .utm bundle (an archive copy of a golden image). */
  exportTo(name, file) {
    // AppleScript gives up on a reply after 2 minutes by default; copying a VM takes longer.
    return this.osa(
      `with timeout of 3600 seconds
tell application "UTM" to export (virtual machine named ${asString(name)}) to (POSIX file ${asString(file)})
end timeout`,
      3_660_000,
    );
  }
}
