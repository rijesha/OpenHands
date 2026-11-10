import { restartVsCode } from "../guest/ops.mjs";
import { toPlaywrightKey } from "../desktop/keys.mjs";

/** Port VS Code's `--remote-debugging-port` listens on inside the guest. */
export const VSCODE_CDP_PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SNAPSHOT = 30_000;

/**
 * Drives VS Code's own UI (menus, command palette, webviews) over the Chrome
 * DevTools Protocol, reached through an SSH port forward. This sees the DOM,
 * so it is more reliable than clicking pixels. Native OS dialogs and UAC prompts
 * are outside the page: use the desktop_* tools for those.
 *
 * `playwright-core` is imported lazily so the rest of the harness runs without
 * it, and tests can inject `chromium`.
 */
export class VsCodeDriver {
  /**
   * @param {{ ssh: any, ops: any, chromium?: any, workbenchTimeoutMs?: number }} o
   */
  constructor({ ssh, ops, chromium, workbenchTimeoutMs = 60_000 }) {
    this.ssh = ssh;
    this.ops = ops;
    this.chromiumOverride = chromium;
    this.workbenchTimeoutMs = workbenchTimeoutMs;
    this.forward = null;
    this.browser = null;
    this.page = null;
  }

  async #chromium() {
    if (this.chromiumOverride) return this.chromiumOverride;
    const { chromium } = await import("playwright-core");
    return chromium;
  }

  /** Polls the forwarded debugging port until the workbench window has rendered. */
  async #waitForWorkbench(localPort) {
    const deadline = Date.now() + this.workbenchTimeoutMs;
    let last = "no workbench page yet";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${localPort}/json/list`, {
          signal: AbortSignal.timeout(3000),
        });
        const pages = await res.json();
        const wb = pages.find(
          (p) =>
            p.type === "page" &&
            /workbench\.html/.test(p.url) &&
            /Visual Studio Code/.test(p.title),
        );
        if (wb) return;
        last = `pages: ${pages.map((p) => p.title || p.url).join(" | ")}`;
      } catch (e) {
        last = String(e?.message ?? e);
      }
      await sleep(1500);
    }
    throw new Error(`VS Code workbench did not finish loading (${last})`);
  }

  /** Connects (once) and returns the workbench page. */
  async ensure() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.forward) {
      this.forward = await this.ssh.forwardLocal({
        remotePort: VSCODE_CDP_PORT,
      });
    }
    await this.#waitForWorkbench(this.forward.localPort);
    const chromium = await this.#chromium();
    this.browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${this.forward.localPort}`,
    );
    const pages = this.browser.contexts().flatMap((c) => c.pages());
    const page = (
      await Promise.all(
        pages.map(async (p) =>
          (await p.title()).includes("Visual Studio Code") ? p : null,
        ),
      )
    ).find(Boolean);
    if (!page)
      throw new Error(
        "VS Code is running but its window was not found over CDP",
      );
    this.page = page;
    return page;
  }

  /**
   * Accessibility snapshot with `[ref=eN]` handles for app_click / app_type.
   * @param {{ maxChars?: number, match?: string }} [opts] match keeps only the lines containing that text.
   */
  async snapshot({ maxChars = MAX_SNAPSHOT, match } = {}) {
    const page = await this.ensure();
    let text = await page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
    if (match) {
      // Keep only the lines naming what the caller looks for; each keeps its [ref=..] so it stays clickable.
      const needle = String(match).toLowerCase();
      const lines = text
        .split("\n")
        .filter((l) => l.toLowerCase().includes(needle));
      text = lines.length
        ? lines.join("\n")
        : `(no line contains '${match}'; take a full app_snapshot)`;
    }
    const limit = Math.min(Math.max(maxChars, 500), MAX_SNAPSHOT);
    return text.length > limit
      ? `${text.slice(0, limit)}\n...(truncated; narrow down with match or the command palette)`
      : text;
  }

  /** Clicks by ref; an element covered by a sash or scrolled out of view gets one scroll-and-force retry. */
  async click(ref) {
    const page = await this.ensure();
    const target = page.locator(`aria-ref=${ref}`);
    try {
      await target.click({ timeout: 10_000 });
    } catch (first) {
      try {
        await target.scrollIntoViewIfNeeded?.({ timeout: 3000 });
        await target.click({ timeout: 5000, force: true });
      } catch {
        throw first;
      }
    }
  }

  /**
   * Runs a command-palette command by its exact title. Typing a title and pressing Enter runs the top fuzzy match,
   * which can be a different command ("Open Folder" -> "Open Containing Folder"), so the row is chosen by name.
   */
  async runCommand(title) {
    const page = await this.ensure();
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type(title);
    const names = page.locator(
      ".quick-input-list .monaco-list-row .label-name",
    );
    await names.first().waitFor({ state: "visible", timeout: 5000 });
    const bare = (s) =>
      String(s)
        .trim()
        .toLowerCase()
        .replace(/(\.\.\.|…)$/, "");
    const all = (await names.allTextContents()).map((n) => n.trim());
    const index = all.findIndex((n) => bare(n) === bare(title));
    if (index < 0) {
      await page.keyboard.press("Escape");
      throw new Error(
        `No command titled '${title}'. Closest: ${all.slice(0, 6).join(" | ") || "none"}`,
      );
    }
    await names.nth(index).click({ timeout: 5000 });
  }

  /** Fills the referenced field, or types into whatever has focus when no ref is given. */
  async type(text, { ref, submit = false } = {}) {
    const page = await this.ensure();
    if (ref)
      await page.locator(`aria-ref=${ref}`).fill(text, { timeout: 10_000 });
    else await page.keyboard.type(text);
    if (submit) await page.keyboard.press("Enter");
  }

  async press(key) {
    const page = await this.ensure();
    await page.keyboard.press(toPlaywrightKey(key));
  }

  /** Waits for visible text; returns false on timeout instead of throwing. */
  async waitForText(text, timeoutMs) {
    const page = await this.ensure();
    try {
      await page
        .getByText(text)
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** Drops the connection (the window is about to be replaced) and relaunches VS Code. */
  async restart({ folder } = {}) {
    await this.#disconnect();
    await restartVsCode(this.ops, { cdpPort: VSCODE_CDP_PORT, folder });
  }

  async #disconnect() {
    this.page = null;
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  async close() {
    await this.#disconnect();
    await this.forward?.close().catch(() => undefined);
    this.forward = null;
  }
}
