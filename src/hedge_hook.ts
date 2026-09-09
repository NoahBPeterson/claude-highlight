/** Stop hook: flag epistemic markers in the assistant message that just ended.
 *
 * Claude Code has no hook that can restyle streamed output, so this reads the
 * finished message out of the transcript and emits a `systemMessage`, which the
 * UI renders as a warning line directly under the turn.
 *
 * Wire up in settings.json:
 *     "Stop": [{"hooks": [{"type": "command",
 *               "command": "node /path/to/src/hedge_hook.ts"}]}]
 */
import { readFileSync, readSync } from "node:fs";
import { LEXICON, WEIGHTS } from "./hedge_lexicon.ts";
import { isObject, type Json } from "./json.ts";
import { sleepSync } from "./sys.ts";

// Only the categories that mean "this was inferred, not checked". The noisy
// ones (modal/vagueness/softener) would fire on every turn.
const LOUD = ["inference", "assumption", "appearance", "unknown", "overclaim"] as const;
const THRESHOLD = 2.0;  // weighted score below this stays silent

const PATTERNS: Record<string, RegExp> = Object.fromEntries(
  LOUD.map((c): [string, RegExp] =>
    [c, new RegExp("\\b(?:" + (LEXICON[c] ?? []).join("|") + ")\\b", "gi")]),
);
// [\s\S] stands in for Python's re.DOTALL, which JS has no flag for.
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Python's format(x, ".0f"): a tie rounds to even, where toFixed rounds up. */
function f0(x: number): string {
  const fl = Math.floor(x);
  const frac = x - fl;
  if (frac > 0.5) return String(fl + 1);
  if (frac < 0.5) return String(fl);
  return String(fl % 2 === 0 ? fl : fl + 1);
}

/** Return the text blocks of the final assistant turn. */
function lastAssistantText(transcriptPath: string): string {
  let body: string;
  try {
    // utf8 decoding turns bad bytes into U+FFFD, as Python's errors="replace" does
    body = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.includes('"assistant"')) continue;
    let d: Json;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(d) || d["type"] !== "assistant") continue;
    const msg = d["message"];
    const content = isObject(msg) ? msg["content"] : null;
    if (!Array.isArray(content)) continue;
    const blocks: string[] = [];
    for (const b of content) {
      if (isObject(b) && b["type"] === "text") blocks.push(String(b["text"] ?? ""));
    }
    const text = blocks.join("\n");
    if (text.trim()) return text;
  }
  return "";
}

/** Every byte on stdin. Replaces Bun.stdin.text(), which has no Node
 * counterpart: the payload arrives on a pipe that may hand it over in pieces,
 * so this reads to EOF, and an EAGAIN means the writer is behind rather than
 * done. Bad bytes become U+FFFD, as Python's errors="replace" did. */
function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
        sleepSync(1);
        continue;
      }
      break;                              // EOF, or stdin was never opened
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function main(): void {
  let payload: Json;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return;
  }
  if (!isObject(payload)) return;
  if (payload["stop_hook_active"]) return;
  const path = payload["transcript_path"];
  const text = lastAssistantText(typeof path === "string" ? path : "").replace(CODE_RE, " ");
  if (!text) return;

  let score = 0.0;
  const found: Record<string, string[]> = {};
  for (const [cat, pat] of Object.entries(PATTERNS)) {
    pat.lastIndex = 0;
    const hits = [...text.matchAll(pat)].map(m => m[0].toLowerCase());
    if (hits.length) {
      found[cat] = hits;
      score += (WEIGHTS[cat] ?? 0) * hits.length;
    }
  }
  if (score < THRESHOLD) return;

  const parts: string[] = [];
  for (const cat of LOUD) {
    const hits = found[cat];
    if (hits !== undefined) {
      const uniq = [...new Set(hits)].sort().slice(0, 4);
      parts.push(`${cat}: ${uniq.join(", ")}`);
    }
  }
  console.log(JSON.stringify({
    systemMessage: `⚠ unverified-claim markers (${f0(score)}) — ` + parts.join(" │ "),
  }));
}

if (import.meta.main) main();
