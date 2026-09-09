#!/usr/bin/env bun
/** Paste-path tests: every byte typed or pasted must reach the child.
 *
 * Kept out of test_filter.ts because each case spawns a pty and waits for the
 * child to enter raw mode. Run directly: bun run test/test_paste.ts
 *
 * Ported from test_paste.py -- same 3 checks, same order, same names. The
 * original printed its own PASS lines rather than calling a report helper;
 * this uses the shared harness, which prints the same line and keeps the
 * exit-code contract.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { report, finish, B } from "./harness";
import { environ } from "../src/util";

const HERE = join(import.meta.dir, "..");
// Where the Python ran the `claude-highlight` script directly, run the port.
// The wrapper under test: the TypeScript entry by default, or whatever
// CLAUDE_HIGHLIGHT_BIN points at -- which is how `bun run build && ...` puts
// these same checks through the built artifact rather than the source.
const WRAPPER = process.env["CLAUDE_HIGHLIGHT_BIN"]
  ? [process.env["CLAUDE_HIGHLIGHT_BIN"]]
  : ["bun", "run", join(HERE, "src", "claude-highlight.ts")];

/** The sink stays in Python, exactly as the wrapper's own test child does: it
 * puts the pty *slave* into raw mode with termios and then blocks in
 * select()/os.read() on fd 0 -- the pattern Bun's tty layer handles badly,
 * and the reason src/pty.ts exists. A stand-in for `claude` written in
 * another language is also the better test of a wrapper that has to be
 * language-agnostic. String.raw so every backslash reaches Python as it did
 * from the original '''...''' literal. */
const SINK = String.raw`
import hashlib, os, select, sys, termios, tty
tty.setraw(0, termios.TCSANOW)
h = hashlib.md5(); n = 0
while True:
    r, _, _ = select.select([0], [], [], 3.0)
    if not r: break
    d = os.read(0, 65536)
    if not d: break
    n += len(d); h.update(d)
open(os.environ["SINK_OUT"], "w").write(f"{n} {h.hexdigest()}")
`;

const PASTE_ON = B("\x1b[200~"), PASTE_OFF = B("\x1b[201~"), F9 = B("\x1b[20~");

/** `b"line %06d the quick brown fox\n" % i` for i in range(8000). */
function newlineHeavy(): Buffer {
  let s = "";
  for (let i = 0; i < 8000; i++) s += `line ${String(i).padStart(6, "0")} the quick brown fox\n`;
  return B(s);
}

const CASES: ReadonlyArray<readonly [string, Buffer]> = [
  ["newline-heavy 224 KB", newlineHeavy()],
  ["bracketed paste with an embedded F9",
   Buffer.concat([PASTE_ON, B("before "), F9, B(" after "),
                  Buffer.alloc(50_000, 0x78), PASTE_OFF])],
  ["1 MB bracketed paste",
   Buffer.concat([PASTE_ON, B("the quick brown fox jumps over the lazy dog ".repeat(24_000)),
                  PASTE_OFF])],
];

const shq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

async function run(payload: Buffer, tmp: string): Promise<[string, string]> {
  const sinkPy = join(tmp, "sink.py"), out = join(tmp, "out.txt"), pay = join(tmp, "pay.bin");
  writeFileSync(sinkPy, SINK);
  writeFileSync(pay, payload);
  const env: Record<string, string> = {
    ...environ(), SINK_OUT: out, CLAUDE_HIGHLIGHT_CMD: "python3",
  };
  // The pty is canonical until the child goes raw; a newline-free payload
  // sent into that window would hit MAX_CANON (~1 KB) and be truncated by
  // the line discipline. A real session is long past that by paste time.
  //
  // Python spawned the feed and the wrapper separately and handed the wrapper
  // the feed's stdout fd; one /bin/sh pipeline is the same two processes and
  // the same real OS pipe, started together, with the delay on the writing
  // side -- and it survives being spawned from an event loop, which a
  // JS-side ReadableStream bridge would not.
  const cmd = `{ sleep 1.5; cat ${shq(pay)}; } | `
            + `${WRAPPER.map(shq).join(" ")} ${shq(sinkPy)}`;
  const proc = Bun.spawn(["/bin/sh", "-c", cmd], {
    stdout: "ignore", stderr: "ignore", stdin: "ignore", env, cwd: HERE,
    timeout: 120_000,
  });
  await proc.exited;
  if (!existsSync(out)) return ["0", ""];
  const [n, digest] = readFileSync(out, "utf8").split(/\s+/);
  return [n ?? "0", digest ?? ""];
}

for (const [name, payload] of CASES) {
  const tmp = mkdtempSync(join(tmpdir(), "hl-paste-"));
  let n = "0", digest = "";
  try {
    [n, digest] = await run(payload, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const want = createHash("md5").update(payload).digest("hex");
  const good = digest === want && Number(n) === payload.length;
  report(`${name}: sent ${payload.length.toLocaleString("en-US")},`
         + ` got ${Number(n).toLocaleString("en-US")}`, good,
         `md5 want ${want} got ${digest}`);
}

finish();
