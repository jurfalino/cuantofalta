import { describe, it, expect } from 'vitest'
import { createTestDb } from './testDb'
import {
  createGoal, upsertPlatformContribution, listPendingPlatformContributions,
  createNgo, saveNgoTokens, getNgoById, listNgos, isUniqueConstraintError,
} from './queries'
import * as s from './schema'

async function seedNgoAndGoal(d: ReturnType<typeof createTestDb>) {
  await d.insert(s.ngo).values({ id: 'ngo-1', name: 'Refugio', slug: 'refugio', status: 'connected' })
  await createGoal(d, {
    id: 'goal-1', ngoId: 'ngo-1', title: 'Techo nuevo', description: '', targetAmountCents: 100_000,
  })
}

// This exercises the real SQL upsert in queries.ts against a real SQLite
// engine (via the better-sqlite3 D1 shim in testDb.ts), rather than the
// pure `attributePayments` mapping function, which is deterministic by
// construction and cannot catch a bug in the upsert itself.
describe('upsertPlatformContribution idempotency', () => {
  it('re-ingesting the same mp_payment_id updates the existing row instead of duplicating it', async () => {
    const d = createTestDb()
    await seedNgoAndGoal(d)

    await upsertPlatformContribution(d, {
      id: 'mp-p1', goalId: 'goal-1', mpPaymentId: 'p1',
      amountCents: 50_000, status: 'pending', paidAt: '2026-08-31T10:00:00Z',
    })
    await upsertPlatformContribution(d, {
      id: 'mp-p1', goalId: 'goal-1', mpPaymentId: 'p1',
      amountCents: 50_000, status: 'approved', paidAt: '2026-09-02T09:00:00Z',
    })

    const rows = await d.select().from(s.contribution)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('approved')
    expect(rows[0]?.paidAt).toBe('2026-09-02T09:00:00Z')
    expect(rows[0]?.amountCents).toBe(50_000)
  })

  it('two different mp_payment_ids produce two separate rows', async () => {
    const d = createTestDb()
    await seedNgoAndGoal(d)

    await upsertPlatformContribution(d, {
      id: 'mp-p1', goalId: 'goal-1', mpPaymentId: 'p1',
      amountCents: 10_000, status: 'approved', paidAt: '2026-08-31T10:00:00Z',
    })
    await upsertPlatformContribution(d, {
      id: 'mp-p2', goalId: 'goal-1', mpPaymentId: 'p2',
      amountCents: 20_000, status: 'approved', paidAt: '2026-08-31T11:00:00Z',
    })

    const rows = await d.select().from(s.contribution)
    expect(rows).toHaveLength(2)
  })
})

describe('createNgo', () => {
  it('creates a row that saveNgoTokens can later find', async () => {
    const d = createTestDb()
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    const ngo = await getNgoById(d, 'ngo-1')
    expect(ngo).toMatchObject({ id: 'ngo-1', name: 'Refugio', slug: 'refugio', status: 'pending' })
  })

  it('rejects a duplicate slug rather than silently overwriting', async () => {
    const d = createTestDb()
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    await expect(createNgo(d, { id: 'ngo-2', name: 'Otro', slug: 'refugio' })).rejects.toThrow()
    expect(await listNgos(d)).toHaveLength(1)
  })

  it('the thrown error is recognized by isUniqueConstraintError, even through drizzle-orm/d1\'s wrapping', async () => {
    const d = createTestDb()
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    let caught: unknown
    try {
      await createNgo(d, { id: 'ngo-2', name: 'Otro', slug: 'refugio' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(isUniqueConstraintError(caught)).toBe(true)
  })
})

describe('isUniqueConstraintError', () => {
  it('returns false for an unrelated error', () => {
    expect(isUniqueConstraintError(new Error('boom'))).toBe(false)
  })
  it('returns false for null/undefined', () => {
    expect(isUniqueConstraintError(null)).toBe(false)
    expect(isUniqueConstraintError(undefined)).toBe(false)
  })
  it('finds the message on a nested .cause', () => {
    const inner = new Error('UNIQUE constraint failed: ngo.slug')
    const outer = new Error('Failed query', { cause: inner })
    expect(isUniqueConstraintError(outer)).toBe(true)
  })
})

describe('getNgoById', () => {
  it('never includes token ciphertext columns, even after tokens are saved', async () => {
    const d = createTestDb()
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    await saveNgoTokens(d, {
      ngoId: 'ngo-1', accessTokenEnc: 'secret-access', refreshTokenEnc: 'secret-refresh',
      tokenExpiresAt: '2026-09-01T00:00:00Z', mpUserId: 'mp-1',
    })
    const ngo = await getNgoById(d, 'ngo-1')
    expect(ngo).not.toBeNull()
    expect(JSON.stringify(ngo)).not.toContain('secret-access')
    expect(JSON.stringify(ngo)).not.toContain('secret-refresh')
    expect(ngo!.status).toBe('connected')
  })

  it('returns null for an unknown id', async () => {
    const d = createTestDb()
    expect(await getNgoById(d, 'nope')).toBeNull()
  })
})

describe('saveNgoTokens rows-changed reporting', () => {
  it('reports 1 row changed when the ngo exists', async () => {
    const d = createTestDb()
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    const { rowsChanged } = await saveNgoTokens(d, {
      ngoId: 'ngo-1', accessTokenEnc: 'a', refreshTokenEnc: 'b',
      tokenExpiresAt: '2026-09-01T00:00:00Z', mpUserId: 'mp-1',
    })
    expect(rowsChanged).toBe(1)
  })

  it('reports 0 rows changed for a non-existent ngo id, instead of silently succeeding', async () => {
    const d = createTestDb()
    const { rowsChanged } = await saveNgoTokens(d, {
      ngoId: 'does-not-exist', accessTokenEnc: 'a', refreshTokenEnc: 'b',
      tokenExpiresAt: '2026-09-01T00:00:00Z', mpUserId: 'mp-1',
    })
    expect(rowsChanged).toBe(0)
  })
})

describe('listPendingPlatformContributions', () => {
  it('returns only pending platform contributions, with the ngo id needed to re-check them', async () => {
    const d = createTestDb()
    await seedNgoAndGoal(d)

    await upsertPlatformContribution(d, {
      id: 'mp-p1', goalId: 'goal-1', mpPaymentId: 'p1',
      amountCents: 10_000, status: 'pending', paidAt: '2026-08-20T10:00:00Z',
    })
    await upsertPlatformContribution(d, {
      id: 'mp-p2', goalId: 'goal-1', mpPaymentId: 'p2',
      amountCents: 20_000, status: 'approved', paidAt: '2026-08-31T11:00:00Z',
    })

    const pending = await listPendingPlatformContributions(d)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ mpPaymentId: 'p1', goalId: 'goal-1', ngoId: 'ngo-1' })
  })
})
