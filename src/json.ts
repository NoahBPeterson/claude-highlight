/** What JSON.parse actually returns, spelled out.
 *
 * Config files and transcripts are the only untyped input this project has,
 * and both are JSON, so they get a type rather than `unknown` and a trail of
 * casts: narrowing a Json is a property check, not an assertion.
 */
export type Json = null | boolean | number | string | Json[] | JsonObject;

export interface JsonObject {
  [key: string]: Json;
}

/** A JSON object, as opposed to null, an array, or a scalar -- the check
 * every "if not isinstance(x, dict)" in the Python turned into. Takes
 * undefined too, since indexing a JsonObject may not find the key. */
export function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && v !== undefined && !Array.isArray(v);
}

/** Parse, or null if the text is not JSON at all. Callers that had a Python
 * `except (OSError, ValueError)` want exactly this. */
export function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/** Python's bool(): empty containers are false. A config file is full of
 * them, and JavaScript would call {} and [] truthy -- turning `"on": []` on. */
export function truthy(v: Json): boolean {
  if (v === null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return v;
}
