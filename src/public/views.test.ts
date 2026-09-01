import { describe, it, expect } from 'vitest'
import { formatArs, formatArsBreakdown, barWidthPercent, GoalPage } from './views'
import type { Goal } from '../goals/types'
import type { GoalProgress } from '../goals/progress'

describe('formatArs', () => {
  it('formats centavos as pesos with thousands separators', () => {
    expect(formatArs(1_234_500)).toBe('$12.345')
  })
  it('formats zero', () => {
    expect(formatArs(0)).toBe('$0')
  })
})

describe('formatArsBreakdown', () => {
  it('makes verified 50c + manual 50c sum to the same $1 shown as the headline, rather than $1 + $1', () => {
    const { total, parts } = formatArsBreakdown(100, [50, 50])
    expect(total).toBe('$1')
    expect(parts).toEqual(['$1', '$0'])
  })

  it('leaves already-consistent whole-peso figures untouched', () => {
    const { total, parts } = formatArsBreakdown(150_000, [100_000, 50_000])
    expect(total).toBe('$1.500')
    expect(parts).toEqual(['$1.000', '$500'])
  })

  it('handles a single part (no other parts to fold slack into)', () => {
    const { total, parts } = formatArsBreakdown(50, [50])
    expect(total).toBe('$1')
    expect(parts).toEqual(['$1'])
  })

  it('handles zero total and zero parts', () => {
    const { total, parts } = formatArsBreakdown(0, [0, 0])
    expect(total).toBe('$0')
    expect(parts).toEqual(['$0', '$0'])
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

describe('GoalPage', () => {
  it('shows the true percent in visible text while clamping aria-valuenow, when the goal is exceeded', async () => {
    const goal: Goal = {
      id: 'g1',
      ngoId: 'n1',
      title: 'Campaña de castración',
      description: 'Castrar 50 gatos comunitarios.',
      targetAmountCents: 100_000,
      status: 'active',
    }
    const progress: GoalProgress = {
      goalId: 'g1',
      targetCents: 100_000,
      raisedCents: 150_000,
      verifiedCents: 0,
      manualCents: 150_000,
      percent: 150,
      reached: true,
    }
    const out = await GoalPage({ goal, progress }).toString()
    expect(out).toContain('(150%)')
    expect(out).toContain('aria-valuenow="100"')
    expect(out).not.toContain('aria-valuenow="150"')
  })
})
