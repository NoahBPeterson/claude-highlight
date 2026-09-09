/** The handful of terminal primitives the wrapper needs, in the form that
 * works on both runtimes.
 *
 * These were bun:ffi calls into termios and the winsize ioctls, because the
 * port assumed Bun had no usable tty layer. Measured inside a real pty, it
 * does: node:tty's isatty, process.stdin.setRawMode and
 * process.stdout.columns/rows all behave identically under Bun and Node. So
 * the only thing that still needs a runtime-specific implementation is the
 * pty itself -- see pty.ts.
 */
import { existsSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";

/** Raw mode on stdin, returning a function that puts it back -- or null when
 * stdin is not a tty (tests, pipes), which is the Python original's
 * degrade-to-nothing path.
 *
 * TCSANOW semantics, not TCSAFLUSH: setRawMode does not discard pending
 * input, which matters because anything typed or pasted before the wrapper
 * got here has to survive. */
export function setRawStdin(): (() => void) | null {
  if (!isatty(0) || typeof process.stdin.setRawMode !== "function") return null;
  process.stdin.setRawMode(true);
  return () => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // the terminal is gone; nothing left to restore it for
    }
  };
}

/** The terminal's size as [rows, cols], falling back the way the Python's
 * failed TIOCGWINSZ did. */
export function winsize(): [number, number] {
  const rows = process.stdout.rows, cols = process.stdout.columns;
  if (rows && cols) return [rows, cols];
  return [24, Number(process.env["COLUMNS"]) || 80];
}

/** Write every byte to a file descriptor. Short writes on a tty are the norm,
 * not the exception, which is why this loops. */
export function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) {
    try {
      off += writeSync(fd, data, off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;      // the terminal is behind; try again
      return;                               // EPIPE and friends: it is gone
    }
  }
}

/** Block for `ms`. The forced repaint depends on the child seeing an
 * intermediate window size for a real moment, so this is a true sleep the way
 * time.sleep() was -- not a turn of the event loop. Works on both runtimes. */
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(SLEEPER, 0, 0, ms);
}

/** The first executable named `name` on PATH, or null. Replaces Bun.which,
 * which has no Node equivalent. */
export function which(name: string): string | null {
  if (name.includes("/")) return null;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable PATH entry; keep looking
    }
  }
  return null;
}
