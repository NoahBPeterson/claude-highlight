/** A pty for the wrapper, in the Bun-native way.
 *
 * node-pty is unusable under Bun (its read pump is a node:tty ReadStream on
 * the raw master fd, which never delivers -- see ISSUE-node-pty-bun.md), so
 * this owns the plumbing the way the Python original did:
 *
 *   openpty(3) via bun:ffi gets a master/slave pair with the right winsize;
 *   Bun.spawn runs the child on the slave and reaps it, reporting exit codes
 *   in shell convention (N, or 128+signal for a signalled child);
 *   worker threads do the blocking read and the blocking write.
 *
 * One deliberate difference from pty.fork: the child is NOT given a
 * controlling terminal. Claude Code sets the slave raw and reads signal
 * characters as bytes, so all that is lost is kernel-delivered SIGWINCH --
 * which the wrapper sends explicitly on resize, as the Python version did
 * too -- and SIGHUP on master close, which we also send ourselves.
 */
import { closeSync } from "node:fs";
import { setWinsize, SIGWINCH, SIGHUP, SIGTERM, ffi } from "./sysffi";
import { environ } from "./util";

export interface PtySpawnOptions {
  readonly cols: number;
  readonly rows: number;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

export interface Pty {
  readonly pid: number;
  /** Resolves to the exit code, or 128+signal when the child was signalled. */
  readonly exited: Promise<number>;
  /** Resolves when the master hits end of stream, i.e. every byte the child
   * wrote has been delivered to onData. A child can exit while its last
   * write is still in the pty buffer, so output tests must await this and
   * not `exited`. Pending until onData() has been attached. */
  readonly drained: Promise<void>;
  /** Bytes for the child; queued and drained in order by the write worker. */
  write(data: Buffer | Uint8Array): void;
  /** Bytes from the child, unparsed. Attach once, before any output. */
  onData(cb: (chunk: Buffer) => void): void;
  resize(rows: number, cols: number): void;
  kill(signal?: number): void;
  /** Close the master; the child gets SIGHUP from us (it has no session). */
  destroy(): void;
}

/** The URL of a sibling worker module, in whichever form this code is
 * running as: the .ts source in development, the built .js after a build.
 *
 * `new Worker(new URL("./x.ts", import.meta.url))` is not something a bundler
 * rewrites -- bun build leaves the string alone and emits no such file -- so
 * the extension is chosen here instead, and the build emits the workers as
 * entry points of their own beside the bundle. Both forms keep every module
 * in one directory, which is what makes the relative URL resolve either way.
 */
export function workerUrl(name: string): URL {
  return new URL(`./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
                 import.meta.url);
}

export function ptySpawn(file: string, args: readonly string[], opts: PtySpawnOptions): Pty {
  const m = Buffer.alloc(4);
  const s = Buffer.alloc(4);
  const name = Buffer.alloc(128);
  const ws = Buffer.alloc(8);
  ws.writeUInt16LE(Math.max(opts.rows, 1) & 0xffff, 0);
  ws.writeUInt16LE(Math.max(opts.cols, 1) & 0xffff, 2);
  const rc = ffi.openpty.openpty(m, s, name, null, ws);
  if (rc !== 0) throw new Error(`openpty failed (${rc})`);
  const master = m.readInt32LE(0);
  const slave = s.readInt32LE(0);

  const proc = Bun.spawn([file, ...args], {
    stdin: slave,
    stdout: slave,
    stderr: slave,
    env: opts.env ?? environ(),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  closeSync(slave);            // the parent holds only the master: clean EOF

  const reader = new Worker(workerUrl("pty-read-worker"));
  const writer = new Worker(workerUrl("pty-write-worker"));
  let dataCb: ((chunk: Buffer) => void) | null = null;
  let markDrained: () => void = () => {};
  const drained = new Promise<void>(res => { markDrained = res; });
  reader.addEventListener("message", (event) => {
    const chunk = (event as MessageEvent<Uint8Array | null>).data;
    if (chunk === null) markDrained();
    else dataCb?.(Buffer.from(chunk));
  });

  const exited = (async () => Number(await proc.exited))();
  let reading = false;

  return {
    pid: proc.pid,
    get exited() { return exited; },
    get drained() { return drained; },
    write(data) {
      writer.postMessage({ fd: master, data: new Uint8Array(data) });
    },
    onData(cb) {
      dataCb = cb;
      if (!reading) {
        reading = true;
        reader.postMessage({ fd: master });
      }
    },
    resize(rows, cols) {
      setWinsize(master, rows, cols);
      try { proc.kill(SIGWINCH); } catch { /* already gone */ }
    },
    kill(signal = SIGTERM) {
      try { proc.kill(signal); } catch { /* already gone */ }
    },
    destroy() {
      try { proc.kill(SIGHUP); } catch { /* already gone */ }
      try { closeSync(master); } catch { /* already closed */ }
      markDrained();          // nothing more will arrive once the master is shut
      reader.terminate();
      writer.terminate();
    },
  };
}
