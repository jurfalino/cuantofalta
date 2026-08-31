import type { Goal, Contribution } from './types'

export interface GoalProgress {
  goalId: string
  targetCents: number
  raisedCents: number
  verifiedCents: number
  manualCents: number
  percent: number
  reached: boolean
}

export function computeProgress(goal: Goal, contributions: Contribution[]): GoalProgress {
  const counted = contributions.filter(
    (c) => c.goalId === goal.id && c.status === 'approved',
  )
  const sum = (src: Contribution['source']) =>
    counted.filter((c) => c.source === src).reduce((t, c) => t + c.amountCents, 0)

  const verifiedCents = sum('platform')
  const manualCents = sum('manual')
  const raisedCents = verifiedCents + manualCents

  const percent =
    goal.targetAmountCents > 0
      ? Math.round((raisedCents / goal.targetAmountCents) * 100)
      : 0

  return {
    goalId: goal.id,
    targetCents: goal.targetAmountCents,
    raisedCents,
    verifiedCents,
    manualCents,
    percent,
    reached: goal.targetAmountCents > 0 && raisedCents >= goal.targetAmountCents,
  }
}
