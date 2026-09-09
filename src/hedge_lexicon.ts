/** Lexicon of epistemic markers for agent transcripts.
 *
 * Ported verbatim from hedge_lexicon.py: categories are ordered roughly by how
 * strongly they predict "the model inferred this instead of checking it".
 * The TypeScript port must keep expand() in exact agreement with the
 * patterns, since the stream filter's cross-chunk holding depends on it.
 */

// Each entry: regex fragment (word-boundary wrapped at compile time)
export const LEXICON: Record<string, readonly string[]> = {
  // A claim about the world stated at reduced confidence. In agent
  // transcripts these are the highest-yield markers: the thing hedged is
  // usually cheaply checkable (run it, read it, grep it).
  inference: [
    "likely", "probably", "presumably", "most likely", "chances are",
    "i suspect", "i'd (?:guess|bet|expect)", "my guess", "i imagine",
    "chances? (?:are|of)", "chances are",
  ],
  // Perception verbs -- "it looks like X" is a report of an impression,
  // not of a verified fact.
  appearance: [
    "seems?(?: (?:to|like|that))?", "appears?(?: (?:to|that))?", "looks like",
    "apparently", "ostensibly", "supposedly", "as far as i can tell",
    "from what i can see", "on the surface",
  ],
  // Explicit unverified premise. Often honest, always worth surfacing.
  assumption: [
    "assuming", "i(?:'m| am) assuming", "assumption", "presuming",
    "if i'm right", "in theory", "in principle", "on paper",
    // "should have" is excluded: in transcripts it is nearly always a
    // self-correction ("I should have checked"), not an assumption.
    "should (?:work|be|already|still)", "ought to", "by design",
    // "mostly" reads as vague quantity but in transcripts it is a claim
    // about coverage no one measured ("the tests mostly pass"), so it
    // sits here rather than with "roughly" and "several".
    "mostly",
  ],
  // Modal possibility. Noisy (also used for genuine option-listing), so
  // weighted low and reported separately.
  modal: [
    "might", "may (?:be|have|not|still|need|want|require)", "could be",
    "can be", "possibly", "potentially", "perhaps", "conceivably",
  ],
  // Admitted ignorance. Not a failure -- but a to-do list.
  unknown: [
    "not sure", "unsure", "unclear", "hard to say", "i don'?t know",
    "can'?t tell", "can'?t verify", "couldn'?t verify",
    // "I can't test that for you" is the same admission as "untested";
    // the earlier list only covered verify/tell and missed the rest.
    "can'?t (?:test|check|confirm|reproduce|measure|be sure)",
    "couldn'?t (?:test|check|confirm|reproduce)",
    "no (?:easy )?way to (?:test|check|reproduce)",
    "no way to (?:know|tell|check)", "unverified", "untested",
    "haven'?t (?:tested|verified|checked|run|confirmed)",
    "didn'?t (?:test|verify|check|run|confirm)",
    "without (?:testing|running|checking)",
    "needs? (?:testing|verification|confirmation)",
    "i'd need to (?:check|verify|test|look)",
  ],
  // Imprecision about quantity/scope.
  vagueness: [
    "roughly", "approximately", "about \\d", "or so", "a (?:few|couple)",
    "several", "various", "some(?:what)?", "generally",
    "typically", "usually", "often", "in most cases", "more or less",
    "basically", "essentially", "effectively", "pretty much",
  ],
  // The opposite failure: unearned certainty. A spike here next to a
  // spike in "inference" is the interesting pattern.
  overclaim: [
    "definitely", "certainly", "obviously", "clearly", "of course",
    "without a doubt", "guaranteed", "always works", "never fails",
    "trivially", "simply (?:add|change|run|do)", "just (?:add|change|run|do)",
  ],
  // Softeners that shrink a claim after making it.
  softener: [
    "a bit", "slightly", "somewhat", "fairly", "relatively",
    "more or less", "kind of", "sort of", "to some extent",
    "at least in", "for the most part",
  ],
}

// Weight = how much a hit in this category should count toward a session's
// "unverified claim" score. Modal/vagueness/softener are common in ordinary
// prose, so they contribute little.
export const WEIGHTS: Record<string, number> = {
  inference: 3.0,
  appearance: 2.0,
  assumption: 2.0,
  unknown: 2.5,
  modal: 0.5,
  vagueness: 0.3,
  overclaim: 1.0,
  softener: 0.2,
}

/** Expand one lexicon pattern into the literal strings it can match.
 *
 * The patterns only use a small subset of regex -- (?:a|b) groups, optional
 * ? on a char or group, and \\d -- so a tiny recursive expander is enough.
 * Used to work out what text could still grow into a match, which is what
 * the stream filter needs in order to hold a phrase across a chunk boundary.
 */
export function expand(term: string): string[] {
  const chAt = (s: string, i: number): string => (i < s.length ? s.charAt(i) : "")

  function seq(i: number, stop: string | null): [string[], number] {
    let out = [""]
    // `stop` is a SET of characters ("|)"), the way Python's `term[i] not in
    // stop` read it: comparing against the whole string never stops a
    // group, so every (?:a|b) term expands to one literal with the bar in it.
    while (i < term.length && (stop === null || !stop.includes(chAt(term, i)))) {
      const c = chAt(term, i)
      if (c === "(") {                          // "(?:" ... ")"
        let [alts, ni] = alternatives(i + 3)
        i = ni + 1                             // past ")"
        if (i < term.length && chAt(term, i) === "?") {
          i += 1
          alts = [...alts, ""]
        }
        out = out.flatMap(a => alts.map(b => a + b))
      } else if (c === "\\") {
        const nxt = chAt(term, i + 1)
        if (nxt === "") throw new Error("trailing backslash")
        const pool = nxt === "d" ? "0123456789" : nxt
        out = out.flatMap(a => [...pool].map(d => a + d))
        i += 2
      } else if (chAt(term, i + 1) === "?") {
        out = [...out.map(a => a + c), ...out]
        i += 2
      } else {
        out = out.map(a => a + c)
        i += 1
      }
    }
    return [out, i]
  }

  function alternatives(i: number): [string[], number] {
    const alts: string[] = []
    while (true) {
      const [opts, ni] = seq(i, "|)")
      alts.push(...opts)
      if (ni < term.length && chAt(term, ni) === "|") {
        i = ni + 1
        continue
      }
      return [alts, ni]
    }
  }

  return seq(0, null)[0]
}

/** Turn a config word into a regex fragment.
 *
 * Plain text is matched literally, so a phrase from config can never be a
 * broken regex that takes the wrapper down. Prefix with "re:" to opt into a
 * raw pattern.
 */
export function userPattern(term: string): string {
  return term.startsWith("re:") ? term.slice(3) : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Every literal string any category can match, lowercased.
 *
 * `extra` holds already-converted regex fragments from user config; one that
 * the expander cannot parse is skipped, which costs it cross-chunk matching
 * but never breaks the run.
 */
export function literals(extra: readonly string[] = []): Set<string> {
  const out = new Set<string>()
  for (const terms of [...Object.values(LEXICON), extra]) {
    for (const t of terms) {
      try {
        for (const x of expand(t)) if (x.length > 0) out.add(x.toLowerCase())
      } catch {
        // a fragment the expander cannot parse: skip it
      }
    }
  }
  return out
}

/** Text that is a PROPER prefix of some literal -- i.e. could still grow.
 *
 * A complete term that cannot extend ("likely") is deliberately absent, so
 * it paints immediately instead of waiting for a timeout. A complete term
 * that can extend ("some" -> "somewhat") is present.
 */
export function growablePrefixes(extra: readonly string[] = []): Set<string> {
  const lits = literals(extra)
  const out = new Set<string>()
  for (const lit of lits) {
    for (let n = 1; n < lit.length; n++) out.add(lit.slice(0, n))
  }
  return out
}
