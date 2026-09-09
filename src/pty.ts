/** A pty for the wrapper, on whichever runtime is running it.
 *
 * There are two backends because neither library covers both runtimes:
 * node-pty does not work under Bun (its read pump is a node:tty ReadStream on
 * the raw master fd and never delivers a byte -- see ISSUE-node-pty-bun.md),
 * and bun:ffi does not exist under Node. Everything else the wrapper needs
 * from the terminal -- raw mode, window size, writes, a real sleep -- is the
 * same call on both and lives in sys.ts.
 *
 * The backend is chosen at first use and imported dynamically, because a
 * static import of pty-bun.ts would pull in bun:ffi and fail on Node before a
 * line of it ran.
 */
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
  /** Resolves when the pty hits end of stream, i.e. every byte the child
   * wrote has been delivered to onData. A child can exit while its last write
   * is still in the buffer, so output tests must await this and not
   * `exited`. */
  readonly drained: Promise<void>;
  /** Bytes for the child, written in order. */
  write(data: Buffer | Uint8Array): void;
  /** Bytes from the child, unparsed. Attach once, before any output. */
  onData(cb: (chunk: Buffer) => void): void;
  resize(rows: number, cols: number): void;
  kill(signal?: number): void;
  /** Hang up on the child and stop pumping. */
  destroy(): void;
}

/** True when this process is running under Bun rather than Node. */
export const IS_BUN: boolean = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export async function ptySpawn(file: string, args: readonly string[],
                               opts: PtySpawnOptions): Promise<Pty> {
  if (IS_BUN) {
    const { ptySpawnBun } = await import("./pty-bun.ts");
    return ptySpawnBun(file, args, opts);
  }
  const { ptySpawnNode } = await import("./pty-node.ts");
  return ptySpawnNode(file, args, opts);
}
