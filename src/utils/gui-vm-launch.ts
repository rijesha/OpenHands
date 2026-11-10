import type { PluginSpec } from "#/api/conversation-service/agent-server-conversation-service.types";
import { parseRuntimeServicesInfo } from "#/api/agent-server-adapter";

/** Name of the plugin (skill + MCP config) the VM harness publishes. */
export const GUI_VM_PLUGIN_NAME = "gui-vm-testing";

/**
 * The VM baseline a conversation may be told to test in. These are the harness's
 * baseline roles: a clean machine, or the same OS with the prepared Zephyr
 * workspace that VS Code opens.
 */
export type GuiVmTarget =
  "windows" | "windows-workspace" | "ubuntu" | "ubuntu-workspace";

export const GUI_VM_TARGETS: readonly GuiVmTarget[] = [
  "windows",
  "windows-workspace",
  "ubuntu",
  "ubuntu-workspace",
];

/** The guest OS of a baseline. */
export function guiVmTargetOs(target: GuiVmTarget): "windows" | "ubuntu" {
  return target.startsWith("windows") ? "windows" : "ubuntu";
}

const isWorkspaceTarget = (target: GuiVmTarget) =>
  target.endsWith("-workspace");

export function isGuiVmTarget(value: string): value is GuiVmTarget {
  return (GUI_VM_TARGETS as readonly string[]).includes(value);
}

/**
 * The harness plugin directory the agent-server can load, or null when the
 * backend does not advertise a running harness.
 */
export function getVmHarnessPluginPath(
  runtimeServices: unknown,
): string | null {
  const path =
    parseRuntimeServicesInfo(runtimeServices)?.services?.vm_harness
      ?.plugin_path;
  return typeof path === "string" && path.trim() ? path : null;
}

/** The plugin attached to a conversation that opted into GUI VM testing. */
export function buildGuiVmPlugin(pluginPath: string): PluginSpec {
  return { source: pluginPath, name: GUI_VM_PLUGIN_NAME };
}

const GUI_VM_LABEL: Record<"windows" | "ubuntu", string> = {
  windows: "Windows",
  ubuntu: "Ubuntu",
};

/**
 * Agent-facing instruction (not UI copy) to verify work in a GUI VM. It names
 * the tools and the skill explicitly: the agent has them only because the
 * conversation was started with the plugin, and the skill's keyword triggers
 * load it from this text.
 */
export function buildGuiVmVerification(
  target: GuiVmTarget,
  subject: string,
  origin?: GuiVmOrigin,
): string {
  const context = origin
    ? ` Pass \`context\` ${JSON.stringify(origin)} so the run is linked to its source.`
    : "";
  const workspace = isWorkspaceTarget(target)
    ? " This image already holds a prepared Zephyr workspace that VS Code opens: use it and do not delete or reset it."
    : "";
  return `Verify ${subject} in a full-GUI ${GUI_VM_LABEL[guiVmTargetOs(target)]} virtual machine using the ${GUI_VM_PLUGIN_NAME} skill: lease the VM first with \`vm_start\` (image "${target}") and build the application into your conversation workspace while it boots (\`vm_put_file\` only accepts files there), exercise it through its GUI with screenshot evidence for each step, submit the report, and always \`vm_stop\` the VM.${workspace}${context} If the VM will not boot, follow the skill's boot-failure rule instead of starting more. Quote the report verdict in your reply.`;
}

/** What a VM run is for, passed to `vm_start` as `context` so the Test VMs page can link back. */
export interface GuiVmOrigin {
  repository: string;
  item: string;
  /** Whether `item` is an issue or a pull request, so the run links to the right tab. */
  kind?: "issue" | "pull_request";
}

/** Appends the GUI VM instruction to a free-form message. */
export function withGuiVmInstruction(
  message: string,
  target: GuiVmTarget | undefined,
): string {
  if (!target) return message;
  const instruction = buildGuiVmVerification(target, "the result");
  return message
    ? `${message}

${instruction}`
    : instruction;
}
