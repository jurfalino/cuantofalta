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

export interface PendingContributionRef {
  id: string
  goalId: string
  mpPaymentId: string
}

// Re-checks contributions that were ingested as `pending` and never
// revisited, regardless of how long ago they were paid — this is what
// actually closes the "efectivo settles days later" hole (see
// src/index.ts): the poller's normal lookback window only ever looks at
// *recently created* payments, so a payment that ages out of that window
// while still pending would otherwise never be looked at again.
//
// A failure on ONE payment (a transient network blip, a payment MP no
// longer serves for some other reason) must not abort the rest of the
// list — only a genuine 401 propagates, so withTokenRefresh around this
// can do its one retry-with-refresh. A 404 (payment not found) is treated
// the same as "still pending": we do not know it was rejected, so we must
// not upsert a `rejected` status we don't actually have evidence for.
export async function recheckPendingContributions(deps: {
  client: MercadoPagoClient
  accessToken: string
  pending: PendingContributionRef[]
  upsert: (c: Contribution) => Promise<void>
}): Promise<{ updated: number; stillPending: number }> {
  let updated = 0
  let stillPending = 0

  for (const p of deps.pending) {
    let payment: MpPayment | null
    try {
      payment = await deps.client.getPayment({ accessToken: deps.accessToken, paymentId: p.mpPaymentId })
    } catch (err) {
      if (isAuthError(err)) throw err
      stillPending++
      continue
    }

    if (!payment || payment.status === 'pending') {
      stillPending++
      continue
    }

    await deps.upsert({
      id: p.id,
      goalId: p.goalId,
      source: 'platform',
      mpPaymentId: p.mpPaymentId,
      amountCents: payment.transactionAmountCents,
      status: payment.status,
      paidAt: payment.dateApproved ?? new Date(0).toISOString(),
      note: null,
    })
    updated++
  }

  return { updated, stillPending }
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
  loadPendingContributions: () => Promise<PendingContributionRef[]>
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
    const pending = await deps.loadPendingContributions()
    const stored = await deps.decrypt(secrets.accessTokenEnc)

    await withTokenRefresh({
      run: async (token) => {
        const accessToken = token ?? stored
        await ingestForNgo({
          client: deps.client,
          accessToken,
          goalIds,
          since: deps.since,
          now: deps.now,
          upsert: deps.upsert,
        })
        // Same access token, same per-NGO try/catch: a 401 here is handled
        // by this same withTokenRefresh retry-once, and a disconnect from
        // a failed refresh covers both phases identically to before.
        await recheckPendingContributions({
          client: deps.client,
          accessToken,
          pending,
          upsert: deps.upsert,
        })
      },
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
