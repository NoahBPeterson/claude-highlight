/** Blocking write pump for one pty master fd, on its own worker thread.
 *
 * A raw-mode pty accepts only ~1 KB per write, and the kernel blocks a
 * writer once its buffer fills -- so keystrokes bound for the child are
 * posted here and written to completion, one message at a time, in order.
 * A blocking write stalls only this thread, never the wrapper's read path:
 * the same deadlock the Python wrapper avoided with its write queue.
 */
import { dlopen, FFIType } from "bun:ffi";

const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.dylib" : "libc.so.6", {
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});

/** Worker globals; bun-types does not declare them and pulling in the DOM
 * lib for two names would be worse. */
declare const self: {
  onmessage: ((event: MessageEvent<{ fd: number; data: Uint8Array }>) => void) | null;
};

function writeAll(fd: number, data: Uint8Array): void {
  let off = 0;
  while (off < data.length) {
    const n = Number(lib.symbols.write(fd, data.subarray(off), data.length - off));
    if (n <= 0) return;         // child gone; drop the rest
    off += n;
  }
}

self.onmessage = (event: MessageEvent<{ fd: number; data: Uint8Array }>) => {
  writeAll(event.data.fd, event.data.data);
};
