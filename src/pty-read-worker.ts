/** Blocking read pump for one pty master fd, on its own worker thread.
 *
 * The Python wrapper's select loop blocked on the master between ticks; a
 * worker thread is the same shape in Bun, where FFI calls are synchronous and
 * must not run on the main loop. read() blocks, so there is no EAGAIN, and
 * n <= 0 is end-of-stream: the child exited (macOS reports EIO on the
 * master once the slave's last fd closes, Linux returns 0).
 */
import { dlopen, FFIType } from "bun:ffi";

const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.dylib" : "libc.so.6", {
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});

/** Worker globals; bun-types does not declare them and pulling in the DOM
 * lib for two names would be worse. */
declare const self: {
  onmessage: ((event: MessageEvent<{ fd: number }>) => void) | null;
  /** A chunk, or null for end of stream. */
  postMessage(value: Uint8Array | null): void;
};

self.onmessage = (event: MessageEvent<{ fd: number }>) => {
  const fd = event.data.fd;
  const buf = new Uint8Array(65536);
  try {
    for (;;) {
      const n = Number(lib.symbols.read(fd, buf, buf.length));
      if (n <= 0) break;
      // structured clone copies the view at post time, so reuse is safe
      self.postMessage(buf.subarray(0, n));
    }
  } catch {
    // read errors here all mean the child is gone
  }
  self.postMessage(null);
};
