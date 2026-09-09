#!/usr/bin/env node
/** Every suite, in one run. Each is a standalone program that prints its own
 * PASS lines and exits nonzero on any failure, so this only has to sequence
 * them and add up the verdicts -- the same contract the Python suites had.
 *
 * They run one at a time on purpose: the pty and wrapper suites spawn real
 * processes and wait on real timings, and running them alongside each other
 * makes those waits flaky rather than fast.
 */
import { spawnSync } from "node:child_process";
import { report, finish } from "./harness.ts";

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
  // process.execPath, not a hardcoded runtime: a suite is exercised under
  // whichever of Bun or Node is running this file, so one command covers both.
  const proc = spawnSync(process.execPath, [suite], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    // Node caps a captured stream at 1 MB and then reports ENOBUFS with the
    // output truncated; a failing suite's detail is the whole point here.
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  const lines = out.split("\n");
  const passes = lines.filter(l => l.startsWith("PASS")).length;
  // A failing check prints its name, then indented detail lines -- and the
  // detail is the whole point on a machine you cannot open a shell on, so
  // carry it up rather than just the headline.
  const fails: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("FAIL")) continue;
    fails.push(line);
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) fails.push(lines[++i]!);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  // status is null for a suite killed by a signal, which is not a pass either.
  const ok = proc.status === 0;
  report(`${suite}  (${passes} checks, ${dt}s)`, ok,
         ...fails.slice(0, 10), ...(fails.length > 10 ? [`...and ${fails.length - 10} more`] : []),
         ...(ok || fails.length ? [] : [out.slice(-2000)]));
}

finish();
