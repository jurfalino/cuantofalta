import { describe, it, expect } from 'vitest'
import { formatArs, barWidthPercent } from './views'

describe('formatArs', () => {
  it('formats centavos as pesos with thousands separators', () => {
    expect(formatArs(1_234_500)).toBe('$12.345')
  })
  it('formats zero', () => {
    expect(formatArs(0)).toBe('$0')
  })
})

describe('barWidthPercent', () => {
  it('clamps display width at 100 even when the goal is exceeded', () => {
    expect(barWidthPercent(150)).toBe(100)
  })
  it('passes through partial progress', () => {
    expect(barWidthPercent(42)).toBe(42)
  })
  it('floors negatives at zero', () => {
    expect(barWidthPercent(-5)).toBe(0)
  })
})
