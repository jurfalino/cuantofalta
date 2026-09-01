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
