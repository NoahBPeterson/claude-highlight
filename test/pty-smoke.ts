// Smoke test for src/pty.ts. Run: bun test/pty-smoke.ts
import { createHash } from "node:crypto";
import { ptySpawn } from "../src/pty";
import { environ } from "../src/util";
import type { Detail } from "./harness";

let passed = 0, failed = 0;
function report(name: string, ok: boolean, detail?: Detail): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log("      ", detail);
  ok ? passed++ : failed++;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ENV = environ();

// 1. byte fidelity, including high bytes, through the pty
{
  // Octal, not \xHH: /bin/sh is dash on most Linux distributions, and hex
  // escapes are a bash/GNU extension its printf does not implement -- so the
  // hex form emitted the literal text there and this check failed on CI while
  // passing on macOS, where /bin/sh is bash.
  const p = ptySpawn("/bin/sh", ["-c", 'printf "A\\377\\376\\033[31mZ"; exit 3'],
    { rows: 24, cols: 80, env: ENV });
  let got = Buffer.alloc(0);
  p.onData(c => { got = Buffer.concat([got, c]); });
  await p.drained;              // exit can beat the last write out of the pty
  report("byte fidelity incl. high bytes", got.subarray(0, 1).toString("latin1") === "A" &&
    got.includes(Buffer.from([0xff, 0xfe])) && got.includes(Buffer.from("\x1b[31m", "latin1")), got.toString("latin1"));
  report("exit code 3 propagates", await p.exited === 3, await p.exited);
  p.destroy();
}

// 2. signal death -> shell convention 128+N
{
  const p = ptySpawn("/bin/sleep", ["30"], { rows: 24, cols: 80, env: ENV });
  await sleep(150);
  p.kill(9);                    // SIGKILL
  report("SIGKILL -> 137", await p.exited === 137, await p.exited);
  p.destroy();
}

// 3. winsize: stty reports what openpty/ioctl set
{
  const p = ptySpawn("/bin/sh", ["-c", "stty size; sleep 0.3"], { rows: 24, cols: 80, env: ENV });
  let got = "";
  p.onData(c => { got += c.toString("latin1"); });
  await p.drained;
  report("initial winsize 24 80", got.trim().startsWith("24 80"), got);
  p.destroy();
}
{
  const p = ptySpawn("/bin/sh", ["-c", "sleep 0.15; stty size"], { rows: 24, cols: 80, env: ENV });
  p.resize(30, 100);
  let got = "";
  p.onData(c => { got += c.toString("latin1"); });
  await p.drained;
  report("resize to 30 100", got.trim().startsWith("30 100"), got);
  p.destroy();
}

// 4. SIGWINCH delivered explicitly on resize
{
  const child = `
    process.on("SIGWINCH", () => { console.log("WINCH"); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
  const p = ptySpawn(process.execPath, ["-e", child], { rows: 24, cols: 80, env: ENV });
  let got = "";
  p.onData(c => { got += c.toString("latin1"); });
  await sleep(300);
  p.resize(30, 100);
  const code = await p.exited;
  report("SIGWINCH delivered on resize", code === 0 && got.includes("WINCH"), { code, got });
  p.destroy();
}

// 5. 1 MB round trip: write queue + read pump under load (child echoes)
{
  const payload = Buffer.from(
    Array.from({ length: 1 << 20 }, (_, i) => 65 + (i % 26)));
  // raw mode on the slave: a cooked line discipline caps a line at MAX_CANON
  // (1 KB) and would wedge on a payload with no newlines in it.
  const p = ptySpawn("/bin/sh", ["-c", "stty raw -echo; exec cat"],
    { rows: 60, cols: 200, env: ENV });
  let got = Buffer.alloc(0);
  p.onData(c => { got = Buffer.concat([got, c]); });
  await sleep(200);
  const t0 = Date.now();
  for (let off = 0; off < payload.length; off += 4096) p.write(payload.subarray(off, off + 4096));
  // cat exits on EOF; our destroy sends SIGHUP -- instead wait for enough data
  const deadline = Date.now() + 30000;
  while (got.length < payload.length && Date.now() < deadline) await sleep(50);
  const dt = Date.now() - t0;
  report(`1 MB round trip (${dt}ms)`, got.length === payload.length &&
    createHash("md5").update(got).digest("hex") === createHash("md5").update(payload).digest("hex"),
    { got: got.length, want: payload.length });
  p.destroy();
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES PRESENT"} (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
