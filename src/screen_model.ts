/** A shadow copy of the screen, so a highlight can be taken back.
 *
 * The wrapper paints cells the child believes are default-coloured. Claude Code
 * repaints with a cell-level diff -- it rewrites the characters that changed and
 * jumps over the ones that did not -- so a cell it skips keeps our colour after
 * the word that earned it is gone. Measured on a recorded session: 107 stale
 * paints over 14k frames, one of them still on screen 5,050 frames later.
 *
 * Nothing in the child's damage model can know about the colour, so the fix has
 * to live here: mirror the screen, and at the end of every frame rewrite the
 * cells we painted whose match no longer holds. Rewriting a cell with the same
 * character at the same column changes an attribute and nothing else, which
 * keeps the wrapper's "never move a cell" rule intact.
 *
 * Only cells this wrapper painted are ever touched. A cell the child wrote, or
 * one we have never seen, is left alone no matter what the text around it says.
 *
 * Nothing here is really private: the Python original marked its internals with
 * a leading underscore and its test suite reached straight past it, and the
 * port keeps that bargain rather than growing accessors the tests would only
 * have to work around.
 */
import type { Rule } from "./rules.ts";

// Sticky, so it can be anchored at an offset the way Python's CSI.match(data, i) was.
const CSI = /\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/y;
const FRAME_END = /\x1b\[\?2026l/g;
const PARTIAL_CSI = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*$/;

// Corrections are cheap (a few bytes a cell) but a desynced model could in
// principle want to rewrite the whole screen. Cap a frame's worth; rows that
// do not fit stay dirty and are picked up by the next frame.
export const MAX_FIX = 4096;
// A sequence split across chunks is normally a few bytes; anything longer than
// this is not an escape we understand, and is dropped rather than buffered.
const MAX_PENDING = 4096;
// The input box lives at the bottom of the screen, bounded by full-width rules.
const RULE_CHARS = new Set("─━╌╍┄┅┈┉│┃╭╮╰╯┌┐└┘├┤┬┴┼");
const BOTTOM_CHROME = 10;     // the box's lower rule sits within this many rows of the end
const MAX_COMPOSER = 24;      // ...and its upper rule no further than this above it

/** East_Asian_Width W and F, as [lo, hi] pairs. JavaScript exposes general
 * categories to regexes but not this property, so the table Python read out of
 * unicodedata is carried here instead (Unicode 16.0). */
const WIDE: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0,
  0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2630, 0x2637,
  0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f, 0x2693, 0x2693, 0x26a1,
  0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce,
  0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa,
  0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728,
  0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795,
  0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50,
  0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0,
  0x303e, 0x3041, 0x3096, 0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e,
  0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247, 0x3250, 0xa48c, 0xa490,
  0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19,
  0xfe30, 0xfe52, 0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0,
  0xffe6, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800,
  0x18cd5, 0x18cff, 0x18d08, 0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd,
  0x1affe, 0x1b000, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155,
  0x1b155, 0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360,
  0x1d376, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191,
  0x1f19a, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250,
  0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337,
  0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0,
  0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442,
  0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a,
  0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680,
  0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7, 0x1f6dc,
  0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0,
  0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70,
  0x1fa7c, 0x1fa80, 0x1fa89, 0x1fa8f, 0x1fac6, 0x1face, 0x1fadc, 0x1fadf,
  0x1fae9, 0x1faf0, 0x1faf8, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;
/** The characters Python's `unicodedata.combining(ch)` catches that are not
 * Mn, Me or Cf -- spacing marks that still carry a combining class. */
const ZERO_EXTRA = new Set([
  0x1715, 0x1734, 0x1b44, 0x1baa, 0x1bf2, 0x1bf3, 0x302e, 0x302f, 0xa953,
  0xa9c0, 0x111c0, 0x11235, 0x1134d, 0x113cf, 0x116b6, 0x1193d, 0x11f41,
  0x16ff0, 0x16ff1, 0x1d165, 0x1d166, 0x1d16d, 0x1d16e, 0x1d16f, 0x1d170,
  0x1d171, 0x1d172,
].map(c => String.fromCodePoint(c)));

/** Columns a character occupies. Combining marks add nothing, CJK and most
 * emoji take two. */
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0xad) return 1;              // ASCII and Latin-1 up to the soft hyphen
  if (ZERO.test(ch) || ZERO_EXTRA.has(ch)) return 0;
  let lo = 0, hi = WIDE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE[mid * 2]!) hi = mid - 1;
    else if (cp > WIDE[mid * 2 + 1]!) lo = mid + 1;
    else return 2;
  }
  return 1;
}

export class ScreenModel {
  palette: Set<string>;
  rows!: number;
  cols!: number;
  chars!: (string | null)[][];
  fg!: (string | null)[][];
  ours!: boolean[][];
  rule!: (boolean | null)[];
  x!: number;
  y!: number;
  curFg!: string | null;
  curOurs!: boolean;
  saved!: [number, number, string | null];
  top!: number;
  bot!: number;
  alt!: boolean;
  wrapPending!: boolean;
  dirty!: Set<number>;
  pending!: Buffer;
  inFrame!: boolean;

  constructor(rows: number, cols: number, palette: Iterable<string> = []) {
    this.palette = new Set(palette);   // fg params this wrapper injects
    this.resize(rows, cols);
  }

  // -- state ---------------------------------------------------------------
  resize(rows: number, cols: number): void {
    this.rows = Math.max(rows, 1);
    this.cols = Math.max(cols, 1);
    this.invalidate();
  }

  /** Forget the screen. Used when something bypasses us -- the plugin panel
   * draws straight to stdout -- so we never rewrite a cell whose contents we
   * are only guessing at. */
  invalidate(): void {
    this.chars = Array.from({ length: this.rows }, () => new Array<string | null>(this.cols).fill(null));
    this.fg = Array.from({ length: this.rows }, () => new Array<string | null>(this.cols).fill(null));
    this.ours = Array.from({ length: this.rows }, () => new Array<boolean>(this.cols).fill(false));
    // "is this row one of the box's rules?", worked out lazily and dropped
    // whenever the row changes. Rescanning the bottom 32 rows every frame
    // costs more than everything else here put together.
    this.rule = new Array<boolean | null>(this.rows).fill(null);
    this.x = this.y = 0;
    this.curFg = null;
    this.curOurs = false;
    this.saved = [0, 0, null];
    this.top = 0;
    this.bot = this.rows - 1;
    this.alt = false;
    this.wrapPending = false;
    this.dirty = new Set();
    this.pending = Buffer.alloc(0);   // a sequence cut in half by a chunk boundary
    this.inFrame = false;             // inside a synchronised-output block
  }

  // -- writing -------------------------------------------------------------
  blankRow(): [(string | null)[], (string | null)[], boolean[]] {
    return [new Array<string | null>(this.cols).fill(null),
            new Array<string | null>(this.cols).fill(null),
            new Array<boolean>(this.cols).fill(false)];
  }

  set(x: number, ch: string): void {
    this.chars[this.y]![x] = ch;
    this.fg[this.y]![x] = this.curFg;
    this.ours[this.y]![x] = this.curOurs;
    this.dirty.add(this.y);
    this.rule[this.y] = null;
  }

  put(text: string): void {
    for (const ch of text) {
      const w = cellWidth(ch);
      if (w === 0) continue;         // a combining mark rides on the cell before it
      if (this.wrapPending || this.x + w > this.cols) {
        this.x = 0;
        this.index();
        this.wrapPending = false;
      }
      this.set(this.x, ch);
      if (w === 2 && this.x + 1 < this.cols) this.set(this.x + 1, "");  // continuation of the wide cell
      this.x += w;
      if (this.x >= this.cols) {
        this.x = this.cols - 1;
        this.wrapPending = true;
      }
    }
  }

  /** Line feed, honouring the scroll region. */
  index(): void {
    if (this.y === this.bot) this.scroll(1);
    else this.y = Math.min(this.y + 1, this.rows - 1);
  }

  scroll(n: number, up = true): void {
    for (let k = 0; k < Math.max(n, 1); k++) {
      const [c, f, o] = this.blankRow();
      if (up) {
        this.chars.splice(this.top, 1); this.chars.splice(this.bot, 0, c);
        this.fg.splice(this.top, 1); this.fg.splice(this.bot, 0, f);
        this.ours.splice(this.top, 1); this.ours.splice(this.bot, 0, o);
      } else {
        this.chars.splice(this.bot, 1); this.chars.splice(this.top, 0, c);
        this.fg.splice(this.bot, 1); this.fg.splice(this.top, 0, f);
        this.ours.splice(this.bot, 1); this.ours.splice(this.top, 0, o);
      }
    }
    for (let y = this.top; y <= this.bot; y++) this.dirty.add(y);
    this.rule = new Array<boolean | null>(this.rows).fill(null);
  }

  // -- escape handling -----------------------------------------------------
  sgr(params: string): void {
    const toks = params ? params.split(";") : ["0"];
    let i = 0;
    while (i < toks.length) {
      const t = toks[i] || "0";
      const n = /^[0-9]+$/.test(t) ? parseInt(t, 10) : -1;
      if (n === 0 || n === 39) {
        this.curFg = null;
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        this.curFg = t;
      } else if (n === 38) {
        if (toks[i + 1] === "5") { this.curFg = toks.slice(i, i + 3).join(";"); i += 2; }
        else if (toks[i + 1] === "2") { this.curFg = toks.slice(i, i + 5).join(";"); i += 4; }
      }
      i += 1;
    }
    this.curOurs = this.curFg !== null && this.palette.has(this.curFg);
  }

  erase(cells: Iterable<number>): void {
    for (const x of cells) {
      this.chars[this.y]![x] = " ";
      this.fg[this.y]![x] = null;
      this.ours[this.y]![x] = false;
    }
    this.dirty.add(this.y);
    this.rule[this.y] = null;
  }

  csi(priv: string, fin: string, params: string): void {
    const parts = params ? params.split(";") : [];
    const nums = parts.map(p => (/^[0-9]+$/.test(p) ? parseInt(p, 10) : 0));
    const a = nums.length ? nums[0]! : 0;
    if (priv) {
      if ((fin === "h" || fin === "l") && parts.some(p => p === "1049" || p === "1047" || p === "47")) {
        this.invalidate();             // the other screen's cells are not ours
        this.alt = fin === "h";
      } else if ((fin === "h" || fin === "l") && parts.includes("2026")) {
        this.inFrame = fin === "h";
      }
      return;
    }
    if (fin === "H" || fin === "f") {
      this.y = Math.max(0, Math.min(nums.length ? nums[0]! - 1 : 0, this.rows - 1));
      this.x = Math.max(0, Math.min(nums.length > 1 ? nums[1]! - 1 : 0, this.cols - 1));
      this.wrapPending = false;
    } else if (fin === "A") { this.y = Math.max(0, this.y - Math.max(a, 1)); this.wrapPending = false; }
    else if (fin === "B") { this.y = Math.min(this.rows - 1, this.y + Math.max(a, 1)); this.wrapPending = false; }
    else if (fin === "C") { this.x = Math.min(this.cols - 1, this.x + Math.max(a, 1)); this.wrapPending = false; }
    else if (fin === "D") { this.x = Math.max(0, this.x - Math.max(a, 1)); this.wrapPending = false; }
    else if (fin === "E") { this.y = Math.min(this.rows - 1, this.y + Math.max(a, 1)); this.x = 0; }
    else if (fin === "F") { this.y = Math.max(0, this.y - Math.max(a, 1)); this.x = 0; }
    else if (fin === "G") { this.x = Math.max(0, Math.min((a || 1) - 1, this.cols - 1)); this.wrapPending = false; }
    else if (fin === "d") { this.y = Math.max(0, Math.min((a || 1) - 1, this.rows - 1)); }
    else if (fin === "K") {
      if (a === 1) this.erase(span(0, this.x + 1));
      else if (a === 2) this.erase(span(0, this.cols));
      else this.erase(span(this.x, this.cols));
    } else if (fin === "J") {
      if (a === 2 || a === 3) {
        for (let y = 0; y < this.rows; y++) { this.y = y; this.erase(span(0, this.cols)); }
        this.y = 0;
      } else if (a === 0) {
        this.erase(span(this.x, this.cols));
        const keep = this.y;
        for (let y = keep + 1; y < this.rows; y++) { this.y = y; this.erase(span(0, this.cols)); }
        this.y = keep;
      }
    } else if (fin === "X") {
      this.erase(span(this.x, Math.min(this.x + Math.max(a, 1), this.cols)));
    } else if (fin === "S") { this.scroll(a, true); }
    else if (fin === "T") { this.scroll(a, false); }
    else if (fin === "L" || fin === "M") {
      const n = Math.max(a, 1);
      for (let k = 0; k < n; k++) {
        const [c, f, o] = this.blankRow();
        const at = fin === "L" ? this.y : this.bot;
        const from = fin === "L" ? this.bot : this.y;
        this.chars.splice(from, 1); this.chars.splice(at, 0, c);
        this.fg.splice(from, 1); this.fg.splice(at, 0, f);
        this.ours.splice(from, 1); this.ours.splice(at, 0, o);
      }
      for (let y = this.y; y <= this.bot; y++) this.dirty.add(y);
      this.rule = new Array<boolean | null>(this.rows).fill(null);
    } else if (fin === "P" || fin === "@") {
      const n = Math.max(a, 1);
      const chars = this.chars[this.y]!, fg = this.fg[this.y]!, ours = this.ours[this.y]!;
      if (fin === "P") {
        chars.splice(this.x, n); while (chars.length < this.cols) chars.push(null);
        fg.splice(this.x, n); while (fg.length < this.cols) fg.push(null);
        ours.splice(this.x, n); while (ours.length < this.cols) ours.push(false);
      } else {
        for (let k = 0; k < n; k++) {
          chars.splice(this.x, 0, null); chars.pop();
          fg.splice(this.x, 0, null); fg.pop();
          ours.splice(this.x, 0, false); ours.pop();
        }
      }
      this.dirty.add(this.y);
      this.rule[this.y] = null;
    } else if (fin === "r") {
      this.top = Math.max(0, nums.length ? nums[0]! - 1 : 0);
      this.bot = Math.min(this.rows - 1, nums.length > 1 ? nums[1]! - 1 : this.rows - 1);
      if (this.top >= this.bot) { this.top = 0; this.bot = this.rows - 1; }
      this.x = this.y = 0;
    } else if (fin === "m") {
      this.sgr(params);
    }
  }

  /** Length of an incomplete UTF-8 sequence at the end of `data`. */
  static partialUtf8(data: Buffer): number {
    for (let back = 1; back <= Math.min(4, data.length); back++) {
      const b = data[data.length - back]!;
      if (b < 0x80) return 0;
      if (b >= 0xc0) {
        const need = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        return back < need ? back : 0;
      }
    }
    return 0;
  }

  feed(data: Buffer): void {
    if (this.pending.length) {
      data = Buffer.concat([this.pending, data]);
      this.pending = Buffer.alloc(0);
    }
    const s = data.toString("latin1");   // byte offsets and char offsets agree
    let i = 0;
    const n = data.length;
    while (i < n) {
      const b = data[i]!;
      if (b === 0x1b) {
        CSI.lastIndex = i;
        const m = CSI.exec(s);
        if (m) {
          const p = m[1]!;
          const priv = "?><=".includes(p.slice(0, 1)) ? p.slice(0, 1) : "";
          this.csi(priv, m[3]!, p.slice(priv.length));
          i = CSI.lastIndex;
          continue;
        }
        const nxt = data[i + 1];
        if (nxt === undefined || (nxt === 0x5b /* [ */ && PARTIAL_CSI.test(s.slice(i)))) {
          return this.hold(data.subarray(i));      // finish it next chunk
        }
        if (nxt >= 0x20 && nxt <= 0x2f) {
          // ESC ( B and friends: intermediates, then a final byte.
          // Reading it as a two-byte escape leaves the final byte to
          // be printed -- a stray "B" on the screen, 25 a session.
          let j = i + 1;
          while (j < n && data[j]! >= 0x20 && data[j]! <= 0x2f) j++;
          if (j >= n) return this.hold(data.subarray(i));
          i = j + 1;
          continue;
        }
        if (nxt === 0x50 || nxt === 0x58 || nxt === 0x5e || nxt === 0x5f || nxt === 0x5d) {
          const bel = s.indexOf("\x07", i + 2);    // string sequences
          const st = s.indexOf("\x1b\\", i + 2);
          const ends = [bel, st].filter(j => j !== -1);
          if (!ends.length) return this.hold(data.subarray(i));
          const end = Math.min(...ends);
          i = end + (end === bel ? 1 : 2);
          continue;
        }
        if (nxt === 0x37 /* 7 */) {
          this.saved = [this.x, this.y, this.curFg];
        } else if (nxt === 0x38 /* 8 */) {
          [this.x, this.y, this.curFg] = this.saved;
          this.curOurs = this.curFg !== null && this.palette.has(this.curFg);
        } else if (nxt === 0x4d /* M */) {
          if (this.y === this.top) this.scroll(1, false);
          else this.y = Math.max(0, this.y - 1);
        }
        i += 2;
        continue;
      }
      if (b === 0x0a) { this.index(); this.wrapPending = false; i += 1; continue; }
      if (b === 0x0d) { this.x = 0; this.wrapPending = false; i += 1; continue; }
      if (b === 0x08) { this.x = Math.max(0, this.x - 1); this.wrapPending = false; i += 1; continue; }
      if (b === 0x09) { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); i += 1; continue; }
      let j = i;
      while (j < n && data[j]! >= 0x20 && data[j]! !== 0x1b) j++;
      if (j === i) { i += 1; continue; }   // any other control byte: consume, never spin
      let run = data.subarray(i, j);
      if (j === n) {
        const cut = ScreenModel.partialUtf8(run);
        if (cut) {
          const hold = run.subarray(run.length - cut);
          run = run.subarray(0, run.length - cut);
          this.put(run.toString("utf8"));
          return this.hold(hold);
        }
      }
      this.put(run.toString("utf8"));
      i = j;
    }
  }

  /** Keep an unfinished sequence for the next chunk, within reason. */
  hold(tail: Buffer): void {
    this.pending = tail.length <= MAX_PENDING ? Buffer.from(tail) : Buffer.alloc(0);
  }

  // -- the input box -------------------------------------------------------
  /** A row that is nothing but box-drawing: one of the input box's edges. */
  isRule(y: number): boolean {
    const cached = this.rule[y];
    if (cached !== null && cached !== undefined) return cached;
    let marks = 0, other = 0;
    for (const c of this.chars[y]!) {
      if (c !== null && RULE_CHARS.has(c)) marks += 1;
      else if (c !== null && c !== "" && c !== " ") { other += 1; break; }
    }
    const v = other === 0 && marks >= this.cols * 0.8;
    this.rule[y] = v;
    return v;
  }

  /** Rows of the input box, which nothing here may paint.
   *
   * Claude Code draws what you are typing at the default foreground, in the
   * same word-by-word layout as prose, so the stream alone cannot tell the
   * two apart -- but the screen can: the box is the band between the last
   * two full-width rules at the bottom, and everything below it is status
   * chrome. What the user typed is theirs, not ours to annotate.
   */
  composerRows(): number[] {
    const rules: number[] = [];
    for (let y = this.rows - 1; y > Math.max(this.rows - 32, -1); y--) {
      if (this.isRule(y)) rules.push(y);
    }
    const low = rules[0];
    if (low === undefined || low < this.rows - BOTTOM_CHROME) return [];
    let top = low;
    for (const y of rules.slice(1)) {
      if (low - y <= MAX_COMPOSER) { top = y; break; }
    }
    return span(top, this.rows);
  }

  // -- reconciliation ------------------------------------------------------
  /** The row as bytes, plus a byte-offset -> column map. */
  rowBytes(y: number): [Buffer, number[]] {
    const parts: Buffer[] = [];
    const idx: number[] = [];
    const row = this.chars[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === "") continue;                    // continuation half of a wide cell
      const enc = Buffer.from(ch ? ch : " ", "utf8");
      parts.push(enc);
      for (let k = 0; k < enc.length; k++) idx.push(x);
    }
    return [Buffer.concat(parts), idx];
  }

  /** What colour each column of this row should be carrying. */
  desired(y: number, rules: readonly Rule[], onlyUnstyled: boolean,
          offLimits: readonly number[] = []): (string | null)[] {
    if (offLimits.includes(y)) {
      return new Array<string | null>(this.cols).fill(null);   // the input box: never ours to paint
    }
    const [buf, idx] = this.rowBytes(y);
    const text = buf.toString("latin1");
    const want = new Array<string | null>(this.cols).fill(null);
    for (const { pat, style } of rules) {
      const fg = style.subarray(2, style.length - 1).toString("latin1");
      for (const m of text.matchAll(pat)) {
        const start = m.index;
        let end = start + m[0].length;
        while (end > start && text[end - 1] === " ") end -= 1;
        if (end <= start) continue;
        const cells = span(idx[start]!, idx[end - 1]! + 1);
        if (cells.some(c => want[c] !== null)) continue;      // an earlier rule already claimed it
        if (onlyUnstyled && cells.some(c => this.fg[y]![c] !== null && !this.ours[y]![c])) {
          continue;                                          // user message, code, tool chrome
        }
        for (const c of cells) want[c] = fg;
      }
    }
    return want;
  }

  /** Rewrite the cells we painted whose match no longer holds.
   *
   * Emitted inside the frame's synchronised-output block, so the terminal
   * presents the frame and the correction together. DECSC/DECRC put the
   * cursor and its attributes back, and autowrap is off for the duration so
   * a rewrite in the last column cannot scroll the screen.
   */
  corrections(rules: readonly Rule[], onlyUnstyled = true): Buffer {
    if (!this.alt || this.dirty.size === 0) return Buffer.alloc(0);
    const rows = [...this.dirty].sort((p, q) => p - q);
    this.dirty = new Set();
    const offLimits = this.composerRows();
    const out: Buffer[] = [];
    let len = 0, spent = false;
    for (const y of rows) {
      if (spent) { this.dirty.add(y); continue; }        // picked up by the next frame
      if (!this.ours[y]!.some(v => v)) continue;
      const want = this.desired(y, rules, onlyUnstyled, offLimits);
      let x = 0;
      while (x < this.cols) {
        if (!(this.ours[y]![x] && this.fg[y]![x] !== want[x])) { x += 1; continue; }
        let start = x;
        const target = want[x]!;
        while (x < this.cols && this.ours[y]![x] && this.fg[y]![x] !== want[x] && want[x] === target) x += 1;
        if (this.chars[y]![start] === "" && start) start -= 1;   // never start mid-way through a wide cell
        const text = this.chars[y]!.slice(start, x).filter(c => c !== "" && c !== null).join("");
        if (!text) continue;
        const fix = Buffer.concat([
          Buffer.from(`\x1b[${y + 1};${start + 1}H`, "latin1"),
          Buffer.from(target ? `\x1b[${target}m` : "\x1b[39m", "latin1"),
          Buffer.from(text, "utf8"),
        ]);
        if (len + fix.length > MAX_FIX) {
          this.dirty.add(y);          // finish this row on the next frame
          spent = true;
          break;
        }
        out.push(fix);
        len += fix.length;
        for (let c = start; c < x; c++) {
          this.fg[y]![c] = target;
          this.ours[y]![c] = target !== null;
        }
      }
    }
    if (!len) return Buffer.alloc(0);
    return Buffer.concat([Buffer.from("\x1b7\x1b[?7l", "latin1"), ...out,
                          Buffer.from("\x1b[?7h\x1b8", "latin1")]);
  }

  /** Track everything we send the terminal; fix up each frame's end. */
  reconcile(data: Buffer, rules: readonly Rule[], onlyUnstyled = true): Buffer {
    if (!data.length) return data;
    const out: Buffer[] = [];
    let i = 0;
    for (const m of data.toString("latin1").matchAll(FRAME_END)) {
      const seg = data.subarray(i, m.index);
      this.feed(seg);
      out.push(seg);
      out.push(this.corrections(rules, onlyUnstyled));
      const mark = data.subarray(m.index, m.index + m[0].length);
      out.push(mark);
      this.feed(mark);
      i = m.index + m[0].length;
    }
    const tail = data.subarray(i);
    this.feed(tail);
    out.push(tail);
    if (tail.length && !this.inFrame) {
      // The idle flush releases held text after the frame that carried it
      // has already been presented, so this correction cannot ride along
      // inside a sync block -- but nothing else is drawing either.
      out.push(this.corrections(rules, onlyUnstyled));
    }
    return Buffer.concat(out);
  }
}

/** Python's range(a, b) as an array, for the cell spans this file passes about. */
function span(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}
