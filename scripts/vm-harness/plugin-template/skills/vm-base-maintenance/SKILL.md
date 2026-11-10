---
name: vm-base-maintenance
description: Change a golden base VM image (install tools, settings) on the user's instruction, then save the result as a new base revision. Use only when the user asks to change, update or maintain a base or golden VM image.
triggers:
  - golden image
  - base image
  - vm base
  - vm-base-maintenance
---

# Changing a golden base image

Base images are sealed and shared by every test run, so they change only when the user asks for it in the Test VMs window. The user has opened the named base for changes for a limited time; `vm_start` with `purpose: "base-edit"` is refused otherwise, and you must not look for a way around that.

## Workflow

1. **Confirm the request.** There are four baselines (`windows`, `windows-workspace`, `ubuntu`, `ubuntu-workspace`). A change to a workspace baseline must leave its workspace (west workspace, SDK, project, build) intact. Restate which base you are changing and what the change is. If the request is vague or could break existing runs (removing tools, changing the user account, upgrading the OS), ask before starting.
2. **Boot it for editing.** `vm_start` with `image` = the base image id and `purpose: "base-edit"`, then `vm_wait_ready`. This VM allows installs through `vm_exec`; the app tools are off.
3. **Make only the requested change.** Prefer the vendor's installer or the OS package manager. Keep the change small and note exactly what you ran.
4. **Verify it.** Check the new tool or setting works (version command, a quick launch with `desktop_screenshot`). Look for leftovers: reboot prompts, pending updates, large temp files; clean them up.
5. **Save a new revision.** `vm_save_base` with a short `name` and `notes` listing exactly what changed. This creates a NEW revision of the base; the old one is untouched and the new one becomes the newest base for that OS. The VM is gone after it, so do not call `vm_stop`.
6. **If it went wrong,** call `vm_stop` instead (nothing is saved) and tell the user what failed.

## Rules

- Never save a revision the user did not ask for, and never save one you did not verify.
- Do not change the guest account, the SSH setup or the VS Code launch task: the harness depends on them.
- Report the new image id and the change notes in your reply.
