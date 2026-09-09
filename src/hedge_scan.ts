/** Mine Claude Code / OpenCode / Kimi Code transcripts for epistemic markers.
 *
 * Scans assistant-authored prose (final answers, and optionally reasoning) and
 * reports where the agent hedged, assumed, or overclaimed.
 *
 * Usage:
 *     bun run src/hedge_scan.ts                      # scan everything, print report
 *     bun run src/hedge_scan.ts --tool claude        # one source
 *     bun run src/hedge_scan.ts --thinking           # include reasoning blocks
 *     bun run src/hedge_scan.ts --json out.json      # dump raw hits
 *     bun run src/hedge_scan.ts --samples inference  # show example sentences
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LEXICON, WEIGHTS, userPattern } from "./hedge_lexicon";
import { isObject, type Json } from "./json";
import { configFile } from "./util";

// Fold in whatever claude-highlight is configured to highlight, so a word you
// added shows up in scans too rather than only lighting up live.
const HOME = process.env["HOME"] || homedir();
const CONFIG = configFile("claude-highlight");

/** Config patterns that compile. An invalid one is skipped, never fatal. */
/** The value domain a sqlite row can hold, which is what bun:sqlite hands
 * back from .values(). */
type SqlValue = string | number | bigint | Uint8Array | null;

function valid(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const frag = userPattern(w);
    try {
      new RegExp(frag);
    } catch {
      continue;
    }
    out.push(frag);
  }
  return out;
}

/** Config words as a list. A bare string is one word, not one word per
 * character; anything else is treated as empty rather than fatal. */
function wordlist(x: Json | undefined): readonly string[] {
  if (typeof x === "string") return [x];
  return Array.isArray(x) ? x.map(w => String(w)) : [];
}

function mergeUserTerms(): void {
  let cfg: Json;
  try {
    cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return;
  }
  if (!isObject(cfg)) return;
  const cats = isObject(cfg["categories"]) ? cfg["categories"] : {};
  for (const [cat, spec] of Object.entries(cats)) {
    if (!isObject(spec)) continue;
    const added = valid(wordlist(spec["add"]));
    if (added.length) {
      LEXICON[cat] = [...(LEXICON[cat] ?? []), ...added];
      WEIGHTS[cat] ??= 1.0;
    }
  }
  const custom = isObject(cfg["custom"]) ? cfg["custom"] : {};
  for (const [name, spec] of Object.entries(custom)) {
    if (!isObject(spec)) continue;
    const terms = valid(wordlist(spec["terms"]));
    if (terms.length) {
      LEXICON[name] = [...(LEXICON[name] ?? []), ...terms];
      WEIGHTS[name] ??= 1.0;
    }
  }
}

mergeUserTerms();

const CC_ROOT = join(HOME, ".claude", "projects");
const OC_ROOT = join(HOME, ".local", "share", "opencode", "storage");
const KIMI_ROOT = join(HOME, ".kimi-code", "sessions");

// One compiled alternation per category, with word boundaries.
const PATTERNS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(LEXICON).map(
    ([cat, terms]) => [cat, new RegExp("\\b(?:" + terms.join("|") + ")\\b", "gi")],
  ),
);
const WORD_RE = /[A-Za-z']+/g;
// Fenced code, inline code, and file paths are prose-free: hedge words inside
// them are almost always false positives ("may" in a variable, "some" in a path).
// [\s\S] stands in for Python's re.DOTALL, which JS has no flag for.
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`|\/\S+\/\S+/g;

function stripCode(text: string): string {
  return text.replace(CODE_RE, " ");
}

function countWords(text: string): number {
  let n = 0;
  WORD_RE.lastIndex = 0;
  while (WORD_RE.exec(text) !== null) n++;
  return n;
}

function sentenceOf(text: string, start: number, end: number): string {
  // Python's rfind(sub, 0, start) requires the hit to end before `start`;
  // lastIndexOf's fromIndex is inclusive, hence the -1.
  const rfind = (sub: string): number => (start <= 0 ? -1 : text.lastIndexOf(sub, start - 1));
  const left = Math.max(rfind("."), rfind("\n")) + 1;
  const ahead = [text.indexOf(".", end), text.indexOf("\n", end)].filter(x => x !== -1);
  const right = ahead.length ? Math.min(...ahead) : text.length;
  return text.slice(left, right + 1).split(/\s+/).filter(s => s.length > 0).join(" ").slice(0, 300);
}

interface Rec {
  tool: string;
  session: string;
  project: string;
  kind: "text" | "thinking";
  text: string;
}

/** Every file under `root` whose basename satisfies `match`, at any depth. */
function rglob(root: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...rglob(p, match));
    else if (match(e.name)) out.push(p);
  }
  return out;
}

/** Read as text, dropping nothing: bad bytes become U+FFFD, matching
 * Python's errors="replace". */
function readReplace(path: string): string {
  return readFileSync(path, "utf8");
}

function* iterClaude(includeThinking: boolean): Generator<Rec> {
  for (const path of rglob(CC_ROOT, n => n.endsWith(".jsonl"))) {
    const project = basename(dirname(path));
    const session = basename(path).replace(/\.[^.]*$/, "");
    let body: string;
    try {
      body = readReplace(path);
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let d: Json;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(d) || d["type"] !== "assistant") continue;
      const msg = isObject(d["message"]) ? d["message"] : {};
      const content = msg["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isObject(block)) continue;
        const t = block["type"];
        if (t === "text" && block["text"]) {
          yield { tool: "claude", session, project, kind: "text", text: String(block["text"]) };
        } else if (t === "thinking" && includeThinking && block["thinking"]) {
          yield { tool: "claude", session, project, kind: "thinking", text: String(block["thinking"]) };
        }
      }
    }
  }
}

/** OpenCode keeps current sessions in sqlite and older ones as flat JSON. */
function* iterOpencode(includeThinking: boolean): Generator<Rec> {
  const seenParts = new Set<string>();
  const db = join(dirname(OC_ROOT), "opencode.db");
  if (existsSync(db)) {
    const con = new Database(db, { readonly: true });
    const q = `
            SELECT p.id, p.session_id, json_extract(p.data,'$.type'),
                   json_extract(p.data,'$.text')
            FROM part p JOIN message m ON m.id = p.message_id
            WHERE json_extract(m.data,'$.role') = 'assistant'
              AND json_extract(p.data,'$.type') IN ('text','reasoning')
        `;
    for (const row of con.query(q).values() as SqlValue[][]) {
      const [pid, sess, kind, text] = row;
      seenParts.add(String(pid));
      if (kind === "reasoning" && !includeThinking) continue;
      if (typeof text === "string" && text.trim()) {
        yield {
          tool: "opencode", session: typeof sess === "string" && sess ? sess : "?",
        project: "opencode",
          kind: kind === "text" ? "text" : "thinking", text,
        };
      }
    }
    con.close();
  }

  const roles = new Map<string, [Json, Json]>();
  for (const path of rglob(join(OC_ROOT, "message"), n => n.endsWith(".json"))) {
    let d: Json;
    try {
      d = JSON.parse(readReplace(path));
    } catch {
      continue;
    }
    if (!isObject(d)) continue;
    roles.set(String(d["id"]), [d["role"] ?? null, d["sessionID"] ?? null]);
  }
  for (const path of rglob(join(OC_ROOT, "part"), n => n.endsWith(".json"))) {
    let d: Json;
    try {
      d = JSON.parse(readReplace(path));
    } catch {
      continue;
    }
    if (!isObject(d)) continue;
    if (seenParts.has(String(d["id"]))) continue;
    const kind = d["type"];
    if (kind !== "text" && kind !== "reasoning") continue;
    if (kind === "reasoning" && !includeThinking) continue;
    const [role, sess] = roles.get(String(d["messageID"])) ?? [null, d["sessionID"] ?? null];
    if (role !== "assistant") continue;
    const text = typeof d["text"] === "string" ? d["text"] : "";
    if (text.trim()) {
      yield {
        tool: "opencode", session: typeof sess === "string" && sess ? sess : "?",
        project: "opencode",
        kind: kind === "text" ? "text" : "thinking", text,
      };
    }
  }
}

function* iterKimi(includeThinking: boolean): Generator<Rec> {
  for (const path of rglob(KIMI_ROOT, n => n === "wire.jsonl")) {
    // .../sessions/<workspace>/<session_uuid>/agents/<agent>/wire.jsonl
    const parts = path.split("/");
    const i = parts.indexOf("sessions");
    let project: string;
    let session: string;
    if (i !== -1 && i + 2 < parts.length) {
      project = parts[i + 1] as string;
      session = parts[i + 2] as string;
    } else {
      project = "kimi";
      session = basename(dirname(path));
    }
    let body: string;
    try {
      body = readReplace(path);
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line.includes('"content.part"')) continue;
      let d: Json;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(d)) continue;
      const ev = isObject(d["event"]) ? d["event"] : d;
      if (ev["type"] !== "content.part") continue;
      const part = isObject(ev["part"]) ? ev["part"] : {};
      if (part["type"] === "text" && part["text"]) {
        yield { tool: "kimi", session, project, kind: "text", text: String(part["text"]) };
      } else if (part["type"] === "think" && includeThinking && part["think"]) {
        yield { tool: "kimi", session, project, kind: "thinking", text: String(part["think"]) };
      }
    }
  }
}

const SOURCES: Record<string, (includeThinking: boolean) => Generator<Rec>> = {
  claude: iterClaude,
  opencode: iterOpencode,
  kimi: iterKimi,
};

type Counter = Record<string, number>;

interface Session {
  words: number;
  score: number;
  cats: Counter;
  tool: string;
  project: string;
  session: string;
  msgs: number;
}

interface Result {
  terms: Record<string, Counter>;
  cats: Record<string, Counter>;
  words: Counter;
  msgs: Counter;
  sessions: Map<string, Session>;
  samples: Record<string, [string, string, string][]>;
}

/** defaultdict(Counter): reading a tool creates its (empty) counter, exactly
 * as the Python does, so the JSON dump lists the same tools. */
function counterOf(d: Record<string, Counter>, key: string): Counter {
  let c = d[key];
  if (c === undefined) {
    c = {};
    d[key] = c;
  }
  return c;
}

const bump = (c: Counter, k: string, n = 1): void => {
  c[k] = (c[k] ?? 0) + n;
};

/** Counter.most_common: count descending, ties in insertion order (JS sort
 * is stable, so a plain comparator reproduces Python's heapq.nlargest). */
function mostCommon(c: Counter, n?: number): [string, number][] {
  const items: [string, number][] = Object.entries(c);
  items.sort((a, b) => b[1] - a[1]);
  return n === undefined ? items : items.slice(0, n);
}

function scan(tools: readonly string[], includeThinking: boolean, keepSamples = 8): Result {
  const perToolTerms: Record<string, Counter> = {};   // tool -> matched phrase -> n
  const perToolCat: Record<string, Counter> = {};     // tool -> category -> n
  const perToolWords: Counter = {};
  const perToolMsgs: Counter = {};
  const sessions = new Map<string, Session>();
  const samples: Record<string, [string, string, string][]> = {};

  for (const tool of tools) {
    const source = SOURCES[tool];
    if (source === undefined) continue;
    for (const rec of source(includeThinking)) {
      const prose = stripCode(rec.text);
      const nwords = countWords(prose);
      if (nwords < 5) continue;
      bump(perToolWords, tool, nwords);
      bump(perToolMsgs, tool);
      const key = `${tool}\u0000${rec.project}\u0000${rec.session}`;
      let s = sessions.get(key);
      if (s === undefined) {
        s = { words: 0, score: 0.0, cats: {}, tool: "", project: "", session: rec.session, msgs: 0 };
        sessions.set(key, s);
      }
      s.tool = tool;
      s.project = rec.project;
      s.words += nwords;
      s.msgs += 1;
      for (const [cat, pat] of Object.entries(PATTERNS)) {
        pat.lastIndex = 0;
        for (const m of prose.matchAll(pat)) {
          const phrase = m[0].toLowerCase();
          bump(counterOf(perToolTerms, tool), phrase);
          bump(counterOf(perToolCat, tool), cat);
          bump(s.cats, cat);
          s.score += WEIGHTS[cat] ?? 0;
          const bucket = (samples[cat] ??= []);
          if (bucket.length < keepSamples && rec.kind === "text") {
            bucket.push([
              tool, rec.session.slice(0, 8),
              sentenceOf(prose, m.index, m.index + m[0].length),
            ]);
          }
        }
      }
    }
  }
  return {
    terms: perToolTerms,
    cats: perToolCat,
    words: perToolWords,
    msgs: perToolMsgs,
    sessions,
    samples,
  };
}

const L = (s: string, n: number): string => s.padEnd(n);
const R = (s: string, n: number): string => s.padStart(n);
// Python's "{:,}" grouping; en-US pins the separator regardless of locale.
const G = (n: number): string => n.toLocaleString("en-US");
// Python's "{:.Nf}" rounds half-to-even, toFixed rounds an exact tie up, so
// the two disagree only on a value like 80.625. Nothing in the suite asserts
// these digits, so toFixed stands rather than a hand-rolled decimal formatter.
const F = (x: number, n: number): string => x.toFixed(n);

function report(r: Result, showSamples: readonly string[] | null = null): void {
  const W = r.words;
  const totalWords = Object.values(W).reduce((a, b) => a + b, 0);
  const tools = Object.keys(W).sort((a, b) => (W[b] ?? 0) - (W[a] ?? 0));
  console.log("=".repeat(78));
  console.log("EPISTEMIC MARKER SCAN");
  console.log("=".repeat(78));
  console.log(`${L("source", 10)} ${R("messages", 9)} ${R("prose words", 13)} ${R("hits", 8)} ${R("per 1k words", 13)}`);
  for (const tool of tools) {
    const w = W[tool] ?? 0;
    const hits = Object.values(counterOf(r.cats, tool)).reduce((a, b) => a + b, 0);
    const rate = w ? (hits / w) * 1000 : 0;
    console.log(`${L(tool, 10)} ${R(G(r.msgs[tool] ?? 0), 9)} ${R(G(w), 13)} ${R(G(hits), 8)} ${R(F(rate, 1), 13)}`);
  }
  const totalMsgs = Object.values(r.msgs).reduce((a, b) => a + b, 0);
  console.log(`${L("TOTAL", 10)} ${R(G(totalMsgs), 9)} ${R(G(totalWords), 13)}`);

  const catHits = (t: string, c: string): number => counterOf(r.cats, t)[c] ?? 0;

  console.log("\n" + "-".repeat(78));
  console.log("BY CATEGORY  (rate per 1,000 prose words)");
  console.log("-".repeat(78));
  console.log(`${L("category", 14)} ${R("weight", 7)} ` + tools.map(t => R(t, 12)).join("") + R("total", 10));
  const cats = Object.keys(LEXICON).sort(
    (a, b) => tools.reduce((s, t) => s + catHits(t, b), 0) - tools.reduce((s, t) => s + catHits(t, a), 0),
  );
  for (const cat of cats) {
    let row = `${L(cat, 14)} ${R(F(WEIGHTS[cat] ?? 0, 1), 7)} `;
    for (const t of tools) {
      const w = W[t] ?? 0;
      const rate = w ? (catHits(t, cat) / w) * 1000 : 0;
      row += R(F(rate, 2), 12);
    }
    row += R(G(tools.reduce((s, t) => s + catHits(t, cat), 0)), 10);
    console.log(row);
  }

  console.log("\n" + "-".repeat(78));
  console.log("TOP PHRASES");
  console.log("-".repeat(78));
  const merged: Counter = {};
  for (const t of tools) for (const [k, n] of Object.entries(counterOf(r.terms, t))) bump(merged, k, n);
  for (const [phrase, n] of mostCommon(merged, 30)) {
    const top = mostCommon(merged, 1)[0]?.[1] ?? 1;
    const bar = "#".repeat(Math.min(40, Math.trunc((n / Math.max(1, top)) * 40)));
    console.log(`${L(phrase, 28)} ${R(G(n), 7)}  ${bar}`);
  }

  console.log("\n" + "-".repeat(78));
  console.log("HEDGIEST SESSIONS  (weighted score per 1,000 words, min 2,000 words)");
  console.log("-".repeat(78));
  const ranked = [...r.sessions.entries()]
    .filter(([, v]) => v.words >= 2000)
    .map(([k, v]) => ({ dens: (v.score / v.words) * 1000, key: k, v }));
  // Python sorts (density, (tool, project, session)) descending; the map key
  // joins those three with U+0000, which sorts below any printable char, so a
  // plain string compare reproduces the tuple compare.
  ranked.sort((a, b) => (b.dens - a.dens) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  console.log(`${R("density", 8)}  ${L("tool", 9)} ${R("words", 8)}  ${L("top categories", 34)} project / session`);
  for (const { dens, v } of ranked.slice(0, 20)) {
    const cs = mostCommon(v.cats, 3).map(([c, n]) => `${c}:${n}`).join(", ");
    const proj = v.project.replaceAll("-Users-noahpeterson-", "~/").slice(0, 38);
    console.log(`${R(F(dens, 1), 8)}  ${L(v.tool, 9)} ${R(G(v.words), 8)}  ${L(cs, 34)} ${proj}/${v.session.slice(0, 8)}`);
  }

  if (showSamples) {
    for (const cat of showSamples) {
      console.log("\n" + "-".repeat(78));
      console.log(`SAMPLES: ${cat}`);
      console.log("-".repeat(78));
      for (const [tool, sess, sent] of r.samples[cat] ?? []) {
        console.log(`[${tool}/${sess}] ${sent}`);
      }
    }
  }
}

interface Args {
  tool: string[] | null;
  thinking: boolean;
  json: string | null;
  samples: string[] | null;
}

/** argparse by hand: the flags of the Python CLI, same argv shape. */
function parseArgs(argv: readonly string[]): Args {
  const sources = Object.keys(SOURCES);
  const catNames = Object.keys(LEXICON);
  const usage = "usage: hedge_scan.ts [-h] [--tool {" + sources.join(",") + "}] [--thinking]"
    + " [--json PATH] [--samples {" + catNames.join(",") + "}]";
  const die = (msg: string): never => {
    process.stderr.write(`${usage}\nhedge_scan.ts: error: ${msg}\n`);
    process.exit(2);
  };
  const a: Args = { tool: null, thinking: false, json: null, samples: null };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    let flag = raw;
    let inline: string | null = null;
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq !== -1) {
      flag = raw.slice(0, eq);
      inline = raw.slice(eq + 1);
    }
    const value = (): string => {
      if (inline !== null) return inline;
      const nxt = argv[++i];
      if (nxt === undefined) die(`argument ${flag}: expected one argument`);
      return nxt as string;
    };
    switch (flag) {
      case "-h":
      case "--help":
        process.stdout.write(usage + "\n");
        process.exit(0);
        break;
      case "--thinking":
        a.thinking = true;
        break;
      case "--tool": {
        const v = value();
        if (!sources.includes(v)) die(`argument --tool: invalid choice: '${v}'`);
        (a.tool ??= []).push(v);
        break;
      }
      case "--samples": {
        const v = value();
        if (!catNames.includes(v)) die(`argument --samples: invalid choice: '${v}'`);
        (a.samples ??= []).push(v);
        break;
      }
      case "--json":
        a.json = value();
        break;
      default:
        die(`unrecognized arguments: ${raw}`);
    }
  }
  return a;
}

function main(): void {
  const a = parseArgs(Bun.argv.slice(2));
  const tools = a.tool ?? Object.keys(SOURCES);
  const r = scan(tools, a.thinking);
  report(r, a.samples);
  if (a.json) {
    const out = {
      words: { ...r.words },
      messages: { ...r.msgs },
      categories: Object.fromEntries(Object.entries(r.cats).map(([t, c]) => [t, { ...c }])),
      terms: Object.fromEntries(Object.entries(r.terms).map(([t, c]) => [t, { ...c }])),
      sessions: [...r.sessions.values()].map(v => ({
        tool: v.tool, project: v.project, session: v.session, words: v.words,
        score: v.score, categories: { ...v.cats },
      })),
    };
    writeFileSync(a.json, JSON.stringify(out, null, 1));
    console.log(`\nwrote ${a.json}`);
  }
}

if (import.meta.main) main();
