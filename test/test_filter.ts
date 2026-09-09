#!/usr/bin/env node
/** Invariant tests for the stream filter. The one that matters is the last:
 * printable cell count must be identical before and after.
 *
 * Ported from test_filter.py -- same 28 checks, same order, same names. The
 * fuzz section draws from a seeded mulberry32 instead of Python's Mersenne
 * Twister, so the streams differ from the Python run but are fixed here. */
import { AnsiHighlighter } from "../src/highlight_filter.ts"
import type { Rule, Rewrite } from "../src/rules.ts"
import { LEXICON, growablePrefixes } from "../src/hedge_lexicon.ts"
import { report, finish, B, visible } from "./harness.ts"

const COLOR = B("\x1b[38;5;203m")
const RULES: Rule[] = [{ pat: /\b(?:likely|probably|assuming)\b/gi, style: COLOR }]

/** LEXICON is an index signature, so every lookup is possibly-undefined. */
const cat = (name: string): readonly string[] => LEXICON[name] ?? []

/** `\b(?:a|b|c)\b`, case-insensitive, over one lexicon category. */
const catRule = (name: string, style: Buffer): Rule => ({
  pat: new RegExp("\\b(?:" + cat(name).join("|") + ")\\b", "gi"),
  style,
})

function run(chunks: readonly Buffer[]): Buffer {
  const h = new AnsiHighlighter([...RULES])
  const parts = chunks.map(c => h.feed(c))
  parts.push(h.drain())
  return Buffer.concat(parts)
}

function check(name: string, chunks: readonly Buffer[], wantColor = true): void {
  const src = Buffer.concat([...chunks])
  const out = run(chunks)
  const same = visible(src).equals(visible(out))
  const colored = out.includes(COLOR)
  const ok = same && colored === wantColor
  report(name, ok, `in  ${JSON.stringify(src.toString("latin1"))}`,
    `out ${JSON.stringify(out.toString("latin1"))}`,
    `visible-equal=${same} colored=${colored} want=${wantColor}`)
}

check("plain match", [B("that is likely true")])
check("split mid-word", [B("that is lik"), B("ely true")])
check("split every byte", [...B("it is probably fine")].map(c => Buffer.from([c])))
check("no partial-word FP", [B("unlikelyhood of it")], false)
check("word at chunk end", [B("seems likely")], true)
// Colored foreground means code / chrome, not prose -- must not be painted.
check("skips syntax-colored text", [B("\x1b[1;32mlikely\x1b[0m ok")], false)
check("skips inline-code fg", [B("\x1b[38;2;177;185;249mlikely\x1b[39m")], false)
check("skips user-message background",
  [B("\x1b[48;2;55;55;55mit is likely fine\x1b[49m")], false)
check("paints bold prose", [B("\x1b[1mlikely\x1b[22m done")])
check("paints again after fg resets", [B("\x1b[32mcode\x1b[39m then likely prose")])
check("split escape seq", [B("\x1b[3"), B("9mlikely done")])
check("cursor moves preserved", [B("\x1b[2J\x1b[10;5Hlikely\x1b[H"), B("assuming\r\n")])
check("osc title untouched", [B("\x1b]0;probably a title\x07visible likely here")])
check("no match", [B("nothing to see here")], false)

// The invariant, hammered: random ANSI-ish traffic, random chunk splits.
// A seeded PRNG so the suite is deterministic run to run.
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
const rnd = mulberry32(7)
const choice = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T
/** k distinct values from range(n) -- Python's random.sample. */
function sample(n: number, k: number): number[] {
  const pool = Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  for (let i = 0; i < k; i++) {
    const j = Math.floor(rnd() * pool.length)
    out.push(pool[j] as number)
    pool[j] = pool[pool.length - 1] as number
    pool.pop()
  }
  return out
}

const words = [B("likely"), B("maybe"), B("assuming"), B("code"), B("\x1b[31m"),
  B("\x1b[0m"), B("\x1b[12;40H"), B("\n"), B(" "), B("\x1b]0;t\x07"),
  B("probably"), B("x")]
let bad = 0
let firstFail: Buffer | null = null
for (let trial = 0; trial < 400; trial++) {
  const src = Buffer.concat(Array.from({ length: 40 }, () => choice(words)))
  const cuts = sample(src.length + 1, Math.min(8, src.length)).sort((a, b) => a - b)
  const chunks: Buffer[] = []
  let prev = 0
  for (const c of [...cuts, src.length]) {
    chunks.push(src.subarray(prev, c))
    prev = c
  }
  if (!visible(run(chunks)).equals(visible(src))) {
    bad += 1
    if (bad === 1) firstFail = src.subarray(0, 120)
  }
}
report(`fuzz: 400 random streams, arbitrary chunk splits (${bad} mismatches)`, bad === 0,
  ...(firstFail ? ["first failing src:", firstFail] : []))

// --- regressions for the "seems" bug -------------------------------------
// A match that ends in a space needs a following word character to satisfy the
// trailing \b -- but the filter holds trailing word chars back across chunks,
// so such a term silently never highlights while streaming.
const spaceEnding: string[] = []
for (const [c, terms] of Object.entries(LEXICON)) {
  for (const t of terms) if (/ \(\?:[^)]*\)\?$/.test(t)) spaceEnding.push(`${c}:${t}`)
}
report("no lexicon term can match ending in a space", spaceEnding.length === 0, ...spaceEnding)

// The failure as it actually occurred: text streamed in pieces, with an idle
// drain between them, so the word after "seems" is not in the paint buffer.
const APPEAR_STYLE = B("\x1b[38;5;179m")
const APPEAR: Rule[] = [catRule("appearance", APPEAR_STYLE)]
const SEEMS_CASES: Array<[string, Buffer[]]> = [
  ["streamed word-by-word", [B("it "), B("seems"), B(" fine "), B("here")]],
  ["drained mid-sentence", [B("it seems"), B(" fine")]],
  ["end of message", [B("that seems")]],
]
for (const [label, chunks] of SEEMS_CASES) {
  const h = new AnsiHighlighter([...APPEAR])
  const parts: Buffer[] = []
  for (const c of chunks) {
    parts.push(h.feed(c))
    parts.push(h.drain()) // simulate the 20 ms idle flush
  }
  parts.push(h.drain())
  const out = Buffer.concat(parts)
  report(`seems highlights when ${label}`, out.includes(APPEAR_STYLE),
    `out ${JSON.stringify(out.toString("latin1"))}`)
}

// --- resume-hint rewrite, using the exact bytes Claude Code emits ----------
const HINT = B("\x1b[2mResume this session with:\x1b[22m\r\n"
  + "\x1b[2mclaude --resume eb1737b1-6302-4436-945c-034cdfad668e\x1b[22m\r\n")
const RESUME_RW = (): Rewrite[] => [{ pat: /\bclaude(?= --resume\b)/g, repl: "claude-highlight" }]

const h1 = new AnsiHighlighter([], true)
h1.rewrites = RESUME_RW()
const out1 = Buffer.concat([h1.feed(Buffer.concat([B("\x1b[?1049l"), HINT])), h1.drain()])
report("resume hint rewritten on the normal screen",
  out1.includes(B("claude-highlight --resume eb1737b1")),
  `out ${JSON.stringify(out1.toString("latin1"))}`)

// Same text inside the alt screen must be left alone: changing length there
// would shift every cell the TUI has already placed.
const h2 = new AnsiHighlighter([], true)
h2.rewrites = RESUME_RW()
const out2 = Buffer.concat([h2.feed(Buffer.concat([B("\x1b[?1049h"), HINT])), h2.drain()])
report("rewrite suppressed inside the alt screen",
  !out2.includes(B("claude-highlight")) && out2.includes(B("claude --resume")),
  `out ${JSON.stringify(out2.toString("latin1"))}`)

// --- multi-word terms must survive any chunk boundary ---------------------
// Streaming splits phrases constantly. Holding only partial *words* lost
// "can't tell" at 10 of 29 split points; holding anything that could still
// grow into a match -- without ever cutting through a match already present --
// takes that to zero.
const PFX = growablePrefixes()
const CATS: Array<[string, Buffer]> = [
  ["unknown", B("\x1b[38;5;170m")], ["inference", B("\x1b[38;5;203m")],
  ["overclaim", B("\x1b[38;5;51m")], ["appearance", B("\x1b[38;5;179m")],
  ["assumption", B("\x1b[38;5;214m")],
]
const PHRASE_RULES: Rule[] = CATS.map(([c, col]) => catRule(c, col))

function stream(text: Buffer, cut: number): Buffer {
  const h = new AnsiHighlighter([...PHRASE_RULES])
  h.holdPrefixes = PFX
  return Buffer.concat([h.feed(text.subarray(0, cut)), h.drain(false),
    h.feed(text.subarray(cut)), h.drain(true)])
}

const PHRASES = [B("I can't tell whether it works."), B("There is no way to know for sure."),
  B("As far as I can tell it holds."), B("It never fails in practice."),
  B("That is most likely correct."), B("I haven't verified the claim."),
  B("On the surface it seems to hold."), B("You should be fine, in theory."),
  B("Just add a rule and it works."), B("I'd need to check that first.")]
let totalSplits = 0
let missed = 0
let firstMiss: string | null = null
for (const ph of PHRASES) {
  for (let i = 1; i < ph.length; i++) {
    totalSplits += 1
    const out = stream(ph, i)
    if (!CATS.some(([, c]) => out.includes(c))) {
      missed += 1
      if (missed === 1) {
        firstMiss = `first miss: ${JSON.stringify(ph.subarray(0, i).toString("latin1"))}`
          + ` | ${JSON.stringify(ph.subarray(i).toString("latin1"))}`
      }
    }
  }
}
report(`phrases survive all ${totalSplits} chunk splits (${missed} missed)`, missed === 0,
  ...(firstMiss ? [firstMiss] : []))

// The hold must not stall a term that cannot grow: "likely" paints on the
// short tick, without waiting for the force flush.
const h3 = new AnsiHighlighter([...PHRASE_RULES])
h3.holdPrefixes = PFX
const out3 = Buffer.concat([h3.feed(B("that is likely fine ")), h3.drain(false)])
report("non-growable term paints on the short tick", out3.includes(B("38;5;203")))

// --- phrases split by cursor-positioning escapes ---------------------------
// Claude Code lays prose out word by word ("PROSE ESC[9G it ESC[12G seems"),
// so a phrase is routinely severed by an escape rather than a chunk boundary.
// ~a third of word transitions in a real capture used a cursor jump.
const LAYOUT: Array<[string, Buffer, boolean]> = [
  ["word-positioned (CHA)", B("I\x1b[3Gcan't\x1b[9Gtell\x1b[14Gwhether it works."), true],
  ["cursor-forward (CUF)", B("I\x1b[1Ccan't\x1b[1Ctell\x1b[1Cwhether it works."), true],
  ["contiguous", B("I can't tell whether it works."), true],
  ["inside code colour", B("\x1b[32mI can't tell whether it works.\x1b[39m"), false],
  ["inside user-msg bg", B("\x1b[48;2;55;55;55mI can't tell here\x1b[49m"), false],
]
for (const [name, src, want] of LAYOUT) {
  const h = new AnsiHighlighter([...PHRASE_RULES])
  h.holdPrefixes = PFX
  const out = Buffer.concat([h.feed(src), h.drain(true)])
  const painted = CATS.some(([, c]) => out.includes(c))
  const ok = painted === want && visible(out).equals(visible(src))
  report(`layout: ${name} (painted=${painted}, want=${want})`, ok,
    `out ${JSON.stringify(out.toString("latin1"))}`)
}

finish()
