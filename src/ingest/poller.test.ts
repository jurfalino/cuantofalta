import { describe, it, expect } from 'vitest'
import {
  attributePayments, withTokenRefresh, ingestForNgo, ingestOneNgo, recheckPendingContributions,
  TokenRefreshFailedError,
} from './poller'
import { FakeMercadoPago } from '../mp/fake'
import type { MpPayment } from '../mp/client'

const payment = (over: Partial<MpPayment>): MpPayment => ({
  id: 'p1', status: 'approved', transactionAmountCents: 100_000,
  externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z', ...over,
})

describe('attributePayments', () => {
  it('maps an approved payment to a platform contribution on the referenced goal', () => {
    const [c] = attributePayments([payment({})], ['g1'])
    expect(c.goalId).toBe('g1')
    expect(c.source).toBe('platform')
    expect(c.mpPaymentId).toBe('p1')
    expect(c.amountCents).toBe(100_000)
    expect(c.status).toBe('approved')
  })

  it('ignores payments whose external_reference matches no known goal', () => {
    expect(attributePayments([payment({ externalReference: 'unknown' })], ['g1'])).toEqual([])
  })

  it('ignores payments with no external_reference at all', () => {
    expect(attributePayments([payment({ externalReference: null })], ['g1'])).toEqual([])
  })

  it('keeps pending and rejected payments but marks their status', () => {
    const out = attributePayments([
      payment({ id: 'p2', status: 'pending', dateApproved: null }),
      payment({ id: 'p3', status: 'rejected' }),
    ], ['g1'])
    expect(out.map((c) => c.status)).toEqual(['pending', 'rejected'])
  })

  it('is deterministic on payment id so re-ingestion upserts rather than duplicates', () => {
    const a = attributePayments([payment({})], ['g1'])
    const b = attributePayments([payment({})], ['g1'])
    expect(a[0].id).toBe(b[0].id)
  })
})

describe('withTokenRefresh', () => {
  it('returns the result directly when there is no auth failure', async () => {
    let refreshes = 0
    const r = await withTokenRefresh({
      run: async () => 'ok',
      refresh: async () => { refreshes++; return 'new-token' },
    })
    expect(r).toBe('ok')
    expect(refreshes).toBe(0)
  })

  it('refreshes once and retries when the first attempt 401s', async () => {
    let attempts = 0
    let refreshes = 0
    const r = await withTokenRefresh({
      run: async () => {
        attempts++
        if (attempts === 1) throw new Error('MP searchPayments failed: 401')
        return 'ok-after-refresh'
      },
      refresh: async () => { refreshes++; return 'new-token' },
    })
    expect(r).toBe('ok-after-refresh')
    expect(attempts).toBe(2)
    expect(refreshes).toBe(1)
  })

  it('does not retry more than once', async () => {
    let attempts = 0
    await expect(withTokenRefresh({
      run: async () => { attempts++; throw new Error('MP searchPayments failed: 401') },
      refresh: async () => 'new-token',
    })).rejects.toThrow('401')
    expect(attempts).toBe(2)
  })

  it('propagates non-auth errors without refreshing', async () => {
    let refreshes = 0
    await expect(withTokenRefresh({
      run: async () => { throw new Error('MP searchPayments failed: 500') },
      refresh: async () => { refreshes++; return 'new-token' },
    })).rejects.toThrow('500')
    expect(refreshes).toBe(0)
  })

  it('surfaces a TokenRefreshFailedError when the refresh itself fails after a 401', async () => {
    await expect(withTokenRefresh({
      run: async () => { throw new Error('MP searchPayments failed: 401') },
      refresh: async () => { throw new Error('MP OAuth error: invalid_grant') },
    })).rejects.toThrow(TokenRefreshFailedError)
  })
})

describe('ingestForNgo', () => {
  it('upserts payments attributed to a known goal and ignores the rest, via FakeMercadoPago', async () => {
    const fake = new FakeMercadoPago()
    fake.seedPayment({
      id: 'p1', status: 'approved', transactionAmountCents: 50_000,
      externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z',
    })
    fake.seedPayment({
      id: 'p2', status: 'approved', transactionAmountCents: 20_000,
      externalReference: 'unknown-goal', dateApproved: '2026-08-31T11:00:00Z',
    })

    const upserted: unknown[] = []
    const result = await ingestForNgo({
      client: fake,
      accessToken: 'tok',
      goalIds: ['g1'],
      since: new Date('2026-08-31T00:00:00Z'),
      now: new Date('2026-08-31T23:59:59Z'),
      upsert: async (c) => { upserted.push(c) },
    })

    expect(result).toEqual({ upserted: 1, ignored: 1 })
    expect(upserted).toEqual([expect.objectContaining({
      goalId: 'g1', mpPaymentId: 'p1', amountCents: 50_000,
    })])
  })

  it('composes with withTokenRefresh: a 401 from the fake triggers exactly one refresh, then the retry lands the payment', async () => {
    const fake = new FakeMercadoPago()
    fake.seedPayment({
      id: 'p1', status: 'approved', transactionAmountCents: 75_000,
      externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z',
    })
    fake.failNextWith401 = true

    const stored = 'stale-token'
    let refreshes = 0
    const upserted: unknown[] = []

    const result = await withTokenRefresh({
      run: (token) => ingestForNgo({
        client: fake,
        accessToken: token ?? stored,
        goalIds: ['g1'],
        since: new Date('2026-08-31T00:00:00Z'),
        now: new Date('2026-08-31T23:59:59Z'),
        upsert: async (c) => { upserted.push(c) },
      }),
      refresh: async () => { refreshes++; return 'fresh-token' },
    })

    expect(refreshes).toBe(1)
    expect(result).toEqual({ upserted: 1, ignored: 0 })
    expect(upserted).toEqual([expect.objectContaining({ mpPaymentId: 'p1', goalId: 'g1' })])
  })
})

describe('recheckPendingContributions', () => {
  it('upserts a payment that has since settled to approved', async () => {
    const fake = new FakeMercadoPago()
    fake.seedPayment({
      id: 'p1', status: 'approved', transactionAmountCents: 30_000,
      externalReference: 'g1', dateApproved: '2026-09-02T10:00:00Z',
    })
    const upserted: unknown[] = []
    const result = await recheckPendingContributions({
      client: fake,
      accessToken: 'tok',
      pending: [{ id: 'mp-p1', goalId: 'g1', mpPaymentId: 'p1' }],
      upsert: async (c) => { upserted.push(c) },
    })
    expect(result).toEqual({ updated: 1, stillPending: 0 })
    expect(upserted).toEqual([expect.objectContaining({ status: 'approved', amountCents: 30_000 })])
  })

  it('leaves a still-pending payment alone (no upsert) rather than writing a false status', async () => {
    const fake = new FakeMercadoPago()
    fake.seedPayment({
      id: 'p1', status: 'pending', transactionAmountCents: 30_000,
      externalReference: 'g1', dateApproved: null,
    })
    const upserted: unknown[] = []
    const result = await recheckPendingContributions({
      client: fake, accessToken: 'tok',
      pending: [{ id: 'mp-p1', goalId: 'g1', mpPaymentId: 'p1' }],
      upsert: async (c) => { upserted.push(c) },
    })
    expect(result).toEqual({ updated: 0, stillPending: 1 })
    expect(upserted).toEqual([])
  })

  it('treats a payment MP no longer has (404 / null) as still-pending, never as rejected', async () => {
    const fake = new FakeMercadoPago() // no seeded payments -> getPayment returns null
    const upserted: unknown[] = []
    const result = await recheckPendingContributions({
      client: fake, accessToken: 'tok',
      pending: [{ id: 'mp-gone', goalId: 'g1', mpPaymentId: 'gone' }],
      upsert: async (c) => { upserted.push(c) },
    })
    expect(result).toEqual({ updated: 0, stillPending: 1 })
    expect(upserted).toEqual([])
  })

  it('a non-auth failure on one payment does not abort the rest of the list', async () => {
    const fake = new FakeMercadoPago()
    fake.seedPayment({
      id: 'p2', status: 'approved', transactionAmountCents: 10_000,
      externalReference: 'g1', dateApproved: '2026-09-02T10:00:00Z',
    })
    let calls = 0
    const flaky: typeof fake = {
      ...fake,
      getPayment: async (input: { accessToken: string; paymentId: string }) => {
        calls++
        if (input.paymentId === 'p1') throw new Error('MP getPayment failed: 500')
        return fake.getPayment(input)
      },
    } as unknown as typeof fake
    const upserted: unknown[] = []
    const result = await recheckPendingContributions({
      client: flaky, accessToken: 'tok',
      pending: [
        { id: 'mp-p1', goalId: 'g1', mpPaymentId: 'p1' },
        { id: 'mp-p2', goalId: 'g1', mpPaymentId: 'p2' },
      ],
      upsert: async (c) => { upserted.push(c) },
    })
    expect(calls).toBe(2)
    expect(result).toEqual({ updated: 1, stillPending: 1 })
    expect(upserted).toEqual([expect.objectContaining({ mpPaymentId: 'p2' })])
  })

  it('propagates a 401 rather than swallowing it, so withTokenRefresh can retry', async () => {
    const fake = new FakeMercadoPago()
    fake.failNextWith401 = true
    await expect(recheckPendingContributions({
      client: fake, accessToken: 'stale',
      pending: [{ id: 'mp-p1', goalId: 'g1', mpPaymentId: 'p1' }],
      upsert: async () => {},
    })).rejects.toThrow('401')
  })
})

describe('ingestOneNgo', () => {
  const baseDeps = (over: Partial<Parameters<typeof ingestOneNgo>[0]> = {}) => ({
    ngoId: 'ngo-1',
    client: new FakeMercadoPago(),
    since: new Date('2026-08-31T00:00:00Z'),
    now: new Date('2026-08-31T23:59:59Z'),
    loadSecrets: async () => ({ accessTokenEnc: 'enc-access', refreshTokenEnc: 'enc-refresh' }),
    loadGoalIds: async () => ['g1'],
    loadPendingContributions: async () => [],
    decrypt: async () => 'plain-token',
    refresh: async () => 'fresh-token',
    upsert: async () => {},
    markDisconnected: async () => {},
    log: () => {},
    ...over,
  })

  it('never throws when loadSecrets fails (e.g. a corrupted row or a rotated TOKEN_KEY), so a caller looping over NGOs can move on', async () => {
    const logs: string[] = []
    let disconnected = false
    await expect(ingestOneNgo(baseDeps({
      loadSecrets: async () => { throw new Error('D1_ERROR: no such table') },
      markDisconnected: async () => { disconnected = true },
      log: (m) => logs.push(m),
    }))).resolves.toBeUndefined()
    expect(disconnected).toBe(false) // a DB blip is not a reconnect-required condition
    expect(logs).toHaveLength(1)
  })

  it('never throws when decrypt fails (bad AES-GCM tag / rotated key), and does not mark the NGO disconnected', async () => {
    const logs: string[] = []
    let disconnected = false
    await expect(ingestOneNgo(baseDeps({
      decrypt: async () => { throw new Error('OperationError') },
      markDisconnected: async () => { disconnected = true },
      log: (m) => logs.push(m),
    }))).resolves.toBeUndefined()
    expect(disconnected).toBe(false)
    expect(logs).toHaveLength(1)
  })

  it('marks the NGO disconnected when the refresh itself fails after a 401', async () => {
    const fake = new FakeMercadoPago()
    fake.failNextWith401 = true
    let disconnected = false
    await ingestOneNgo(baseDeps({
      client: fake,
      refresh: async () => { throw new Error('MP OAuth error: invalid_grant') },
      markDisconnected: async () => { disconnected = true },
    }))
    expect(disconnected).toBe(true)
  })

  it('skips silently (no error, no disconnect) when the NGO has no stored tokens', async () => {
    let disconnected = false
    let upserts = 0
    await ingestOneNgo(baseDeps({
      loadSecrets: async () => ({ accessTokenEnc: null, refreshTokenEnc: null }),
      markDisconnected: async () => { disconnected = true },
      upsert: async () => { upserts++ },
    }))
    expect(disconnected).toBe(false)
    expect(upserts).toBe(0)
  })

  it('also recheck-upserts a contribution that was pending outside the normal lookback window', async () => {
    const fake = new FakeMercadoPago()
    // Settled now, but its date_approved is long before `since` — the
    // normal searchPayments window would never see it again.
    fake.seedPayment({
      id: 'old-1', status: 'approved', transactionAmountCents: 40_000,
      externalReference: 'g1', dateApproved: '2020-01-01T00:00:00Z',
    })
    const upserted: unknown[] = []
    await ingestOneNgo(baseDeps({
      client: fake,
      loadPendingContributions: async () => [{ id: 'mp-old-1', goalId: 'g1', mpPaymentId: 'old-1' }],
      upsert: async (c) => { upserted.push(c) },
    }))
    expect(upserted).toEqual([expect.objectContaining({ mpPaymentId: 'old-1', status: 'approved' })])
  })

  it('one NGO throwing at every stage does not prevent the next NGO in a loop from ingesting successfully', async () => {
    const fake = new FakeMercadoPago()
    fake.seedPayment({
      id: 'p1', status: 'approved', transactionAmountCents: 60_000,
      externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z',
    })

    const upsertedByNgo: Record<string, unknown[]> = { a: [], b: [] }
    const order = ['a', 'b']

    for (const ngoId of order) {
      await ingestOneNgo(baseDeps({
        ngoId,
        client: fake,
        // NGO 'a' fails as early as possible in the per-NGO body.
        loadSecrets: async () => {
          if (ngoId === 'a') throw new Error('D1_ERROR: connection reset')
          return { accessTokenEnc: 'enc-access', refreshTokenEnc: 'enc-refresh' }
        },
        upsert: async (c) => { upsertedByNgo[ngoId]!.push(c) },
      }))
    }

    expect(upsertedByNgo.a).toEqual([])
    expect(upsertedByNgo.b).toEqual([expect.objectContaining({ mpPaymentId: 'p1', goalId: 'g1' })])
  })
})
