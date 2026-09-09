# Comment to post on oven-sh/bun#25822

<!--
Post as a comment on https://github.com/oven-sh/bun/issues/25822
Do NOT open a new issue: #25822 already covers the "onData never fires" symptom,
and #29114 already diagnoses the cause.
Do NOT ask for a review pass on #29114 — it got a substantive one on 2026-09-01
("keep open, rework") listing two concrete correctness problems. The useful
contribution now is the encoding:null data point, which bears on one of them.
-->

Still present on **Bun 1.4.0 / node-pty 1.1.0 / macOS 26.5 (25F71) arm64**, and
I hit a variant that isn't in this thread yet: with `encoding: null` (raw
`Buffer` mode) **no callbacks fire at all** — not even `onExit` — and the
process never exits on its own. I first ran into it as a silent 60s+ hang with
zero output; it has to be killed externally.

The `encoding: "utf8"` path fails the way everyone else has described here:

```ts
// repro.ts  -- bun add node-pty; bun repro.ts
import { spawn as ptySpawn } from "node-pty";

const p = ptySpawn("/bin/sh", ["-c", 'printf "hi"; exit 3'], {
  encoding: "utf8", cols: 80, rows: 24, env: process.env,
});
p.onData((d: string) => console.log("onData:", JSON.stringify(d)));
p.onExit(({ exitCode, signal }) => console.log("exit:", exitCode, "signal:", signal ?? 0));
```

Same file, same machine:

```
node 26.8.1:   onData: "hi"
               exit: 3 signal: 0

bun 1.4.0:     exit: 0 signal: 1
```

Swap `encoding: "utf8"` for `encoding: null` and the Bun run prints nothing and
hangs; Node still delivers the data and `exit: 3 signal: 0`.

## Consistent with the #29114 diagnosis

The `signal: 1` is the tell, and I think it's the same single defect rather than
a second one. Bun's `tty.ReadStream` is backed by `fs.ReadStream`, so the first
`EAGAIN` from the `O_NONBLOCK` master fd that node-pty's addon hands it reaches
`errorOrDestroy` and the stream is destroyed and the fd closed. node-pty wraps
the master at `lib/unixTerminal.js:93` (`this._socket = new tty.ReadStream(term.fd)`)
and — per the 2026-09-01 review on #29114 — deliberately releases it through
`_socket.destroy()`, sending `SIGHUP` from `_socket.once('close')`. So the
premature `EAGAIN` destroy doesn't just lose the read pump; it fires node-pty's
whole teardown path before the child has produced a byte. That accounts for the
successful fork, the zero delivered bytes, and `{ exitCode: 0, signal: 1 }`
reported here and in the Linux confirmation above.

The `encoding: null` case is the part I can't place. Losing `onData` is
explained above, but `onExit` goes through node-pty's `Napi::ThreadSafeFunction`
in `src/unix/pty.cc`, independent of the socket, and it fires fine in the utf8
case — so something about raw `Buffer` mode is also stalling the exit callback,
or preventing the destroy from completing at all. The hang (rather than an early
`SIGHUP` kill) suggests the latter.

That may be worth folding into whatever test lands with the rework. The review
already asks that the test await `'close'` after `destroy()` and assert the fd
is closed; a raw-`Buffer` `tty.ReadStream` over a non-blocking fd would exercise
the same path with no decoder in between, and on current `main` it's a case
where `'close'` appears never to arrive at all.

Happy to re-run any of this against a branch if that's useful — I have both
runtimes set up on the affected machine.

## Unrelated packaging snag, for anyone reproducing

node-pty 1.1.0's prebuild ships `prebuilds/darwin-arm64/spawn-helper` without
the executable bit, and neither npm (blocked install scripts) nor Bun (untrusted
lifecycle scripts) runs its install scripts. Without

```sh
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
```

the spawn fails earlier with `Error: posix_spawnp failed.` — that's a separate
node-pty packaging issue, not this bug.

## Environment

- Bun 1.4.0
- Node 26.8.1 (reference behavior)
- macOS 26.5 (build 25F71), arm64
- node-pty 1.1.0, prebuilt `darwin-arm64` addon — the addon loads under Bun and
  `pty.fork` works (child spawns, pid comes back), so the native binding is not
  the problem
