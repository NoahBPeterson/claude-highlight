/** The libc surface the wrapper needs, via bun:ffi.
 *
 * The Python original called these through pty/termios/tty; Bun does not
 * implement those (its node:tty pump is what breaks node-pty), so the port
 * owns its plumbing: openpty, ioctl, raw mode via tcgetattr/cfmakeraw/
 * tcsetattr with TCSANOW -- the same call the Python version made
 * deliberately, because TCSAFLUSH would discard input pasted before raw
 * mode took effect.
 */
import { dlopen, FFIType } from "bun:ffi";

/** ioctl(2) is variadic, and Apple's arm64 ABI passes variadic arguments on
 * the stack rather than in x2-x7 -- so the obvious three-argument
 * declaration hands the callee a pointer it never reads, and every call
 * quietly writes nothing and returns 0. Declaring eight named integer
 * arguments pushes the winsize pointer into the first stack slot, which is
 * where va_arg looks. Everywhere else (Linux arm64 and x86-64, and macOS
 * x86-64) variadic arguments stay in registers, so the plain form is right.
 */
const APPLE_VARARGS = process.platform === "darwin" && process.arch === "arm64";

const IOCTL_PAD = [FFIType.u64, FFIType.u64, FFIType.u64,
                   FFIType.u64, FFIType.u64, FFIType.u64] as const;

const IOCTL = {
  ioctl: {
    args: APPLE_VARARGS
      ? [FFIType.i32, FFIType.u64, ...IOCTL_PAD, FFIType.ptr]
      : [FFIType.i32, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;

const CORE = {
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  cfmakeraw: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;

const OPENPTY = {
  openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
             returns: FFIType.i32 },
} as const;

/** The call signatures behind the symbols above. dlopen returns them typed
 * from the definition objects, but the platform-conditional ioctl shape
 * defeats that inference, so the whole surface is declared here and cast
 * once at the boundary -- which is what an FFI edge is anyway. */
interface CoreSyms {
  read(fd: number, buf: Uint8Array, n: number | bigint): bigint;
  write(fd: number, buf: Uint8Array, n: number | bigint): bigint;
  close(fd: number): number;
  // Variadic: the argument list is the platform's, see APPLE_VARARGS.
  ioctl(...args: (number | bigint | Uint8Array)[]): number;
  kill(pid: number, sig: number): number;
  tcgetattr(fd: number, buf: Uint8Array): number;
  tcsetattr(fd: number, action: number, buf: Uint8Array): number;
  cfmakeraw(buf: Uint8Array): number;
}

interface OpenptySyms {
  openpty(master: Uint8Array, slave: Uint8Array, name: Uint8Array | null,
          termios: Uint8Array | null, winsize: Uint8Array | null): number;
}

/** dlopen builds its symbol table at runtime, so this is the one place the
 * declared C signatures above are asserted over it. */
function bind<T>(symbols: object): T {
  return symbols as T;
}

function load(): { core: CoreSyms; openpty: OpenptySyms } {
  if (process.platform === "darwin") {
    const lib = dlopen("/usr/lib/libSystem.dylib", { ...CORE, ...IOCTL, ...OPENPTY });
    const syms = bind<CoreSyms & OpenptySyms>(lib.symbols);
    return { core: syms, openpty: syms };
  }
  // Linux: everything but openpty lives in libc; openpty moved out of
  // libutil into libc in glibc 2.34, so try both.
  const core = bind<CoreSyms>(dlopen("libc.so.6", { ...CORE, ...IOCTL }).symbols);
  for (const name of ["libc.so.6", "libutil.so.1", "libutil.so"]) {
    try {
      return { core, openpty: bind<OpenptySyms>(dlopen(name, OPENPTY).symbols) };
    } catch {
      // try the next candidate
    }
  }
  throw new Error("openpty not found in libc.so.6, libutil.so.1 or libutil.so");
}

export const ffi = load();

export const TCSANOW = 0;
export const TIOCGWINSZ = process.platform === "darwin" ? 0x40087468 : 0x5413;
// TIOCSWINSZ differs by platform; the winsize struct is 4 uint16s everywhere.
// macOS: _IOW('t', 103, struct winsize) -- note 103, not the 104 of the
// neighbouring TIOCGWINSZ; the off-by-one number fails with EINVAL.
export const TIOCSWINSZ = process.platform === "darwin" ? 0x80087467 : 0x5414;
export const SIGWINCH = 28;
export const SIGHUP = 1;
export const SIGTERM = 15;

/** Raw mode on stdin, mirroring tty.setraw(0, TCSANOW): returns the saved
 * termios blob to hand to restoreStdin(), or null when stdin is not a tty
 * (tests, pipes) -- exactly the Python wrapper's degrade-to-nothing path. */
export function saveAndSetRawStdin(): Buffer | null {
  const cur = Buffer.alloc(128);
  if (ffi.core.tcgetattr(0, cur) !== 0) return null;
  const saved = Buffer.from(cur);
  ffi.core.cfmakeraw(cur);
  ffi.core.tcsetattr(0, TCSANOW, cur);
  return saved;
}

export function restoreStdin(saved: Buffer): void {
  ffi.core.tcsetattr(0, TCSANOW, saved);
}

/** Set the pty's window size. Returns the ioctl result. */
export function setWinsize(master: number, rows: number, cols: number): number {
  const ws = Buffer.alloc(8);
  ws.writeUInt16LE(Math.max(rows, 1) & 0xffff, 0);
  ws.writeUInt16LE(Math.max(cols, 1) & 0xffff, 2);
  return ioctlPtr(master, TIOCSWINSZ, ws);
}

/** One ioctl whose third argument is a pointer, in whichever shape this
 * platform's variadic ABI requires. */
function ioctlPtr(fd: number, request: number, arg: Buffer): number {
  return APPLE_VARARGS
    ? ffi.core.ioctl(fd, BigInt(request), 0n, 0n, 0n, 0n, 0n, 0n, arg)
    : ffi.core.ioctl(fd, BigInt(request), arg);
}

/** Read a terminal's window size as [rows, cols], or null if the fd is not
 * one. The Python original let the OSError reach its caller, which answered
 * with a 24x80 default; the callers here do the same. */
export function getWinsize(fd: number): [number, number] | null {
  const ws = Buffer.alloc(8);
  if (ioctlPtr(fd, TIOCGWINSZ, ws) !== 0) return null;
  return [ws.readUInt16LE(0), ws.readUInt16LE(2)];
}

/** Write every byte. write(2) returns short constantly on a tty, which is
 * why the Python original had this loop too. */
export function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) {
    const n = Number(ffi.core.write(fd, data.subarray(off), data.length - off));
    if (n <= 0) return;              // the other end is gone; drop the rest
    off += n;
  }
}

/** Block for `ms`. The wrapper's forced repaint depends on the child seeing
 * an intermediate window size for a real moment, so this is a true sleep,
 * the way time.sleep() was -- not a turn of the event loop. */
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(SLEEPER, 0, 0, ms);
}
