# node-pty under Bun: pty.spawn delivers no data; child is killed by SIGHUP

## What happened?

Running node-pty 1.1.0 under Bun 1.4.0, `pty.spawn()` itself succeeds — the
pty is created and a pid is returned — but:

- `onData` never fires. No output from the child is ever delivered.
- The child is killed by SIGHUP before it can do anything: `onExit` reports
  `{ exitCode: 0, signal: 1 }` regardless of the child's actual exit code.
- With `encoding: null` (raw Buffer mode), no callbacks fire at all and the
  process never exits on its own; it has to be killed externally (first
  observed as a silent 60s+ hang with zero output).

## What did you expect to happen?

The Node behavior, which the identical snippet produces on the same machine:
output delivered through `onData`, and the child's real exit status reported
by `onExit` (`exit: 3 signal: 0`).

## Code snippet

```ts
// repro.ts  -- bun add node-pty; bun repro.ts
import { spawn as ptySpawn } from "node-pty";

const p = ptySpawn("/bin/sh", ["-c", 'printf "hi"; exit 3'], {
  encoding: "utf8", cols: 80, rows: 24, env: process.env,
});
p.onData((d: string) => console.log("onData:", JSON.stringify(d)));
p.onExit(({ exitCode, signal }) => console.log("exit:", exitCode, "signal:", signal ?? 0));
```

Note for anyone reproducing: node-pty 1.1.0's prebuild ships
`prebuilds/darwin-arm64/spawn-helper` without the executable bit, and neither
npm (blocked install scripts) nor Bun (untrusted lifecycle scripts) runs its
install scripts. Without
`chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` the spawn fails
earlier with `Error: posix_spawnp failed.` — a separate packaging issue, not
the one described here.

## Behavior on Node vs Bun

Same code, same machine (`.mjs` under Node, `.ts` under Bun):

Node 26.8.1:

```
onData: "hi"
exit: 3 signal: 0
```

Bun 1.4.0:

```
exit: 0 signal: 1
```

`onData` never fires. With `encoding: null` additionally nothing fires and the
process hangs until killed.

## Node version, bun version, OS version, other environment information

- Bun 1.4.0
- Node 26.8.1 (reference behavior)
- macOS 26.5 (build 25F71), arm64
- node-pty 1.1.0, prebuilt `darwin-arm64` addon. The addon loads under Bun and
  `pty.fork` works (the child is spawned and a pid comes back), so the native
  binding is not the problem.
- Likely relevant: node-pty's read pump is
  `this._socket = new tty.ReadStream(term.fd)` at
  `lib/unixTerminal.js:93` — a `node:tty` `ReadStream` constructed around the
  raw pty master fd. Under Bun that stream appears to deliver no data and no
  error; node-pty's close path then closes the master fd, which sends SIGHUP
  to the child as session leader — consistent with the successful fork, the
  zero delivered bytes, and `signal: 1`.
