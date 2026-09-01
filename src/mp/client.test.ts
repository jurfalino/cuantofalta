import { describe, it, expect } from 'vitest'
import { normalizePaymentStatus } from './client'

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
