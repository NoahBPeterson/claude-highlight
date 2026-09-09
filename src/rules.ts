/** The shape the whole pipeline passes around.
 *
 * `pat` runs over the latin1 view of a Buffer, where byte indices equal
 * char indices -- the standard trick for porting Python's bytes regexes.
 * Rules are compiled with the "gi" flags.
 */
export interface Rule {
  readonly pat: RegExp;
  readonly style: Buffer;
}

/** A length-changing rewrite (the resume-hint rename), applied per text
 * segment only on the normal screen, where no wrapping math depends on it. */
export interface Rewrite {
  readonly pat: RegExp;
  readonly repl: string;
}
