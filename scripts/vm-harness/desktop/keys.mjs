/** Maps combos like "ctrl+shift+p" to Windows virtual-key codes for Msvm_Keyboard Press/Type/Release. */
const MODIFIERS = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  super: 0x5b,
  meta: 0x5b,
};
const NAMED = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  insert: 0x2d,
};

/** @param {string} name */
export function keyCode(name) {
  const n = name.toLowerCase();
  if (n in MODIFIERS) return MODIFIERS[n];
  if (n in NAMED) return NAMED[n];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) return 0x6f + Number(n.slice(1));
  if (/^[a-z]$/.test(n)) return n.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(n)) return n.charCodeAt(0);
  throw new Error(`Unknown key: ${name}`);
}

/**
 * @param {string} combo
 * @returns {{ press: number[], type: number[], release: number[] }}
 */
export function parseCombo(combo) {
  const parts = combo
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Empty key combo");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => {
    if (!(m.toLowerCase() in MODIFIERS))
      throw new Error(`Not a modifier: ${m}`);
    return MODIFIERS[m.toLowerCase()];
  });
  return { press: mods, type: [keyCode(key)], release: [...mods].reverse() };
}

const PLAYWRIGHT_ALIASES = {
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  super: "Meta",
  win: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  pgup: "PageUp",
  pgdn: "PageDown",
};

/**
 * Spells a combo the way Playwright expects ("ctrl+shift+p" -> "Control+Shift+p"), so app_* and desktop_* tools
 * accept the same key syntax.
 * @param {string} combo
 */
export function toPlaywrightKey(combo) {
  const parts = String(combo)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Empty key combo");
  return parts
    .map((p) => {
      const alias = PLAYWRIGHT_ALIASES[p.toLowerCase()];
      if (alias) return alias;
      if (p.length === 1) return p.toLowerCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join("+");
}
