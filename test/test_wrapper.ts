#!/usr/bin/env node
/** Black-box tests: the real wrapper, on a real pty, against a stand-in child.
 *
 * CLAUDE_HIGHLIGHT_CMD exists precisely so the wrapper can be exercised without
 * launching a session; these drive the actual `claude-highlight` process end to
 * end -- filtering, input forwarding, the paste queue, hotkeys, the plugin menu,
 * config hot-reload, exit-code propagation, and the --hl-record raw/filtered
 * pair, which lets the cardinal invariant (visible bytes unchanged) be checked
 * against a real pty run.
 *
 * Each case spawns a child harness in a chosen mode (argv at the top of
 * CHILD_SRC). Run: bun run test/test_wrapper.ts
 *
 * Ported from test_wrapper.py -- same 45 checks, same order, same names.
 * Three things differ, all noted where they occur:
 *
 *   the child harness stays in Python (see CHILD_SRC);
 *   the keystroke flood draws from a seeded mulberry32 instead of Python's
 *   Mersenne Twister, so the byte stream differs from the Python run but is
 *   fixed here;
 *   a signalled child surfaces as 128+signal, not Python's 247 (see the
 *   "child death by signal" case).
 */
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { report, finish, B } from "./harness.ts";
import { isObject, parseJson, type Json } from "../src/json.ts";
import { environ } from "../src/util.ts";

const HERE = join(import.meta.dirname, "..");
// Where the Python ran the `claude-highlight` script directly, run the port.
// The wrapper under test: the TypeScript entry by default, or whatever
// CLAUDE_HIGHLIGHT_BIN points at -- which is how `bun run build && ...` puts
// these same checks through the built artifact rather than the source.
//
// The source is handed to process.execPath rather than a named runtime, so
// the wrapper is exercised under whichever of Bun or Node runs this suite.
const BIN = process.env["CLAUDE_HIGHLIGHT_BIN"];
const WRAPPER: readonly [string, ...string[]] =
  BIN ? [BIN] : [process.execPath, join(HERE, "src", "claude-highlight.ts")];
const WORKDIR = mkdtempSync(join(tmpdir(), "hl-wrap-"));
const CHILD = join(WORKDIR, "child.py");
const F9 = B("\x1b[20~");
const PASTE_ON = B("\x1b[200~"), PASTE_OFF = B("\x1b[201~");
const TITLE = B("plugins");

const CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

/** Printable bytes only, kept in the latin1 view so byte indices are char
 * indices and no re-encoding can move a byte. */
function visible(b: Buffer): string {
  return b.toString("latin1").replace(CSI, "");
}

/** The stand-in for `claude`, deliberately left in Python.
 *
 * It is a test fixture, not part of the port: it puts the pty *slave* into
 * raw mode with termios and then does blocking read1()/os.read() on fd 0 --
 * the exact pattern Bun's tty layer handles badly, and the reason src/pty.ts
 * exists at all. Rewriting it in TypeScript would test the wrapper against
 * the same runtime quirks it is built to avoid; a child in another language
 * is the better test of a wrapper that must be language-agnostic, and keeps
 * these cases byte-identical to the Python suite they are diffed against.
 *
 * A raw template literal, so every backslash reaches Python exactly as it did
 * from the r'''...''' original.
 */
const CHILD_SRC = String.raw`
import os, random, select, signal, struct, sys, time

W = sys.stdout.buffer
def out(b): W.write(b); W.flush()

mode = sys.argv[1] if len(sys.argv) > 1 else "script"

if mode == "argv":
    out(b"ARGV " + repr(sys.argv[2:]).encode() + b"\n"); sys.exit(0)

if mode == "exitcode":
    out(b"READY\n"); sys.exit(int(sys.argv[2]))

if mode == "kill":
    out(b"READY\n"); os.kill(os.getpid(), signal.SIGKILL)

if mode == "stderr":
    sys.stderr.buffer.write(b"stderr says probably\n"); sys.stderr.buffer.flush()
    out(b"READY\n"); sys.exit(0)

def frame(body): return b"\x1b[?2026h" + body + b"\x1b[?2026l"

def go_raw():
    import termios, tty
    try: tty.setraw(0, termios.TCSANOW)
    except Exception: pass

if mode == "garbage":
    go_raw()
    rng = random.Random(1234)
    payload = bytes(rng.randrange(256) for _ in range(120_000))
    for i in range(0, len(payload), 4096):
        out(payload[i:i+4096]); time.sleep(0.002)
    out(b"\nGARBAGE DONE\n"); sys.exit(0)

if mode == "burst":
    go_raw()
    total = bytearray()
    for i in range(750):
        body = b"".join(b"\x1b[%d;1HIt seems likely number %d and probably fine"
                        % (y, i) for y in range(1, 25))
        total += frame(bytes(body))
    total += b"\x1b[?1049l\ndone\n"
    for i in range(0, len(total), 8192):
        out(bytes(total[i:i+8192])); time.sleep(0.0005)
    sys.exit(0)

if mode == "echo":
    go_raw()
    out(b"READY\n")
    while True:
        d = sys.stdin.buffer.read1(65536)
        if not d: break
        out(d)
        if b"@@QUIT@@" in d: sys.exit(0)
    sys.exit(0)

if mode == "ticker":
    go_raw()
    out(b"READY\n")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    for i in range(n):
        out(frame(b"\x1b[2;1HIt is probably fine number %d" % i) + b"\n")
        time.sleep(0.15)
    out(b"\x1b[?1049l\nTICKER DONE\n")
    sys.exit(0)

# --- script mode: a full stand-in session ---
import fcntl, termios, tty
try: tty.setraw(0, termios.TCSANOW)
except Exception: pass

def on_winch(s, f):
    try:
        sz = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
        r, c = struct.unpack("HHHH", sz)[:2]
        out(("RESIZED %d %d\n" % (r, c)).encode())
    except Exception:
        pass
signal.signal(signal.SIGWINCH, on_winch)

out(b"READY\n")
out(b"\x1b[?1049h")
out(frame(b"\x1b[1;1HIt\x1b[4Gseems\x1b[10Glikely\x1b[17Gfine."))
out(frame(b"\x1b[3;1H\x1b[32mif (probably) then code\x1b[39m"))
out(frame(b"\x1b[5;1H\x1b[48;2;55;55;55muser says probably\x1b[49m"))
out(frame(b"\x1b[7;1H\x1b[1mbold likely word\x1b[22m"))
out(b"MARKDONE\n")
while True:
    r, _, _ = select.select([0], [], [], 0.2)
    if not r: continue
    d = os.read(0, 4096)
    if not d: break
    if b"QUIT" in d: break
    if d.startswith(b"EXIT "):
        sys.exit(int(d[5:8]))
    if d.startswith(b"LINE "):
        out(frame(b"\x1b[9;1H" + d[5:].strip()))
        continue
    out(b"GOT " + d)
out(b"\x1b[?1049l\nSCRIPT DONE\n")
sys.exit(0)
`;
writeFileSync(CHILD, CHILD_SRC);

// sys.executable in the Python original; the interpreter that runs the child.
const PYTHON = "python3";

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function pump(stream: Readable, sink: (b: Buffer) => void): Promise<void> {
  for await (const chunk of stream) sink(Buffer.from(chunk as Uint8Array));
}

interface SessionOpts {
  childArgs?: readonly (string | number)[];
  args?: readonly string[];
  envExtra?: Record<string, string>;
  record?: string;
}

/** One claude-highlight process around the child harness. */
class Session {
  readonly xdg: string;
  readonly proc: ChildProcessByStdio<Writable, Readable, Readable>;
  err: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private cached: Buffer | null = null;
  private errParts: Buffer[] = [];
  /** Both readers finished: nothing more can arrive. Python polled the child
   * instead, which raced its own reader thread; waiting on the streams is the
   * same guard without the race. */
  private live = true;
  private readonly pumps: Promise<void>;
  /** Bun's Subprocess.exited resolved to a number even for a signalled child;
   * node:child_process splits that into a null code plus a signal name, so
   * fold it back into the same 128+signal shell convention. */
  private readonly exited: Promise<number>;

  constructor(mode: string, opts: SessionOpts = {}) {
    this.xdg = join(WORKDIR, `xdg-${mode}-${process.hrtime.bigint()}`);
    const env: Record<string, string> = {
      ...environ(),
      XDG_CONFIG_HOME: this.xdg,
      CLAUDE_HIGHLIGHT_CMD: PYTHON,
      COLUMNS: "100",
      ...(opts.envExtra ?? {}),
    };
    const argv = WRAPPER.slice(1);
    if (opts.record !== undefined) argv.push(`--hl-record=${opts.record}`);
    argv.push(...(opts.args ?? []), CHILD, mode,
              ...(opts.childArgs ?? []).map(String));
    this.proc = spawn(WRAPPER[0], argv, {
      stdio: ["pipe", "pipe", "pipe"], env, cwd: HERE,
    });
    // A child that has already died turns the next write into an EPIPE error
    // event, and an unhandled one on a stream takes this suite down with it.
    // The "kill" and "exitcode" cases reach finish() in exactly that state.
    this.proc.stdin.on("error", () => { /* the wrapper is gone; nothing to say */ });
    this.exited = new Promise<number>(done => {
      this.proc.once("exit", (code, signal) =>
        done(code ?? 128 + (signal === null ? 0 : constants.signals[signal])));
    });
    this.pumps = Promise.all([
      pump(this.proc.stdout, b => { this.parts.push(b); this.cached = null; }),
      pump(this.proc.stderr, b => { this.errParts.push(b); }),
    ]).then(() => { this.live = false; });
  }

  cap(): Buffer {
    if (this.cached === null) {
      this.cached = Buffer.concat(this.parts);
      this.parts = [this.cached];
    }
    return this.cached;
  }

  /** Returns once the bytes are with the OS, which is what Bun's stdin.flush()
   * gave: the flood case writes past the pipe buffer, and a send that returned
   * early would let the next one queue ahead of an unfinished write. */
  async send(data: Buffer): Promise<void> {
    if (this.proc.stdin.write(data)) return;
    await new Promise<void>(done => {
      const go = (): void => {
        this.proc.stdin.off("drain", go);
        this.proc.stdin.off("error", go);
        done();
      };
      this.proc.stdin.on("drain", go);
      this.proc.stdin.on("error", go);   // a dead pipe never drains
    });
  }

  async waitFor(pat: Buffer, timeout = 10): Promise<boolean> {
    const end = performance.now() + timeout * 1000;
    for (;;) {
      if (this.cap().includes(pat)) return true;
      if (!this.live) return false;
      if (performance.now() >= end) return false;
      await sleep(20);
    }
  }

  count(pat: Buffer): number {
    const hay = this.cap().toString("latin1");
    const needle = pat.toString("latin1");
    let n = 0, i = 0;
    for (;;) {
      const j = hay.indexOf(needle, i);
      if (j < 0) return n;
      n += 1;
      i = j + needle.length;
    }
  }

  async finish(timeout = 15): Promise<number> {
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    let code = await Promise.race([
      this.exited,
      sleep(timeout * 1000).then(() => null),
    ]);
    if (code === null) {
      this.proc.kill(9);
      code = await this.exited;
    }
    await this.pumps;      // Python's blocking stderr.read() to EOF
    this.err = Buffer.concat(this.errParts);
    return code;
  }

  config(): Json {
    const p = join(this.xdg, "claude-highlight", "config.json");
    return existsSync(p) ? parseJson(readFileSync(p, "utf8")) : null;
  }
}

/** `cfg["categories"][cat]["on"]`, through a config file of any shape. */
function catOn(cfg: Json, cat: string): Json | undefined {
  if (!isObject(cfg)) return undefined;
  const cats = cfg["categories"];
  if (!isObject(cats)) return undefined;
  const c = cats[cat];
  return isObject(c) ? c["on"] : undefined;
}

async function start(mode: string, opts: SessionOpts = {}): Promise<Session> {
  const s = new Session(mode, opts);
  if (["echo", "ticker", "exitcode", "kill", "stderr"].includes(mode)) {
    if (!await s.waitFor(B("READY"))) throw new Error(`${mode}: no READY`);
  }
  return s;
}

// == 1. flags that never spawn a child ==============================

interface FlagResult { code: number; stdout: Buffer; stderr: Buffer }

function runFlag(args: readonly string[], envExtra?: Record<string, string>,
                 xdgConfig?: string): FlagResult {
  const xdg = join(WORKDIR, `xdg-flag-${process.hrtime.bigint()}`);
  const env: Record<string, string> = {
    ...environ(), XDG_CONFIG_HOME: xdg, COLUMNS: "100", ...(envExtra ?? {}),
  };
  if (xdgConfig !== undefined) {
    mkdirSync(join(xdg, "claude-highlight"), { recursive: true });
    writeFileSync(join(xdg, "claude-highlight", "config.json"), xdgConfig);
  }
  const p = spawnSync(WRAPPER[0], [...WRAPPER.slice(1), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env, cwd: HERE, timeout: 60_000,
  });
  // status is null when the timeout killed it, which no check should read as 0.
  return { code: p.status ?? -1, stdout: p.stdout, stderr: p.stderr };
}

let p = runFlag(["--hl-help"]);
report("flags: --hl-help prints the doc, exits 0",
       p.code === 0 && p.stdout.includes(B("PTY")), p.code, p.stdout.subarray(0, 80));

p = runFlag(["--hl-selftest"]);
report("flags: --hl-selftest shows paint and exits 0",
       p.code === 0 && p.stdout.includes(B("self-test")) && p.stdout.includes(B("38;5;")),
       p.code, p.stdout.subarray(0, 120));

p = runFlag(["--hl-selftest"], undefined,
            '{"categories": {"inference": {"add": ["re:("]}}}');
report("flags: selftest lists rejected config words, does not die",
       p.code === 0 && p.stdout.includes(B("rejected config words"))
       && p.stdout.includes(B("re:(")), p.code, p.stdout.subarray(-200));

p = runFlag(["--hl-selftest"], undefined, "{broken json");
report("flags: broken config file still starts (defaults)",
       p.code === 0 && p.stdout.includes(B("self-test")), p.code);

for (const cols of [50, 80, 120, 200]) {
  p = runFlag(["--hl-menu"], { COLUMNS: String(cols) });
  // Python decoded each stripped line as UTF-8 and measured code points; the
  // panel is full of box-drawing glyphs, so the byte count is not the width.
  const lines = p.stdout.toString("latin1").split("\n")
    .map(ln => Buffer.from(ln.replace(CSI, ""), "latin1").toString("utf8"));
  const rows = lines.filter(ln => ln.includes("[on ") || ln.includes("[off"));
  const lens = new Set(rows.map(ln => ln.length));
  const sorted = [...lens].sort((a, b) => a - b);
  report(`flags: --hl-menu rows uniform at COLUMNS=${cols} `
         + `(${rows.length} rows, widths [${sorted.join(", ")}])`,
         p.code === 0 && rows.length === 8 && lens.size === 1
         && Math.max(...lens) <= cols, p.code, sorted);
}

p = runFlag(["--hl-palette"]);
report("flags: --hl-palette shows the curated swatches",
       p.code === 0 && p.stdout.includes(B("38;5;")) && p.stdout.includes(B("to change one")),
       p.code);
p = runFlag(["--hl-palette", "all"]);
report("flags: --hl-palette all adds the 256-colour ramp",
       p.code === 0 && p.stdout.includes(B("256-colour ramp")), p.code);

// == 2. child lifecycle =======================================================

let s = new Session("argv", { childArgs: ["--flag=x", "positional arg"] });
let code = await s.finish();
report("lifecycle: unknown args pass through to the child",
       code === 0 && s.cap().includes(B("ARGV ['--flag=x', 'positional arg']")), s.cap());

s = new Session("exitcode", { childArgs: [3] });
report("lifecycle: child exit code propagates", await s.finish() === 3, "");

s = new Session("kill");
code = await s.finish();
// sys.exit(-9) lands as 256-9 on POSIX; a wrapper that re-raises the signal
// instead would surface as -9. Both readings of "the child died" are fine.
// The port adds a third: src/pty.ts reports a signalled child in shell
// convention (128+signal), the only encoding reachable from process.exit(),
// since that masks to 0-255.
report("lifecycle: child death by signal propagates",
       [-9, 247, 137].includes(code), code);

s = new Session("stderr");
code = await s.finish();
report("lifecycle: child stderr surfaces through the pty (and gets painted)",
       code === 0 && s.cap().includes(B("stderr says"))
       && s.cap().includes(B("\x1b[38;5;203mprobably")), s.cap());

// == 3. filtering, end to end ================================================

s = await start("script");
if (!await s.waitFor(B("MARKDONE"))) throw new Error("script child never signalled MARKDONE");
let cap = s.cap();
report("filter: prose laid out with CHA jumps is painted",
       cap.includes(B("\x1b[38;5;179mseems")) && cap.includes(B("\x1b[38;5;203mlikely")),
       cap.subarray(0, 400));
report("filter: fenced-code colour skipped",
       cap.includes(B("\x1b[32mif (probably)")) && !cap.includes(B("38;5;203mprobably")), "");
report("filter: user-message background skipped",
       cap.includes(B("\x1b[48;2;55;55;55muser says probably")), "");
report("filter: bold prose painted",
       cap.includes(B("bold \x1b[38;5;203mlikely")), "");
await s.send(B("PING\n"));
report("input: typed bytes reach the child and echo back",
       await s.waitFor(B("GOT PING")), s.cap().subarray(-200));
await s.send(B("QUIT"));
report("input: QUIT ends the child and the wrapper exits 0", await s.finish() === 0, "");

// == 4. hotkeys and the menu ==================================================

s = await start("script");
if (!await s.waitFor(B("MARKDONE"))) throw new Error("no MARKDONE");
await s.send(F9);
report("menu: F9 opens the panel, cursor hidden",
       await s.waitFor(TITLE) && await s.waitFor(B("\x1b[?25l")), s.cap().subarray(-300));
await s.send(B("PING\n"));
await sleep(400);
report("menu: while open, typed bytes are menu keys, not child input",
       s.count(B("GOT PING")) === 0, s.cap().subarray(-200));
await s.send(B("\x1b[B"));            // down to "unknown"
await sleep(200);
await s.send(B(" "));                 // toggle it off
await sleep(200);
await s.send(B("q"));
const okClose = await s.waitFor(B("\x1b[?25h")) && await s.waitFor(B("RESIZED"));
const cfg = s.config();
report("menu: q closes, cursor restored, child saw the resize nudge",
       okClose, s.cap().subarray(-300));
report("menu: toggle persisted to the config file",
       cfg !== null && catOn(cfg, "unknown") === false, cfg);
await s.send(B("PING\n"));
report("menu: input forwarding resumes after close",
       await s.waitFor(B("GOT PING")), s.cap().subarray(-200));
await s.send(B("LINE It seems likely but I can't tell why\n"));
let ok = await s.waitFor(B("can't tell why"));
cap = s.cap();
report("menu: toggled-off category no longer paints new output",
       ok && !cap.includes(B("\x1b[38;5;170mcan't tell"))
       && cap.includes(B("\x1b[38;5;179mseems")), cap.subarray(-400));
await s.send(B("QUIT"));
await s.finish();

s = await start("script");
if (!await s.waitFor(B("MARKDONE"))) throw new Error("no MARKDONE");
await s.send(B("\x1b[20"));           // hotkey split across two reads: half 1
await sleep(300);
report("hotkey: split prefix held, nothing forwarded yet",
       s.count(TITLE) === 0 && s.count(B("GOT")) === 0, s.cap().subarray(-200));
await s.send(B("~"));                 // half 2 completes the hotkey
report("hotkey: completed across reads, menu opens",
       await s.waitFor(TITLE), s.cap().subarray(-300));
await s.send(B("q"));
if (!await s.waitFor(B("\x1b[?25h"))) throw new Error("menu never closed");
let nMenus = s.count(TITLE);
await s.send(B("\x1b[20"));           // split again, but the next byte is not ~
await sleep(300);
await s.send(B("x"));
report("hotkey: abandoned prefix is released and forwarded",
       await s.waitFor(B("GOT \x1b[20x")) && s.count(TITLE) === nMenus,
       s.cap().subarray(-300));
await s.send(B("QUIT"));
await s.finish();

// == 5. pastes ================================================================

// A short paste with an embedded F9, all in one write: the exact case where
// 200~ and 201~ land in the same read. The F9 is content, not a hotkey.
s = await start("echo");
const payload = Buffer.concat([PASTE_ON, B("before "), F9, B(" after"), PASTE_OFF]);
await s.send(payload);
ok = await s.waitFor(payload);        // echoed back verbatim, F9 bytes included
await sleep(400);
report("paste: short paste with embedded F9 delivered intact, no menu",
       ok && s.count(B("plugins")) === 0, s.cap().subarray(-300));
await s.send(B("@@QUIT@@"));
await s.finish();

// A bigger paste, split across many writes, with an F9 mid-paste.
s = await start("echo");
const chunks: Buffer[] = [PASTE_ON,
  ...Array.from({ length: 20 }, (_, i) => Buffer.alloc(700, 65 + (i % 26))),
  B("mid "), F9, B(" end"), PASTE_OFF];
for (const c of chunks) {
  await s.send(c);
  await sleep(20);
}
const blob = Buffer.concat(chunks.slice(1, -1));
ok = await s.waitFor(blob, 20);
report("paste: long split paste with embedded F9 delivered whole",
       ok && s.count(B("plugins")) === 0, s.cap().length);
await s.send(B("@@QUIT@@"));
await s.finish();

// Unterminated paste: every F9 stays content until 201~ arrives.
s = await start("script");
if (!await s.waitFor(B("MARKDONE"))) throw new Error("no MARKDONE");
await s.send(PASTE_ON);
await s.send(F9);
await sleep(500);
report("paste: unterminated paste keeps F9 as content",
       s.count(TITLE) === 0 && s.cap().includes(F9), s.cap().subarray(-200));
await s.send(PASTE_OFF);
let n0 = s.count(TITLE);
await s.send(F9);
let end = performance.now() + 5000;
while (s.count(TITLE) === n0 && performance.now() < end) await sleep(20);
report("paste: after 201~, F9 works as a hotkey again",
       s.count(TITLE) > n0, s.cap().subarray(-300));
await s.send(B("q"));
if (!await s.waitFor(B("\x1b[?25h"))) throw new Error("menu never closed");
// A paste while the panel is up closes it and is delivered, not eaten.
n0 = s.count(TITLE);
await s.send(F9);
end = performance.now() + 5000;
while (s.count(TITLE) === n0 && performance.now() < end) await sleep(20);
if (s.count(TITLE) <= n0) throw new Error("menu did not open");
await s.send(Buffer.concat([PASTE_ON, B("menu paste"), PASTE_OFF]));
report("paste: paste-while-menu-open closes the panel and is delivered",
       await s.waitFor(Buffer.concat([PASTE_ON, B("menu paste"), PASTE_OFF])),
       s.cap().subarray(-400));
await s.send(B("PING\n"));
report("paste: forwarding works after the panel closed on a paste",
       await s.waitFor(B("GOT PING")), s.cap().subarray(-200));
await s.send(B("QUIT"));
await s.finish();

// A keystroke flood through the ~1 KB pty write ceiling.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
s = await start("echo");
const rnd = mulberry32(5);
// randrange(32, 127) never returns 0, so the original's `or 65` never fired.
const flood = Buffer.from(Array.from({ length: 100_000 },
                                     () => 32 + Math.floor(rnd() * 95))
  .filter(b => b !== 0x40));   // no '@' runs -> no accidental QUIT
await s.send(flood);
ok = await s.waitFor(flood.subarray(-4000), 30);
report("input: 100 KB keystroke flood drains through the write queue",
       ok, s.cap().length);
await s.send(B("@@QUIT@@"));
await s.finish();

// == 6. EOF on stdin must not end the session ================================

s = await start("ticker", { childArgs: [6] });
s.proc.stdin.end();
ok = await s.waitFor(B("TICKER DONE"), 30);
report("lifecycle: stdin EOF does not kill the session",
       ok && s.count(B("fine number 5")) === 1, s.count(B("fine number")));
report("lifecycle: wrapper exits 0 after the child finishes", await s.finish() === 0, "");

// == 7. config hot-reload =====================================================

s = await start("script");
if (!await s.waitFor(B("MARKDONE"))) throw new Error("no MARKDONE");
if (!s.cap().includes(B("\x1b[38;5;203mlikely"))) throw new Error("nothing painted");
writeFileSync(join(s.xdg, "claude-highlight", "config.json"),
              JSON.stringify({ categories: { inference: { color: "38;5;196" } } }));
await sleep(300);                   // let an idle tick notice the mtime
await s.send(B("LINE it is probably fine after reload\n"));
report("config: colour change applies live to new output",
       await s.waitFor(B("\x1b[38;5;196mprobably"), 10), s.cap().subarray(-400));
await s.send(B("QUIT"));
await s.finish();

// == 8. recording pair + burst ===============================================

const rec = join(WORKDIR, "burst");
s = new Session("burst", { record: rec });
code = await s.finish(90);
const raw = readFileSync(rec + ".raw");
const out = readFileSync(rec + ".out");
const scriptParts: string[] = [];
for (let i = 0; i < 750; i++) {
  let body = "";
  for (let y = 1; y < 25; y++) body += `\x1b[${y};1HIt seems likely number ${i} and probably fine`;
  scriptParts.push("\x1b[?2026h" + body + "\x1b[?2026l");
}
scriptParts.push("\x1b[?1049l\ndone\n");
const script = Buffer.from(scriptParts.join(""), "latin1");
report(`record: ${raw.length.toLocaleString("en-US")} raw bytes captured verbatim from the pty`,
       code === 0 && raw.equals(script), raw.length, script.length, code);
report("record: filtered output equals what we captured",
       out.equals(s.cap()), out.length, s.cap().length);
// corrections rewrite cells the frame already wrote, so their text is
// excluded before comparing visible bytes, exactly as in test_integration
const FIXBLOCK = /\x1b7\x1b\[\?7l[\s\S]*?\x1b\[\?7h\x1b8/g;
const noFix = (b: Buffer): Buffer => Buffer.from(b.toString("latin1").replace(FIXBLOCK, ""), "latin1");
report("record: the cardinal invariant over a real pty run",
       visible(noFix(raw)) === visible(noFix(s.cap())), "");
report("record: paint present in .out, absent in .raw",
       out.includes(B("38;5;203")) && !raw.includes(B("38;5;203")), "");

// == 9. hostile child output ==================================================

s = new Session("garbage");
code = await s.finish();
// The original looked for a Python "Traceback"; the wrapper is TypeScript now,
// so an uncaught-error banner counts as a crash too -- and it has to be
// recognised under both runtimes, since Bun prints "error:" where Node prints
// the error class.
const crashed = /Traceback|^error:|^[A-Za-z]*Error:/m.test(s.err.toString("latin1"));
report("hostile: 120 KB of random bytes through the wrapper, no crash",
       code === 0 && await s.waitFor(B("GARBAGE DONE")) && !crashed,
       code, s.err.subarray(-200));

s = new Session("exitcode", { childArgs: [0] });
report("hostile: child that exits instantly, wrapper exits cleanly",
       await s.finish() === 0, "");

finish();
