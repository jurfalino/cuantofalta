import { Hono } from 'hono'
import { html } from 'hono/html'
import { requireOperator } from './auth'
import { db, listGoalsByNgo, createGoal, addManualContribution, listContributions } from '../db/queries'
import { computeProgress } from '../goals/progress'
import { formatArs } from '../public/views'
import type { Env } from '../env'

export const adminRoutes = new Hono<{ Bindings: Env }>()
adminRoutes.use('/admin/*', requireOperator)

adminRoutes.get('/admin/ngo/:ngoId', async (c) => {
  const d = db(c.env.DB)
  const goals = await listGoalsByNgo(d, c.req.param('ngoId'))
  const rows = await Promise.all(goals.map(async (g) =>
    ({ g, p: computeProgress(g, await listContributions(d, g.id)) })))
  return c.html(html`<!DOCTYPE html>${(
    <html lang="es"><body>
      <h1>Objetivos</h1>
      <ul>{rows.map(({ g, p }) => (
        <li>
          {g.title} — {formatArs(p.raisedCents)} / {formatArs(p.targetCents)} ({p.percent}%)
          <br />
          <small>plataforma {formatArs(p.verifiedCents)} · manual {formatArs(p.manualCents)}</small>
          <form method="post" action={`/admin/goal/${g.id}/manual`}>
            <input name="montoPesos" type="number" min="1" required placeholder="Monto recibido fuera de la plataforma" />
            <input name="note" placeholder="Nota (ej. transferencias por alias)" />
            <button type="submit">Registrar</button>
          </form>
        </li>
      ))}</ul>
      <h2>Nuevo objetivo</h2>
      <form method="post" action="/admin/goal">
        <input type="hidden" name="ngoId" value={c.req.param('ngoId')} />
        <input name="title" placeholder="Título" required />
        <input name="description" placeholder="Descripción" />
        <input name="targetPesos" type="number" min="1" required />
        <button type="submit">Crear</button>
      </form>
    </body></html>
  )}`)
})

adminRoutes.post('/admin/goal', async (c) => {
  const f = await c.req.formData()
  await createGoal(db(c.env.DB), {
    id: crypto.randomUUID(),
    ngoId: String(f.get('ngoId')),
    title: String(f.get('title')),
    description: String(f.get('description') ?? ''),
    targetAmountCents: Number(f.get('targetPesos')) * 100,
  })
  return c.redirect(`/admin/ngo/${f.get('ngoId')}`)
})

adminRoutes.post('/admin/goal/:goalId/manual', async (c) => {
  const f = await c.req.formData()
  await addManualContribution(db(c.env.DB), {
    id: crypto.randomUUID(),
    goalId: c.req.param('goalId'),
    amountCents: Number(f.get('montoPesos')) * 100,
    note: String(f.get('note') ?? ''),
  })
  return c.redirect(`/g/${c.req.param('goalId')}`)
})
