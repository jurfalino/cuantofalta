/**
 * Parses an operator- or donor-supplied peso amount (from a form field, so
 * type `unknown`) into an integer number of centavos.
 *
 * Only plain decimal notation is accepted — digits, an optional single `.`,
 * and at most two digits after it (e.g. "300", "10.5", "10.55"). Scientific
 * notation ("1e5"), "Infinity", "NaN", signs, thousands separators, and
 * anything with more than two decimal places are all rejected rather than
 * coerced, because this is money: a value the form's HTML constraints don't
 * actually enforce (they're client-side only) must never silently become
 * NaN, negative, zero, or fractional centavos.
 *
 * Returns null on any invalid input — never throws — so callers can respond
 * with a 400 and write nothing.
 */
const PESOS_PATTERN = /^\d+(\.\d{1,2})?$/

// A ceiling on any single peso amount, well beyond any plausible goal
// target or donation. Exists purely to keep centavos inside
// Number.isSafeInteger (and therefore inside SQLite's int64) — without it,
// something like "99999999999999999.99" parses to 1e19 cents, silently
// beyond safe-integer precision and beyond what the `contribution` /
// `goal` tables can actually store.
const MAX_PESOS = 1_000_000_000

export function parsePesosToCents(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()
  if (str.length === 0) return null
  if (!PESOS_PATTERN.test(str)) return null

  const pesos = Number(str)
  if (!Number.isFinite(pesos) || pesos <= 0) return null
  if (pesos > MAX_PESOS) return null

  // Safe: the regex above already guarantees at most 2 decimal digits, so
  // this rounds away only floating-point representation error, never real
  // precision. Number.isSafeInteger is a final belt-and-suspenders check
  // for the same magnitude concern the MAX_PESOS bound above exists for.
  const cents = Math.round(pesos * 100)
  return Number.isSafeInteger(cents) ? cents : null
}
