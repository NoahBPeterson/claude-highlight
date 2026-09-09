/** The Node pty backend: node-pty, which is the native way to do this on the
 * runtime it was written for.
 *
 * @lydell/node-pty rather than node-pty itself, for one concrete reason:
 * node-pty publishes its tarball with `spawn-helper` at mode 0644 and relies
 * on a postinstall script to add the executable bit -- which does not always
 * run, and even when it does, does not always work. The fork ships per
 * platform prebuilds as optional dependencies, with the bit already set, so
 * an install needs no scripts at all.
 *
 * Unlike the Bun backend this gives the child a real controlling terminal, so
 * the kernel delivers SIGWINCH on resize by itself; sending it again would
 * only make the child redraw twice.
 */
import * as nodePty from "@lydell/node-pty";
import { environ } from "./util.ts";
import type { Pty, PtySpawnOptions } from "./pty.ts";

export function ptySpawnNode(file: string, args: readonly string[],
                             opts: PtySpawnOptions): Pty {
  const term = nodePty.spawn(file, [...args], {
    name: process.env["TERM"] ?? "xterm-256color",
    cols: Math.max(opts.cols, 1),
    rows: Math.max(opts.rows, 1),
    env: opts.env ?? environ(),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    encoding: null,           // Buffers, not strings: this stream is bytes
  });

  let dataCb: ((chunk: Buffer) => void) | null = null;
  let markDrained: () => void = () => {};
  const drained = new Promise<void>(res => { markDrained = res; });
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>(res => { resolveExit = res; });

  term.onData(chunk => {
    // encoding: null asks for Buffers, but the typings say string; the data
    // is bytes either way, and latin1 is the lossless round trip if a build
    // of the addon hands back a string.
    dataCb?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, "latin1"));
  });
  term.onExit(({ exitCode, signal }) => {
    // Shell convention, matching the Bun backend and the Python original.
    resolveExit(signal ? 128 + signal : exitCode);
    markDrained();
  });

  return {
    pid: term.pid,
    exited,
    drained,
    write(data) {
      term.write(Buffer.from(data).toString("latin1"));
    },
    onData(cb) {
      dataCb = cb;
    },
    resize(rows, cols) {
      try {
        term.resize(Math.max(cols, 1), Math.max(rows, 1));
      } catch {
        // the child is already gone
      }
    },
    kill(signal = 15) {
      try {
        term.kill(signal === 9 ? "SIGKILL" : signal === 1 ? "SIGHUP" : "SIGTERM");
      } catch {
        // already gone
      }
    },
    destroy() {
      try {
        term.kill("SIGHUP");
      } catch {
        // already gone
      }
      markDrained();
    },
  };
}
