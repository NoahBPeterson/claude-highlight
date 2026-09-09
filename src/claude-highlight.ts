#!/usr/bin/env node
/** claude-highlight -- run Claude Code behind a PTY that colors epistemic markers.
 *
 * Spawns the real `claude` on a pseudo-terminal and forwards bytes both ways,
 * injecting SGR color around matched words on the way out.
 *
 * Two things differ from the Python original, both forced by the runtime and
 * both invisible from outside:
 *
 *   the select() loop is gone. Bun is event driven, so the master and stdin
 *   are pumped by worker threads (see pty.ts) and the idle branch -- the one
 *   that released held text and re-read the config -- is a 20 ms timer that
 *   stands down on any tick that carried data, which is exactly when
 *   select() would have returned early instead of timing out.
 *
 *   the paste queue is gone. It existed because a raw-mode pty accepts about
 *   a kilobyte per write and a blocking write would have stalled the reader;
 *   the write worker takes that stall on a thread of its own, in order.
 */
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { AnsiHighlighter } from "./highlight_filter.ts";
import { LEXICON, growablePrefixes, userPattern } from "./hedge_lexicon.ts";
import { ScreenModel } from "./screen_model.ts";
import { ptySpawn, type Pty } from "./pty.ts";
import { setRawStdin, sleepSync, which, winsize, writeAll } from "./sys.ts";
import { configFile, environ } from "./util.ts";
import type { Rewrite, Rule } from "./rules.ts";
import { isObject, parseJson, truthy, type Json, type JsonObject } from "./json.ts";

const DOC = `claude-highlight — run Claude Code behind a PTY that colors epistemic markers.

    claude-highlight [any claude args...]

Spawns the real \`claude\` on a pseudo-terminal and forwards bytes both ways,
injecting SGR color around matched words on the way out. Because SGR is
zero-width, the child's layout math is untouched — see highlight_filter.ts.

Hotkey (default F9, or bind cmd+/ in Ghostty — see README) opens a plugin
menu to toggle categories live. Config lives at
~/.config/claude-highlight/config.json and is re-read whenever it changes.
`;

export const CONFIG = configFile("claude-highlight");
const HOTKEY = "\x1b[20~";          // F9; Ghostty can map cmd+/ to send this
const PASTE_ON = "\x1b[200~";       // bracketed paste; hotkeys inside it are content
const PASTE_MARK = /\x1b\[20[01]~/g;   // ...and its 201~ close
const IDLE = 20;                    // short tick (ms): emit anything that cannot grow
const FORCE_IDLE = 300;             // long tick: give up waiting on a phrase
const REPAINT_IDLE = 500;           // quiet for this long: optional full repaint

// 256-color codes chosen to stay legible on both light and dark themes.
const DEFAULT_STYLES: Record<string, { color: string; on: boolean; desc: string }> = {
  inference:  { color: "38;5;203", on: true,  desc: "hedged claim (likely, probably)" },
  unknown:    { color: "38;5;170", on: true,  desc: "admitted gap (untested, can't verify)" },
  assumption: { color: "38;5;214", on: true,  desc: "unverified premise (assuming, in theory)" },
  appearance: { color: "38;5;179", on: true,  desc: "impression (seems, looks like)" },
  overclaim:  { color: "38;5;51",  on: true,  desc: "unearned certainty (obviously, clearly)" },
  modal:      { color: "38;5;33",  on: false, desc: "possibility (might, could be)" },
  vagueness:  { color: "38;5;99",  on: false, desc: "imprecision (roughly, several)" },
  softener:   { color: "38;5;105", on: false, desc: "hedge-after-the-fact (a bit, fairly)" },
};
/** The built-in categories, in the order the menu and the config file
 * present them. */
export const ORDER = Object.keys(DEFAULT_STYLES);

/** One category, after the config file has been merged over the defaults.
 *
 * A config file may put anything at all in these keys, so loadConfig coerces
 * each one to the type the rest of the wrapper can rely on -- `String()` and
 * Python's bool() semantics, applied once at the edge instead of at every
 * use. The index signature carries any other key the file had, so a hand
 * written config survives the rewrite that closing the menu performs.
 */
export interface CategoryCfg {
  color: string;
  on: boolean;
  desc: string;
  add: string[];
  [key: string]: Json;
}

/** A category of the user's own, from the config file's "custom" block. */
export interface CustomSpec {
  color: string;
  on: boolean;
  desc: string;
  terms: string[];
}

export interface Config {
  categories: Record<string, CategoryCfg>;
  custom: Record<string, CustomSpec>;
  annotations: boolean;
  // On-disk key names, so an existing config.json keeps working.
  prose_only: boolean;
  idle_repaint: boolean;
}

/** `add`/`terms` as a list of words. A bare string is one word, not one word
 * per character; anything else is treated as empty rather than allowed to
 * take the session down. */
function wordlist(x: Json | undefined): string[] {
  if (typeof x === "string") return [x];
  return Array.isArray(x) ? x.map(w => String(w)) : [];
}

/** A string from a config value of any shape, the way Python's f-string
 * would have rendered it. */
function text(v: Json | undefined, fallback: string): string {
  return v === undefined ? fallback : String(v);
}

export function loadConfig(): Config {
  const parsed = existsSync(CONFIG) ? parseJson(readFileSync(CONFIG, "utf8")) : null;
  // valid JSON, wrong shape: fall back rather than fail
  const user: JsonObject = isObject(parsed) ? parsed : {};
  const catsRaw = user["categories"];
  const cats: JsonObject = isObject(catsRaw) ? catsRaw : {};
  const customRaw = user["custom"];
  const customObj: JsonObject = isObject(customRaw) ? customRaw : {};

  const cfg: Record<string, CategoryCfg> = {};
  for (const cat of ORDER) {
    const dflt = DEFAULT_STYLES[cat]!;
    const specRaw = cats[cat];
    const spec: JsonObject = isObject(specRaw) ? specRaw : {};
    const on = spec["on"];
    cfg[cat] = {
      ...spec,                       // any other key the file carried
      color: text(spec["color"], dflt.color),
      on: on === undefined ? dflt.on : truthy(on),
      desc: text(spec["desc"], dflt.desc),
      add: wordlist(spec["add"]),
    };
  }
  // Whole categories of your own, with their own colour and toggle. An entry
  // that is not an object cannot describe a category, and -- unlike the
  // Python, which wrote it back out untouched -- is dropped here rather than
  // kept in a shape nothing can read.
  const custom: Record<string, CustomSpec> = {};
  for (const [name, specRaw] of Object.entries(customObj)) {
    if (!isObject(specRaw)) continue;
    const on = specRaw["on"];
    custom[name] = {
      color: text(specRaw["color"], "38;5;99"),
      on: on === undefined ? true : truthy(on),
      desc: text(specRaw["desc"], "custom"),
      terms: wordlist(specRaw["terms"]),
    };
    if (name in cfg) continue;
    cfg[name] = { ...custom[name]!, add: custom[name]!.terms };
  }
  const cfgAll: Config = {
    categories: cfg,
    custom,
    annotations: truthy(user["annotations"] ?? true),
    // Paint only where fg and bg are both default -- that is exactly
    // assistant prose. Set false if a theme gives prose an explicit
    // foreground and highlighting stops appearing entirely.
    prose_only: truthy(user["prose_only"] ?? true),
    // Belt-and-braces for stale highlights: force a full repaint once the
    // session goes quiet. screen_model.ts fixes them at the frame that
    // creates them, so this is off unless the model ever loses track.
    idle_repaint: truthy(user["idle_repaint"] ?? false),
  };
  if (!existsSync(CONFIG)) {
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(cfgAll, null, 2));
  }
  return cfgAll;
}

/** How the user invoked us, so the resume hint stays copy-pasteable.
 *
 * Python read this straight off sys.argv[0]; Bun resolves argv[1] through the
 * symlink first, so an install -- a link named `claude-highlight` pointing at
 * this file -- arrives here as the path to the built .js, and the name that
 * was typed is gone. The shell still has it in $_, so that is asked first;
 * the .js/.ts-stripped basename is the fallback for a $_ that is missing or
 * stale.
 *
 * Every candidate has to stat back to this very file before it is used, so a
 * wrong $_ can only cost us the fallback, never print a name that is not us.
 */
export function selfName(): string {
  const argv0 = process.argv[1] ?? "";
  const base = basename(argv0);
  const typed = process.env["_"];
  const candidates = [...(typed === undefined ? [] : [basename(typed)]),
                      base, base.replace(/\.[jt]s$/, "")];
  for (const name of candidates) {
    const found = which(name);
    if (!found) continue;
    try {
      // statSync throws if either path is gone, which is the normal case
      // when invoked by a bare name that PATH does not resolve to us.
      const a = statSync(found), b = statSync(resolve(argv0));
      if (a.ino === b.ino && a.dev === b.dev) return name;
    } catch {
      // not the same file, or not a file at all
    }
  }
  return argv0;
}

/** Claude Code's exit hint says `claude --resume <id>`, which would drop you
 * out of the wrapper. It prints on the normal screen after the alt screen
 * closes, at default fg/bg, so rewriting its length is safe there. */
export function buildRewrites(): Rewrite[] {
  return [{ pat: /\bclaude(?= --resume\b)/g, repl: toLatin1(selfName()) }];
}

/** A JS string carrying the UTF-8 bytes of `s`, one byte per char -- the form
 * every pattern and replacement in this pipeline is matched in. */
function toLatin1(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/** Built-in patterns for this category plus any words from config.
 *
 * A config word that will not compile is dropped rather than allowed to take
 * the session down; `--hl-selftest` lists anything rejected.
 */
export function categoryTerms(cat: string, c: CategoryCfg): [string[], string[]] {
  const terms: string[] = [...(LEXICON[cat] ?? [])];
  const bad: string[] = [];
  for (const word of c.add) {
    const frag = userPattern(word);
    try {
      new RegExp(frag);
    } catch {
      bad.push(word);
      continue;
    }
    terms.push(frag);
  }
  return [terms, bad];
}

/** Every config-supplied pattern, for the cross-chunk prefix set. */
export function userFragments(cfg: Config): string[] {
  const out: string[] = [];
  for (const [cat, c] of Object.entries(cfg.categories)) {
    out.push(...categoryTerms(cat, c)[0].slice((LEXICON[cat] ?? []).length));
  }
  return out;
}

export function rejectedTerms(cfg: Config): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [cat, c] of Object.entries(cfg.categories)) {
    const bad = categoryTerms(cat, c)[1];
    if (bad.length) out[cat] = bad;
  }
  return out;
}

/** Every fg parameter this wrapper injects.
 *
 * The screen model uses it to tell our colour from the child's: a cell
 * carrying one of these was painted here, and is ours to take back. Claude
 * Code writes truecolor (38;2;r;g;b) and never an indexed 38;5;n, so the two
 * sets do not collide -- verified across a 1.8 MB recorded session.
 */
export function paintPalette(cfg: Config): Set<string> {
  const out = new Set(Object.values(cfg.categories).map(c => c.color));
  out.add("38;5;203");          // the annotation rule's colour
  return out;
}

export function buildRules(cfg: Config): Rule[] {
  const rules: Rule[] = [];
  for (const [cat, c] of Object.entries(cfg.categories)) {
    if (!c.on) continue;
    const [terms] = categoryTerms(cat, c);
    if (!terms.length) continue;
    const pat = "\\b(?:" + terms.join("|") + ")\\b";
    rules.push({ pat: new RegExp(toLatin1(pat), "gi"),
                 style: Buffer.from(`\x1b[${c.color}m`, "latin1") });
  }
  if (cfg.annotations) {
    // [text](low certainty) -> color `text`, and paint the annotation in
    // the background color so it vanishes without freeing its cells.
    // Deleting the characters would desync the child's wrapping math.
    rules.push({ pat: /\[[^\]\n]{1,80}\]\((?:low certainty|assumed|unverified)\)/g,
                 style: Buffer.from("\x1b[38;5;203m", "latin1") });
  }
  return rules;
}

// Measured against 2.1.236: two TIOCSWINSZ calls back to back produce a redraw
// of exactly 0 bytes. The child coalesces the signals, reads the final size,
// finds it unchanged, and skips rendering. Holding the intermediate size for a
// moment makes it actually re-render (~4.9 KB emitted).
const REPAINT_HOLD = 80;

/** Force a full redraw by resizing away and back, with a real pause. */
function forceRepaint(pty: Pty, rows: number, cols: number): void {
  pty.resize(Math.max(rows - 1, 1), cols);
  sleepSync(REPAINT_HOLD);
  pty.resize(rows, cols);
}

// The overlay sits on top of a live TUI, so it has to announce itself as a
// different surface: its own background, a bright border, and a title bar.
// Truecolor and box-drawing glyphs are terminal capabilities, not OS features,
// but a Linux console or a non-UTF-8 locale has neither -- so both degrade
// rather than render as noise. Widths are identical either way.
const TRUECOLOR = ["truecolor", "24bit"].includes((process.env["COLORTERM"] ?? "").toLowerCase());
// Python read sys.stdout.encoding; the locale is where that came from, and an
// unset locale means UTF-8 on every platform this runs on.
const UNICODE = (process.env["LC_ALL"] || process.env["LC_CTYPE"] || process.env["LANG"] || "utf-8")
  .toLowerCase().replace(/-/g, "").includes("utf8");

const c_ = (trueSeq: string, indexed: string): string => (TRUECOLOR ? trueSeq : indexed);

const PANEL_BG = c_("48;2;38;42;64", "48;5;236");
const PANEL_FG = c_("38;2;205;212;232", "38;5;252");
const PANEL_DIM = c_("38;2;132;140;170", "38;5;245");
const BORDER_FG = c_("38;2;122;162;247", "38;5;75");
const TITLE_BG = c_("48;2;122;162;247", "48;5;75");
const TITLE_FG = c_("38;2;16;18;28", "38;5;235");
const SEL_BG = c_("48;2;64;74;112", "48;5;238");
const SEL_FG = c_("38;2;255;255;255", "38;5;255");
const SEL_BAR = c_("38;2;255;214;102", "38;5;221");

const G: Record<string, string> = UNICODE
  ? { tl: "╭", tr: "╮", bl: "╰", br: "╯",
      h: "─", v: "│", vsel: "┃",
      mark: " ▸ ", swatch: "██", up: "↑↓", dot: "·" }
  : { tl: "+", tr: "+", bl: "+", br: "+",
      h: "-", v: "|", vsel: "|",
      mark: " > ", swatch: "##", up: "up/dn", dot: "-" };

type Segment = [string, string | null];

/** Compose one panel row from (text, fg) segments, padded to width.
 *
 * Only foreground codes appear inside a row, so the row background set at
 * the start survives to the end and the panel reads as one solid block.
 */
function row(segments: readonly Segment[], width: number, bg: string): string {
  let out = `\x1b[${bg}m`;
  let used = 0;
  for (const [raw, fg] of segments) {
    if (used >= width) break;
    const text = raw.slice(0, width - used);   // clamp: a narrow terminal must not wrap
    used += text.length;
    out += (fg ? `\x1b[${fg}m` : "") + text;
  }
  return out + " ".repeat(Math.max(0, width - used)) + "\x1b[0m";
}

/** Render the panel as a list of styled lines (no cursor positioning). */
export function menuLines(cfg: Config, cols: number, sel: number): string[] {
  const w = Math.max(46, cols - 1);
  const inner = w - 2;
  const title = ` claude-highlight ${G["dot"]} plugins `;
  const lines = [
    row([[G["tl"]!, BORDER_FG], [title, null],
         [G["h"]!.repeat(Math.max(0, inner - title.length)), BORDER_FG],
         [G["tr"]!, BORDER_FG]], w, TITLE_BG + ";" + TITLE_FG),
  ];
  const cats = Object.keys(cfg.categories);
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i]!;
    const c = cfg.categories[cat]!;
    const selected = i === sel;
    const bg = selected ? SEL_BG : PANEL_BG;
    const fg = selected ? SEL_FG : PANEL_FG;
    lines.push(row([
      [selected ? G["vsel"]! : G["v"]!, selected ? SEL_BAR : BORDER_FG],
      [selected ? G["mark"]! : " ".repeat(G["mark"]!.length), selected ? SEL_FG : PANEL_DIM],
      [`[${c.on ? "on " : "off"}] `, fg],
      [G["swatch"]!, c.color],
      [` ${cat.padEnd(11)}`, fg],
      [c.desc, selected ? fg : PANEL_DIM],
    ], w - 1, bg) + `\x1b[${bg}m\x1b[${BORDER_FG}m` + G["v"] + "\x1b[0m");
  }
  const hint = ` ${G["up"]} move ${G["dot"]} space / enter toggle ` +
               `${G["dot"]} q / esc / F9 close `;
  lines.push(row([[G["bl"]!, BORDER_FG], [hint, TITLE_FG],
                  [G["h"]!.repeat(Math.max(0, inner - hint.length)), BORDER_FG],
                  [G["br"]!, BORDER_FG]], w, TITLE_BG));
  return lines;
}

/** Overlay drawn over the bottom rows; dismissed with a forced repaint. */
export function drawMenu(cfg: Config, rows: number, cols: number, sel: number): void {
  const lines = menuLines(cfg, cols, sel);
  const top = Math.max(rows - lines.length, 0);
  const out = ["\x1b7", "\x1b[?25l"];   // save cursor, hide it while the panel is up
  lines.forEach((text, i) => out.push(`\x1b[${top + i + 1};1H\x1b[2K` + text));
  out.push("\x1b8");                    // restore cursor
  writeAll(1, Buffer.from(out.join(""), "utf8"));
}

// Indexed colours only, deliberately: Claude Code paints exclusively in
// truecolor (89 distinct values in a capture, not one 38;5;n), so an indexed
// code is unambiguously ours -- which is what lets screen_model.ts tell a cell
// it painted from a cell the child painted. A 38;2;r;g;b of your own works, but
// pick one the child does not already use or the two become indistinguishable.
const PALETTE: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ["reds — loudest, for the claim you most want to catch",
   "inference", [203, 196, 202, 209, 167, 174, 210, 168]],
  ["pinks and magentas — loud but not alarming",
   "unknown", [170, 176, 177, 183, 213, 205, 141, 218]],
  ["ambers and yellows — warm, reads as 'check this'",
   "assumption", [214, 215, 220, 221, 222, 178, 136, 223]],
  ["golds and tans — quieter warmth, good for a busy category",
   "appearance", [179, 180, 187, 144, 137, 173, 143, 229]],
  ["cyans and teals — cold, opposite end from the reds",
   "overclaim", [51, 45, 44, 80, 87, 116, 73, 37]],
  ["greens", "unused — free for a category of your own",
   [71, 78, 108, 114, 150, 84, 42, 155]],
  ["blues and violets — cool, and nothing in warm prose competes with them",
   "modal, vagueness, softener", [33, 39, 99, 105, 27, 63, 93, 135]],
];

/** Every colour worth considering, painted, in the terminal that has to show
 * it. A swatch in a README is a swatch in someone else's theme. */
export function paletteLines(cfg: Config, cols: number, full = false): string[] {
  const out = ["", "  in use now"];
  for (const [cat, c] of Object.entries(cfg.categories)) {
    const state = c.on ? "on " : "off";
    out.push(`    \x1b[${c.color}m${cat.padEnd(11)}\x1b[0m ${state}  ` +
             `${c.color.padEnd(10)} ${c.desc}`);
  }
  out.push("", "  to change one, edit the config -- it is re-read live, so the next",
           "  line Claude Code prints already has the new colour:", "",
           `    ${CONFIG}`,
           '    { "categories": { "assumption": { "color": "38;5;220" } } }');
  const word = "mostly";
  const cell = word.length + 5;      // word, space, 3-wide code, space
  const perRow = Math.max(1, Math.floor((cols - 6) / cell));
  for (const [title, who, codes] of PALETTE) {
    out.push("", `  ${title}`, `    (${who})`);
    for (let i = 0; i < codes.length; i += perRow) {
      const line = codes.slice(i, i + perRow)
        .map(n => `\x1b[38;5;${n}m${word}\x1b[39m ${String(n).padEnd(3)} `).join("");
      out.push("    " + line);
    }
  }
  if (full) {
    out.push("", "  the whole 256-colour ramp");
    for (let base = 16; base < 256; base += 12) {
      let line = "";
      for (let n = base; n < Math.min(base + 12, 256); n++) {
        line += `\x1b[38;5;${n}m██\x1b[39m${String(n).padEnd(4)}`;
      }
      out.push("    " + line);
    }
  }
  out.push("");
  return out;
}

/** Push sample text through the real filter so the colors can be eyeballed.
 *
 * Each line reproduces the styling Claude Code uses for that kind of region,
 * so what you see here is what you get in a session.
 */
export function selftest(cfg: Config): number {
  const hl = new AnsiHighlighter(buildRules(cfg), cfg.prose_only);
  const samples: ReadonlyArray<readonly [string, string, string]> = [
    ["prose",        "", "It seems likely this is probably fine, assuming nothing breaks."],
    ["bold prose",   "\x1b[1m", "That seems untested and I can't verify it.\x1b[22m"],
    ["admissions",   "", "I can't test this for you; the result is unverified."],
    ["overclaim",    "", "Obviously this clearly works and definitely always will."],
    ["inline code",  "\x1b[38;2;177;185;249m", "it seems likely here\x1b[39m"],
    ["fenced code",  "\x1b[32m", "# it seems likely that this is code\x1b[39m"],
    ["user message", "\x1b[48;2;55;55;55m\x1b[38;2;255;255;255m",
                     "it seems likely this is what you typed\x1b[0m"],
  ];
  const out: Buffer[] = [
    Buffer.from("\n  claude-highlight self-test - top four lines should show color,", "latin1"),
    Buffer.from("  bottom three should be untouched.\n", "latin1"),
  ];
  for (const [label, prefix, text] of samples) {
    const body = Buffer.from(prefix + text, "latin1");
    out.push(Buffer.concat([Buffer.from(`  ${label.padEnd(13)}`, "latin1"),
                            hl.feed(body), hl.drain(), Buffer.from("\x1b[0m", "latin1")]));
  }
  out.push(Buffer.alloc(0));
  const bad = rejectedTerms(cfg);
  if (Object.keys(bad).length) {
    out.push(Buffer.from("  \x1b[38;5;203mrejected config words (invalid patterns):\x1b[39m", "latin1"));
    for (const [cat, words] of Object.entries(bad)) {
      out.push(Buffer.from(`    ${cat}: ${words.join(", ")}`, "utf8"));
    }
    out.push(Buffer.alloc(0));
  }
  for (const [cat, c] of Object.entries(cfg.categories)) {
    const state = c.on ? "on " : "off";
    const extra = c.add.length;
    const tag = extra ? `  +${extra} from config` : "";
    out.push(Buffer.from(`  \x1b[${c.color}m${cat.padEnd(11)}\x1b[0m ${state}  ${c.desc}${tag}`, "utf8"));
  }
  writeAll(1, Buffer.concat([joinBuf(out, "\n"), Buffer.from("\n", "latin1")]));
  return 0;
}

function joinBuf(parts: readonly Buffer[], sep: string): Buffer {
  const s = Buffer.from(sep, "latin1");
  const out: Buffer[] = [];
  parts.forEach((p, i) => { if (i) out.push(s); out.push(p); });
  return Buffer.concat(out);
}

interface Args {
  hlHelp: boolean;
  hlSelftest: boolean;
  hlMenu: boolean;
  hlPalette: string | null;
  hlRecord: string | null;
  rest: string[];
}

/** argparse's parse_known_args, for the five flags this actually has. Option
 * abbreviation is the one argparse feature not reproduced: `--hl-self` was
 * never a documented spelling. */
export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { hlHelp: false, hlSelftest: false, hlMenu: false,
                    hlPalette: null, hlRecord: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    if (name === "--hl-help") a.hlHelp = true;
    else if (name === "--hl-selftest") a.hlSelftest = true;
    else if (name === "--hl-menu") a.hlMenu = true;
    else if (name === "--hl-palette") {
      // nargs="?", const="curated": the value is optional, and a following
      // token is taken only when it is not itself an option.
      if (inline !== null) a.hlPalette = inline;
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) { a.hlPalette = next; i++; }
        else a.hlPalette = "curated";
      }
    } else if (name === "--hl-record") {
      if (inline !== null) a.hlRecord = inline;
      else if (argv[i + 1] !== undefined) { a.hlRecord = argv[i + 1]!; i++; }
    } else {
      a.rest.push(arg);
    }
  }
  return a;
}

/** The terminal's width, for the previews that run without a child. The
 * Python default was 100 rather than the 80 a pipe reports. */
function stdoutCols(): number {
  return process.stdout.columns || Number(process.env["COLUMNS"]) || 100;
}

export async function main(argv: readonly string[]): Promise<number> {
  const known = parseArgs(argv);
  if (known.hlHelp) {
    writeAll(1, Buffer.from(DOC + "\n", "utf8"));
    return 0;
  }

  let cfg = loadConfig();
  if (known.hlSelftest) return selftest(cfg);
  if (known.hlPalette) {
    writeAll(1, Buffer.from(paletteLines(cfg, stdoutCols(), known.hlPalette === "all").join("\n"), "utf8"));
    return 0;
  }
  if (known.hlMenu) {
    writeAll(1, Buffer.from("\n" + menuLines(cfg, stdoutCols(), 0).join("\n") + "\n\n", "utf8"));
    return 0;
  }

  let mtime = existsSync(CONFIG) ? statSync(CONFIG).mtimeMs : 0;
  const hl = new AnsiHighlighter(buildRules(cfg), cfg.prose_only);
  hl.rewrites = buildRewrites();
  hl.holdPrefixes = growablePrefixes(userFragments(cfg));
  const screen = new ScreenModel(24, 80, paintPalette(cfg));

  // CLAUDE_HIGHLIGHT_CMD exists so the wrapper can be exercised against a
  // stand-in program in tests without launching a real session.
  const child = process.env["CLAUDE_HIGHLIGHT_CMD"] ?? "claude";
  // Recording both sides is the only way to settle a rendering oddity after
  // the fact: .raw is what Claude Code emitted, .out is what we handed the
  // terminal. Replaying .raw through the filter reproduces .out exactly.
  const recRaw = known.hlRecord === null ? null : openSync(known.hlRecord + ".raw", "w");
  const recOut = known.hlRecord === null ? null : openSync(known.hlRecord + ".out", "w");

  let [rows, cols] = winsize();
  const pty = await ptySpawn(child, known.rest, { rows, cols, env: environ() });
  screen.resize(rows, cols);

  // Null when stdin is not a tty (tests, pipes), which is the degrade-to-
  // nothing path the Python original had.
  const restoreStdin = setRawStdin();

  process.on("SIGWINCH", () => {
    [rows, cols] = winsize();
    pty.resize(rows, cols);         // the kernel would have, given a session
    screen.resize(rows, cols);      // a signal handler here runs between turns
  });

  let menu = false, sel = 0, pendingIn = "", pasting = false;
  let repainted = true;             // nothing to clean up before any output
  let lastData = performance.now();
  let sawData = false;
  let stdinOpen = true;

  const emit = (out: Buffer): void => {
    if (!out.length) return;
    writeAll(1, out);
    if (recOut !== null) writeSync(recOut, out);
  };

  /** Dismiss the panel: restore the cursor, persist toggles, and force the
   * repaint that erases the overlay (the resize nudge needs the pause in the
   * middle to be seen by the child). */
  const closeMenu = (): void => {
    menu = false;
    screen.invalidate();
    writeAll(1, Buffer.from("\x1b[?25h", "latin1"));
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    mtime = statSync(CONFIG).mtimeMs;
    forceRepaint(pty, rows, cols);
  };

  pty.onData(data => {
    sawData = true;
    lastData = performance.now();
    repainted = false;
    if (recRaw !== null) writeSync(recRaw, data);
    if (!menu) {
      emit(screen.reconcile(hl.feed(data), hl.rules, hl.onlyUnstyled));
    } else {
      hl.feed(data);          // keep parser in sync; screen is ours
      screen.invalidate();    // ...and the model cannot see it
    }
  });

  const onStdin = (data: Buffer): void => {
    sawData = true;
    let buf = pendingIn + data.toString("latin1");
    pendingIn = "";

    if (menu) {
      if (buf.includes(PASTE_ON)) {
        // A paste while the panel is up closes it; the paste is delivered
        // rather than eaten as menu keys.
        closeMenu();
      } else {
        for (const key of buf.match(/\x1b\[[A-D]|[\s\S]/g) ?? []) {
          const cats = Object.keys(cfg.categories);
          if (key === "\x1b[A") sel = (sel - 1 + cats.length) % cats.length;
          else if (key === "\x1b[B") sel = (sel + 1) % cats.length;
          else if (key === " " || key === "\r" || key === "\n") {
            const cat = cats[sel]!;
            cfg.categories[cat]!.on = !cfg.categories[cat]!.on;
            hl.rules = buildRules(cfg);
          } else if (key === "q" || key === "\x1b") {
            closeMenu();
            break;
          }
        }
        if (menu) drawMenu(cfg, rows, cols, sel);
        return;
      }
    }

    // Inside a bracketed paste every byte is content. Without this a pasted
    // F9 sequence would be stripped from the text and pop the menu open
    // mid-paste. Markers are honoured in the order they appear, so a short
    // paste whose markers land in a single read is treated exactly like a
    // long one split across reads.
    // One stdin read becomes one write to the child, the way the Python's
    // to_child queue guaranteed: a read split across two writes reaches the
    // child as two reads, and a paste is only a paste if its markers and its
    // body arrive together.
    const toChild: string[] = [];
    let pos = 0, opened = false;
    PASTE_MARK.lastIndex = 0;
    for (const m of buf.matchAll(PASTE_MARK)) {
      let seg = buf.slice(pos, m.index);
      if (!pasting && seg.includes(HOTKEY)) {
        seg = seg.split(HOTKEY).join("");
        opened = true;
      }
      toChild.push(seg + m[0]);
      pasting = m[0] === PASTE_ON;
      pos = m.index + m[0].length;
    }
    buf = buf.slice(pos);
    if (!pasting && buf.includes(HOTKEY)) {
      buf = buf.split(HOTKEY).join("");
      opened = true;
    }
    if (opened) {
      menu = true;
      sel = 0;
      screen.invalidate();
      drawMenu(cfg, rows, cols, sel);
    }
    // A hotkey split across reads: hold a possible prefix.
    for (let n = 1; n < (pasting ? 0 : HOTKEY.length); n++) {
      if (buf.endsWith(HOTKEY.slice(0, n))) {
        pendingIn = buf.slice(buf.length - n);
        buf = buf.slice(0, buf.length - n);
        break;
      }
    }
    if (buf) toChild.push(buf);
    if (toChild.length) pty.write(Buffer.from(toChild.join(""), "latin1"));
  };

  // Reading stdin needed a worker thread while the pty was hand-rolled; as a
  // plain stream it is the same call on both runtimes.
  process.stdin.on("data", (chunk: Buffer) => { if (stdinOpen) onStdin(chunk); });
  process.stdin.on("end", () => { stdinOpen = false; });
  process.stdin.resume();

  // The idle branch of the select loop: it ran when nothing was readable, so
  // a tick that carried data stands down and lets the next one do the work.
  const tick = (): void => {
    if (sawData) { sawData = false; return; }
    const now = performance.now();
    emit(screen.reconcile(hl.drain(now - lastData > FORCE_IDLE), hl.rules, hl.onlyUnstyled));
    if (cfg.idle_repaint && !menu && !repainted && now - lastData > REPAINT_IDLE) {
      repainted = true;
      forceRepaint(pty, rows, cols);
    }
    if (existsSync(CONFIG) && statSync(CONFIG).mtimeMs !== mtime) {
      mtime = statSync(CONFIG).mtimeMs;
      cfg = loadConfig();
      hl.rules = buildRules(cfg);
      hl.onlyUnstyled = cfg.prose_only;
      hl.holdPrefixes = growablePrefixes(userFragments(cfg));
      hl.rewrites = buildRewrites();
      screen.palette = paintPalette(cfg);
    }
  };
  const timer = setInterval(tick, IDLE);

  await pty.drained;
  clearInterval(timer);
  process.stdin.pause();
  restoreStdin?.();
  try {
    emit(hl.drain(true));
  } catch {
    // the terminal is gone; nothing left to say to it
  }
  const code = await pty.exited;
  pty.destroy();
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
