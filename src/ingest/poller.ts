import type { MpPayment, MercadoPagoClient } from '../mp/client'
import type { Contribution } from '../goals/types'

export function attributePayments(payments: MpPayment[], goalIds: string[]): Contribution[] {
  const known = new Set(goalIds)
  return payments
    .filter((p) => p.externalReference !== null && known.has(p.externalReference))
    .map((p) => ({
      id: `mp-${p.id}`,
      goalId: p.externalReference as string,
      source: 'platform' as const,
      mpPaymentId: p.id,
      amountCents: p.transactionAmountCents,
      status: p.status,
      paidAt: p.dateApproved ?? new Date(0).toISOString(),
      note: null,
    }))
}

export async function ingestForNgo(deps: {
  client: MercadoPagoClient
  accessToken: string
  goalIds: string[]
  since: Date
  now: Date
  upsert: (c: Contribution) => Promise<void>
}): Promise<{ upserted: number; ignored: number }> {
  const payments = await deps.client.searchPayments({
    accessToken: deps.accessToken,
    beginDate: deps.since.toISOString(),
    endDate: deps.now.toISOString(),
  })
  const contributions = attributePayments(payments, deps.goalIds)
  for (const c of contributions) await deps.upsert(c)
  return { upserted: contributions.length, ignored: payments.length - contributions.length }
}

export function isAuthError(err: unknown): boolean {
  return String(err).includes('401')
}

// Thrown when the first attempt 401s AND the subsequent refresh() itself
// fails (e.g. a revoked/expired refresh token). Distinguished from a bare
// 401 so the caller can tell "never even tried to refresh" apart from
// "refresh was attempted and failed" — the latter is the case that must
// mark an NGO disconnected, per the reconnect-required rule.
export class TokenRefreshFailedError extends Error {
  constructor(cause: unknown) {
    super(`token refresh failed: ${cause}`)
    this.name = 'TokenRefreshFailedError'
  }
}

export async function withTokenRefresh<T>(deps: {
  run: (accessToken?: string) => Promise<T>
  refresh: () => Promise<string>
}): Promise<T> {
  try {
    return await deps.run()
  } catch (err) {
    if (!isAuthError(err)) throw err
    let fresh: string
    try {
      fresh = await deps.refresh()
    } catch (refreshErr) {
      throw new TokenRefreshFailedError(refreshErr)
    }
    return await deps.run(fresh)
  }
}

// The entire per-NGO body for one scheduled-poll iteration, including
// loading secrets, decrypting, and ingesting — all wrapped in a single
// try/catch. This must never let an exception escape: JS gives a `for`
// loop no per-iteration isolation, so one NGO's failure (a corrupted row,
// a TOKEN_KEY rotated without re-encrypting, a transient DB blip) would
// otherwise abort every subsequent NGO for the rest of the run, on every
// cron tick — a stalled-but-plausible-looking progress bar, the worst
// failure mode this system has. Every dependency is injected so this stays
// testable with no network and no D1.
export async function ingestOneNgo(deps: {
  ngoId: string
  client: MercadoPagoClient
  since: Date
  now: Date
  loadSecrets: () => Promise<{ accessTokenEnc: string | null; refreshTokenEnc: string | null } | null>
  loadGoalIds: () => Promise<string[]>
  decrypt: (encrypted: string) => Promise<string>
  refresh: (refreshTokenEnc: string) => Promise<string>
  upsert: (c: Contribution) => Promise<void>
  markDisconnected: () => Promise<void>
  log: (message: string) => void
}): Promise<void> {
  try {
    const secrets = await deps.loadSecrets()
    if (!secrets?.accessTokenEnc || !secrets.refreshTokenEnc) return
    const refreshTokenEnc = secrets.refreshTokenEnc

    const goalIds = await deps.loadGoalIds()
    const stored = await deps.decrypt(secrets.accessTokenEnc)

    await withTokenRefresh({
      run: (token) => ingestForNgo({
        client: deps.client,
        accessToken: token ?? stored,
        goalIds,
        since: deps.since,
        now: deps.now,
        upsert: deps.upsert,
      }),
      refresh: () => deps.refresh(refreshTokenEnc),
    })
  } catch (err) {
    // A retried-and-still-401 or a failed refresh() means the NGO must
    // reconnect. Anything else (a decrypt failure, a DB read failure) is
    // logged but leaves the NGO's status untouched — a transient blip
    // should not disconnect a perfectly good integration.
    if (err instanceof TokenRefreshFailedError || isAuthError(err)) {
      await deps.markDisconnected()
    }
    deps.log(`ingest failed for ngo ${deps.ngoId}: ${err}`)
  }
}
