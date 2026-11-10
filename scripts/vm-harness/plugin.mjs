import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_PREFIX } from "./config.mjs";

const TEMPLATE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "plugin-template",
);

/**
 * Renders the per-conversation plugin (skill + MCP server config) into `outDir` and returns its path.
 *
 * The agent-server loads this directory through `plugins: [{source: <path>}]` and merges its skill and `.mcp.json`
 * into that one conversation, so VM tools are only visible to conversations that opted in. The MCP client runs inside
 * the agent-server process on the host, so it talks to the harness on loopback directly (not through the ingress).
 *
 * @param {{ outDir: string, port: number, apiKey: string }} o
 */
export function renderPlugin({ outDir, port, apiKey }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(TEMPLATE_DIR, outDir, { recursive: true });
  const mcp = {
    mcpServers: {
      "vm-harness": {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Session-API-Key": apiKey },
        timeout: 180,
      },
    },
  };
  fs.writeFileSync(
    path.join(outDir, ".mcp.json"),
    `${JSON.stringify(mcp, null, 2)}\n`,
    { mode: 0o600 },
  );
  return outDir;
}

/** Fields the launcher advertises in `/server_info.runtime_services.services.vm_harness`. */
export function describeService({ pluginDir }) {
  return {
    description:
      "GUI VM test harness: disposable Windows/Linux VMs driven by screenshots, mouse and keyboard. Only conversations started with the 'gui-vm-testing' plugin get its tools.",
    api_prefix: API_PREFIX,
    plugin_path: pluginDir,
  };
}
