import { UnsafeIdentifierError } from "./errors.js";

/**
 * Table and column names can't travel as bound parameters. The driver would
 * send them as string literals and the statement wouldn't parse, so they have
 * to be inlined into the SQL text, which is where injection lives.
 *
 * So we check them once, at setup, against a narrow rule: letters, digits and
 * underscores, optionally schema-qualified with a single dot. Anything else is
 * rejected rather than escaped. A quota table called `weird name; drop table x`
 * is a bug worth failing on, not a case worth supporting.
 */
const SAFE_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdentifier(value: string, role: string): string {
  const parts = value.split(".");

  if (parts.length > 2) {
    throw new UnsafeIdentifierError(role, value);
  }

  for (const part of parts) {
    if (!SAFE_PART.test(part)) {
      throw new UnsafeIdentifierError(role, value);
    }
  }

  // Quoted so a name that collides with a reserved word still works.
  return parts.map((part) => `"${part}"`).join(".");
}
