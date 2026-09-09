/** Shared harness for the ported test suites: same PASS/FAIL print style
 * and exit-code contract as the Python originals (0 only when all pass).
 * Also the byte-literal and visible-text helpers every suite needs. */

/** What a failing check may print alongside its name. `object` covers the
 * buffers, arrays and suite-defined interfaces that get handed over -- an
 * index-signature type would reject every one of those -- while leaving out
 * the two things printing cannot say anything useful about, symbols and
 * functions. fmt narrows before it touches any of it. */
export type Detail = string | number | bigint | boolean | null | undefined | object;

export const results: boolean[] = [];

function fmt(d: Detail): string {
  if (Buffer.isBuffer(d)) return JSON.stringify(d.toString("latin1"));
  if (d instanceof Uint8Array) return JSON.stringify(Buffer.from(d).toString("latin1"));
  if (typeof d === "object" && d !== null) {
    try { return JSON.stringify(d); } catch { return String(d); }
  }
  return String(d);
}

export function report(name: string, ok: boolean, ...detail: Detail[]): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) for (const d of detail) console.log("      ", fmt(d));
  results.push(ok);
}

export function finish(): never {
  const bad = results.filter(x => !x).length;
  console.log("\n" + (bad === 0 ? "ALL PASS" : `FAILURES PRESENT (${bad})`));
  process.exit(bad === 0 ? 0 : 1);
}

/** Byte literal, like Python's b"...": escapes land as single bytes. */
export const B = (s: string): Buffer => Buffer.from(s, "latin1");

const CSI_STRIP = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

/** Printable text only: what test_filter.py called `visible`. */
export function visible(b: Buffer): Buffer {
  return Buffer.from(b.toString("latin1").replace(CSI_STRIP, ""));
}
