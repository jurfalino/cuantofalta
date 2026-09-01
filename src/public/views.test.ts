import { describe, it, expect } from 'vitest'
import { formatArs, barWidthPercent, GoalPage } from './views'
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
