#!/usr/bin/env bun
/** Every suite, in one run. Each is a standalone program that prints its own
 * PASS lines and exits nonzero on any failure, so this only has to sequence
 * them and add up the verdicts -- the same contract the Python suites had.
 *
 * They run one at a time on purpose: the pty and wrapper suites spawn real
 * processes and wait on real timings, and running them alongside each other
 * makes those waits flaky rather than fast.
 */
import { report, finish } from "./harness";

const SUITES = [
  "test/pty-smoke.ts",
  "test/test_filter.ts",
  "test/test_screen.ts",
  "test/test_integration.ts",
  "test/test_wrapper.ts",
  "test/test_paste.ts",
  "test/test_miners.ts",
] as const;

const root = new URL("..", import.meta.url).pathname;

for (const suite of SUITES) {
  const t0 = Date.now();
  const proc = Bun.spawnSync(["bun", "run", suite], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  const passes = out.split("\n").filter(l => l.startsWith("PASS")).length;
  const fails = out.split("\n").filter(l => l.startsWith("FAIL"));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  report(`${suite}  (${passes} checks, ${dt}s)`, proc.exitCode === 0,
         ...fails.slice(0, 10), ...(fails.length > 10 ? [`...and ${fails.length - 10} more`] : []),
         ...(proc.exitCode === 0 || fails.length ? [] : [out.slice(-2000)]));
}

finish();
