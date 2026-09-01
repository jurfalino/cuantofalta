import type { Goal } from '../goals/types'
import type { GoalProgress } from '../goals/progress'

export function formatArs(cents: number): string {
  const pesos = Math.round(cents / 100)
  return '$' + pesos.toLocaleString('es-AR')
}

/**
 * Formats a total alongside a breakdown of parts that must visibly sum to
 * it, e.g. "raised" next to "verified + manual". Rounding each figure
 * independently (as plain `formatArs` does) can make the displayed parts
 * add up to something other than the displayed total — e.g. 50c verified +
 * 50c manual each round up to $1, printing "$1 + $1" under a "$1" headline.
 *
 * Here the total is rounded first, each part is rounded normally, and any
 * rounding slack is folded into the LAST part, so `parts` always sums
 * exactly to `total` in the returned strings.
 */
export function formatArsBreakdown(totalCents: number, partsCents: number[]): { total: string; parts: string[] } {
  const totalPesos = Math.round(totalCents / 100)
  const roundedParts = partsCents.map((c) => Math.round(c / 100))
  if (roundedParts.length > 0) {
    const sumRounded = roundedParts.reduce((a, b) => a + b, 0)
    roundedParts[roundedParts.length - 1]! += totalPesos - sumRounded
  }
  return {
    total: '$' + totalPesos.toLocaleString('es-AR'),
    parts: roundedParts.map((p) => '$' + p.toLocaleString('es-AR')),
  }
}

export function barWidthPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent))
}

export function ProgressBar({ progress }: { progress: GoalProgress }) {
  return (
    <div class="bar" role="progressbar" aria-valuenow={barWidthPercent(progress.percent)} aria-valuemin={0} aria-valuemax={100}>
      <div class="bar-fill" style={`width:${barWidthPercent(progress.percent)}%`} />
    </div>
  )
}

export function GoalPage({ goal, progress }: { goal: Goal; progress: GoalProgress }) {
  const breakdown = formatArsBreakdown(progress.raisedCents, [progress.verifiedCents, progress.manualCents])
  return (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{goal.title} — Cuánto Falta</title>
        <style>{`
          body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
          .bar{background:#eee;border-radius:999px;height:1.25rem;overflow:hidden}
          .bar-fill{background:#2f9e44;height:100%}
          .totals{display:flex;justify-content:space-between;margin-top:.5rem;font-size:.9rem}
          .detail{color:#666;font-size:.8rem;margin-top:.25rem}
        `}</style>
      </head>
      <body>
        <h1>{goal.title}</h1>
        <p>{goal.description}</p>
        <ProgressBar progress={progress} />
        <div class="totals">
          <strong>{formatArs(progress.raisedCents)}</strong>
          <span>de {formatArs(progress.targetCents)} ({progress.percent}%)</span>
        </div>
        <p class="detail">
          Incluye {breakdown.parts[0]} recibidos por la plataforma
          y {breakdown.parts[1]} registrados por la organización.
        </p>
        <form method="get" action={`/g/${goal.id}/donar`}>
          <label>Monto (pesos): <input type="number" name="monto" min="100" required /></label>
          <button type="submit">Donar</button>
        </form>
      </body>
    </html>
  )
}
