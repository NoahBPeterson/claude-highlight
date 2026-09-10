/** The Bun pty backend: openpty(3) through bun:ffi.
 *
 * Only reached when the process is running under Bun. Node uses node-pty
 * instead (see pty-node.ts) -- which is the right tool there, and the wrong
 * one here, since node-pty is what does not work under Bun.
 *
 * node-pty is unusable under Bun (its read pump is a node:tty ReadStream on
 * the raw master fd, which never delivers -- see oven-sh/bun#25822), so
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
import { setWinsize, SIGWINCH, SIGHUP, SIGTERM, ffi } from "./sysffi.ts";
import { environ } from "./util.ts";
import type { Pty, PtySpawnOptions } from "./pty.ts";

/** The URL of a sibling worker module, in whichever form this is running as:
 * the .ts source in development, the built .js after a build. Bundlers do not
 * rewrite the string inside `new Worker(new URL(...))`, so the extension is
 * chosen here and the build emits the workers as entry points of their own. */
function workerUrl(name: string): URL {
  return new URL(`./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
                 import.meta.url);
}

export function ptySpawnBun(file: string, args: readonly string[], opts: PtySpawnOptions): Pty {
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
