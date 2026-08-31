import { describe, it, expect } from 'vitest'
import type { Contribution } from './types'

describe('domain types', () => {
  it('models a manual contribution with no MP payment id', () => {
    const c: Contribution = {
      id: 'c1', goalId: 'g1', source: 'manual', mpPaymentId: null,
      amountCents: 500000, status: 'approved',
      paidAt: '2026-08-31T10:00:00Z', note: 'Transferencia por alias',
    }
    expect(c.mpPaymentId).toBeNull()
    expect(c.amountCents).toBe(500000)
  })
})
