# VM harness

Leases disposable full-GUI VMs to OpenHands agents so they can verify a change by using the real application (screenshots, mouse, keyboard) instead of only running tests in the default sandbox. It replaces the zephyr-ide `tools/ai-qa` tool's VM layer.

Status: **Hyper-V on Windows** (Windows 11 and Ubuntu guests from ai-qa golden images). UTM on macOS and macOS/ARM guests are planned; the provider contract is in `providers/hyperv/provider.mjs`.

## Setup (Windows)

1. Hyper-V enabled, your user in the "Hyper-V Administrators" group, PowerShell 7 (`pwsh`) and the OpenSSH client on `PATH`.
2. Choose the data folder in the Test VMs page (**Data folder**: type a path or use Browse). It must hold `images/`, `secrets/guest_ed25519` (+ `guest-creds.json` with `{"password": "..."}`) and room for VMs; to reuse the ai-qa images pick `D:zide-ai-qa`. The choice is saved in `~/.openhands/vm-harness-settings.json` and wins over the `VM_HARNESS_ROOT` environment variable, which is now only the fallback.
3. `node scripts/vm-harness/cli.mjs doctor` should print `ok` for every check.
4. Start Canvas as usual (`npm run dev`). On Windows with `pwsh` the harness starts automatically; pass `--no-vm-harness` (or `OH_VM_HARNESS=0`) to turn it off, or `--vm-harness` to force it on elsewhere.
5. Open **Test VMs** in the sidebar (`/test-vms`). It is a built-in page, offered whenever the backend advertises the harness, so there is nothing to install. An earlier version shipped it as a Canvas App: uninstall a "Test VMs" app from Customize → Apps if you added one.

## Building images (replaces `ai-qa images`)

Sealed golden images are what run VMs boot from (differencing disks). Existing ai-qa images work as they are. To make a new one:

1. `node scripts/vm-harness/cli.mjs images create-vm --os windows --iso D:\isos\Win11.iso` creates the empty VM under `<root>\imagesuild`.
2. Start it in Hyper-V Manager, install the OS by hand (local user `zide`), copy `scripts/vm-harness/images/` into the guest and run the provision script for the OS (`images/windows/provision.ps1` or `images/ubuntu/provision.sh`; they take the public half of `secrets/guest_ed25519`). Reboot and run the matching `validate` script. These recipes are carried over unchanged from ai-qa, including the VS Code, SSH and launch-task setup the harness relies on.
3. `node scripts/vm-harness/cli.mjs images seal --os windows --vm vmh-golden-windows --os-build ... --edition ... --vscode-version ... --vscode-commit ... --ssh-fingerprint SHA256:... --provision-sha ...` shuts the VM down and moves the disk into `images/` as a read-only sealed image.
4. `images list` shows what the harness can boot.

## The four baselines

Everything starts from one of four **baselines**, named by role in `images/current.json` (ai-qa's role -> image id map; `<os>-prepared` is read as `<os>-workspace`):

| Role | What it is |
|---|---|
| `windows`, `ubuntu` | Clean machines. VS Code opens an empty workspace, which is wiped on every boot. |
| `windows-workspace`, `ubuntu-workspace` | The same OS with a prepared Zephyr workspace (west workspace, SDK, project, build). The workspace is **kept** on boot: any prepared image or snapshot keeps its workspace, only clean bases start empty. |

`vm_start image=<role>` and the Canvas Test environment dropdown use these roles. Snapshots can only be saved from a baseline or from a snapshot descended from one; other images show under **Other images** on the Test VMs page and can be deleted. `vm_save_base` on a workspace baseline makes a new revision that stays a prepared image and becomes that role's baseline.

## Snapshots and images

The Test VMs page keeps two lists apart.

**Base images** (golden) are the clean, sealed machines every run starts from. They are **locked**: the API refuses to rename or delete one (HTTP 403) and an agent cannot boot one for editing. The only way to change a base is **Change this base** in the Test VMs window: describe the change in its chat bar and the page opens that base for 60 minutes (`POST /images/:id/unlock`; **Lock now** closes it early) and hands the request to an agent conversation with the `vm-base-maintenance` skill, which boots it with `vm_start purpose=base-edit` and finishes with `vm_save_base`. The result is always a **new base revision** (a child of the old one, nested under it, newest for its OS, locked again); the old base is never modified, and deleting the new revision rolls back.

**Snapshots** are saved states of a running VM and can be renamed or deleted freely. Per image: **Start VM**, **Edit** (display name and notes) and **Delete** (two-click confirm; refused while an image depends on it or a VM is running from it, and the disk is only removed if it lives in `images/`).

To make a snapshot, start a VM from an image, set it up (install the tools, sign in), then use **Save snapshot** on the running VM or let the agent call `vm_snapshot`. The guest is shut down cleanly and its differencing disk is kept as a read-only child of the base image, so a snapshot only stores what changed. Later runs boot it with `vm_start image=<snapshot id>`. A snapshot depends on its base image's disk, so keep the base while snapshots exist.

## Screenshots

The same report, steps and gallery appear on the **GitHub page**, under **GUI test runs** on the issue or pull request the agent was told to test (the run is matched by the `context` repository and item the prompt passes to `vm_start`). The newest run starts open, so a finished review shows its screenshots without leaving the pull request; **Open test run** goes to the run's own page, which links back to the item. A VM that is still running for the item is listed with its live screen.

Open a run from **Recent test runs** for a gallery of all its screenshots: filter to the ones cited by steps or by failed steps, click a thumbnail for the full-size view, and move with the arrow keys (Esc closes; Actual size toggles 1:1). Each screenshot shows the recorded step it is evidence for.

## Using it

On the GitHub page or the home chat box, pick **Test environment → GUI VM: Windows / Ubuntu** before starting an agent. The conversation gets the `gui-vm-testing` plugin (skill + MCP tools `vm_*`, `app_*` (VS Code over CDP), `desktop_*`, `record_step`, `submit_report`). The default **Default sandbox** attaches nothing. The option is offered for every agent kind, including ACP agents such as Claude Code, but whether an ACP agent receives the plugin's MCP tools has not been verified (the SDK forwards `mcp_config` to ACP servers).

## Configuration

`VM_HARNESS_ROOT` (fallback for the GUI-chosen data folder), `VM_HARNESS_SETTINGS_FILE`, `VM_HARNESS_PORT` (18010), `VM_HARNESS_MAX_VMS` (2), `VM_HARNESS_LEASE_TTL_MIN` (90), `VM_HARNESS_MEMORY_MB` (6144), `VM_HARNESS_CPUS` (4), `VM_HARNESS_WORKSPACE_ROOTS`, `OH_CANVAS_SAFE_VM_HARNESS_PORT`.

## Not yet done

UTM provider, macOS guests, noVNC take-over, a `prepared` image builder (ai-qa `images prepare`; project-specific).

## When a VM will not start

A boot that fails keeps `boot.log` (stage timings), `boot-failure.png` and `boot-failure.txt` (launcher task state, user sessions, processes) in its run folder; `vm_wait_ready` reports `stageSeconds` and `bootSeconds`. `vm_start` refuses at once when the host has too little free memory and says how much is free and needed; retry once with `waitForRam: true` to queue instead. A lease that fails keeps its stage and error in `lease.json`, and the run list on the Test VMs page shows them (with the boot screenshot when there is one). Running leases show how long until the idle reaper stops them, with an **Extend** button, and a ready VM can be driven by hand: click the screenshot, or use the Type and Press key boxes under it.
