#!/usr/bin/env node
/** Integration tests: the whole pipeline, wired the way claude-highlight wires it.
 *
 * Ported from test_integration.py -- same 187 checks, same order, same names.
 * They lock in observable behaviour end to end: filter + shadow screen + real
 * config-driven rules, driven with realistic Claude Code traffic *and*
 * deliberately hostile input.
 *
 *   1. golden prose: every category painted, in its own colour, at the right
 *      columns -- and nothing painted where the child carries a style.
 *   2. streaming: chunk splits, idle ticks, growable holds, EOF edges.
 *   3. screen operations: every mutating CSI hand-computed, corrections after
 *      each one, plus the adversarial versions (huge params, junk params,
 *      split sequences, invalid UTF-8, C0/C1 bytes, wrap edges).
 *   4. the input box: found, protected, degraded safely when it is not there.
 *   5. corrections mechanics: sync-block placement, the 4 KB cap and deferral,
 *      unpainting on category toggle, out-of-alt-screen pin.
 *   6. config matrix: merge rules, custom categories, bad patterns, and
 *      type-abusive config files that must never take a session down.
 *   7. fuzz: a generated session checked at every frame end, a hostile corpus,
 *      and random-byte streams that must never crash or hang.
 *
 * One deliberate divergence from the Python, invisible in the check names:
 * `random` is a seeded mulberry32 rather than the Mersenne Twister, so the
 * generated traffic differs run-for-run from Python's (trial counts and
 * structure are identical).
 *
 * Run: bun run test/test_integration.ts
 */
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { AnsiHighlighter } from "../src/highlight_filter.ts"
import * as HL from "../src/hedge_lexicon.ts"
import { ScreenModel, MAX_FIX, cellWidth } from "../src/screen_model.ts"
import type { Rewrite, Rule } from "../src/rules.ts"
import type { CategoryCfg, Config } from "../src/claude-highlight.ts"
import type { Json, JsonObject } from "../src/json.ts"
import { report, finish, B, visible } from "./harness.ts"

const TMP = mkdtempSync(join(tmpdir(), "hl-int-"))
process.env["XDG_CONFIG_HOME"] = TMP       // must precede loading the wrapper
// Dynamic, so the assignment above lands before CONFIG is resolved at the
// wrapper's module top level -- a static import would be hoisted past it.
const ch = await import("../src/claude-highlight.ts")

const CFG_PATH = join(TMP, "claude-highlight", "config.json")
const ORDER = ch.ORDER

// -- helpers ------------------------------------------------------------------

/** Python's str.encode(): UTF-8 bytes. `B` is the b"..." literal. */
const U = (s: string): Buffer => Buffer.from(s, "utf8")

/** Python's bytes.count: non-overlapping occurrences. */
function count(hay: Buffer, needle: Buffer): number {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n += 1
  return n
}

/** Python's bytes.replace, for the one caller that strips the sync marks. */
const noSync = (b: Buffer): Buffer => B(b.toString("latin1").split("\x1b[?2026").join(""))

// undefined is a legitimate operand here: a missing key and an absent value
// are exactly what several of these checks are asserting.
const same = (a: Json | undefined, b: Json | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const range = (a: number, b: number): number[] => {
  const out: number[] = []
  for (let i = a; i < b; i++) out.push(i)
  return out
}

/** Python's repr() of a bytes object -- two check names are built from it. */
function reprBytes(b: Buffer): string {
  let s = "b'"
  for (const c of b) {
    if (c === 0x5c) s += "\\\\"
    else if (c === 0x27) s += "\\'"
    else if (c === 0x09) s += "\\t"
    else if (c === 0x0a) s += "\\n"
    else if (c === 0x0d) s += "\\r"
    else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c)
    else s += "\\x" + c.toString(16).padStart(2, "0")
  }
  return s + "'"
}

/** Python's repr() of a bool / an (x, y) tuple, for the same check names. */
const pyBool = (v: boolean): string => (v ? "True" : "False")
const pyTuple = (v: readonly number[]): string => "(" + v.join(", ") + ")"

const frame = (body: Buffer): Buffer =>
  Buffer.concat([B("\x1b[?2026h"), body, B("\x1b[?2026l")])

/** loadConfig() against a deterministic file: defaults, or `user` JSON. */
function freshCfg(user?: string | JsonObject): Config {
  if (existsSync(CFG_PATH)) unlinkSync(CFG_PATH)
  if (user !== undefined) {
    mkdirSync(dirname(CFG_PATH), { recursive: true })
    writeFileSync(CFG_PATH, typeof user === "string" ? user : JSON.stringify(user))
  }
  return ch.loadConfig()
}

function allOn(cfg: Config): Config {
  for (const c of Object.values(cfg.categories)) c.on = true
  return cfg
}

const paint = (cfg: Config, cat: string): Buffer =>
  B(`\x1b[${(cfg.categories[cat] as CategoryCfg).color}m`)

type Run = (data: Buffer, tick?: boolean) => Buffer
type Force = (data?: Buffer) => Buffer

interface PipeOpts {
  cfg?: Config
  rows?: number
  cols?: number
  rewrites?: readonly Rewrite[]
  rules?: Rule[]
  /** "auto" computes growable prefixes; null disables holding. */
  pfx?: Set<string> | null | "auto"
  pal?: Set<string>
}

/** Filter + shadow screen, wired exactly like the wrapper's main loop. */
function pipeline(o: PipeOpts = {}): [Run, Force, AnsiHighlighter, ScreenModel] {
  const cfg = o.cfg ?? allOn(freshCfg())
  const hl = new AnsiHighlighter(o.rules ?? ch.buildRules(cfg), cfg.prose_only)
  const pfx = o.pfx === undefined ? "auto" : o.pfx
  hl.holdPrefixes = pfx === "auto" ? HL.growablePrefixes(ch.userFragments(cfg)) : pfx
  hl.rewrites = [...(o.rewrites ?? [])]
  const scr = new ScreenModel(o.rows ?? 24, o.cols ?? 80, o.pal ?? ch.paintPalette(cfg))

  const run: Run = (data, tick = false) => {
    let out = scr.reconcile(hl.feed(data), hl.rules, hl.onlyUnstyled)
    if (tick) out = Buffer.concat([out, scr.reconcile(hl.drain(false), hl.rules, hl.onlyUnstyled)])
    return out
  }
  const force: Force = (data = Buffer.alloc(0)) =>
    Buffer.concat([scr.reconcile(hl.feed(data), hl.rules, hl.onlyUnstyled),
      scr.reconcile(hl.drain(true), hl.rules, hl.onlyUnstyled)])

  return [run, force, hl, scr]
}

/** Cells carrying a colour their text no longer justifies (all rows). */
function stale(scr: ScreenModel, rules: readonly Rule[]): number {
  let n = 0
  for (let y = 0; y < scr.rows; y++) {
    if (!scr.ours[y]!.some(v => v)) continue
    const want = scr.desired(y, rules, true)
    for (let x = 0; x < scr.cols; x++) {
      if (scr.ours[y]![x] && scr.fg[y]![x] !== want[x]) n += 1
    }
  }
  return n
}

const ours = (scr: ScreenModel, y: number): number[] => {
  const out: number[] = []
  for (let x = 0; x < scr.cols; x++) if (scr.ours[y]![x]) out.push(x)
  return out
}

const rowtext = (scr: ScreenModel, y: number): string =>
  scr.chars[y]!.map(c => (c ? c : " ")).join("").replace(/\s+$/u, "")

const anyOurs = (scr: ScreenModel, y: number): boolean => scr.ours[y]!.some(v => v)

const RULES_OP: Rule[] = [{ pat: /\bmostly\b/gi, style: B("\x1b[38;5;214m") }]
const OP_PAL = new Set(["38;5;214"])
const PAINT_OP = B("\x1b[38;5;214mthe tests mostly pass\x1b[39m")

function opModel(rows = 6, cols = 40, alt = true): ScreenModel {
  const m = new ScreenModel(rows, cols, OP_PAL)
  m.reconcile(Buffer.concat([alt ? B("\x1b[?1049h") : Buffer.alloc(0),
    frame(Buffer.concat([B("\x1b[1;1H"), PAINT_OP]))]), RULES_OP, true)
  return m
}

// == 1. golden prose ==========================================================

let cfg: Config = allOn(freshCfg())
const INF = paint(cfg, "inference"), UNK = paint(cfg, "unknown"),
  ASSUM = paint(cfg, "assumption"), APPEAR = paint(cfg, "appearance"),
  OVER = paint(cfg, "overclaim")
const MODAL = paint(cfg, "modal"), VAGUE = paint(cfg, "vagueness"),
  SOFT = paint(cfg, "softener")

let [run, force, hl, scr] = pipeline({ cfg })
let out = force(frame(B("\x1b[1;1HIt seems likely that this is probably fine.")))
report("golden: three markers painted in their own colours",
  out.includes(Buffer.concat([APPEAR, B("seems")]))
  && out.includes(Buffer.concat([INF, B("likely")]))
  && out.includes(Buffer.concat([INF, B("probably")])), out)
report("golden: paint restores fg only (39m), never 0m",
  count(out, Buffer.concat([APPEAR, B("seems\x1b[39m")])) === 1
  && !out.includes(B("\x1b[0m")), out)
report("golden: painted columns are exactly the marker words",
  same(ours(scr, 0), [...range(3, 8), ...range(9, 15), ...range(29, 37)]),
  ours(scr, 0))
report("golden: no stale paint at the frame end", stale(scr, hl.rules) === 0)

;[run, force, hl, scr] = pipeline({ cfg: allOn(freshCfg()) })
out = force(frame(B("\x1b[1;1HIt might be, roughly a bit more or less, kind of fine.")))
report("golden: off-by-default categories paint when switched on",
  out.includes(Buffer.concat([MODAL, B("might")]))
  && out.includes(Buffer.concat([VAGUE, B("roughly")]))
  && out.includes(Buffer.concat([SOFT, B("a bit")])), out)
report("golden: overlap resolved by rule order (vagueness claims 'more or less')",
  out.includes(Buffer.concat([VAGUE, B("more or less")]))
  && !out.includes(Buffer.concat([SOFT, B("more or less")])), out)

;[run, force, hl, scr] = pipeline({ cfg: freshCfg() })   // defaults: modal/vague/soft off
out = force(frame(B("\x1b[1;1HIt might be roughly a bit odd, perhaps.")))
report("golden: default config leaves modal/vagueness/softener unpainted",
  !noSync(out).includes(B("38;5;")), out)

;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(B("\x1b[1;1H(Likely?) [probably,] obviously\x1b[2J ok")))
report("golden: case-insensitive, boundaries at punctuation",
  out.includes(Buffer.concat([INF, B("Likely")]))
  && out.includes(Buffer.concat([INF, B("probably")]))
  && out.includes(Buffer.concat([OVER, B("obviously")])), out)
report("golden: trailing space never painted",
  force(frame(B("\x1b[1;1Hmostly  fine")))
    .includes(Buffer.concat([ASSUM, B("mostly\x1b[39m ")])),
  force(frame(B("\x1b[1;1Hmostly  fine"))))

// annotations
;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(B("\x1b[1;1HThe claim [is sound](low certainty) holds.")))
report("annotations: [text](low certainty) painted whole",
  out.includes(B("\x1b[38;5;203m[is sound](low certainty)")), out)
out = force(frame(Buffer.concat([B("\x1b[1;1H["), B("x".repeat(80)), B("](low certainty)")])))
report("annotations: 80-char text accepted at the cap",
  out.includes(B("\x1b[38;5;203m[")), out)
out = force(frame(Buffer.concat([B("\x1b[1;1H["), B("x".repeat(81)), B("](low certainty)")])))
report("annotations: 81 chars refused", !out.includes(B("38;5;203")), out)
out = force(frame(B("\x1b[1;1H[a [b](low certainty) and (low certainty) alone")))
report("annotations: nested bracket matches outer-first; bare suffix does not",
  out.includes(B("\x1b[38;5;203m[a [b](low certainty)"))
  && !out.includes(B("38;5;203m(low certainty)")), out)
out = force(frame(B("\x1b[1;1H\x1b[32m[mostly](low certainty)\x1b[39m")))
report("annotations: suppressed inside code colour", !out.includes(B("38;5;203")), out)
const noann = freshCfg({ annotations: false })
;[run, force, hl, scr] = pipeline({ cfg: noann })
out = force(frame(B("\x1b[1;1H[mostly](low certainty)")))
report("annotations: disabled by config", !out.includes(B("38;5;203")), out)

// == 2. regions the wrapper must not paint ====================================

;[run, force, hl, scr] = pipeline({ cfg })
out = force(Buffer.concat([B("\x1b[?1049h"), frame(B(
  "\x1b[1;1H\x1b[32mif (probably) then likely\x1b[39m"                 // fenced-code colour
  + "\x1b[2;1H\x1b[38;2;177;185;249mit seems likely inline\x1b[39m"    // inline code
  + "\x1b[3;1H\x1b[48;2;55;55;55m\x1b[38;2;255;255;255mit seems likely typed\x1b[0m"))]))
report("regions: code colour, inline code and user message all skipped",
  !noSync(out).includes(B("38;5;")), out)
report("regions: nothing ours anywhere on those rows",
  ![0, 1, 2].some(y => anyOurs(scr, y)), ours(scr, 0))
out = force(frame(B("\x1b[4;1Hplain again, likely here")))
report("regions: painting resumes at the next default-fg text",
  out.includes(Buffer.concat([INF, B("likely")])) && same(ours(scr, 3), range(13, 19)), out)

;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(B("\x1b[1;1H\x1b[1mbold likely still bold\x1b[22m")))
report("regions: bold prose painted without disturbing the bold",
  out.includes(B("bold \x1b[38;5;203mlikely\x1b[39m still bold\x1b[22m")), out)
out = force(frame(B("\x1b[1;1H\x1b[3mitalic likely ok\x1b[23m")))
report("regions: italic prose painted (3 is not a foreground)",
  out.includes(B("italic \x1b[38;5;203mlikely\x1b[39m ok\x1b[23m")), out)
out = force(frame(B("\x1b[1;1H\x1b[2mdim likely hint\x1b[22m")))
report("regions: dim prose painted",
  out.includes(B("dim \x1b[38;5;203mlikely\x1b[39m hint")), out)

;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(B("\x1b[1;1Hun\x1b[20Glikely then")))
report("layout: marker after a wide CHA jump still painted at its columns",
  out.includes(Buffer.concat([INF, B("likely")])) && same(ours(scr, 0), range(19, 25)),
  ours(scr, 0))
out = force(frame(B("\x1b[2;1HI\x1b[3Gcan't\x1b[9Gtell\x1b[14Gwhether it works.")))
report("layout: phrase across CHA jumps painted whole",
  out.includes(Buffer.concat([UNK, B("can't")])) && out.includes(B("tell"))
  && ours(scr, 1).length !== 0, out)
out = force(frame(B("\x1b[3;1HI\x1b[1Ccan't\x1b[1Ctell\x1b[1Cwhether it works.")))
report("layout: phrase across CUF jumps painted whole",
  out.includes(Buffer.concat([UNK, B("can't")])), out)
out = force(frame(B("\x1b[4;1HI\tcan't\ttell\twhether it works.")))
report("layout: tabs are real gaps, not one space -- phrase not painted",
  !out.includes(UNK) && !out.includes(INF), out)

// == 3. streaming: splits, holds, EOF =========================================

const PHRASES = [B("I can't tell whether it works."), B("There is no way to know for sure."),
  B("As far as I can tell it holds."), B("It never fails in practice."),
  B("That is most likely correct."), B("I haven't verified the claim."),
  B("On the surface it seems to hold."), B("You should be fine, in theory."),
  B("Just add a rule and it works."), B("I'd need to check that first."),
  B("It might perhaps be roughly fine."), B("A bit more or less, kind of.")]
const COLORS = [INF, UNK, APPEAR, OVER, ASSUM, MODAL, VAGUE, SOFT]

cfg = allOn(freshCfg())
const RULES_ONCE = ch.buildRules(cfg)
const PFX_ONCE = HL.growablePrefixes(ch.userFragments(cfg))
const PAL_ONCE = ch.paintPalette(cfg)
let total = 0, missed = 0
let firstMiss: [Buffer, Buffer] | null = null
for (const ph of PHRASES) {
  for (let cut = 1; cut < ph.length; cut++) {
    total += 1
    const [r, f] = pipeline({ rules: RULES_ONCE, pfx: PFX_ONCE, pal: PAL_ONCE })
    const o = Buffer.concat([r(ph.subarray(0, cut), true), f(ph.subarray(cut))])
    if (!COLORS.some(c => o.includes(Buffer.concat([c, B("likely")])) || o.includes(c))) {
      missed += 1
      firstMiss = firstMiss ?? [ph.subarray(0, cut), ph.subarray(cut)]
    }
  }
}
report(`streaming: phrases survive all ${total} chunk splits (${missed} missed)`,
  missed === 0, `first miss: ${firstMiss === null ? "None" : "("
    + reprBytes(firstMiss[0]) + ", " + reprBytes(firstMiss[1]) + ")"}`)

;[run, force, hl, scr] = pipeline({ rules: RULES_ONCE, pfx: PFX_ONCE, pal: PAL_ONCE })
out = Buffer.concat([run(B("that is lik"), true), run(B("ely fine "), true), force()])
report("streaming: split mid-word paints one word, once",
  count(out, Buffer.concat([INF, B("likely"), B("\x1b[39m")])) === 1
  && visible(out).equals(B("that is likely fine ")), out)

;[run, force, hl, scr] = pipeline({ rules: RULES_ONCE, pfx: PFX_ONCE, pal: PAL_ONCE })
out = run(B("that is likel"), true)
report("streaming: 'likel' held on the short tick (growable prefix)",
  out.equals(B("that is ")) && !out.includes(INF), out)
out = force(B("y fine"))
report("streaming: completing the word paints it",
  out.includes(Buffer.concat([INF, B("likely")])), out)

;[run, force, hl, scr] = pipeline({ rules: RULES_ONCE, pfx: null, pal: PAL_ONCE })
out = run(Buffer.concat([B("a "), B("x".repeat(48))]), true)
report("streaming: 48-char word tail held (MAX_HOLD boundary)",
  out.equals(B("a ")) && hl.drain(false).length === 0, out)
report("streaming: force tick releases it", force().equals(B("x".repeat(48))), force())
;[run, force, hl, scr] = pipeline({ rules: RULES_ONCE, pfx: null, pal: PAL_ONCE })
out = run(Buffer.concat([B("a "), B("x".repeat(49))]), true)
report("streaming: 49-char word tail never held",
  out.equals(Buffer.concat([B("a "), B("x".repeat(49))])), out)

// EOF edges: a stream that dies mid-escape must lose only the escape's tail
let h = new AnsiHighlighter([...RULES_ONCE])
h.holdPrefixes = PFX_ONCE
let o1 = h.feed(B("it seems lik"))
let o2 = h.feed(B("\x1b[3"))
let o3 = h.drain(true)
report("EOF: mid-escape force-drain emits held text, drops only the escape tail",
  o1.equals(B("it ")) && o2.length === 0
  && o3.equals(Buffer.concat([APPEAR, B("seems\x1b[39m lik")]))
  && !o3.toString("latin1").endsWith("\x1b[3"), [o1, o2, o3])
h = new AnsiHighlighter([...RULES_ONCE])
h.holdPrefixes = PFX_ONCE
o1 = h.feed(B("probably\x1b]0;tit"))
o2 = h.drain(false)
o3 = h.drain(true)
report("EOF: mid-OSC force-drain keeps the painted word, drops the OSC tail",
  o1.equals(Buffer.concat([INF, B("probably\x1b[39m")])) && o2.length === 0
  && o3.length === 0 && !o1.includes(B("]0;tit")), [o1, o2, o3])
h = new AnsiHighlighter([...RULES_ONCE])
h.holdPrefixes = PFX_ONCE
o1 = h.feed(B("lik\x1b[1"))
o2 = h.drain(false)
o3 = Buffer.concat([h.feed(B("mely fine")), h.drain(true)])
report("streaming: a word split by an in-line SGR still paints, single restore",
  o2.length === 0 && o3.equals(Buffer.concat([INF, B("lik\x1b[1mely\x1b[39m fine")])),
  [o1, o2, o3])

// empty feeds are no-ops
h = new AnsiHighlighter([...RULES_ONCE])
const oEmpty = Buffer.concat([h.feed(B("")), h.drain(false), h.feed(B("likely")), h.drain(true)])
report("streaming: empty chunk is a no-op and loses nothing",
  oEmpty.includes(Buffer.concat([INF, B("likely")])), oEmpty)

// == 4. screen operations, hand-computed ======================================

let m = opModel()
report("ops: painted row lands as written",
  rowtext(m, 0) === "the tests mostly pass" && same(ours(m, 0), range(10, 16)),
  rowtext(m, 0), ours(m, 0))

m = opModel()
out = m.reconcile(frame(B("\x1b[1;9H\x1b[4P")), RULES_OP, true)
report("ops: DCH shifts our cells left, correction rewrites exactly them",
  rowtext(m, 0) === "the teststly pass" && same(ours(m, 0), [])
  && out.includes(B("\x1b[1;9H\x1b[39mstly")), rowtext(m, 0), out)

m = opModel()
out = m.reconcile(frame(B("\x1b[1;10H\x1b[4@")), RULES_OP, true)
report("ops: ICH shifts our cells right, live match survives (no correction)",
  rowtext(m, 0) === "the tests     mostly pass" && same(ours(m, 0), range(14, 20))
  && !out.includes(B("\x1b7")), [rowtext(m, 0), ours(m, 0)])
out = m.reconcile(frame(B("\x1b[1;15Habc")), RULES_OP, true)
report("ops: after ICH, child overwrites leave a correction at the new columns",
  same(ours(m, 0), []) && out.includes(B("\x1b[1;18H\x1b[39mtly")), out)

m = opModel()
out = m.reconcile(frame(B("\x1b[1;11H\x1b[2X")), RULES_OP, true)
report("ops: ECH takes back only the orphaned cells",
  rowtext(m, 0) === "the tests   stly pass"
  && out.includes(B("\x1b[1;13H\x1b[39mstly")), out)

m = opModel()
out = m.reconcile(frame(B("\x1b[1;11H\x1b[K")), RULES_OP, true)
report("ops: EL0 erases to end of line, ours gone, no correction",
  rowtext(m, 0) === "the tests" && !anyOurs(m, 0) && !out.includes(B("\x1b7")), out)
m = opModel()
m.reconcile(frame(B("\x1b[1;5H\x1b[1K")), RULES_OP, true)
report("ops: EL1 keeps the painted word intact", same(ours(m, 0), range(10, 16)), ours(m, 0))
m = opModel()
out = m.reconcile(frame(B("\x1b[2K")), RULES_OP, true)
report("ops: EL2 clears the row", rowtext(m, 0) === "" && !anyOurs(m, 0), out)
m = opModel()
out = m.reconcile(frame(B("\x1b[2J")), RULES_OP, true)
report("ops: ED2 clears everything ours",
  !m.ours.some(r => r.some(v => v)) && !out.includes(B("\x1b7")), out)
m = opModel()
out = m.reconcile(frame(B("\x1b[1;11H\x1b[J")), RULES_OP, true)
report("ops: ED0 from cursor erases our word", !anyOurs(m, 0), out)

m = opModel()
m.reconcile(frame(B("\x1b[3;1H\x1b[38;5;170mnot sure at all\x1b[39m")), RULES_OP, true)
out = m.reconcile(frame(B("\x1b[1;1H\x1b[2L")), RULES_OP, true)
report("ops: IL pushes painted rows down, colour travels with the text",
  rowtext(m, 2) === "the tests mostly pass" && same(ours(m, 2), range(10, 16))
  && rowtext(m, 4) === "not sure at all", range(0, 6).map(y => rowtext(m, y)))
out = m.reconcile(frame(B("\x1b[3;1H\x1b[M")), RULES_OP, true)
report("ops: DL removes the row at the cursor, ours goes with it",
  rowtext(m, 2) === "" && !anyOurs(m, 2)
  && rowtext(m, 3) === "not sure at all" && !anyOurs(m, 3),
  range(0, 6).map(y => rowtext(m, y)))

m = opModel()
m.reconcile(frame(Buffer.concat([B("\x1b[6;1H"), PAINT_OP])), RULES_OP, true)
out = m.reconcile(frame(B("\x1b[6;1H\n")), RULES_OP, true)
report("ops: LF on the bottom row scrolls the painted row up",
  rowtext(m, 4) === "the tests mostly pass" && same(ours(m, 4), range(10, 16)),
  range(0, 6).map(y => rowtext(m, y)))
out = m.reconcile(frame(B("\x1b[5;11HH\x1b[1Cver!")), RULES_OP, true)
report("ops: correction lands on the scrolled row, at the skipped cell",
  out.includes(B("\x1b[5;12H\x1b[39mo")) && !anyOurs(m, 4), out)

m = opModel()
out = m.reconcile(frame(B("\x1b[1S")), RULES_OP, true)
report("ops: SU scrolls the painted row off the top, nothing left to fix",
  rowtext(m, 0) === "" && !m.ours.some(r => r.some(v => v))
  && !out.includes(B("\x1b7")), out)
m = opModel()
out = m.reconcile(frame(B("\x1b[1T")), RULES_OP, true)
report("ops: SD pushes the painted row down intact",
  same(ours(m, 1), range(10, 16)) && rowtext(m, 1) === "the tests mostly pass",
  range(0, 3).map(y => rowtext(m, y)))
m = opModel()
out = m.reconcile(frame(B("\x1b[1;1H\x1bM")), RULES_OP, true)
report("ops: RI at the top scrolls down like SD",
  same(ours(m, 1), range(10, 16)), range(0, 3).map(y => rowtext(m, y)))

m = opModel()
m.reconcile(frame(Buffer.concat([B("\x1b[2;1H"), PAINT_OP,
  B("\x1b[3;1H\x1b[38;5;170mnot sure at all\x1b[39m")])), RULES_OP, true)
out = m.reconcile(frame(B("\x1b[2;4r\x1b[4;1H\n")), RULES_OP, true)
report("ops: LF inside a scroll region scrolls the region only",
  rowtext(m, 1) === "not sure at all" && !anyOurs(m, 2) && m.top === 1 && m.bot === 3,
  range(0, 6).map(y => rowtext(m, y)), [m.top, m.bot])
out = m.reconcile(frame(B("\x1b[r")), RULES_OP, true)
report("ops: DECSTBM with no params resets to full screen",
  m.top === 0 && m.bot === m.rows - 1, [m.top, m.bot])
const m2 = opModel()
m2.reconcile(frame(B("\x1b[5;3r")), RULES_OP, true)
report("ops: inverted region (top>bot) resets to full",
  m2.top === 0 && m2.bot === m2.rows - 1, [m2.top, m2.bot])

m = opModel()
out = m.reconcile(frame(Buffer.concat([B("\x1b[20;0H"), PAINT_OP])), RULES_OP, true)
report("ops: past-bottom row write is clamped onto the last row",
  rowtext(m, 5).startsWith("the tests mostly pass"), range(0, 6).map(y => rowtext(m, y)))

// cursor movement maths (want values are (x, y))
m = new ScreenModel(6, 40, OP_PAL)
const CURSOR_CASES: Array<[Buffer, [number, number]]> = [
  [B("\x1b[5;7H"), [6, 4]], [B("\x1b[2A"), [6, 2]], [B("\x1b[99B"), [6, 5]],
  [B("\x1b[99C"), [39, 5]], [B("\x1b[99D"), [0, 5]], [B("\x1b[12G"), [11, 5]],
  [B("\x1b[0G"), [0, 5]], [B("\x1b[3d"), [0, 2]], [B("\x1b[2E"), [0, 4]],
  [B("\x1b[1F"), [0, 3]], [B("\t"), [8, 3]], [B("\t"), [16, 3]],
  [B("\x08\x08\x08"), [13, 3]], [B("\r"), [0, 3]], [B("\n"), [0, 4]],
  [B("\x08".repeat(99)), [0, 4]], [B("\t".repeat(99)), [39, 4]],
  [B("\x1b[;H"), [0, 0]], [B("\x1b[0;0H"), [0, 0]], [B("\x1b[999;999H"), [39, 5]],
]
for (const [seq, want] of CURSOR_CASES) {
  m.feed(seq)
  report(`ops: cursor ${reprBytes(seq.subarray(0, 16))} -> ${pyTuple(want)}`,
    m.x === want[0] && m.y === want[1], [m.x, m.y])
}

m = opModel()
m.feed(B("\x1b[1;1H\x1b[38;5;214mmo"))     // cursor inside our paint, ours active
m.feed(B("\x1b7"))
m.feed(B("\x1b[39m\x1b[3;1Hchild text"))
m.feed(B("\x1b8"))
report("ops: DECRC restores cursor, colour and ours-ness",
  m.x === 2 && m.y === 0 && m.curFg === "38;5;214" && m.curOurs === true,
  [m.x, m.y, m.curFg, m.curOurs])
m.feed(B("re"))
report("ops: cells written after DECRC are ours again",
  Boolean(m.ours[0]![3]), m.ours[0]!.slice(0, 6))
m.feed(B("\x1b7\x1b7\x1b[2;1H\x1b8"))
report("ops: DECSC overwrites (no stack)", m.x === 4 && m.y === 0, [m.x, m.y])

// mode tracking
m = new ScreenModel(6, 40, OP_PAL)
m.feed(B("\x1b[?2026;1049h"))
report("ops: combined private set honours alt-screen first (2026 not seen)",
  m.alt === true && m.inFrame === false, [m.alt, m.inFrame])
m.feed(B("\x1b[?2026h"))
report("ops: sync-output enter tracked", m.inFrame === true)
m.feed(B("\x1b[?1049l"))
report("ops: alt-screen exit invalidates everything",
  m.alt === false && !m.ours.some(r => r.some(v => v)))
m.feed(B("\x1b[?2004h\x1b[?25l\x1b[?1;2;3;4h\x1b[!p\x1b[>c"))
report("ops: unknown private/intermediate modes are ignored, not printed",
  rowtext(m, 0) === "" && m.x === 0 && m.y === 0, rowtext(m, 0))

m = opModel(6, 40, false)
out = m.reconcile(frame(B("\x1b[1;11HH\x1b[1Cver!")), RULES_OP, true)
report("ops: outside the alt screen nothing is corrected (documented)",
  !out.includes(B("\x1b7")) && stale(m, RULES_OP) > 0, out)
m.resize(30, 100)
report("ops: resize invalidates the model completely",
  m.rows === 30 && m.cols === 100 && !m.ours.some(r => r.some(v => v)))

// wrap edges
m = new ScreenModel(3, 10, OP_PAL)
m.feed(B("\x1b[1;10Hab"))
report("wrap: last-column write defers the wrap to the next char",
  m.chars[0]![9] === "a" && m.chars[1]![0] === "b" && m.x === 1 && m.y === 1,
  [rowtext(m, 0), rowtext(m, 1)])
m = new ScreenModel(3, 10, OP_PAL)
m.feed(Buffer.concat([B("\x1b[1;9H"), U("世x")]))
report("wrap: wide pair fits exactly, continuation cell marked, next char wraps",
  m.chars[0]![8] === "世" && m.chars[0]![9] === "" && m.chars[1]![0] === "x",
  range(0, 3).map(y => rowtext(m, y)))
m = new ScreenModel(3, 10, OP_PAL)
m.feed(Buffer.concat([B("\x1b[1;10H"), U("世x")]))
report("wrap: wide char that cannot fit wraps to the next line whole",
  m.chars[1]![0] === "世" && m.chars[1]![1] === "" && m.chars[1]![2] === "x",
  range(0, 3).map(y => rowtext(m, y)))

// control bytes and broken UTF-8
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b[1;1H\x00\x07\x0e\x0fhi"))
report("control: NUL/BEL/SO/SI consumed silently, cursor unmoved",
  rowtext(m, 0) === "hi" && m.x === 2 && m.y === 0, [rowtext(m, 0), [m.x, m.y]])
m.feed(B("\x7f"))
report("control: DEL lands as a printable cell (terminal-dependent, pinned)",
  m.chars[0]![2] === "\x7f", m.chars[0]!.slice(0, 4))
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b[1;1H\xff\x9bZ"))
report("utf8: invalid bytes become U+FFFD cells, never crash",
  m.chars[0]![0] === "�" && m.chars[0]![1] === "�" && m.chars[0]![2] === "Z",
  m.chars[0]!.slice(0, 4))
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b[1;1H\xc3"))
m.feed(B("\xa9 caf\xc3"))
m.feed(B("\xa9"))
report("utf8: multi-byte sequences split across feeds decode once",
  m.chars[0]![0] === "é" && m.chars[0]![2] === "c" && m.chars[0]![5] === "é",
  m.chars[0]!.slice(0, 8).map(c => (c ? c : " ")).join(""))
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b[1;1H\xc0\x80ok"))
report("utf8: overlong encoding degrades to replacement chars",
  m.chars[0]![0] === "�" && m.chars[0]![2] === "o", m.chars[0]!.slice(0, 4))

// sequences split across feeds, OSC/DCS pass-through, hostile sizes
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b[1;"))
m.feed(B("1Hok"))
report("split: CSI cut in half by a chunk boundary completes correctly",
  rowtext(m, 0) === "ok", rowtext(m, 0))
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b]0;ti"))
m.feed(B("tle\x07X"))
report("split: OSC cut in half completes, nothing leaks as text",
  rowtext(m, 0) === "X", rowtext(m, 0))
m.feed(B("\x1b]2;x\x1b\\Y"))
report("split: OSC with ST terminator consumed too", rowtext(m, 0) === "XY", rowtext(m, 0))
m.feed(B("\x1bP$q544e\x1b\\ok"))
report("split: DCS passed through without landing on screen",
  rowtext(m, 0) === "XYok", rowtext(m, 0))
m.feed(B("\x1bP1;2"))
m.feed(B("q..\x1b\\done"))
report("split: DCS cut in half completes", rowtext(m, 0) === "XYokdone", rowtext(m, 0))

// an OSC whose payload contains the frame-end bytes must not corrupt the model
;[run, force, hl, scr] = pipeline({ cfg })
const evil = frame(B("\x1b[2;1H\x1b]0;evil \x1b[?2026l title\x07\x1b[3;1Hlikely here"))
out = force(evil)
report("hostile: OSC containing a fake frame-end passes through intact",
  visible(out).equals(visible(evil)) && out.includes(B("evil"))
  && out.includes(Buffer.concat([INF, B("likely")])), out)
report("hostile: model not corrupted by the fake frame-end",
  rowtext(scr, 1) === "" && rowtext(scr, 2).includes("likely here"), rowtext(scr, 2))

// unterminated OSC beyond MAX_PENDING is dropped, and the model survives
m = new ScreenModel(3, 20, OP_PAL)
m.feed(Buffer.concat([B("\x1b]0;"), B("x".repeat(5000))]))
m.feed(B("\x1b[2;1Hafter"))
report("hostile: >4 KB unterminated OSC dropped, parser still usable",
  rowtext(m, 1) === "after", [rowtext(m, 0).slice(0, 20), rowtext(m, 1)])

// huge and junk params
m = new ScreenModel(6, 40, OP_PAL)
m.feed(B("\x1b[1;1Habc\x1b[999P\x1b[2;1Hok"))
report("hostile: DCH with a huge count never bloats the row (regression)",
  m.chars[0]!.length === 40 && rowtext(m, 1) === "ok", m.chars[0]!.length)
let okJunk = true
for (const seq of [B("\x1b[999@\x1b[999L\x1b[999M\x1b[999S\x1b[999T\x1b[999X\x1b[999G"),
  B("\x1b[-5A\x1b[3;4;5;9;11m\x1b[38;2;1;2;3;4;5m\x1b[38m\x1b[48;5;m"),
  B("\x1b[?12;25h\x1b[?1049;25h\x1b[1;2;3;4;5H\x1b;;;;;;;;;;H")]) {
  try {
    m.feed(seq)
    okJunk = true
  } catch (e) {
    okJunk = false
    m = new ScreenModel(6, 40, OP_PAL)
    report(`hostile: ${reprBytes(seq)} raised ${String(e)}`, false)
  }
}
report("hostile: junk/huge CSI params never raise and leave a sane model",
  okJunk && m.rows === 6 && m.cols === 40, "")

// ESC ESC restart, DEL/BS storms, C1 in text -- model stays deterministic
m = new ScreenModel(3, 20, OP_PAL)
m.feed(B("\x1b\x1b[1;1H"))          // ESC ESC: both consumed, rest is text (pinned)
report("hostile: ESC ESC consumed as two bytes, remainder printed (pinned)",
  rowtext(m, 0).startsWith("[1;1H"), rowtext(m, 0))

// the add-path: the frame reconciler paints a match the streaming pass never
// coloured. Claude Code redraws a scrolled screen cell by cell, so a word can
// land split across an absolute cursor jump the stream filter cannot bridge --
// it must still come out painted, or it flickers as the scroll offset shifts.
m = new ScreenModel(6, 40, OP_PAL)
out = m.reconcile(Buffer.concat([B("\x1b[?1049h"),
  frame(B("\x1b[1;1Hthe tests mostly pass"))]), RULES_OP, true)
report("add: a plain word the child wrote is painted at the frame end",
  same(ours(m, 0), range(10, 16))
  && m.fg[0]!.slice(10, 16).every(v => v === "38;5;214")
  && out.includes(B("\x1b[1;11H\x1b[38;5;214mmostly")), [ours(m, 0), out])

m = new ScreenModel(6, 40, OP_PAL)
out = m.reconcile(Buffer.concat([B("\x1b[?1049h"),
  frame(B("\x1b[1;1Hthe tests mos\x1b[1;14Htly pass"))]), RULES_OP, true)
report("add: a word split across a cursor jump is still painted",
  same(ours(m, 0), range(10, 16)) && out.includes(B("\x1b[38;5;214mmostly")),
  [ours(m, 0), out])

m = new ScreenModel(6, 40, OP_PAL)
out = m.reconcile(Buffer.concat([B("\x1b[?1049h"),
  frame(B("\x1b[2;1H\x1b[48;5;236mthe tests mostly pass\x1b[49m"))]), RULES_OP, true)
report("add: a non-default background blocks the add-path (user message)",
  !anyOurs(m, 1) && !out.includes(B("\x1b[38;5;214m")), out)

// composer sweep: a paint can reach the input box out of step with the frame
// that redrew it -- the highlighter holds a partial word and flushes it a tick
// late, after that row's dirty flag was cleared -- so a dirty-only correction
// leaves the user's own prompt coloured. Regression from a recorded session
// where "clearly" typed into the box stayed painted for 21 frames.
{
  const mm = new ScreenModel(8, 40, OP_PAL)
  const rule = Buffer.from("─".repeat(40), "utf8")       // box-drawing is multi-byte UTF-8
  mm.feed(B("\x1b[?1049h"))
  mm.feed(Buffer.concat([
    B("\x1b[5;1H"), rule,                                 // input box top rule
    B("\x1b[6;1H> \x1b[38;5;214mmostly\x1b[39m pass"),    // prompt, hedge word painted
    B("\x1b[7;1H"), rule,                                 // input box bottom rule
    B("\x1b[8;1Hstatus line here"),
  ]))
  report("composer: the input row is detected as off-limits",
    mm.composerRows().includes(5), mm.composerRows())
  report("composer: the hedge word landed painted in the box",
    same(ours(mm, 5), range(2, 8)), ours(mm, 5))
  mm.dirty = new Set()                                    // the late flush's frame already passed
  const corr = mm.corrections(RULES_OP, true)
  report("composer: an unconditional sweep strips paint even when the row is clean",
    !anyOurs(mm, 5) && corr.includes(B("\x1b[6;")) && corr.includes(B("\x1b[39m")),
    [ours(mm, 5), corr])
}

// == 5. the input box =========================================================

const RULE = "─".repeat(60)

const composerBody = (typed: string): Buffer =>
  Buffer.concat([B("\x1b[1;1Hthe tests mostly pass"),
    U(`\x1b[3;1H${RULE}\x1b[4;1H❯ ${typed}\x1b[5;1H${RULE}`),
    B("\x1b[6;1Hprobably v2.1.236")])

;[run, force, hl, scr] = pipeline({ cfg, rows: 6, cols: 60 })
out = force(Buffer.concat([B("\x1b[?1049h"), frame(composerBody("this usually works"))]))
report("box: found geometrically between the last two rules",
  same(scr.composerRows(), [2, 3, 4, 5]), scr.composerRows())
report("box: prose above the box is still painted",
  same(ours(scr, 0), range(10, 16)), ours(scr, 0))
report("box: typed marker taken back inside the frame",
  same(ours(scr, 3), []) && out.includes(B("\x1b[4;8H\x1b[39musually"))
  && out.indexOf(B("\x1b7")) < out.indexOf(B("\x1b[?2026l")), out)
report("box: status chrome below is never ours",
  same(ours(scr, 5), []) && out.includes(B("\x1b[6;1H\x1b[39mprobably")), out)
report("box: the box's own text is left exactly as written",
  rowtext(scr, 3) === "❯ this usually works", rowtext(scr, 3))

;[run, force, hl, scr] = pipeline({ cfg, rows: 6, cols: 60 })
force(Buffer.concat([B("\x1b[?1049h"), frame(composerBody(""))]))
{
  let i = 0
  for (const c of "usually fine") {
    force(frame(U(`\x1b[4;${3 + i}H${c}`)))
    i += 1
  }
}
report("box: keystroke-at-a-time typing never keeps a colour",
  !anyOurs(scr, 3), rowtext(scr, 3))

;[run, force, hl, scr] = pipeline({ cfg, rows: 12, cols: 40 })
out = force(Buffer.concat([B("\x1b[?1049h"), frame(Buffer.concat([B("\x1b[2;1H"), U(RULE),
  B("\x1b[5;1Hthis usually works")]))]))
report("box: a lone rule too far from the bottom is not a box (paints stay)",
  same(scr.composerRows(), []) && ours(scr, 4).length !== 0,
  [scr.composerRows(), ours(scr, 4)])

;[run, force, hl, scr] = pipeline({ cfg, rows: 34, cols: 40 })
out = force(Buffer.concat([B("\x1b[?1049h"), frame(Buffer.concat([
  U(`\x1b[3;1H${RULE}`), B("\x1b[20;1Hthis usually works"),
  U(`\x1b[33;1H${RULE}`)]))]))
report("box: band capped at 24 rows -- a stray rule cannot swallow the screen",
  same(scr.composerRows(), range(32, 34)), scr.composerRows())
report("box: text between rules 30 apart is outside the band and stays painted",
  ours(scr, 19).length !== 0, ours(scr, 19))

m = new ScreenModel(3, 10, OP_PAL)
m.feed(Buffer.concat([B("\x1b[1;1H"), U("─".repeat(8))]))
report("box: rule detection needs >=80% box chars", m.isRule(0) === true)
m.feed(Buffer.concat([B("\x1b[2;1H"), U("─".repeat(7)), B("x")]))
report("box: one non-rule character settles a row", m.isRule(1) === false)
m.feed(Buffer.concat([B("\x1b[3;1H"), U("─".repeat(7))]))
report("box: 70% box chars is not a rule", m.isRule(2) === false)

// == 6. corrections mechanics =================================================

;[run, force, hl, scr] = pipeline({ cfg })
out = force(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1Hthe tests mostly pass"))]))
const paintedCells = range(0, 40).filter(x => scr.ours[0]![x])
report("corrections: streamed match painted at once",
  same(paintedCells, range(10, 16)), paintedCells)
out = force(frame(B("\x1b[1;11HH\x1b[1Cver!")))
report("corrections: wrapped in one DECSC/DECRC + autowrap-off pair",
  count(out, B("\x1b7")) === 1 && count(out, B("\x1b8")) === 1
  && count(out, B("\x1b[?7l")) === 1 && count(out, B("\x1b[?7h")) === 1, out)
report("corrections: fix sits inside the frame's sync block",
  out.indexOf(B("\x1b7")) < out.indexOf(B("\x1b[1;12H\x1b[39mo"))
  && out.indexOf(B("\x1b[1;12H\x1b[39mo")) < out.indexOf(B("\x1b[?2026l")), out)
report("corrections: after fixing, nothing is stale", stale(scr, hl.rules) === 0)

// the 4 KB cap: dirty more than fits, next frame must finish the rest
;[run, force, hl, scr] = pipeline({ cfg, rows: 24, cols: 80 })
const paintAll = Buffer.concat(range(0, 24).map(y =>
  B(`\x1b[${y + 1};1H` + "mostly ".repeat(11))))
const damageParts: Buffer[] = []
for (let y = 0; y < 24; y++) for (let k = 0; k < 11; k++) {
  damageParts.push(B(`\x1b[${y + 1};${7 * k + 1}HXX`))
}
const damage = Buffer.concat(damageParts)
force(Buffer.concat([B("\x1b[?1049h"), frame(paintAll)]))
const out1 = force(frame(damage))
const pre = B("\x1b7\x1b[?7l"), post = B("\x1b[?7h\x1b8")
const burst = out1.includes(pre)
  ? out1.subarray(out1.indexOf(pre) + pre.length, out1.indexOf(post))
  : Buffer.alloc(0)
report("corrections: a frame's burst is capped at MAX_FIX bytes",
  0 < burst.length && burst.length <= MAX_FIX, burst.length)
const still = range(0, 24).filter(y => anyOurs(scr, y)).length
report("corrections: overflow rows deferred to the next frame", still > 0, still)
force(frame(B("\x1b[1;1H")))
report("corrections: deferred rows are picked up and nothing is stale after",
  stale(scr, hl.rules) === 0, stale(scr, hl.rules))

// toggling a category off unpaints on the row's next touch: corrections only
// re-examine dirty rows, which is exactly how the live config reload behaves
const cfg2 = allOn(freshCfg())
;[run, force, hl, scr] = pipeline({ cfg: cfg2 })
force(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1HIt seems likely fine."))]))
;(cfg2.categories["inference"] as CategoryCfg).on = false
hl.rules = ch.buildRules(cfg2)          // exactly what the config reload does
out = force(frame(B("\x1b[1;1H*")))
report("corrections: category toggle unpaints on the row's next touch",
  out.includes(B("\x1b[1;10H\x1b[39mlikely")) && same(ours(scr, 0), range(3, 8)), out)
out = force(frame(B("\x1b[2;1HIt seems likely again.")))
report("corrections: toggled-off category no longer paints new text",
  !out.includes(B("\x1b[38;5;203m")) && out.includes(B("\x1b[38;5;179mseems")), out)

// palette collision: a child cell painted in one of our colours is treated
// as ours and taken back -- the documented trade for indexed colours.
;[run, force, hl, scr] = pipeline({ cfg })
out = force(Buffer.concat([B("\x1b[?1049h"),
  frame(B("\x1b[1;1H\x1b[38;5;214mmostly child\x1b[39m"))]))
report("corrections: child text in a palette colour counts as ours (documented)",
  same(ours(scr, 0), range(0, 6)), ours(scr, 0))
out = force(frame(B("\x1b[1;1Hover!")))
report("corrections: ...and is taken back once the match dies",
  out.includes(B("\x1b[1;6H\x1b[39my")), out)

// == 7. config matrix =========================================================

cfg = freshCfg()
report("config: default file created, complete and valid",
  existsSync(CFG_PATH) && same(Object.keys(cfg.categories).sort(), [...ORDER].sort())
  && cfg.prose_only === true && cfg.annotations === true)

cfg = freshCfg({ categories: { inference: { color: "38;5;196", add: ["ballpark", "re:gut feel"] } } })
let rules = ch.buildRules(cfg)
report("config: colour override and add-words reach the rules",
  rules.some(r => r.style.equals(B("\x1b[38;5;196m"))), rules.map(r => r.style))
;[run, force, hl, scr] = pipeline({ cfg })
out = force(B("\x1b[1;1Ha ballpark estimate and a gut feel too"))
report("config: literal and re: add-words both match",
  out.includes(B("\x1b[38;5;196mballpark")) && out.includes(B("\x1b[38;5;196mgut feel")), out)
let bad = ch.rejectedTerms(cfg)
report("config: invalid add-words listed, not fatal", Object.keys(bad).length === 0, bad)

cfg = freshCfg({ categories: { inference: { add: ["re:(", "ok-word"] } } })
bad = ch.rejectedTerms(cfg)
report("config: a broken re: pattern is rejected and reported",
  same(bad["inference"], ["re:("]), bad)
rules = ch.buildRules(cfg)
report("config: the valid sibling word still compiled",
  rules.some(r => r.pat.source.includes("ok\\-word") || r.pat.source.includes("ok-word")),
  rules.map(r => r.pat.source))

cfg = freshCfg({ custom: { deadline: { terms: ["slipping", "at risk"],
  color: "38;5;90", desc: "schedule" } } })
rules = ch.buildRules(cfg)
report("config: custom category gets its own rule and palette entry",
  rules.some(r => r.style.equals(B("\x1b[38;5;90m")))
  && ch.paintPalette(cfg).has("38;5;90"), [...ch.paintPalette(cfg)])
;[run, force, hl, scr] = pipeline({ cfg })
out = force(B("\x1b[1;1Hthe deadline is slipping, at risk"))
report("config: custom terms painted in the custom colour",
  count(out, B("\x1b[38;5;90m")) === 2, out)
let PFX = HL.growablePrefixes(ch.userFragments(cfg))
report("config: custom terms join the cross-chunk prefix set",
  PFX.has("slippin") && PFX.has("at ri"), [...PFX].filter(p => p.includes("slip")).sort())
;[run, force, hl, scr] = pipeline({ cfg })
let okSplits = true
const PHRASE = B("the deadline is slipping, at risk")
for (let cut = 1; cut < PHRASE.length; cut++) {
  const [r2, f2] = pipeline({ cfg })
  const o = Buffer.concat([r2(PHRASE.subarray(0, cut), true), f2(PHRASE.subarray(cut))])
  if (!o.includes(B("\x1b[38;5;90m"))) okSplits = false
}
report("config: custom multi-word terms survive every chunk split", okSplits)

cfg = freshCfg({ custom: { inference: { terms: ["x"] } } })
report("config: custom category may not shadow a built-in",
  !Object.keys(cfg.categories).filter(c => !ORDER.includes(c)).includes("inference")
  && Object.keys(cfg.categories).every(c =>
    !(cfg.categories[c] as CategoryCfg).desc.includes("inference")),
  Object.keys(cfg.categories).sort())

cfg = freshCfg({ prose_only: false })
;[run, force, hl, scr] = pipeline({ cfg: allOn(cfg) })
const srcBytes = B("\x1b[1;1H\x1b[32mlikely in code\x1b[39m and "
  + "\x1b[48;2;55;55;55mprobably typed\x1b[49m")
out = force(srcBytes)
report("config: prose_only=false paints styled regions too, visible intact",
  count(out, B("\x1b[38;5;203m")) === 2 && visible(out).equals(visible(srcBytes)), out)

// type-abusive configs must never take a session down
const ABUSE: Array<[string, string]> = [
  ["config is a JSON list", "[1,2,3]"],
  ["config is a JSON string", '"hello"'],
  ["config is broken JSON", "{broken"],
  ["categories is a string", '{"categories": "nope"}'],
  ["category spec is a string", '{"categories": {"inference": "nope"}}'],
  ["add is a string (one word, not chars)", '{"categories": {"inference": {"add": "ballpark"}}}'],
  ["add is a number", '{"categories": {"inference": {"add": 42}}}'],
  ["add is an object", '{"categories": {"inference": {"add": {"a": 1}}}}'],
  ["custom is a list", '{"custom": ["x"]}'],
  ["custom spec is a string", '{"custom": {"x": "no"}}'],
  ["custom terms is a number", '{"custom": {"x": {"terms": 5}}}'],
  ["custom color is a number", '{"custom": {"x": {"terms": ["slipping"], "color": 99}}}'],
  ["builtin color is null", '{"categories": {"inference": {"color": null}}}'],
  ["on is the string 'false' (bool quirk, pinned)", '{"categories": {"inference": {"on": "false"}}}'],
]
for (const [name, raw] of ABUSE) {
  let ok: boolean
  let abuseOut: Buffer | string
  try {
    cfg = freshCfg(raw)
    const r = ch.buildRules(cfg)
    const pal = ch.paintPalette(cfg)
    HL.growablePrefixes(ch.userFragments(cfg))
    const h2 = new AnsiHighlighter(r, cfg.prose_only)
    abuseOut = Buffer.concat([h2.feed(B("\x1b[32mlikely ballpark code\x1b[39m")), h2.drain()])
    ok = Array.isArray(r) && pal instanceof Set
  } catch (e) {
    ok = false
    abuseOut = String(e)
  }
  report(`config abuse: ${name} survives`, ok, abuseOut)
}

cfg = freshCfg({ categories: { inference: { add: "ballpark" } } })
rules = ch.buildRules(cfg)
;[run, force, hl, scr] = pipeline({ cfg })
out = force(B("\x1b[1;1Hb x ballpark"))
report("config abuse: string add is one word -- single letters not painted",
  !out.includes(B("\x1b[38;5;203mb\x1b[39m"))
  && out.includes(B("\x1b[38;5;203mballpark")), out)

// lexicon invariants: the expander and the patterns must agree
const badLex: string[] = []
for (const [cat, terms] of Object.entries(HL.LEXICON)) {
  for (const t of terms) {
    const pat = new RegExp("\\b(?:" + t + ")\\b", "i")
    for (const lit of HL.expand(t)) {
      if (!pat.test(lit)) badLex.push(`${cat}:${t}->${JSON.stringify(lit)}`)
    }
  }
}
report(`lexicon: every expansion of every term matches its own pattern (${badLex.length} bad)`,
  badLex.length === 0, badLex.slice(0, 5))
const LITS = HL.literals()
report("lexicon: literals include multi-word and unicode-free terms",
  LITS.has("likely") && LITS.has("can't tell") && LITS.has("in theory"), "")
PFX = HL.growablePrefixes()
report("lexicon: growable prefixes hold partials, not complete words",
  !PFX.has("likely") && PFX.has("some") && PFX.has("can't tel") && PFX.has("roughl"), "")
report("lexicon: literals() folds in user regex fragments, skipping junk",
  HL.literals(["gut feel"]).has("gut feel") && HL.literals(["("]) !== null, "")
report("lexicon: user_pattern escapes literals and passes re: through",
  HL.userPattern("a(b)c") === "a\\(b\\)c" && HL.userPattern("re:ab(c)") === "ab(c)",
  [HL.userPattern("a(b)c"), HL.userPattern("re:ab(c)")])

// == 8. word boundaries, case, unicode ========================================

// (the Python re-derived `cfg` here only when it had lost its dict-ness; in
// TypeScript it is a Config throughout, so the previous value simply stands.)
const BOUNDARY_CASES: Array<[Buffer, boolean]> = [
  [B("unlikelyhood of it"), false], [B("likely2 here"), false], [B("_likely_ no"), false],
  [B("likely-hood yes"), true], [B("(Likely?)"), true], [B("LIKELY."), true],
  [B("probably, then"), true], [U("I can’t tell you"), false],
  [B("likely"), true],
]
for (const [text, want] of BOUNDARY_CASES) {
  ;[run, force, hl, scr] = pipeline({ cfg })
  out = force(frame(Buffer.concat([B("\x1b[1;1H"), text])))
  const got = noSync(out).includes(B("38;5;"))
  report(`boundary: ${reprBytes(text)} painted=${pyBool(got)} (want ${pyBool(want)})`,
    got === want, out)
}

;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(U("\x1b[1;1H世界 mostly pass")))
report("unicode: match after wide chars painted at the right columns",
  same(ours(scr, 0), range(5, 11)), ours(scr, 0))
;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(U("é x évaluer it seems fine")))
report("unicode: 2-byte chars decode and paint cleanly",
  out.includes(B("\x1b[38;5;179mseems")), out)
;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(U("\x1b[1;1Hlikelý ok")))
report("unicode: combining mark rides the painted cell without shifting it",
  out.includes(B("\x1b[38;5;203mlikely")) && cellWidth("́") === 0
  && same(ours(scr, 0), range(0, 6)), out, ours(scr, 0))
;[run, force, hl, scr] = pipeline({ cfg })
out = force(frame(U("\u{1F468}‍\u{1F469}‍\u{1F467} ok probably")))
report("unicode: ZWJ emoji takes two columns, marker after it lands correctly",
  out.includes(B("\x1b[38;5;203mprobably")), out)

// == 9. fuzz ==================================================================

const MARKERS = ["likely", "probably", "seems", "mostly", "can't tell", "in theory",
  "not sure", "obviously", "untested", "might", "roughly", "a bit",
  "should work", "haven't verified", "perhaps", "no way to know",
  "in theory", "world", "café", "likely"]
const FILLER = ["the", "tests", "pass", "run", "code", "value", "returns", "ok",
  "we", "see", "here", "result", "x", "42", "path", "file", "this",
  "line", "text", "some", "plain", "words", "note", "finds"]

/** Deterministic stand-in for Python's random.Random(seed). */
interface Rng {
  random(): number
  randint(a: number, b: number): number
  randrange(n: number): number
  choice<T>(arr: readonly T[]): T
}

function makeRng(seed: number): Rng {
  let a = seed >>> 0
  const random = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    random,
    randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    randrange: n => Math.floor(random() * n),
    choice<T>(arr: readonly T[]): T { return arr[Math.floor(random() * arr.length)] as T },
  }
}

/** Claude-Code-shaped traffic: synced frames, word-jump prose, styled
 * regions, an input box, scrolls and erases above it. */
function genSession(rng: Rng, nframes = 120, rows = 24, cols = 80): Buffer[] {
  const parts: Buffer[] = [B("\x1b[?1049h"), B("\x1b[2J"), B("\x1b[?25l"), B("\x1b]0;session\x07")]
  const boxTop = rows - 4, boxTyped = rows - 3, boxLow = rows - 2   // 1-indexed
  for (let i = 0; i < nframes; i++) {
    const body: Buffer[] = []
    const y = rng.randint(1, rows - 8)
    const nwords = rng.randint(3, 8)
    const words: string[] = []
    for (let k = 0; k < nwords; k++) {
      words.push(rng.random() < 0.45 ? rng.choice(MARKERS) : rng.choice(FILLER))
    }
    body.push(B(`\x1b[${y};1H`))
    let col = 1
    for (const w of words) {
      if (col >= cols - 2) break
      body.push(U(w))
      col += w.length + 1
      if (rng.random() < 0.5) {
        col += 1
        body.push(B(`\x1b[${Math.min(col, cols - 1)}G`))
      }
    }
    if (rng.random() < 0.35) {      // a styled region: not ours to paint
      const y2 = rng.randint(1, rows - 8)
      body.push(B(`\x1b[${y2};1H\x1b[38;2;177;185;249m`), U(rng.choice(MARKERS)), B("\x1b[39m"))
    }
    if (rng.random() < 0.25) {      // user message band
      const y3 = rng.randint(1, rows - 8)
      body.push(B(`\x1b[${y3};1H\x1b[48;2;55;55;55muser says `), U(rng.choice(FILLER)),
        B("\x1b[49m"))
    }
    if (rng.random() < 0.20) {      // erase a prose row
      body.push(B(`\x1b[${rng.randint(1, rows - 8)};1H\x1b[K`))
    }
    if (rng.random() < 0.15) {      // scroll the screen up one row
      body.push(B(`\x1b[${rows};1H\n`))
    }
    if (rng.random() < 0.10) {      // charset select / OSC title churn
      body.push(B(`\x1b(B\x1b]0;f${i}\x07`))
    }
    // the input box, redrawn with fresh typed content
    const typed = rng.choice([...MARKERS, ...FILLER])
    body.push(B(`\x1b[${boxTop};1H`), U("─".repeat(cols - 1)),
      U(`\x1b[${boxTyped};1H❯ ${typed}`),
      B(`\x1b[${boxLow};1H`), U("─".repeat(cols - 1)),
      B(`\x1b[${rows};1Hprobably v2.1.236`))
    parts.push(Buffer.concat([B("\x1b[?2026h"), ...body, B("\x1b[?2026l")]))
  }
  parts.push(B("\x1b[?1049l\n"))
  return parts
}

type Mode = "frames" | "blob" | "random" | "bytes"

/** Returns (out, screen, hl). */
function replay(frames: readonly Buffer[], mode: Mode, config: Config,
  rows = 24, cols = 80, seed = 1): [Buffer, ScreenModel, AnsiHighlighter] {
  const h2 = new AnsiHighlighter(ch.buildRules(config), true)
  h2.holdPrefixes = HL.growablePrefixes(ch.userFragments(config))
  const s = new ScreenModel(rows, cols, ch.paintPalette(config))
  const acc: Buffer[] = []
  const rng = makeRng(seed)
  if (mode === "frames") {
    for (const fr of frames) acc.push(s.reconcile(h2.feed(fr), h2.rules, h2.onlyUnstyled))
  } else if (mode === "blob") {
    acc.push(s.reconcile(h2.feed(Buffer.concat([...frames])), h2.rules, h2.onlyUnstyled))
  } else if (mode === "random") {
    const blob = Buffer.concat([...frames])
    let at = 0
    while (at < blob.length) {
      const n = rng.randint(1, 3000)
      const chunk = blob.subarray(at, at + n)
      at += n
      acc.push(s.reconcile(h2.feed(chunk), h2.rules, h2.onlyUnstyled))
      acc.push(s.reconcile(h2.drain(false), h2.rules, h2.onlyUnstyled))
    }
  } else {
    const blob = Buffer.concat([...frames])
    for (const byte of blob) acc.push(s.reconcile(h2.feed(Buffer.from([byte])), h2.rules, h2.onlyUnstyled))
  }
  acc.push(s.reconcile(h2.drain(true), h2.rules, h2.onlyUnstyled))
  return [Buffer.concat(acc), s, h2]
}

cfg = allOn(freshCfg())
let rng = makeRng(20260904)
const frames = genSession(rng)

// per-frame invariants in the realistic driving mode. Corrections rewrite
// cells the frame already wrote, so their text is excluded before the
// visible-bytes comparison; paint bytes are zero-width and strip out anyway.
const FIXBLOCK = /\x1b7\x1b\[\?7l[\s\S]*?\x1b\[\?7h\x1b8/g
const noFix = (b: Buffer): Buffer => B(b.toString("latin1").replace(FIXBLOCK, ""))

{
  const h2 = new AnsiHighlighter(ch.buildRules(cfg), true)
  h2.holdPrefixes = HL.growablePrefixes(ch.userFragments(cfg))
  const s = new ScreenModel(24, 80, ch.paintPalette(cfg))
  let checkpoints = 0, boxHits = 0, staleHits = 0, visBad = 0
  for (const fr of frames) {
    const got = s.reconcile(h2.feed(fr), h2.rules, h2.onlyUnstyled)
    if (!visible(noFix(got)).equals(visible(fr))) visBad += 1
    if (stale(s, h2.rules)) staleHits += 1
    for (const y of s.composerRows()) {
      for (let x = 0; x < s.cols; x++) if (s.ours[y]![x]) boxHits += 1
    }
    checkpoints += 1
  }
  report(`fuzz: ${checkpoints} frames, visible preserved throughout (${visBad} breaks)`,
    visBad === 0, visBad)
  report(`fuzz: no stale paint at any frame end (${staleHits} dirty checkpoints)`,
    staleHits === 0, staleHits)
  report("fuzz: nothing painted in the input box at any frame end", boxHits === 0, boxHits)
}

const snap = (s: ScreenModel): Json => [s.chars, s.fg, s.ours, s.x, s.y, s.alt]
const [, scrRef] = replay(frames, "frames", cfg)
const [, scrBlob] = replay(frames, "blob", cfg)
const [, scrRand] = replay(frames, "random", cfg)
const [, scrByte] = replay(frames, "bytes", cfg)
report("fuzz: one big blob lands the same screen as per-frame feeds",
  same(snap(scrBlob), snap(scrRef)), "")
report("fuzz: random chunk splits (with idle ticks) land the same screen",
  same(snap(scrRand), snap(scrRef)), "")
report("fuzz: byte-at-a-time lands the same screen",
  same(snap(scrByte), snap(scrRef)), "")

// hostile-but-well-formed corpus: escapes all terminated, so every byte of
// text must survive, chunked or not
const HOSTILE: Buffer[] = [
  B("\x1b[?1049h"), B("\x1b[2J"), B("\x1b[H"),
  B("\x1b[1;1Hplain likely text"),
  B("\x1b(B\x1b(B\x1b(0"),
  B("\x1b[2;1H\x1b[99999999999999999999mhuge param likely\x1b[m"),
  B("\x1b[3;1H\x1b[m\x1b[;m\x1b[0;0m\x1b[39;49m\x1b[38;5;250m\x1b[48;5;mlikely"),
  B("\x1b4;1H\x1b[38;2;1;2;3mtruecolor likely\x1b[39m"),
  B("\x1b]0;title\x07\x1b]2;x\x1b\\\x1b]8;;http://x/y?a=1\x1b\\link\x1b]8;;\x1b\\"),
  B("\x1bP+q544e\x1b\\\x1bP1;2q..\x1b\\"),
  B("\x1b[!p\x1b[>c\x1b[?1;2;3;4;5;6;7h\x1b[?2004h\x1b[?25l\x1b[?25h"),
  B("\x1b[?1049;25h\x1b[?12;25h\x1b[?2026h"),
  B("\x1b7\x1b[38;5;214m\x1b[2;1Hsave/restore \x1b8"),
  Buffer.concat([B("\x1b[1;1H"), B("\x08".repeat(20)), B("\t\t\t\t\t")]),
  B("\x1b[1;1H\x00\x00\x00probably\x07\x7f ok"),
  B("\x1b[1;1H\x9b\x1b[1;1H\xc3\xa9 caf\xc3\xa9"),
  Buffer.concat([B("\x1b[1;1H"), B("likely ".repeat(100))]),
  B("\x1b[1;1H[mostly](low certainty) end"),
  B("\x1b[999;999H\x1b[;5H\x1b[0G\x1b[3d\x1b[5;3r\x1b[r"),
  B("\x1b[1;1H\x1b[99P\x1b[99@\x1b[99L\x1b[99M\x1b[99S\x1b[99T\x1b[99X"),
  B("\x1b\x1b[2;1Hdouble esc"),
  B("\x1b[?2026l"), B("\x1b[?2026h"),
  B("\x1b[5;1Hfinal likely line"),
  B("\x1b[?2026l"),
]
let outB: Buffer = Buffer.alloc(0)
let snapH: Json
{
  const h2 = new AnsiHighlighter(ch.buildRules(cfg), true)
  h2.holdPrefixes = HL.growablePrefixes(ch.userFragments(cfg))
  const s = new ScreenModel(24, 80, ch.paintPalette(cfg))
  const whole = Buffer.concat(HOSTILE)
  let okVis = true, okRun = true
  let first: Buffer[] | string | null = null
  try {
    const acc: Buffer[] = []
    for (const chunk of HOSTILE) acc.push(s.reconcile(h2.feed(chunk), h2.rules, h2.onlyUnstyled))
    acc.push(s.reconcile(h2.drain(true), h2.rules, h2.onlyUnstyled))
    outB = Buffer.concat(acc)
    if (!visible(noFix(outB)).equals(visible(whole))) {
      okVis = false
      first = [visible(whole).subarray(0, 80), visible(noFix(outB)).subarray(0, 80)]
    }
  } catch (e) {
    okRun = false
    first = String(e)
  }
  report("hostile corpus: every visible byte preserved, no crash", okRun && okVis, first)
  report("hostile corpus: highlights still land (likely painted)",
    outB.includes(B("38;5;203")), "")
  snapH = snap(s)

  const h3 = new AnsiHighlighter(ch.buildRules(cfg), true)
  h3.holdPrefixes = HL.growablePrefixes(ch.userFragments(cfg))
  const s2 = new ScreenModel(24, 80, ch.paintPalette(cfg))
  for (const byte of whole) s2.reconcile(h3.feed(Buffer.from([byte])), h3.rules, h3.onlyUnstyled)
  s2.reconcile(h3.drain(true), h3.rules, h3.onlyUnstyled)
  report("hostile corpus: byte-at-a-time lands the same screen", same(snap(s2), snapH), "")
}

// truly random bytes: no crash, no hang, drains always terminate
rng = makeRng(99)
let crashes = 0
for (let trial = 0; trial < 60; trial++) {
  const n = rng.randint(200, 4000)
  const data = Buffer.from(Array.from({ length: n }, () => rng.randrange(256)))
  const h2 = new AnsiHighlighter(ch.buildRules(cfg), true)
  h2.holdPrefixes = HL.growablePrefixes(ch.userFragments(cfg))
  const mm = new ScreenModel(10, 60, ch.paintPalette(cfg))
  try {
    let at = 0
    while (at < data.length) {
      const step = rng.randint(1, 512)
      mm.reconcile(h2.feed(data.subarray(at, at + step)), h2.rules, h2.onlyUnstyled)
      h2.drain(false)
      at += step
    }
    h2.drain(true)
  } catch {
    crashes += 1
  }
}
report(`random bytes: 60 streams through filter+model, no crashes (${crashes})`,
  crashes === 0, "")

// and the same random bytes through the model alone, whole vs split:
// pending-sequence handling must be chunk-consistent even for garbage
rng = makeRng(7)
let mismatches = 0
for (let trial = 0; trial < 20; trial++) {
  const data = Buffer.from(Array.from({ length: 1500 }, () => rng.randrange(256)))
  const a = new ScreenModel(10, 60, [])
  a.feed(data)
  const b2 = new ScreenModel(10, 60, [])
  for (const byte of data) b2.feed(Buffer.from([byte]))
  if (!same([a.chars, a.x, a.y], [b2.chars, b2.x, b2.y])) mismatches += 1
}
report(`random bytes: model chunk-consistency on garbage (${mismatches} mismatches)`,
  mismatches === 0, "")

// == 10. resume-hint rewrite, through the real build_rewrites ================

const HINT = B("\x1b[2mResume this session with:\x1b[22m\r\n"
  + "\x1b[2mclaude --resume eb1737b1-6302-4436-945c-034cdfad668e\x1b[22m\r\n")
const rw = ch.buildRewrites()
report("rewrite: build_rewrites uses self_name()",
  rw.length === 1 && B(rw[0]!.repl).equals(U(ch.selfName())), rw)
;[run, force, hl, scr] = pipeline({ rewrites: rw, rules: [], pfx: new Set<string>(), pal: new Set<string>() })
out = Buffer.concat([run(Buffer.concat([B("\x1b[?1049l"), HINT.subarray(0, 20)])),
  force(HINT.subarray(20))])
const name = U(ch.selfName())
report("rewrite: resume hint rewritten exactly once, across a mid-word split",
  count(out, Buffer.concat([name, B(" --resume")])) === 1
  && !out.includes(B("claude --resume")), out)
;[run, force, hl, scr] = pipeline({ rewrites: rw, rules: [], pfx: new Set<string>(), pal: new Set<string>() })
out = force(Buffer.concat([B("\x1b[?1049h"), HINT, B("\x1b[?1049l"),
  B("\x1b[1;1Hclaude code rocks")]))
report("rewrite: suppressed in the alt screen, other 'claude' text untouched",
  out.includes(B("claude --resume"))
  && count(out, Buffer.concat([name, B(" --resume")])) === 0
  && out.includes(B("claude code rocks")), out)

finish()
