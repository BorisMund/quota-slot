import { UnsafeIdentifierError } from "./errors.js";

/**
 * Table and column names can't be bound as parameters, so they end up inlined
 * into the SQL text. Rejecting anything that isn't a plain identifier, once at
 * setup, is the only defence there is.
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
