#!/usr/bin/env node
/** Tests for the shadow screen: a highlight must be takeable-back.
 *
 * The bug these cover: Claude Code repaints with a cell-level diff, so a cell it
 * skips keeps a colour we injected in an earlier frame -- a single amber letter
 * left inside a word that never earned it.
 *
 * Ported from test_screen.py -- same 28 checks, same order, same names. The
 * Python original exec'd the `claude-highlight` script to borrow load_config /
 * build_rules / paint_palette; here those are plain imports from the ported
 * wrapper. The final chunk-splitting check draws from a seeded mulberry32
 * instead of Python's Mersenne Twister, so the split points differ from the
 * Python run but are fixed here. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { AnsiHighlighter } from "../src/highlight_filter.ts"
import { growablePrefixes } from "../src/hedge_lexicon.ts"
import { ScreenModel, cellWidth } from "../src/screen_model.ts"
import { report, finish, B } from "./harness.ts"
import type { Json } from "../src/json.ts"

// Every category on, in a config of our own.
//
// The Python original read whatever config the developer happened to have, and
// several checks here only mean anything when the category their fixture word
// belongs to is enabled -- on a machine with the defaults, where modal,
// vagueness and softener are off, the Python suite raises ValueError partway
// through. Pinning the config is what makes this suite say the same thing on
// any machine, CI included.
const TMP = mkdtempSync(join(tmpdir(), "hl-screen-"))
mkdirSync(join(TMP, "claude-highlight"), { recursive: true })
writeFileSync(join(TMP, "claude-highlight", "config.json"), JSON.stringify({
  categories: Object.fromEntries(["inference", "unknown", "assumption", "appearance",
    "overclaim", "modal", "vagueness", "softener"].map(c => [c, { on: true }])),
}))
process.env["XDG_CONFIG_HOME"] = TMP
// Dynamic, so the assignment above lands before CONFIG is resolved at the
// wrapper's module top level -- a static import would be hoisted past it.
const ch = await import("../src/claude-highlight.ts")

const CFG = ch.loadConfig()
const RULES = ch.buildRules(CFG)
const PALETTE = ch.paintPalette(CFG)

// --- small helpers the Python got from the language -------------------------
/** Python's b"..." is `B`; this is a str.encode() (UTF-8). */
const U = (s: string): Buffer => Buffer.from(s, "utf8")

/** `"".join(c or " " for c in row).rstrip()` */
const rowText = (row: readonly (string | null)[]): string =>
  row.map(c => (c ? c : " ")).join("").replace(/\s+$/u, "")

/** `[x for x in range(n) if ours[y][x]]` */
const painted = (m: ScreenModel, y: number, n: number): number[] => {
  const out: number[] = []
  for (let x = 0; x < n; x++) if (m.ours[y]![x]) out.push(x)
  return out
}

const anyOurs = (m: ScreenModel, y: number): boolean => m.ours[y]!.some(v => v)

/** Python's bytes.count: non-overlapping occurrences. */
function count(hay: Buffer, needle: Buffer): number {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n += 1
  return n
}

/** `a.index(x) < a.index(y)`; the Python raised when either was absent, so an
 * absent marker is a failure here rather than a silent -1 win. */
function before(hay: Buffer, first: Buffer, second: Buffer): boolean {
  const a = hay.indexOf(first), b = hay.indexOf(second)
  return a !== -1 && b !== -1 && a < b
}

const same = (a: Json | undefined, b: Json | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const range = (a: number, b: number): number[] => {
  const out: number[] = []
  for (let i = a; i < b; i++) out.push(i)
  return out
}

type Runner = (data: Buffer) => Buffer

/** Filter plus model, wired the way claude-highlight wires them. */
function wrapper(cols = 40, rows = 5): [Runner, ScreenModel] {
  const hl = new AnsiHighlighter([...RULES], true)
  hl.holdPrefixes = growablePrefixes()
  const screen = new ScreenModel(rows, cols, PALETTE)
  return [(data: Buffer) => screen.reconcile(hl.feed(data), hl.rules, hl.onlyUnstyled), screen]
}

const frame = (body: Buffer): Buffer =>
  Buffer.concat([B("\x1b[?2026h"), body, B("\x1b[?2026l")])

// -- 1. the reported bug -----------------------------------------------------
// "the tests mostly pass" is painted, then the child rewrites the word as
// "Hover!" -- skipping the 'o', which it knows is already on screen.
let [run, screen] = wrapper()
run(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1Hthe tests mostly pass"))]))
const paintedCells = painted(screen, 0, 40)
report("streamed match is painted", same(paintedCells, range(10, 16)),
  `painted=${JSON.stringify(paintedCells)}`)

const out2 = run(frame(B("\x1b[1;11HH\x1b[1Cver!")))
const line = rowText(screen.chars[0]!)
report("child's cell diff lands as written", line === "the tests Hover! pass", line)
report("stale colour is taken back", !anyOurs(screen, 0), painted(screen, 0, 40))
report("correction rewrites exactly the skipped cell",
  out2.includes(B("\x1b[1;12H\x1b[39mo")), out2)
report("correction sits inside the frame's sync block",
  before(out2, B("\x1b7"), B("\x1b[?2026l")), out2)
report("cursor and autowrap are put back",
  count(out2, B("\x1b7")) === 1 && count(out2, B("\x1b8")) === 1
  && out2.includes(B("\x1b[?7l")) && out2.includes(B("\x1b[?7h")), out2)

// -- 2. a live match is left alone -------------------------------------------
;[run, screen] = wrapper()
let out = run(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1Hthe tests mostly pass"))]))
report("no correction while the match still holds", !out.includes(B("\x1b7")), out)
out = run(frame(B("\x1b[1;1Hthe tests mostly pass")))
report("redrawing the same text corrects nothing", !out.includes(B("\x1b7")), out)

// -- 3. corrections never move a cell ----------------------------------------
// Same characters, same columns: only an attribute changes.
;[run, screen] = wrapper()
run(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1Hthe tests mostly pass"))]))
const corrected = run(frame(B("\x1b[1;11HH\x1b[1Cver!")))
const plain = new ScreenModel(5, 40, PALETTE)
plain.feed(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1Hthe tests mostly pass")),
  frame(B("\x1b[1;11HH\x1b[1Cver!"))]))
const after = new ScreenModel(5, 40, PALETTE)
after.feed(Buffer.concat([B("\x1b[?1049h"), frame(B("\x1b[1;1Hthe tests mostly pass")),
  corrected]))
report("screen text identical with and without corrections",
  same(plain.chars, after.chars),
  after.chars.map((r, y) => [y, rowText(r)]).slice(0, 2))
report("cursor identical with and without corrections",
  plain.x === after.x && plain.y === after.y, [plain.x, plain.y], [after.x, after.y])

// -- 4. columns, not bytes ---------------------------------------------------
report("wide characters are two columns",
  cellWidth("世") === 2 && cellWidth("a") === 1 && cellWidth("́") === 0)
let m = new ScreenModel(3, 20, PALETTE)
m.feed(Buffer.concat([B("\x1b[?1049h\x1b[1;1H"), U("世界x")]))
report("a column after a wide pair is where the terminal puts it",
  m.chars[0]![4] === "x", m.chars[0]!.slice(0, 6))
;[run, screen] = wrapper()
run(Buffer.concat([B("\x1b[?1049h"), frame(U("\x1b[1;1H世界 mostly pass"))]))
report("a match after a wide pair is painted at the right columns",
  same(painted(screen, 0, 40), range(5, 11)), painted(screen, 0, 40))
out = run(frame(U("\x1b[1;6HH\x1b[1Cver!")))
report("and corrected at the right columns", out.includes(B("\x1b[1;7H\x1b[39mo")), out)

// -- 5. cells the child owns are never rewritten -----------------------------
;[run, screen] = wrapper()
run(Buffer.concat([B("\x1b[?1049h"),
  frame(B("\x1b[1;1H\x1b[38;2;177;185;249mmostly\x1b[39m in code"))]))
report("code-coloured text is not ours to paint", !anyOurs(screen, 0))
out = run(frame(B("\x1b[1;1H\x1b[38;2;177;185;249mHover!\x1b[39m in code")))
report("...nor ours to correct", !out.includes(B("\x1b7")), out)

// -- 6. nothing is painted inside the input box ------------------------------
// Claude Code draws what you type at the default foreground, in the same layout
// as prose, so only the screen can tell them apart.
const RULE = "─".repeat(60)

const composerScreen = (typed: string): Buffer =>
  frame(Buffer.concat([U("\x1b[1;1Hthe tests mostly pass"),
    U(`\x1b[3;1H${RULE}\x1b[4;1H❯ ${typed}\x1b[5;1H${RULE}`)]))

;[run, screen] = wrapper(60, 6)
out = run(Buffer.concat([B("\x1b[?1049h"), composerScreen("this usually works")]))
report("the input box is found", same(screen.composerRows(), [2, 3, 4, 5]),
  screen.composerRows())
report("prose above the box is still painted",
  same(painted(screen, 0, 60), range(10, 16)), painted(screen, 0, 60))
report("nothing typed in the box keeps a colour", !anyOurs(screen, 3),
  rowText(screen.chars[3]!))
report("the correction lands before the frame is presented",
  before(out, B("\x1b7"), B("\x1b[?2026l")), out.subarray(out.length - 120))
report("the box's own text is left exactly as the child wrote it",
  rowText(screen.chars[3]!) === "❯ this usually works", rowText(screen.chars[3]!))

// a word typed one keystroke at a time, the way the child actually echoes it
;[run, screen] = wrapper(60, 6)
run(Buffer.concat([B("\x1b[?1049h"), composerScreen("")]))
{
  let i = 0
  for (const c of "usually fine") {
    run(frame(U(`\x1b[4;${3 + i}H${c}`)))
    i += 1
  }
}
report("...and still nothing after typing it letter by letter",
  !anyOurs(screen, 3), rowText(screen.chars[3]!))

// text released by the idle flush lands after the frame that carried it, so the
// correction cannot ride inside a sync block -- it still has to happen.
{
  const hl = new AnsiHighlighter([...RULES], true)
  hl.holdPrefixes = growablePrefixes()
  const scr = new ScreenModel(6, 60, PALETTE)
  scr.reconcile(hl.feed(Buffer.concat([B("\x1b[?1049h"), composerScreen("")])),
    hl.rules, hl.onlyUnstyled)
  const held = scr.reconcile(hl.feed(frame(B("\x1b[4;3Hthis usually"))),
    hl.rules, hl.onlyUnstyled)
  const drained = scr.reconcile(hl.drain(true), hl.rules, hl.onlyUnstyled)
  report("a word released by the idle flush is corrected too",
    !anyOurs(scr, 3), rowText(scr.chars[3]!),
    held.subarray(held.length - 80), drained)
}

// -- 7. ESC ( B is three bytes -----------------------------------------------
m = new ScreenModel(3, 20, PALETTE)
m.feed(B("\x1b[?1049h\x1b[1;1H\x1b(B\x0fhello"))
report("charset selects leave nothing on screen",
  rowText(m.chars[0]!) === "hello", rowText(m.chars[0]!))

// -- 8. a sequence cut in half by a chunk boundary ---------------------------
// The wrapper feeds whatever a 64 KB read returns, so every escape and every
// multi-byte character can arrive in two pieces.
const sample = U("\x1b[?1049h\x1b[1;1H世界 mostly pass\x1b]0;title\x07"
  + "\x1b[2;1H\x1b[38;2;177;185;249mcode\x1b[39m café — seems fine"
  + "\x1b[?2026h\x1b[1;7HH\x1b[1Cver!\x1b[?2026l")
const whole = new ScreenModel(5, 40, PALETTE); whole.feed(sample)
const split = new ScreenModel(5, 40, PALETTE)
for (const b of sample) split.feed(Buffer.from([b]))
report("byte-at-a-time feed matches a single feed",
  same([whole.chars, whole.fg, whole.x, whole.y],
    [split.chars, split.fg, split.x, split.y]),
  rowText(split.chars[0]!), rowText(whole.chars[0]!))

// -- 9. end to end over a recorded session -----------------------------------
// Replays a real capture and asserts no cell is left carrying a colour its row
// no longer justifies. Skipped when there is no recording to hand.

/** The size the capture ran at, read back off its own cursor addressing. */
function recordedSize(data: Buffer): [number, number] {
  const s = data.toString("latin1")
  let rows = 0, cols = 0
  for (const mm of s.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
    rows = Math.max(rows, parseInt(mm[1]!, 10))
    cols = Math.max(cols, parseInt(mm[2]!, 10))
  }
  for (const mm of s.matchAll(/\x1b\[(\d+)G/g)) cols = Math.max(cols, parseInt(mm[1]!, 10))
  return [rows || 24, cols || 80]
}

/** Deterministic stand-in for Python's random.Random(11). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rec = join(homedir(), "frag.raw")
if (existsSync(rec)) {
  const data = readFileSync(rec)
  const [ROWS, COLS] = recordedSize(data)
  const hl = new AnsiHighlighter([...RULES], true)
  hl.holdPrefixes = growablePrefixes()
  const scr = new ScreenModel(ROWS, COLS, PALETTE)
  // Checked at frame ends only: that is what the terminal presents. Mid-frame
  // a row is legitimately half-rewritten, and the correction has not run yet.
  const pieces: Buffer[] = []
  let at = 0
  for (const mm of data.toString("latin1").matchAll(/\x1b\[\?2026l/g)) {
    const end = mm.index + mm[0].length
    pieces.push(data.subarray(at, end)); at = end
  }
  pieces.push(data.subarray(at))
  let checkpoints = 0, stale = 0, typed = 0
  for (const piece of pieces) {
    scr.reconcile(hl.feed(piece), hl.rules, hl.onlyUnstyled)
    checkpoints += 1
    for (const y of scr.composerRows()) {
      for (let x = 0; x < scr.cols; x++) if (scr.ours[y]![x]) typed += 1
    }
    for (let y = 0; y < scr.rows; y++) {
      if (!anyOurs(scr, y)) continue
      const want = scr.desired(y, hl.rules, hl.onlyUnstyled)
      for (let x = 0; x < scr.cols; x++) {
        if (scr.ours[y]![x] && scr.fg[y]![x] !== want[x]) stale += 1
      }
    }
  }
  report(`recorded session: no stale paint at any of ${checkpoints} checkpoints`,
    stale === 0, `stale cells=${stale}`)
  report(`recorded session (${ROWS}x${COLS}): nothing painted in the input box`,
    typed === 0, `painted cells inside the box=${typed}`)

  // Same capture, arbitrary chunk sizes: the screen must land identically.
  const rng = mulberry32(11)
  const head = data.subarray(0, 400_000)
  const one = new ScreenModel(ROWS, COLS, PALETTE); one.feed(head)
  const many = new ScreenModel(ROWS, COLS, PALETTE)
  let cut = 0
  while (cut < head.length) {
    const step = 1 + Math.floor(rng() * 5000)
    many.feed(head.subarray(cut, cut + step)); cut += step
  }
  report("recorded session: random chunk splits land the same screen",
    same([one.chars, one.fg, one.x, one.y], [many.chars, many.fg, many.x, many.y]),
    `cursor ${one.x},${one.y} vs ${many.x},${many.y}`)
} else {
  console.log("SKIP  recorded session (no ~/frag.raw)")
}

finish()
