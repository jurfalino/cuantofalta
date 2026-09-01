import { describe, it, expect } from 'vitest'
import { parsePesosToCents } from './money'

describe('parsePesosToCents', () => {
  it('rejects null', () => {
    expect(parsePesosToCents(null)).toBeNull()
  })
  it('rejects undefined', () => {
    expect(parsePesosToCents(undefined)).toBeNull()
  })
  it('rejects an empty string', () => {
    expect(parsePesosToCents('')).toBeNull()
  })
  it('rejects a whitespace-only string', () => {
    expect(parsePesosToCents('   ')).toBeNull()
  })
  it('rejects non-numeric text', () => {
    expect(parsePesosToCents('abc')).toBeNull()
  })
  it('rejects scientific notation (not a valid plain-decimal peso amount)', () => {
    expect(parsePesosToCents('1e5')).toBeNull()
  })
  it('rejects Infinity', () => {
    expect(parsePesosToCents('Infinity')).toBeNull()
  })
  it('rejects NaN as text', () => {
    expect(parsePesosToCents('NaN')).toBeNull()
  })
  it('rejects zero', () => {
    expect(parsePesosToCents('0')).toBeNull()
  })
  it('rejects negative amounts', () => {
    expect(parsePesosToCents('-5')).toBeNull()
  })
  it('rejects a negative amount with decimals', () => {
    expect(parsePesosToCents('-5.50')).toBeNull()
  })
  it('accepts one decimal place and converts exactly', () => {
    expect(parsePesosToCents('10.5')).toBe(1050)
  })
  it('accepts two decimal places and converts exactly', () => {
    expect(parsePesosToCents('10.55')).toBe(1055)
  })
  it('rejects more than two decimal places rather than rounding', () => {
    expect(parsePesosToCents('10.005')).toBeNull()
  })
  it('accepts a plain positive integer', () => {
    expect(parsePesosToCents('300')).toBe(30000)
  })
  it('returns an exact integer with no float dust for a value known to be float-imprecise', () => {
    const result = parsePesosToCents('19.99')
    expect(result).toBe(1999)
    expect(Number.isInteger(result)).toBe(true)
  })
})
