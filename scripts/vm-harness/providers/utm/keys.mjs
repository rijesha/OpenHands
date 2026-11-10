/**
 * Key tables for UTM guests: QEMU qcodes (QMP input-send-event, used for QEMU guests) and X11 keysyms (RFB KeyEvent,
 * used for macOS guests over Screen Sharing). Both take the shared combo syntax ("ctrl+shift+p", "cmd+space").
 */

/** Modifier name -> [qcode, keysym]. "meta"/"cmd"/"win"/"super" are the Super (Windows/Command) key. */
const MODIFIERS = {
  ctrl: ["ctrl", 0xffe3],
  control: ["ctrl", 0xffe3],
  shift: ["shift", 0xffe1],
  alt: ["alt", 0xffe9],
  option: ["alt", 0xffe9],
  win: ["meta_l", 0xffeb],
  super: ["meta_l", 0xffeb],
  meta: ["meta_l", 0xffeb],
  cmd: ["meta_l", 0xffeb],
  command: ["meta_l", 0xffeb],
};

/** Named key -> [qcode, keysym]. */
const NAMED = {
  enter: ["ret", 0xff0d],
  return: ["ret", 0xff0d],
  tab: ["tab", 0xff09],
  esc: ["esc", 0xff1b],
  escape: ["esc", 0xff1b],
  space: ["spc", 0x20],
  backspace: ["backspace", 0xff08],
  delete: ["delete", 0xffff],
  del: ["delete", 0xffff],
  up: ["up", 0xff52],
  down: ["down", 0xff54],
  left: ["left", 0xff51],
  right: ["right", 0xff53],
  home: ["home", 0xff50],
  end: ["end", 0xff57],
  pageup: ["pgup", 0xff55],
  pgup: ["pgup", 0xff55],
  pagedown: ["pgdn", 0xff56],
  pgdn: ["pgdn", 0xff56],
  insert: ["insert", 0xff63],
};

/** US layout: unshifted punctuation -> qcode, and shifted character -> unshifted base character. */
const PUNCT = {
  "-": "minus",
  "=": "equal",
  "[": "bracket_left",
  "]": "bracket_right",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave_accent",
  ",": "comma",
  ".": "dot",
  "/": "slash",
  " ": "spc",
};
const SHIFTED = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "~": "`",
  "<": ",",
  ">": ".",
  "?": "/",
};

function baseQcode(ch) {
  if (/^[a-z0-9]$/.test(ch)) return ch;
  return PUNCT[ch];
}

/**
 * The qcodes to hold for one printable ASCII character on a US layout (["shift", "a"] for "A").
 * @param {string} ch
 * @returns {string[]}
 */
export function charToQcodes(ch) {
  if (ch === "\n") return ["ret"];
  if (ch === "\t") return ["tab"];
  if (/^[A-Z]$/.test(ch)) return ["shift", ch.toLowerCase()];
  if (SHIFTED[ch]) return ["shift", baseQcode(SHIFTED[ch])];
  const q = baseQcode(ch);
  if (!q)
    throw new Error(`Cannot type ${JSON.stringify(ch)}: printable ASCII only`);
  return [q];
}

/**
 * The keysym for one printable ASCII character (VNC servers apply shift themselves for keysyms).
 * @param {string} ch
 */
export function charToKeysym(ch) {
  if (ch === "\n") return 0xff0d;
  if (ch === "\t") return 0xff09;
  const c = ch.charCodeAt(0);
  if (ch.length !== 1 || c < 0x20 || c > 0x7e)
    throw new Error(`Cannot type ${JSON.stringify(ch)}: printable ASCII only`);
  return c;
}

function splitCombo(combo) {
  const parts = String(combo)
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Empty key combo");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => {
    const mod = MODIFIERS[m.toLowerCase()];
    if (!mod) throw new Error(`Not a modifier: ${m}`);
    return mod;
  });
  return { key, mods };
}

function namedOrSingle(key) {
  const n = key.toLowerCase();
  if (NAMED[n]) return NAMED[n];
  if (MODIFIERS[n]) return MODIFIERS[n];
  if (/^f([1-9]|1[0-2])$/.test(n)) return [n, 0xffbe + Number(n.slice(1)) - 1];
  if (key.length === 1) {
    const ch = key.toLowerCase();
    const q = baseQcode(ch);
    if (q) return [q, ch.charCodeAt(0)];
  }
  throw new Error(`Unknown key: ${key}`);
}

/**
 * "ctrl+shift+p" -> qcodes pressed in order and released in reverse.
 * @param {string} combo
 * @returns {string[]}
 */
export function comboToQcodes(combo) {
  const { key, mods } = splitCombo(combo);
  return [...mods.map((m) => m[0]), namedOrSingle(key)[0]];
}

/**
 * "cmd+space" -> keysyms pressed in order and released in reverse.
 * @param {string} combo
 * @returns {number[]}
 */
export function comboToKeysyms(combo) {
  const { key, mods } = splitCombo(combo);
  return [...mods.map((m) => m[1]), namedOrSingle(key)[1]];
}
