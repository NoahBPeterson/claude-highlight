# claude-highlight

Colors epistemic markers in Claude Code's output, live, in the terminal.

    claude-highlight            # instead of: claude
    claude-highlight --resume   # any claude args pass straight through

## Install

Needs [Bun](https://bun.sh) 1.4 or newer at runtime -- the pty is built on
`openpty(3)` through `bun:ffi`, so Node cannot run this. Unix only.

Globally, the usual way:

    npm install -g claude-highlight

That installs `claude-highlight` on your PATH and its man page alongside, so
`man claude-highlight` works. The published package is just `dist/`, the man
page and this README: 30 KB, no dependencies. From a clone instead, it is
`bun run build && npm install -g .`

Or from a checkout, with no install step at all -- Bun runs the TypeScript
directly, so an edit takes effect on the next run:

    ln -sf "$PWD/src/claude-highlight.ts" ~/.local/bin/claude-highlight

Either way the name on your PATH is what the resume hint uses: the wrapper
looks for the PATH entry that resolves back to the file it is running as, and
rewrites Claude Code's `claude --resume` into that name, so the line it prints
on exit is one you can paste.

### Build

    bun run build      # dist/, what `bin` points at
    bun run test:all   # every suite against src/
    bun run test:dist  # rebuild, then every suite, driving dist/ where it matters

The build emits three files: the bundled entry point and the two pty worker
threads, which stay separate because they are loaded as workers by URL rather
than imported.

Config lives at `~/.config/claude-highlight/config.json` (or `XDG_CONFIG_HOME`),
so category toggles are shared across every workspace.

To make it the default without typing the longer name, add to `~/.zshrc`:

    alias claude='claude-highlight'

Interactive shells only, so scripts, hooks and anything else invoking `claude`
directly are unaffected.

## Why a PTY wrapper

Neither of the two obvious layers can do this:

* **Claude Code hooks** never see rendered output. The event set in 2.1.236 is
  PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, Notification,
  PreCompact, SessionStart, SessionEnd, PermissionRequest — nothing between the
  model's text and the screen.
* **Ghostty** has no text-match highlighter among its 634 config keys. The
  `link` regex option that would come closest is documented "TODO: This can't
  currently be set!"

So the seam is the pseudo-terminal between them.

## Why it doesn't corrupt the TUI

SGR (color) sequences are zero-width. Claude Code lays out its screen by
counting printable cells, so `ESC[38;5;203m` injected mid-stream changes how a
cell looks without moving any cell. The child redraws over the wrapper freely
and never knows it's there.

The two hard parts, both handled in `highlight_filter.ts`:

* **Chunk boundaries.** Streaming means `likely` often arrives as `lik` +
  `ely`. Trailing word characters are held back until the next chunk resolves
  them, or a 20 ms idle timeout flushes them.
* **Escape sequences.** A state machine keeps the regex on ground-state text
  only, passes CSI/OSC/DCS through untouched, and tracks the app's current SGR
  so a highlight can restore it afterward.

`test/test_filter.ts` asserts the invariant that matters — printable cell count
identical before and after — including a fuzz pass over random ANSI traffic cut
at random byte offsets.

## Telling prose from everything else

The wrapper sees bytes, not roles — so left alone it would happily color your
own typing, code blocks, and tool output. It doesn't, because Claude Code
styles those differently. Measured from a real render:

| region | background | foreground |
|---|---|---|
| user message | `48;2;55;55;55` | white |
| plain prose | default | default |
| **bold** prose | default | default |
| list item | default | default |
| inline code | default | `38;2;177;185;249` |
| fenced code | default | `32` (syntax color) |

"Foreground and background both default" is the `prose_only` setting, on by
default. It also makes restoring trivial: since a highlight only ever paints
over a default foreground, `ESC[39m` puts things back exactly, without
disturbing bold or any background.

**Nor does it protect what you are typing.** The input box is drawn at the
default foreground, word by word, exactly like prose -- measured from the
capture, a keystroke echo is `ESC[H ESC[52C ESC[50B a` with no SGR at all. The
stream cannot tell your draft from the model's prose, so that one is settled on
the screen instead: see "What you type is yours" below.

**It does not fully protect code blocks.** Only *syntax-coloured* tokens carry
a foreground; anything the highlighter leaves alone is indistinguishable from
prose in the byte stream:

| token inside a fence | foreground | skipped? |
|---|---|---|
| `# a comment` | 32 | yes |
| `'a string'` | 31 | yes |
| a bare identifier | default | **no** |
| any line in a fence with no language | default | **no** |

So a hedge word in an unlabelled code block still gets painted. A fence with no
language is rendered exactly like prose -- same default colour, same word-by-word
layout -- so there is nothing left to key on without parsing the markdown that
the renderer already consumed.

If you switch to a theme that gives prose an explicit foreground, highlighting
will stop appearing — set `"prose_only": false` in the config to fall back to
painting everything.

## Pastes

A pty in raw mode -- which is what Claude Code puts its tty in -- accepts about
**1 KB per write**. A single `os.write` of a large paste returns after 1,022
bytes and the rest is gone, so keystrokes bound for the child are queued and
drained whenever the pty reports writable. A blocking write-until-done loop
would be worse than the bug: the wrapper would stop reading the child's output
while the child stopped reading its input.

Terminal writes go through `write_all`, which loops, for the same reason.

Two related details:

* Raw mode is set with `TCSANOW`. `tty.setraw`'s default of `TCSAFLUSH`
  discards input already buffered, so anything pasted before raw mode took
  effect would vanish.
* Hotkeys are ignored between `ESC[200~` and `ESC[201~`. Inside a bracketed
  paste every byte is content -- a pasted F9 sequence would otherwise be
  stripped from the text and pop the panel open mid-paste.

`test/test_paste.ts` covers a newline-heavy 256 KB paste, a paste containing an
embedded F9, and a 1 MB paste, checking length and md5 end to end.

## Length: add, never remove

Inside the alternate screen the wrapper can **add** bytes but never **remove**
them. Claude Code already computed its wrapping with every character present,
so changing the count would shift every cell after it. That rules out the
"hide the annotation" half of a `[text](low certainty)` syntax — the wrapper
colors the visible text and leaves the annotation occupying its cells.

The one exception is the normal screen. On exit Claude Code prints
`claude --resume <id>`, which would drop you out of the wrapper; that line is
emitted after the alt screen closes, where nothing redraws, so it is rewritten
to name the wrapper instead. Rewrites are hard-gated on alt-screen state.

## Colour the child doesn't know about

Claude Code repaints with a **cell-level diff**: it rewrites the characters
that changed and jumps over the ones that didn't. Straight from a capture, one
line being updated in place:

    ESC[2C ESC[44B Prob ESC[11G ru ESC[14G es against Hover ESC[31G variants

Cells it skips keep their attributes -- including a colour this wrapper
injected in an earlier frame. The child's damage model tracks characters and
knows nothing about our SGR, so the colour stays behind after the word that
earned it is gone, which shows up as a single amber letter inside a word that
was never a marker.

Measured by replaying a 1.8 MB recorded session and reconstructing the screen,
checked at every frame end:

| | stale cell-frames | longest-lived residue |
|---|---|---|
| filter alone | 7,865 | 5,049 frames |
| filter + `screen_model.ts` | 0 | 0 |

This is the colour half of "add, never remove". Length is safe because the
child computed its wrapping with every character present; colour isn't,
because the child never revisits a cell it believes is already correct.

So `screen_model.ts` mirrors the screen from the bytes we hand the terminal,
and at the end of each frame rewrites the cells **we** painted whose match no
longer holds -- same character, same column, different attribute, cursor put
back with DECSC/DECRC. The screen's cell count is untouched, which is the rule
that governs everything else here. Corrections go inside the frame's
synchronised-output block (`ESC[?2026h/l`, which Claude Code uses on every
frame), so the terminal presents the frame and its correction together.

It only ever rewrites a cell it painted itself. A cell the child wrote, or one
the model has never seen, is left alone whatever the text around it says -- so
a model that drifts loses corrections rather than corrupting the screen.
Anything that bypasses the model invalidates it: the plugin panel draws
straight to stdout, so opening or closing it drops every cell back to unknown
and the repaint on close refills them.

Mirroring the screen costs about **0.04 ms a frame** (measured over 4,339
frames of a real capture), which is well under the child's own frame budget.

One parser bug worth naming, since both parsers had it: `ESC ( B` (select
ASCII) is a *three*-byte escape -- ESC, an intermediate, then the final byte.
Reading it as two bytes leaves the `B` to be printed, which planted a stray
character on screen 25 times a session and drifted every column after it.

The known edges: column tracking assumes `east_asian_width` for wide
characters, corrections are capped at 4 KB per frame (a row that doesn't fit
is finished on the next one), and nothing is corrected outside the alternate
screen. If a terminal lacks synchronized output the corrections are still
right, but the cursor may visibly jitter while they're applied.

`"idle_repaint": true` in the config is the blunt fallback -- a full repaint
via the resize nudge once the session goes quiet, which clears residue by
redrawing everything. It's off by default: the model fixes residue in the
frame that creates it, and this costs a resize per burst.

## What you type is yours

Nothing here paints inside the input box. The box is found geometrically --
the band between the last two full-width rules at the bottom of the screen,
plus the status chrome below them -- and every cell in it is off limits, so a
`usually` in a message you are still drafting stays the colour you typed it.

The filter still paints it on the way past, because a byte-stream filter has no
idea which row it is writing to; the shadow screen takes it back at the end of
the same frame, inside the synchronised-output block, so the painted version is
never presented. Costs a few bytes a frame while you type a marker word.

Detection degrades in the safe direction. No rules found, or the lower rule not
within 10 rows of the bottom, means no box and no suppression -- highlighting
carries on as before. The band is capped at 24 rows so a stray rule higher up
the transcript cannot swallow the screen.

## Checking it works

    claude-highlight --hl-selftest

Pushes sample text through the real filter and prints it: the prose lines
should show color, the inline-code / fenced-code / user-message lines should
not. If a session looks unhighlighted, run this first — usually the message
simply had no markers in it, which is not the same as the filter being broken.

The suites are standalone programs, not a test framework -- each prints its
own PASS lines and exits nonzero on any failure:

    bun run test/run_all.ts       # all of them, one at a time
    bun run test/test_filter.ts   # or any one on its own
    bunx tsc -p tsconfig.json     # types: strict, and every check that applies to src/

## Plugin menu

Press **F9** to open it. Arrows move, **space or enter** toggles the selected
category, and **q / esc / F9** closes. Toggles apply immediately and persist to
the config. In Ghostty, map cmd+/ to open it:

    keybind = cmd+slash=text:\x1b[20~

The menu draws over the bottom rows, then forces a full repaint on close by
resizing the child's window away and back.

That nudge needs a real pause in the middle. Measured against 2.1.236, two
TIOCSWINSZ calls back to back emit **0 bytes** of redraw — the child coalesces
the signals, reads the final size, finds it unchanged, and skips rendering.
Holding the intermediate size for 80 ms produces a full ~4.9 KB repaint. Without
the pause the menu state closes but the overlay is never erased, which looks
exactly like a menu that refuses to close.

Preview the panel without starting a session:

    claude-highlight --hl-menu

The panel is drawn as a bordered card with its own background and a title bar,
so it reads as an overlay rather than as more session output. Rows are clamped
and padded to a uniform width, verified from 50 to 200 columns at every
selection index.

The terminal cursor is hidden while the panel is up. Claude Code leaves it
wherever it last drew, which can land on a panel row -- and a block cursor
reads as the selection far more strongly than a marker does, so the two
compete. The selected row is marked instead by a thick amber bar on its left
edge plus a brighter background.

Config: `~/.config/claude-highlight/config.json`, re-read on change, so you can
edit it in another window and see it apply without restarting.

## Adding your own words

Every category takes an `add` list, and `custom` defines whole new categories
with their own colour and toggle:

    {
      "categories": {
        "inference": { "add": ["gut feel", "ballpark", "re:hand-?waves?"] }
      },
      "custom": {
        "deadline": { "color": "38;5;99", "on": true, "desc": "schedule risk",
                      "terms": ["slipping", "at risk", "behind schedule"] }
      }
    }

Words are matched **literally**, so punctuation and spaces need no escaping and
a typo can never be a broken regex that takes the session down. Prefix with
`re:` to opt into a raw pattern. Anything that will not compile is dropped and
listed by `--hl-selftest` rather than failing at launch.

Multi-word additions work across chunk boundaries like the built-ins do: the
growable-prefix set is rebuilt from your terms too, so "behind schedule" still
highlights when streaming splits it. Verified at every split point.

`hedge_scan.ts` reads the same file, so a word you add is highlighted live *and*
counted in scans -- the two cannot drift apart.

### Where the lexicon's judgement calls came from

The categories and weights are not guesses; they were checked against a real
corpus. `hedge_results.json` is the miner's own dump, from:

    bun run src/hedge_scan.ts --json hedge_results.json

which walks the local Claude Code, OpenCode and Kimi transcript stores. The run
behind the current lexicon covered **3,213,505 words over 48,557 assistant
messages in 1,440 sessions** (44,991 Claude Code, 1,915 OpenCode, 1,651 Kimi),
and 904 of those sessions scored above zero.

What it is good for is the per-term counts, which is what settles an argument
about a word. Across the corpus, 129 of the lexicon's patterns hit at all, and
the head is steep: `likely` 1,204, `should be` 809, `some` 706, `might` 560,
`a few` 556. By category: vagueness 3,416, modal 2,382, inference 1,719,
assumption 1,279, appearance 1,066, overclaim 885, unknown 546, softener 416.
The two loudest categories are exactly the two that ship toggled off and
weighted lowest -- modal 0.5 and vagueness 0.3, against inference 3.0 and
unknown 2.5 -- which is the corpus agreeing with the reason already written
next to them: both fire constantly on ordinary option-listing.

Two of the fiddlier calls in `hedge_lexicon.ts` are downstream of this. The
assumption pattern is `should (?:work|be|already|still)` rather than a bare
`should` precisely because the corpus is full of "I should have checked", which
is a self-correction rather than an assumption -- so "should be" (809 hits) is
counted and "should have" is not. And `mostly` (378 hits) sits in assumption
rather than vagueness, because in transcripts it is almost always a claim about
coverage nobody measured ("the tests mostly pass"), not an imprecise quantity.

The file itself is gitignored: it is a scan of one machine's private
transcripts, down to session UUIDs and project paths. Regenerate it with the
command above -- yours will differ, and that is the point.

## Portability

**Linux: written for, not yet re-verified.** The Python original passed in a
container on Linux 6.12 aarch64 and on linux/amd64, including the 1 MB paste
test and highlighting driven through a real Linux pty. The TypeScript port
carries the two Linux-shaped branches it needs -- `libc.so.6` plus a
`libutil` fallback for `openpty`, and the Linux `TIOCSWINSZ`/`TIOCGWINSZ`
numbers -- but has only been run on macOS arm64, so treat Linux as untested
until someone runs `bun run test/run_all.ts` there.

The one genuinely platform-shaped call is `ioctl`, which is variadic: Apple's
arm64 ABI passes variadic arguments on the stack, so the winsize pointer has
to be handed over as the ninth integer argument to land where `va_arg` looks.
Everywhere else it stays in a register and the plain three-argument form is
correct. Both shapes are in `sysffi.ts`; getting this wrong is silent, and
was: the call returned 0 and set nothing.

The other constant that genuinely differs is the pty write ceiling in raw
mode: **1,022 bytes on macOS, 11,776 on Linux**. Same bug class, absorbed by
the write worker -- which blocks on a thread of its own until every byte is
gone -- rather than by a per-OS branch. The BSDs are untested but use the same
POSIX surface.

**Windows: needs a new plumbing layer.** `openpty`, `termios` and the winsize
ioctls are Unix-only, and `SIGWINCH` does not exist. A port means ConPTY plus
a different resize path. The filter and the shadow screen are pure TypeScript
and portable as-is -- it is the process plumbing that is Unix-shaped, roughly
the whole of `sysffi.ts` and `pty.ts`.

**Terminal capability is separate from OS.** The panel uses truecolor and
box-drawing glyphs, which a Linux console or a non-UTF-8 locale lacks. Both
degrade automatically: `COLORTERM` decides truecolor vs 256-color, and the
locale decides box-drawing vs ASCII. Row widths are identical in
either mode, verified at 50/80/120/200 columns for every selection index.

Config honours `XDG_CONFIG_HOME`.

## Files

| file | what |
|---|---|
| `src/claude-highlight.ts` | the wrapper: entry point, hotkey, menu, config |
| `src/pty.ts` | the pty: openpty + a spawned child, with the blocking reads and writes on worker threads |
| `src/sysffi.ts` | the libc surface, via `bun:ffi` -- openpty, ioctl, raw mode |
| `src/highlight_filter.ts` | the ANSI-safe stream filter |
| `src/screen_model.ts` | shadow screen; takes back a highlight the child stranded |
| `src/hedge_lexicon.ts` | 8 weighted marker categories, shared with the miner |
| `src/hedge_scan.ts` | offline miner over Claude Code / OpenCode / Kimi transcripts |
| `src/hedge_hook.ts` | Stop hook, flags markers after a turn via `systemMessage` |
| `src/json.ts` | the type of parsed JSON, and Python's `bool()` over it |
| `src/rules.ts` | the rule and rewrite shapes the pipeline passes around |
| `test/run_all.ts` | every suite, one at a time |
| `test/test_filter.ts` | invariant + fuzz tests |
| `test/test_screen.ts` | residue, cell-neutrality, and a recorded-session replay |
| `test/test_integration.ts` | whole-pipeline tests: config-driven rules, screen ops, hostile ANSI, adversarial config |
| `test/test_wrapper.ts` | black-box pty tests: real wrapper vs stand-in child (paste, menu, hotkeys, record pairs) |
| `test/test_paste.ts` | paste-path tests through a real pty (224 KB–1 MB, embedded F9) |
| `test/test_miners.ts` | `hedge_scan` / `hedge_hook` against fixture transcripts, counts hand-computed |
| `test/pty-smoke.ts` | the pty layer alone: byte fidelity, exit codes, winsize, 1 MB round trip |
| `*.py`, `claude-highlight` | the Python original this was ported from, kept as the reference the suites are diffed against |
