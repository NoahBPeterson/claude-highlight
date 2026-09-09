/** Integration tests for the offline miners: hedge_scan.ts and hedge_hook.ts.
 *
 * Both run as real subprocesses against fixture transcripts in an isolated fake
 * HOME, with every count hand-computed from the lexicon weights, so the scan's
 * counting rules (code stripping, the 5-word floor, role filtering, thinking
 * gating, config merging) and the hook's message format are pinned exactly.
 *
 * Both halves shell out to `bun run src/<miner>.ts`.
 *
 * Run: bun run test/test_miners.ts
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { B, report, finish } from "./harness";
import type { Json } from "../src/json";
import { environ } from "../src/util";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "..");
const SCAN = join(ROOT, "src", "hedge_scan.ts");
const HOOK = join(ROOT, "src", "hedge_hook.ts");

const tmps: string[] = [];

function mkdtemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

interface Proc {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function runScan(home: string, args: readonly string[] = [], xdg?: string): Proc {
  const env: Record<string, string> = {
    ...environ(),
    HOME: home,
    XDG_CONFIG_HOME: xdg ?? join(home, ".config"),
  };
  return Bun.spawnSync(["bun", "run", SCAN, ...args], {
    env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000,
  });
}

function runHook(payload: Buffer): Proc {
  return Bun.spawnSync(["bun", "run", HOOK], {
    stdin: payload, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
}

interface SessionOut {
  tool: string;
  project: string;
  session: string;
  words: number;
  score: number;
  categories: Record<string, number>;
}

interface ScanJson {
  words: Record<string, number>;
  messages: Record<string, number>;
  categories: Record<string, Record<string, number>>;
  terms: Record<string, Record<string, number>>;
  sessions: SessionOut[];
}

function scanJson(home: string, args: readonly string[] = [], xdg?: string): [Proc, ScanJson | null] {
  const out = join(home, "out.json");
  const p = runScan(home, [...args, "--json", out], xdg);
  return [p, existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as ScanJson) : null];
}

const J = (o: Json): string => JSON.stringify(o);
const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
};
const tail = (b: Buffer, n: number): Buffer => b.subarray(Math.max(0, b.length - n));

// == fixtures ================================================================

function claudeHome(): string {
  const home = mkdtemp("hl-claude-");
  const proj = join(home, ".claude", "projects", "proj-a");
  const lines = [
    "garbage not json {",
    J({ type: "user", message: { content: [
      { type: "text", text: "user says probably and likely here" }] } }),
    J({ type: "assistant", message: { content: [
      { type: "text",
        text: "It seems likely that this probably works, but I can't verify the output." }] } }),
    J({ type: "assistant", message: { content: [
      { type: "text", text: "The patch is untested and probably breaks something." }] } }),
    J({ type: "assistant", message: { content: [
      { type: "text", text: "Seems fine." }] } }),           // < 5 words: skipped
    J({ type: "assistant", message: { content: [
      { type: "text", text: "Use `likely` in code, and probably in prose." }] } }),
    J({ type: "assistant", message: { content: "plain string content" } }),
    J({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Bash", input: {} }] } }),
    J({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "I suspect this is probably untested." }] } }),
    J({ type: "system", message: { content: [
      { type: "text", text: "the assistant said likely in a system line" }] } }),
  ];
  write(join(proj, "sess-1.jsonl"), lines.join("\n") + "\n");
  return home;
}

interface Expect {
  messages: number;
  words: number;
  score: number;
  cats: Record<string, number>;
}

// hand-computed expectations for the claude fixture above:
//   text m1: 13 words, seems + likely + probably + "can't verify" -> 2 + 3 + 3 + 2.5 = 10.5
//   text m2:  8 words, untested + probably                        -> 2.5 + 3       =  5.5
//   text m4:  7 words (backtick `likely` stripped), probably       -> 3
//   short m3, string content, tool_use, system line, user line: no contribution
//   thinking m5: 6 words, "i suspect" + probably + untested        -> 3 + 3 + 2.5   =  8.5
const CLAUDE_BASE: Expect = { messages: 3, words: 13 + 8 + 7, score: 19.0,
  cats: { inference: 4, appearance: 1, unknown: 2 } };
const CLAUDE_THINK: Expect = { messages: 4, words: 28 + 6, score: 27.5,
  cats: { inference: 6, appearance: 1, unknown: 3 } };

function opencodeHome(): string {
  const home = mkdtemp("hl-oc-");
  const oc = join(home, ".local", "share", "opencode");
  write(join(oc, "storage", "message", "m1.json"),
    J({ id: "m1", role: "assistant", sessionID: "s-oc" }));
  write(join(oc, "storage", "message", "m2.json"),
    J({ id: "m2", role: "user", sessionID: "s-oc" }));
  write(join(oc, "storage", "part", "p1.json"),
    J({ id: "p1", messageID: "m1", type: "text",
        text: "It seems likely to be fine." }));
  write(join(oc, "storage", "part", "p2.json"),      // user role: skipped
    J({ id: "p2", messageID: "m2", type: "text",
        text: "probably probably probably here now" }));
  write(join(oc, "storage", "part", "p3.json"),
    J({ id: "p3", messageID: "m1", type: "reasoning",
        text: "probably it is inside reasoning here" }));
  write(join(oc, "storage", "part", "db1.json"),     // same id as the db row: deduped
    J({ id: "db1", messageID: "m1", type: "text",
        text: "DOUBLE COUNTED probably double double double" }));
  const con = new Database(join(oc, "opencode.db"), { create: true });
  con.run("CREATE TABLE message (id TEXT, data TEXT)");
  con.run("CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT)");
  con.run("INSERT INTO message VALUES (?, ?)",
    ["mdb", J({ id: "mdb", role: "assistant", sessionID: "s-db" })]);
  con.run("INSERT INTO part VALUES (?, ?, ?, ?)",
    ["db1", "s-db", "mdb", J({ id: "db1", type: "text",
      text: "This probably works fine today." })]);
  con.run("INSERT INTO part VALUES (?, ?, ?, ?)",
    ["rdb", "s-db", "mdb", J({ id: "rdb", type: "reasoning",
      text: "probably it is inside db reasoning" })]);
  con.close();
  return home;
}

const OC_BASE: Expect = { messages: 2, words: 6 + 5, score: 3 + 3 + 2,
  cats: { inference: 2, appearance: 1 } };
const OC_THINK: Expect = { messages: 4, words: 11 + 6 + 6, score: 8.0 + 3 + 3,
  cats: { inference: 4, appearance: 1 } };

function kimiHome(): string {
  const home = mkdtemp("hl-kimi-");
  const wire = join(home, ".kimi-code", "sessions", "ws-1", "uuid-1", "agents", "main");
  write(join(wire, "wire.jsonl"), [
    "garbage {",
    J({ event: { type: "content.part",
        part: { type: "text", text: "It seems likely fine today." } } }),
    J({ event: { type: "content.part",
        part: { type: "think", think: "probably inside the thinking block" } } }),
    J({ type: "other", part: { type: "text", text: "ignored here now" } }),
  ].join("\n") + "\n");
  // a wire file directly under sessions/ (no workspace/uuid hierarchy):
  // the path walk falls back to project "kimi"
  write(join(home, ".kimi-code", "sessions", "wire.jsonl"), [
    J({ type: "content.part",
        part: { type: "text", text: "It seems likely enough today too." } }),
    J({ type: "content.part",
        part: { type: "think", think: "untested inside the other thinking" } }),
  ].join("\n") + "\n");
  return home;
}

const KIMI_BASE: Expect = { messages: 2, words: 5 + 6, score: (3 + 2) * 2,
  cats: { inference: 2, appearance: 2 } };
const KIMI_THINK: Expect = { messages: 4, words: 11 + 5 + 5, score: 10 + 3 + 2.5,
  cats: { inference: 3, appearance: 2, unknown: 1 } };

function checkTool(home: string, base: Expect, think: Expect, tool: string): void {
  let [p, j] = scanJson(home, ["--tool", tool]);
  const ok = p.exitCode === 0 && j !== null;
  const got = { messages: ok ? j!.messages[tool] : null, words: ok ? j!.words[tool] : null };
  let sess = (ok ? j!.sessions : []).filter(s => s.tool === tool);
  let score = sess.reduce((a, s) => a + s.score, 0);
  const cats: Record<string, number> = { ...(ok ? j!.categories[tool] ?? {} : {}) };
  report(`scan ${tool}: message/word counts match the hand-computed fixture`,
    ok && got.messages === base.messages && got.words === base.words,
    got, base, tail(p.stderr, 200));
  report(`scan ${tool}: per-category hits match`,
    ok && sameCounts(cats, base.cats), cats, base.cats);
  report(`scan ${tool}: weighted session score matches exactly`,
    ok && Math.abs(score - base.score) < 1e-9, score, base.score);
  [p, j] = scanJson(home, ["--tool", tool, "--thinking"]);
  sess = (j ? j.sessions : []).filter(s => s.tool === tool);
  score = sess.reduce((a, s) => a + s.score, 0);
  const tcats: Record<string, number> = j ? j.categories[tool] ?? {} : {};
  report(`scan ${tool}: --thinking adds exactly the gated records`,
    p.exitCode === 0 && j !== null && j.messages[tool] === think.messages
    && j.words[tool] === think.words
    && sameCounts(tcats, think.cats) && Math.abs(score - think.score) < 1e-9,
    j ? j.messages : null, think, tail(p.stderr, 200));
}

// == hedge_scan ===============================================================

checkTool(claudeHome(), CLAUDE_BASE, CLAUDE_THINK, "claude");
checkTool(opencodeHome(), OC_BASE, OC_THINK, "opencode");
checkTool(kimiHome(), KIMI_BASE, KIMI_THINK, "kimi");

// term phrases, lowercased; the code-stripped `likely` never appears as a term
let [p, j] = scanJson(claudeHome());
let terms: Record<string, number> = j ? j.terms["claude"] ?? {} : {};
report("scan: phrases lowercased, code-stripped markers absent from terms",
  p.exitCode === 0
  && sameCounts(terms, { "likely": 1, "probably": 3, "seems": 1,
    "can't verify": 1, "untested": 1 }), terms);

// the --tool filter really limits the scan
[p, j] = scanJson(kimiHome(), ["--tool", "kimi"]);
report("scan: --tool limits sources to the one named",
  p.exitCode === 0 && j !== null && J(Object.keys(j.words).sort()) === J(["kimi"]),
  j ? Object.keys(j.words) : null);

// kimi path-shape fallback
[p, j] = scanJson(kimiHome());
const projects = new Set((j?.sessions ?? []).map(s => s.project));
report("scan: kimi wire file outside sessions/ falls back to project 'kimi'",
  p.exitCode === 0 && projects.size === 2 && projects.has("ws-1") && projects.has("kimi"),
  [...projects]);

// report shape and samples
let home = claudeHome();
p = runScan(home);
report("scan: report prints its sections and exits 0",
  p.exitCode === 0 && ["EPISTEMIC MARKER SCAN", "BY CATEGORY", "TOP PHRASES",
    "HEDGIEST SESSIONS"].every(s => p.stdout.includes(B(s))),
  p.stdout.subarray(0, 200));
p = runScan(home, ["--samples", "inference"]);
report("scan: --samples prints example sentences for the category",
  p.exitCode === 0 && p.stdout.includes(B("SAMPLES: inference"))
  && p.stdout.includes(B("likely")), tail(p.stdout, 400));

// config merge: added words and custom categories join the scan
home = claudeHome();
// a second project with a message aimed at the config terms
let proj = join(home, ".claude", "projects", "proj-b");
write(join(proj, "sess-b.jsonl"), J({ type: "assistant", message: {
  content: [{ type: "text",
    text: "It smells like success and the deadline is slipping." }] } }) + "\n");
let xdg = mkdtemp("hl-xdg-");
write(join(xdg, "claude-highlight", "config.json"), J({
  categories: { inference: { add: ["smells like"] } },
  custom: { deadline: { terms: ["slipping"], color: "38;5;99" } } }));
[p, j] = scanJson(home, [], xdg);
terms = j ? j.terms["claude"] ?? {} : {};
let score = (j?.sessions ?? []).reduce((a, s) => a + s.score, 0);
report("scan: config add-words counted under their category",
  p.exitCode === 0 && terms["smells like"] === 1
  && j?.categories["claude"]?.["inference"] === 5, terms);
report("scan: custom category counted with default weight 1.0",
  p.exitCode === 0 && terms["slipping"] === 1
  && j?.categories["claude"]?.["deadline"] === 1
  && Math.abs(score - (19.0 + 3.0 + 1.0)) < 1e-9,
  score, j ? j.categories["claude"] : null);

// invalid config patterns are skipped, never fatal
xdg = mkdtemp("hl-xdg-");
write(join(xdg, "claude-highlight", "config.json"), J({
  categories: { inference: { add: ["re:(", "smells"] } },
  custom: { x: { terms: ["re:("] } } }));
[p, j] = scanJson(claudeHome(), [], xdg);
report("scan: invalid config patterns skipped, scan still works",
  p.exitCode === 0 && j !== null && j.messages["claude"] === CLAUDE_BASE.messages,
  tail(p.stderr, 200));

// type-abusive config: a string add is ONE word, not one word per character
home = claudeHome();
proj = join(home, ".claude", "projects", "proj-c");
write(join(proj, "sess-c.jsonl"), J({ type: "assistant", message: {
  content: [{ type: "text",
    text: "smells bad here now okay friend" }] } }) + "\n");
xdg = mkdtemp("hl-xdg-");
write(join(xdg, "claude-highlight", "config.json"), J({
  categories: { inference: { add: "smells" } },
  custom: ["not", "a", "dict"], x: "nope" }));
[p, j] = scanJson(home, [], xdg);
terms = j ? j.terms["claude"] ?? {} : {};
const letters = Object.keys(terms).filter(t => t.length === 1);
report("scan abuse: string add is one word; junk config types ignored",
  p.exitCode === 0 && terms["smells"] === 1 && letters.length === 0,
  terms, tail(p.stderr, 200));

// == hedge_hook ==============================================================

const GOLDEN = "⚠ unverified-claim markers (13) — inference: likely, probably "
  + "│ appearance: seems │ unknown: untested, unverified";

function hookHome(lines: readonly string[]): string {
  const home = mkdtemp("hl-hook-");
  return write(join(home, "transcript.jsonl"), lines.join("\n") + "\n");
}

function payload(transcript: string, extra = ""): Buffer {
  return Buffer.from(J({ transcript_path: transcript, ...JSON.parse(extra || "{}") }));
}

const assistant = (text: string): string => J({ type: "assistant", message: {
  content: [{ type: "text", text }] } });
const user = (text: string): string => J({ type: "user", message: {
  content: [{ type: "text", text }] } });

const sysMsg = (q: Proc): string | null => {
  if (q.exitCode !== 0 || q.stdout.toString().trim() === "") return null;
  return (JSON.parse(q.stdout.toString()) as { systemMessage: string }).systemMessage;
};

let tr = hookHome([
  user("user says probably first"),
  assistant("It seems likely, probably fine, but unverified and untested."),
]);
p = runHook(payload(tr));
let msg = sysMsg(p);
report("hook: golden message, LOUD order, sorted unique terms, integer score",
  msg === GOLDEN, msg, tail(p.stderr, 200));

tr = hookHome([assistant("It seems fine.")]);
p = runHook(payload(tr));
report("hook: a score of exactly 2.0 still fires (>= threshold)",
  p.exitCode === 0 && p.stdout.includes(B("seems")), p.stdout);

for (const [name, text] of [["below threshold", "Basically it is fine."],
  ["non-LOUD categories only", "It might be roughly a bit odd, perhaps."]] as const) {
  tr = hookHome([assistant(text)]);
  p = runHook(payload(tr));
  report(`hook: ${name} stays silent`,
    p.exitCode === 0 && p.stdout.length === 0, p.stdout, p.exitCode);
}

tr = hookHome([assistant("It seems likely, probably fine, but unverified.")]);
p = runHook(payload(tr, '{"stop_hook_active": true}'));
report("hook: stop_hook_active short-circuits",
  p.exitCode === 0 && p.stdout.length === 0, p.stdout);

p = runHook(B("not json {{{"));
report("hook: malformed stdin ignored, exit 0",
  p.exitCode === 0 && p.stdout.length === 0, p.stdout, p.exitCode);
p = runHook(Buffer.from(J({ transcript_path: "" })));
report("hook: empty transcript path stays silent",
  p.exitCode === 0 && p.stdout.length === 0, p.stdout);
p = runHook(Buffer.from(J({ transcript_path: "/nonexistent/nope.jsonl" })));
report("hook: nonexistent transcript stays silent",
  p.exitCode === 0 && p.stdout.length === 0, p.stdout);
p = runHook(payload(join(mkdtemp("tmp"), "absent.jsonl")));
report("hook: absent transcript file stays silent",
  p.exitCode === 0 && p.stdout.length === 0, p.stdout);

// code stripping: backticked markers do not count
tr = hookHome([assistant("It seems fine but `probably` is in code.")]);
p = runHook(payload(tr));
msg = sysMsg(p) ?? "";
report("hook: markers inside backticks are stripped before scoring",
  msg.includes("seems") && !msg.includes("probably"), msg);

// thinking blocks are never scored; the text block is
tr = hookHome([assistant("IGNORED")]);  // placeholder replaced below
tr = hookHome([
  J({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "probably untested" },
    { type: "text", text: "It seems fine." }] } }),
]);
p = runHook(payload(tr));
msg = sysMsg(p) ?? "";
report("hook: thinking blocks ignored, text blocks scored",
  msg.includes("seems") && !msg.includes("probably"), msg);

// the last *assistant* turn wins even if a user turn follows it
tr = hookHome([
  user("user says probably"),
  assistant("It seems likely and probably fine."),
  user("user says untested again"),
]);
p = runHook(payload(tr));
msg = sysMsg(p) ?? "";
report("hook: user turn after the answer does not change the verdict",
  msg.includes("likely") && msg.includes("seems"), msg);

// a final assistant turn with no text falls back to the previous one
tr = hookHome([
  assistant("It seems likely and probably fine."),
  J({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Bash", input: {} }] } }),
]);
p = runHook(payload(tr));
msg = sysMsg(p) ?? "";
report("hook: tool_use-only final turn falls back to the last text turn",
  msg.includes("likely"), msg);

// multiple text blocks in one turn are joined
tr = hookHome([
  J({ type: "assistant", message: { content: [
    { type: "text", text: "It seems likely." },
    { type: "text", text: "And probably untested." }] } }),
]);
p = runHook(payload(tr));
msg = sysMsg(p) ?? "";
report("hook: multiple text blocks in one turn all count",
  msg.includes("likely") && msg.includes("seems") && msg.includes("untested"), msg);

// adversarial transcript lines must not crash the hook
tr = hookHome([
  '["assistant"]',
  '"assistant"',
  J({ type: "assistant", message: "probably a string" }),
  J({ type: "assistant", message: { content: "seems likely" } }),
  J({ type: "assistant", message: { content: [
    { type: "text", text: "It seems" }, "junk", 42, null] } }),
]);
p = runHook(payload(tr));
msg = sysMsg(p) ?? "";
report("hook: junk JSON shapes skipped without crashing, real text still found",
  msg.includes("seems") && p.exitCode === 0, msg, tail(p.stderr, 200));

tr = hookHome([]);
p = runHook(payload(tr));
report("hook: empty transcript stays silent",
  p.exitCode === 0 && p.stdout.length === 0, p.stdout);

for (const d of tmps) rmSync(d, { recursive: true, force: true });
finish();
