import type { Goal } from '../goals/types'
import type { GoalProgress } from '../goals/progress'

export function formatArs(cents: number): string {
  const pesos = Math.round(cents / 100)
  return '$' + pesos.toLocaleString('es-AR')
}

export function barWidthPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent))
}

export function ProgressBar({ progress }: { progress: GoalProgress }) {
  return (
    <div class="bar" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
      <div class="bar-fill" style={`width:${barWidthPercent(progress.percent)}%`} />
    </div>
  )
}

export function GoalPage({ goal, progress }: { goal: Goal; progress: GoalProgress }) {
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
          Incluye {formatArs(progress.verifiedCents)} recibidos por la plataforma
          y {formatArs(progress.manualCents)} registrados por la organización.
        </p>
        <form method="get" action={`/g/${goal.id}/donar`}>
          <label>Monto (pesos): <input type="number" name="monto" min="100" required /></label>
          <button type="submit">Donar</button>
        </form>
      </body>
    </html>
  )
}
