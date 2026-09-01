import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizePaymentStatus, LiveMercadoPago } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizePaymentStatus', () => {
  it('maps approved to approved', () => {
    expect(normalizePaymentStatus('approved')).toBe('approved')
  })

  it.each(['pending', 'in_process', 'authorized', 'in_mediation'])(
    'maps %s to pending',
    (raw) => {
      expect(normalizePaymentStatus(raw)).toBe('pending')
    },
  )

  it.each(['rejected', 'cancelled', 'refunded', 'charged_back'])(
    'maps %s to rejected',
    (raw) => {
      expect(normalizePaymentStatus(raw)).toBe('rejected')
    },
  )

  it('maps an unrecognised string to rejected', () => {
    expect(normalizePaymentStatus('wibble')).toBe('rejected')
  })

  it('maps null to rejected', () => {
    expect(normalizePaymentStatus(null)).toBe('rejected')
  })

  it('maps undefined to rejected', () => {
    expect(normalizePaymentStatus(undefined)).toBe('rejected')
  })

  it('maps a non-string value to rejected', () => {
    expect(normalizePaymentStatus(42)).toBe('rejected')
  })
})

describe('LiveMercadoPago.getPayment', () => {
  it('returns null on a 404, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const mp = new LiveMercadoPago()
    expect(await mp.getPayment({ accessToken: 't', paymentId: 'missing' })).toBeNull()
  })

  it('maps a successful response to an MpPayment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 123, status: 'approved', transaction_amount: 500.5,
      external_reference: 'g1', date_approved: '2026-09-01T10:00:00Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const mp = new LiveMercadoPago()
    const payment = await mp.getPayment({ accessToken: 't', paymentId: '123' })
    expect(payment).toEqual({
      id: '123', status: 'approved', transactionAmountCents: 50_050,
      externalReference: 'g1', dateApproved: '2026-09-01T10:00:00Z',
    })
  })

  it('throws on a non-404 error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const mp = new LiveMercadoPago()
    await expect(mp.getPayment({ accessToken: 't', paymentId: '123' })).rejects.toThrow('500')
  })
})
