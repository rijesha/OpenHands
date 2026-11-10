---
name: gui-vm-testing
description: Verify a change by using the real application in a disposable GUI virtual machine (Windows or Linux desktop) instead of only running tests in the sandbox. Use when the user asks to test in a GUI VM, a full VM, or on a real desktop.
triggers:
  - gui vm
  - gui-vm-testing
  - test in a vm
  - full gui
---

# GUI VM testing

You can lease a disposable virtual machine with a real desktop, copy a build into it, and operate the application like a user: look at the screen, click, type, and record screenshot evidence. The `vm_*`, `app_*`, `desktop_*`, `record_step` and `submit_report` tools come from the `vm-harness` MCP server.

Build and run unit tests in your normal workspace first. Use the VM only to verify behavior a user would see.

## Workflow

1. **Understand the change.** Read the issue or PR. Write down the 3-6 user-visible behaviors to verify, plus one check that the app still starts cleanly. A repository may ship its own scenario in `.agents/skills/`; follow it when present.
2. **Lease the VM first, then build while it boots.** Call `vm_images`, then `vm_start` with exactly the image the user or the prompt named (a baseline role or a snapshot id; never swap in a different one because it looks more useful) and pass `context` exactly as the prompt gives it (`{repository, item, kind}`; it links the run to the issue or pull request, whose page then shows your screenshots), and carry on immediately: the first boot takes 1-3 minutes, so build the artifact in your workspace in the meantime (for a VS Code extension: `npx @vscode/vsce package`) and only then call `vm_wait_ready`. If `vm_images` or `vm_start` says there are no images, stop and tell the user to choose the data folder on the Test VMs page; do not keep retrying.
3. **Copy the build in** with `vm_put_file`. The host path must be inside your conversation workspace, so build or copy the artifact there (not into `/tmp`). It returns the guest path.
4. **Install and use the app through its GUI, like a user.** Take a `desktop_screenshot`, decide, then act. **Batch what you can**: `desktop_actions` runs a list of clicks / typing / keys and returns one screenshot at the end, so a whole dialog (click field, type, press Enter) is one call instead of six. Only batch steps whose targets you already know from the last screenshot, and look at the returned screenshot before the next batch. The screen is 1280x800 and coordinates are pixels. For VS Code (`vm_start` with the default `app: "vscode"`), prefer the DOM-level `app_snapshot` -> `app_actions` (click / type / press / wait_for in one call, ending with a fresh snapshot): open the Extensions view, use the `...` menu, _Install from VSIX..._, and enter the guest path. Refs go stale when the page changes, so batch only steps that do not reshuffle it. Run a menu or palette command with `app_command` and its exact title (for example `File: Open Folder...`); never type a title into the palette and press Enter, which runs the top fuzzy match. To open a project, prefer `vm_app_restart` with `folder`. When you know what you look for, `app_snapshot` with `match` returns only the matching lines and costs far fewer tokens. Key names are the same everywhere (`ctrl+shift+p`, `enter`). Use `desktop_*` only for what the page cannot show (native dialogs, UAC, a wedged window).
5. **Snapshot slow setup (optional).** If installing the project's tools took more than a few minutes, `vm_snapshot` saves the VM as a reusable image (this ends the lease; do not `vm_stop` after it) so the next run starts with that work done. Do it only when the user asked for it.
6. **Record as you go.** After each step call `record_step` with `capture: true` (it takes the screenshot and cites it for you; or pass a `desktop_capture` path). A step is `pass` only if you saw the expected result. Use `blocked` or `fail` honestly; retry a failing step at most twice.
7. **Finish.** Call `submit_report` exactly once (it is refused if `passed` contradicts your steps), then `vm_stop`. Always `vm_stop`, even after a failure, because leases are limited.
8. **Report** the verdict and the notable screenshots in your reply (and in the pull request description if you open one).

## Baselines

Four baselines exist: `windows` and `ubuntu` (clean machines, VS Code opens an empty workspace) and `windows-workspace` and `ubuntu-workspace` (a prepared Zephyr workspace, SDK and build; VS Code opens it). On a workspace baseline the workspace is part of the machine: do not delete or reset it. Snapshots are made only from a baseline or from a snapshot of one.

## Rules

- Do everything a user would do **through the GUI**. `vm_exec` is for inspecting state (logs, files, processes). By default it refuses installs and killing the app; do not look for a way around that.
- **Never claim something you did not see.** Environment problems (slow boot, network, VM glitch) go in `envProblems`, not in a product failure, unless the app handled them badly.
- Elevation prompts: `vm_wait_for` with `interruptOn: ["uac"]` (Windows) or `["sudo"]` (Linux) returns when one appears. Take a screenshot, then use `desktop_type_secret` to type the account password without seeing it.
- `desktop_type` types printable ASCII only. Prefer the app's own input fields and the command palette over terminals.
- **Not enough free RAM.** `vm_start` refuses at once and says how much is free and needed. Do not start more VMs: retry once with `waitForRam: true` (the lease then waits for memory, visible as the boot stage), or tell the user.
- **If the VM will not boot, stop.** The harness retries VS Code itself and enforces its own deadlines, so keep calling `vm_wait_ready` until the status is `ready` or `failed`; a slow stage is not a failure. Give up early only when `bootSeconds` passes 600. After a failure, do not start VMs in a loop: `vm_stop` it and try one more time at most. If a workspace baseline failed and the user did not insist on it, that retry may use the clean baseline of the same OS; say so in `envProblems`. Then continue the review without the VM, put the failure (stage and error text) in `envProblems` and say so in your reply. The boot screenshot and session details are saved as `boot-failure.png` and `boot-failure.txt` in the run folder.
- One lease is one clean machine. Do not assume state from an earlier VM.
