import { describe, it, expect } from 'vitest'
import { FakeMercadoPago } from './fake'

describe('FakeMercadoPago', () => {
  it('returns an init point when creating a preference', async () => {
    const mp = new FakeMercadoPago()
    const r = await mp.createPreference({
      accessToken: 't', goalId: 'g1', amountCents: 100_000,
      title: 'Donación', backUrl: 'https://example.test/g/g1',
    })
    expect(r.initPoint).toContain('http')
    expect(r.preferenceId).toBeTruthy()
  })

  it('returns seeded payments filtered by date window', async () => {
    const mp = new FakeMercadoPago()
    mp.seedPayment({
      id: 'p1', status: 'approved', transactionAmountCents: 100_000,
      externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z',
    })
    mp.seedPayment({
      id: 'p2', status: 'approved', transactionAmountCents: 200_000,
      externalReference: 'g1', dateApproved: '2020-01-01T00:00:00Z',
    })
    const found = await mp.searchPayments({
      accessToken: 't', beginDate: '2026-08-01T00:00:00Z', endDate: '2026-09-01T00:00:00Z',
    })
    expect(found.map((p) => p.id)).toEqual(['p1'])
  })

  it('throws the configured auth error so refresh logic can be tested', async () => {
    const mp = new FakeMercadoPago()
    mp.failNextWith401 = true
    await expect(mp.searchPayments({
      accessToken: 'stale', beginDate: '2026-08-01T00:00:00Z', endDate: '2026-09-01T00:00:00Z',
    })).rejects.toThrow('401')
  })
})
