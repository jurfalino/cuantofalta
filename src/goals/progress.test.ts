import { describe, it, expect } from 'vitest'
import { computeProgress } from './progress'
import type { Goal, Contribution } from './types'

const goal: Goal = {
  id: 'g1', ngoId: 'n1', title: 'Castraciones', description: '',
  targetAmountCents: 1_000_000, status: 'active',
}

const contribution = (over: Partial<Contribution>): Contribution => ({
  id: 'c', goalId: 'g1', source: 'platform', mpPaymentId: 'p',
  amountCents: 100_000, status: 'approved', paidAt: '2026-08-31T10:00:00Z',
  note: null, ...over,
})

describe('computeProgress', () => {
  it('sums approved platform and manual contributions into the headline total', () => {
    const r = computeProgress(goal, [
      contribution({ id: 'c1', amountCents: 300_000 }),
      contribution({ id: 'c2', source: 'manual', mpPaymentId: null, amountCents: 200_000 }),
    ])
    expect(r.raisedCents).toBe(500_000)
    expect(r.verifiedCents).toBe(300_000)
    expect(r.manualCents).toBe(200_000)
  })

  it('excludes pending and rejected payments', () => {
    const r = computeProgress(goal, [
      contribution({ id: 'c1', amountCents: 100_000 }),
      contribution({ id: 'c2', amountCents: 900_000, status: 'pending' }),
      contribution({ id: 'c3', amountCents: 900_000, status: 'rejected' }),
    ])
    expect(r.raisedCents).toBe(100_000)
  })

  it('ignores contributions belonging to another goal', () => {
    const r = computeProgress(goal, [contribution({ id: 'c1', goalId: 'other' })])
    expect(r.raisedCents).toBe(0)
  })

  it('reports percent and reached', () => {
    const r = computeProgress(goal, [contribution({ amountCents: 1_000_000 })])
    expect(r.percent).toBe(100)
    expect(r.reached).toBe(true)
  })

  it('allows percent above 100 but reports it honestly', () => {
    const r = computeProgress(goal, [contribution({ amountCents: 1_500_000 })])
    expect(r.percent).toBe(150)
    expect(r.reached).toBe(true)
  })

  it('returns zero percent for a zero target rather than dividing by zero', () => {
    const r = computeProgress({ ...goal, targetAmountCents: 0 }, [contribution({})])
    expect(r.percent).toBe(0)
    expect(Number.isFinite(r.percent)).toBe(true)
  })
})
