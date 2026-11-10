/**
 * `vm_exec` in "inspect-only" mode is for INSPECTION: a tester that must behave like a user sets the app up through
 * the GUI, so commands that install things, kill the app, or power the VM off are refused. Best-effort, not a
 * security boundary: the VM is disposable. "full" mode skips this guard.
 */
const DENY = [
  {
    re: /--install-extension|--uninstall-extension/i,
    why: "install extensions through the app UI",
  },
  {
    re: /\bwinget\b.*\b(install|upgrade|uninstall)\b/i,
    why: "install software through the UI like a user",
  },
  {
    re: /\b(apt|apt-get|aptitude|dpkg)\b.*\b(install|upgrade|remove|purge|-i)\b/i,
    why: "install software through the UI like a user",
  },
  {
    re: /\b(choco|scoop|brew|snap|flatpak|dnf|yum|pacman|zypper)\b.*\b(install|upgrade)\b/i,
    why: "install software through the UI like a user",
  },
  {
    re: /\b(pip3?|pipx|uv)\b.*\binstall\b/i,
    why: "install software through the UI like a user",
  },
  {
    re: /Invoke-WebRequest|Invoke-RestMethod|\b(curl|wget)\b.*\|\s*(sh|bash|iex)/i,
    why: "downloading and running things is not allowed",
  },
  {
    re: /\b(Stop-Process|taskkill|pkill|kill)\b.*\b(Code|code)\b/i,
    why: "use vm_app_restart to restart the app",
  },
  {
    re: /\bshutdown\b|\breboot\b|Restart-Computer|Stop-Computer|\bpoweroff\b|\bhalt\b/i,
    why: "do not power the VM off or reboot it; use vm_stop",
  },
];

/**
 * @param {string} cmd
 * @param {"inspect-only"|"full"} [policy]
 */
export function checkExecCommand(cmd, policy = "inspect-only") {
  if (cmd.length > 4000)
    return { allowed: false, reason: "command too long (max 4000 characters)" };
  if (policy === "full") return { allowed: true };
  for (const d of DENY) {
    if (d.re.test(cmd))
      return {
        allowed: false,
        reason: `vm_exec is for inspection only: ${d.why}.`,
      };
  }
  return { allowed: true };
}
