/** ANSI-aware stream filter: colorize words without disturbing layout.
 *
 * The whole approach rests on one property: SGR sequences are zero-width. A
 * full-screen TUI positions its cursor by counting printable cells, so injecting
 * `ESC[38;5;203m` into the stream changes what a cell looks like but not where
 * any cell lands. Claude Code can redraw over us all it likes and never notice.
 *
 * Two things make it non-trivial:
 *
 *   * A match can straddle a write() boundary. Token streaming means "likely"
 *     routinely arrives as "lik" then "ely", so any trailing word characters are
 *     held back until the next chunk (or a short timeout) resolves them.
 *   * Escape sequences must never be matched inside. The filter is a small
 *     state machine that only runs the regex over ground-state text, and passes
 *     CSI/OSC/DCS bytes through untouched.
 *
 * It also tracks foreground/background so it can tell prose from everything
 * else. Measured from a real Claude Code render:
 *
 *     region          background        foreground
 *     user message    48;2;55;55;55     white
 *     plain prose     default           default
 *     bold prose      default           default
 *     list item       default           default
 *     inline code     default           38;2;177;185;249
 *     fenced code     default           32
 *
 * So "foreground and background are both default" selects assistant prose and
 * nothing else -- user messages, code, and tool chrome all carry a color. That
 * is what `onlyUnstyled` enforces. It also makes restoring trivial: since we
 * only paint over default foreground, ESC[39m puts things back exactly, without
 * disturbing bold or any background the app set.
 *
 * Ported from highlight_filter.py. Bytes are Buffers; the bytes regexes run
 * over the latin1 view of a Buffer, where byte offsets equal char offsets, so a
 * match index slices the Buffer directly.
 */
import type { Rule, Rewrite } from "./rules.ts"
import { decodeIgnore } from "./util.ts"

// --- ANSI parser states -----------------------------------------------------
// A string union rather than an enum: the tsconfig forbids anything that is not
// erasable, and these names only ever need to compare equal to each other.
type State = "GROUND" | "ESC" | "CSI" | "OSC" | "DCS" | "ESCI"

const WORD_TAIL = /[A-Za-z0-9'_-]+$/
// Claude Code lays prose out word by word, jumping the cursor between words:
//   ESC[39m PROSE ESC[9G it ESC[12G seems ESC[18G likely
// Those jumps are visually just the space between words, so text either side of
// one is contiguous on screen. Flushing at every escape (the obvious approach)
// therefore severs any phrase laid out this way -- measured at ~a third of all
// word transitions. These two are treated as one space and matched across.
const TRANSPARENT = /^\x1b\[\d*[GC]$/
const MAX_HOLD = 48 // longest text we will wait on across a chunk boundary

const EMPTY = Buffer.alloc(0)
const SPACE = Buffer.from(" ", "latin1")

/** One piece of the stream since the last real flush.
 *
 * `kind` is "t" for screen text, "jump" for a cursor move that reads as one
 * space, "sgr" for a colour change (zero width). `styled` records the fg/bg
 * that was active while that text was written -- style is per segment, not per
 * flush, so a batch containing several colour changes stays accurate.
 */
type SegKind = "t" | "jump" | "sgr"
interface Seg {
  readonly data: Buffer
  readonly kind: SegKind
  readonly styled: boolean
}

interface Match {
  readonly start: number
  readonly end: number
}

/** All matches of `pat` in `s`, as offsets -- Python's `pat.finditer`.
 *
 * Materialised into an array so that a shared "g" regex's lastIndex can never
 * leak between two loops over the same rule.
 */
function finditer(pat: RegExp, s: string): Match[] {
  const re = pat.global ? pat : new RegExp(pat.source, pat.flags + "g")
  re.lastIndex = 0
  const out: Match[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) re.lastIndex += 1 // never spin on a zero-width match
  }
  return out
}

/** Python's `bytes.decode("ascii", "replace")`: every byte >= 0x80 becomes
 * U+FFFD, which is never a digit and so never a parameter. */
function asciiReplace(b: Buffer): string {
  return b.toString("latin1").replace(/[\u0080-\u00ff]/g, "\ufffd")
}

const isDigits = (s: string): boolean => /^[0-9]+$/.test(s)

export class AnsiHighlighter {
  /** Rules in priority order; each `pat` is compiled with the "gi" flags. */
  rules: Rule[]
  /** Paint only where both fg and bg are the terminal default, which is
   * exactly where assistant prose lives. */
  onlyUnstyled: boolean
  /** Rewrites may change text length, so they are only applied on the normal
   * screen (after the TUI exits the alternate screen). Inside the alt screen
   * the child has already computed its wrapping, and adding or removing a
   * character would shift every cell after it. */
  rewrites: Rewrite[] = []
  alt = false
  /** Text that could still grow into a match (see hedge_lexicon
   * .growablePrefixes). Without this only partial *words* are held, so any
   * chunk gap inside a phrase like "can't tell" destroys the match --
   * measured at 10 of 29 split points for that one phrase. */
  holdPrefixes: Set<string> | null = null

  private readonly restore = Buffer.from("\x1b[39m", "latin1") // back to default fg; leaves bold/bg alone
  private state: State = "GROUND"
  private raw: number[] = [] // partial escape sequence carried across chunks
  private text: number[] = [] // current run of ground-state text
  private segs: Seg[] = []
  private fg: string | null = null
  private bg: string | null = null

  constructor(rules: Rule[], onlyUnstyled = true) {
    this.rules = rules
    this.onlyUnstyled = onlyUnstyled
  }

  // -- SGR bookkeeping ----------------------------------------------------
  /** Track fg/bg across a full CSI sequence (final byte included). */
  private noteSgr(seq: Buffer): void {
    if (seq[seq.length - 1] !== 0x6d) return // not "m"
    const params = asciiReplace(seq.subarray(2, seq.length - 1))
    const toks = params ? params.split(";") : ["0"]
    let i = 0
    while (i < toks.length) {
      const t = toks[i] || "0"
      const n = isDigits(t) ? Number(t) : -1
      if (n === 0) {
        this.fg = null
        this.bg = null
      } else if (n === 39) {
        this.fg = null
      } else if (n === 49) {
        this.bg = null
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        this.fg = t
      } else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
        this.bg = t
      } else if (n === 38 || n === 48) {
        const attr = n === 38 ? "fg" : "bg"
        if (i + 1 < toks.length && toks[i + 1] === "5") {
          this[attr] = toks.slice(i, i + 3).join(";")
          i += 2
        } else if (i + 1 < toks.length && toks[i + 1] === "2") {
          this[attr] = toks.slice(i, i + 5).join(";")
          i += 4
        }
      }
      i += 1
    }
  }

  /** Track the alternate screen (ESC[?1049h / l, and the older ?47/?1047). */
  private noteMode(seq: Buffer): void {
    const last = seq[seq.length - 1]
    if ((last !== 0x68 && last !== 0x6c) || !seq.includes(0x3f)) return // "h"/"l" and "?"
    const nums = asciiReplace(seq.subarray(3, seq.length - 1)).split(";")
    if (nums.some(n => n === "1049" || n === "1047" || n === "47")) this.alt = last === 0x68
  }

  // -- highlighting -------------------------------------------------------
  private pushText(): void {
    if (this.text.length) {
      const styled = this.fg !== null || this.bg !== null
      this.segs.push({ data: Buffer.from(this.text), kind: "t", styled })
      this.text = []
    }
  }

  private static width(kind: SegKind, data: Buffer): number {
    return kind === "t" ? data.length : kind === "jump" ? 1 : 0
  }

  /** Screen text: a cursor jump reads as one space, an SGR as nothing. */
  private static visible(segs: readonly Seg[]): Buffer {
    return Buffer.concat(
      segs.map(s => (s.kind === "t" ? s.data : s.kind === "jump" ? SPACE : EMPTY)),
    )
  }

  /** Split segments at a visible offset. Non-text segments are atomic. */
  private static split(segs: readonly Seg[], vpos: number): [Seg[], Seg[]] {
    const before: Seg[] = []
    const after: Seg[] = []
    let seen = 0
    for (const s of segs) {
      const width = AnsiHighlighter.width(s.kind, s.data)
      if (seen >= vpos && width) {
        after.push(s)
      } else if (seen + width <= vpos) {
        before.push(s)
      } else if (s.kind !== "t") {
        after.push(s)
      } else {
        const cut = vpos - seen
        before.push({ data: s.data.subarray(0, cut), kind: s.kind, styled: s.styled })
        after.push({ data: s.data.subarray(cut), kind: s.kind, styled: s.styled })
      }
      seen += width
    }
    return [before, after]
  }

  /** Paint matches spanning these segments, preserving every escape. */
  private render(segs: readonly Seg[]): Buffer {
    if (segs.length === 0) return EMPTY
    let work: readonly Seg[] = segs
    if (this.rewrites.length && !this.alt) {
      // Length-changing, so applied within a single text segment only.
      work = segs.map(s =>
        s.kind === "t" ? { data: this.rewrite(s.data), kind: s.kind, styled: s.styled } : s,
      )
    }
    const raw = Buffer.concat(work.map(s => s.data))
    const vis = AnsiHighlighter.visible(work)
    const visStr = vis.toString("latin1")
    // Regions written while a colour was active: user messages, code, tool
    // chrome. Matches touching them are dropped rather than painted.
    const blocked: Array<[number, number]> = []
    let seen = 0
    for (const s of work) {
      const w = AnsiHighlighter.width(s.kind, s.data)
      if (s.kind === "t" && s.styled) blocked.push([seen, seen + w])
      seen += w
    }
    const spans: Array<[number, number, Buffer]> = []
    for (const { pat, style } of this.rules) {
      for (const m of finditer(pat, visStr)) {
        if (this.onlyUnstyled && blocked.some(([a, b]) => a < m.end && m.start < b)) continue
        if (!spans.some(([a, b]) => a < m.end && m.start < b)) {
          let end = m.end
          while (end > m.start && visStr.charCodeAt(end - 1) === 0x20) end -= 1
          spans.push([m.start, end, style])
        }
      }
    }
    if (spans.length === 0) return raw
    const marks = new Map<number, Buffer>()
    const mark = (pos: number, b: Buffer): void => {
      marks.set(pos, Buffer.concat([marks.get(pos) ?? EMPTY, b]))
    }
    for (const [a, b, style] of spans) {
      mark(a, style)
      mark(b, this.restore)
    }
    const out: Buffer[] = []
    let vpos = 0
    for (const s of work) {
      if (s.kind !== "t") {
        // pop, not get: a mark placed here is emitted once and must not be
        // repeated by the trailing marks.get below.
        const mk = marks.get(vpos)
        if (mk !== undefined) {
          out.push(mk)
          marks.delete(vpos)
        }
        out.push(s.data)
        vpos += AnsiHighlighter.width(s.kind, s.data)
      } else {
        const t = s.data
        let i = 0
        const hits = [...marks.keys()]
          .filter(k => vpos <= k && k <= vpos + t.length)
          .sort((x, y) => x - y)
        for (const pos of hits) {
          const cut = pos - vpos
          out.push(t.subarray(i, cut))
          out.push(marks.get(pos) ?? EMPTY)
          marks.delete(pos) // CONSUME: the mark at the segment's far edge is
          i = cut // taken by this segment, not left for the next one
        }
        out.push(t.subarray(i))
        vpos += t.length
      }
    }
    const tail = marks.get(vpos)
    if (tail !== undefined) out.push(tail)
    return Buffer.concat(out)
  }

  private rewrite(text: Buffer): Buffer {
    let s = text.toString("latin1")
    for (const { pat, repl } of this.rewrites) {
      pat.lastIndex = 0 // patterns carry "g" to match Python's sub-everything
      s = s.replace(pat, repl)
    }
    return Buffer.from(s, "latin1")
  }

  /** Paint accumulated segments, optionally holding an unfinished tail. */
  private flushText(hold: boolean): Buffer {
    this.pushText()
    const segs = this.segs
    if (segs.length === 0) return EMPTY
    const vis = AnsiHighlighter.visible(segs)
    const visStr = vis.toString("latin1")
    let start = vis.length
    if (hold && vis.length) {
      if (this.holdPrefixes !== null) {
        for (let pos = Math.max(0, vis.length - MAX_HOLD); pos < vis.length; pos++) {
          const tail = decodeIgnore(vis.subarray(pos)).toLowerCase()
          if (tail && this.holdPrefixes.has(tail)) {
            start = pos
            break
          }
        }
      } else {
        const m = WORD_TAIL.exec(visStr)
        if (m && vis.length - m.index <= MAX_HOLD) start = m.index
      }
      if (start < vis.length) {
        // Never cut through a match already present.
        for (const { pat } of this.rules) {
          for (const m of finditer(pat, visStr)) {
            if (m.start < start && start < m.end) start = m.start
          }
        }
      }
    }
    const [emit, keep] = AnsiHighlighter.split(segs, start)
    this.segs = keep
    return this.render(emit)
  }

  // -- main entry point ---------------------------------------------------
  feed(chunk: Buffer): Buffer {
    const out: Buffer[] = []
    for (const b of chunk) {
      if (this.state === "GROUND") {
        if (b === 0x1b) {
          this.state = "ESC"
          this.raw = [b]
        } else {
          this.text.push(b)
          // Control chars end a word; they also bound a match.
          if (b === 0x0a || b === 0x0d || b === 0x08 || b === 0x09) {
            out.push(this.flushText(false))
          }
        }
        continue
      }

      this.raw.push(b)
      if (this.state === "ESC") {
        if (b === 0x5b) {
          this.state = "CSI"
        } else if (b === 0x5d) {
          this.state = "OSC"
        } else if (b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
          this.state = "DCS"
        } else if (b >= 0x20 && b <= 0x2f) {
          // ESC ( B and friends: an intermediate byte, so the final byte is
          // still to come. Claude Code emits ESC ( B 25 times in a session;
          // reading it as two bytes leaves a stray "B" in the text stream.
          this.state = "ESCI"
        } else {
          out.push(this.flushText(false))
          out.push(Buffer.from(this.raw))
          this.state = "GROUND"
          this.raw = []
        }
      } else if (this.state === "CSI") {
        if (b >= 0x40 && b <= 0x7e) {
          const seq = Buffer.from(this.raw)
          if (TRANSPARENT.test(seq.toString("latin1"))) {
            this.pushText()
            this.segs.push({ data: seq, kind: "jump", styled: false })
          } else if (b === 0x6d) {
            this.pushText() // text keeps its own style
            this.noteSgr(seq)
            this.segs.push({ data: seq, kind: "sgr", styled: false })
          } else {
            this.noteMode(seq)
            out.push(this.flushText(false))
            out.push(seq)
          }
          this.state = "GROUND"
          this.raw = []
        }
      } else if (this.state === "ESCI") {
        if (b >= 0x30 && b <= 0x7e) {
          out.push(this.flushText(false))
          out.push(Buffer.from(this.raw))
          this.state = "GROUND"
          this.raw = []
        }
      } else {
        // OSC / DCS: terminated by BEL or ST (ESC \)
        const n = this.raw.length
        if (b === 0x07 || (n >= 2 && this.raw[n - 2] === 0x1b && this.raw[n - 1] === 0x5c)) {
          out.push(this.flushText(false))
          out.push(Buffer.from(this.raw))
          this.state = "GROUND"
          this.raw = []
        }
      }
    }
    // Anything still in ground text: hold a possible partial word.
    out.push(this.flushText(true))
    return Buffer.concat(out)
  }

  /** Release held text.
   *
   * force=false is the short idle tick: anything that cannot still grow into a
   * match is emitted, an unfinished phrase keeps waiting, and a partial escape
   * keeps everything quiet. force=true is the long idle tick (and exit): emit
   * everything. A stream that dies mid-escape loses only the escape's tail,
   * never the text before it -- the unfinished sequence itself stays pending
   * and is never emitted, which is what a terminal does with a truncated
   * sequence too.
   */
  drain(force = true): Buffer {
    if (this.state !== "GROUND" && !force) return EMPTY
    return this.flushText(!force)
  }
}
