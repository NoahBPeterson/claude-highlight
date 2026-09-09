import { homedir } from "node:os";
import { join } from "node:path";

/** Where an app of this family keeps its config, honouring XDG_CONFIG_HOME
 * and $HOME -- the wrapper and the miner have to agree on this, or a word you
 * add stops being counted in scans. */
export function configFile(app: string): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(process.env["HOME"] || homedir(), ".config");
  return join(base, app, "config.json");
}

/** UTF-8 decode that DROPS invalid bytes, matching Python's errors="ignore".
 *
 * Node's TextDecoder inserts U+FFFD for bad sequences; the stream filter's
 * cross-chunk prefix scan needs Python's semantics instead, where a stray
 * byte is simply skipped and the text around it still gets to grow into a
 * marker phrase. Invalid starts resync on the next byte; a truncated
 * sequence at the end of the buffer is dropped.
 */
export function decodeIgnore(buf: Buffer): string {
  let out = "";
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i] ?? 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    let len: number, cp: number;
    if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07; }
    else { i++; continue; }              // continuation alone, overlong lead, 0xf5+
    if (i + len > n) break;              // truncated tail: dropped
    let ok = true;
    for (let k = 1; k < len; k++) {
      const c = buf[i + k] ?? 0x80;
      if ((c & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) { i++; continue; }          // resync after the bad lead byte
    if (len === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (len === 4 && (cp < 0x10000 || cp > 0x10ffff)) ok = false;
    if (!ok) { i++; continue; }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

/** The current environment as a plain string map.
 *
 * process.env types every value `string | undefined` because a lookup can
 * miss -- but an environment holds no unset variables, it simply lacks them,
 * so the copy handed to a child says so and callers stop propagating an
 * undefined that can never arrive.
 */
export function environ(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
