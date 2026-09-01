import { Hono } from 'hono'
import { html } from 'hono/html'
import { requireOperator, isValidOperatorSecret, mintOperatorSessionToken, setOperatorSessionCookie } from './auth'
import {
  db, listGoalsByNgo, createGoal, addManualContribution, listContributions,
  createNgo, listNgos, getNgoById, isUniqueConstraintError,
} from '../db/queries'
import { computeProgress } from '../goals/progress'
import { formatArs, formatArsBreakdown } from '../public/views'
import { parsePesosToCents } from '../money'
import type { Env } from '../env'

export const adminRoutes = new Hono<{ Bindings: Env }>()
adminRoutes.use('/admin/*', requireOperator)

function loginPage(error?: string) {
  return html`<!DOCTYPE html>${(
    <html lang="es">
      <body>
        <h1>Ingreso de operador</h1>
        {error ? <p role="alert">{error}</p> : null}
        <form method="post" action="/admin/login">
          <label>Clave: <input type="password" name="secret" required autofocus /></label>
          <button type="submit">Ingresar</button>
        </form>
      </body>
    </html>
  )}`
}

adminRoutes.get('/admin/login', (c) => c.html(loginPage()))

adminRoutes.post('/admin/login', async (c) => {
  const f = await c.req.formData()
  const provided = String(f.get('secret') ?? '')
  if (!isValidOperatorSecret(provided, c.env.OPERATOR_SECRET)) {
    return c.html(loginPage('Clave incorrecta.'), 401)
  }
  const token = await mintOperatorSessionToken(c.env.TOKEN_KEY)
  setOperatorSessionCookie(c, token)
  return c.redirect('/admin/ngo')
})

adminRoutes.get('/admin/ngo', async (c) => {
  const ngos = await listNgos(db(c.env.DB))
  return c.html(html`<!DOCTYPE html>${(
    <html lang="es">
      <body>
        <h1>Organizaciones</h1>
        <ul>{ngos.map((ngo) => (
          <li>
            <a href={`/admin/ngo/${ngo.id}`}>{ngo.name}</a> ({ngo.slug}) — estado: {ngo.status}
            {' '}
            <a href={`/admin/ngo/${ngo.id}/connect-link`}>Generar enlace de conexión</a>
          </li>
        ))}</ul>
        <h2>Nueva organización</h2>
        <form method="post" action="/admin/ngo">
          <input name="name" placeholder="Nombre" required />
          <input name="slug" placeholder="Slug (identificador corto, ej. refugio-la-esperanza)" required />
          <button type="submit">Crear</button>
        </form>
      </body>
    </html>
  )}`)
})

adminRoutes.post('/admin/ngo', async (c) => {
  const f = await c.req.formData()
  const name = String(f.get('name') ?? '').trim()
  const slug = String(f.get('slug') ?? '').trim()
  if (!name) return c.text('El nombre no puede estar vacío', 400)
  if (!slug) return c.text('El slug no puede estar vacío', 400)

  try {
    await createNgo(db(c.env.DB), { id: crypto.randomUUID(), name, slug })
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return c.text('Ya existe una organización con ese slug. Elegí otro.', 409)
    }
    throw err
  }
  return c.redirect('/admin/ngo')
})

adminRoutes.get('/admin/ngo/:ngoId', async (c) => {
  const d = db(c.env.DB)
  const ngoId = c.req.param('ngoId')
  const ngo = await getNgoById(d, ngoId)
  if (!ngo) return c.text('Organización no encontrada', 404)

  const goals = await listGoalsByNgo(d, ngoId)
  const rows = await Promise.all(goals.map(async (g) =>
    ({ g, p: computeProgress(g, await listContributions(d, g.id)) })))

  return c.html(html`<!DOCTYPE html>${(
    <html lang="es"><body>
      <h1>{ngo.name}</h1>
      {ngo.status === 'disconnected' ? (
        <div role="alert">
          <p>
            Esta organización está desconectada de Mercado Pago: dejamos de poder registrar sus
            donaciones automáticamente.
          </p>
          <p><a href={`/admin/ngo/${ngo.id}/connect-link`}>Generar un nuevo enlace de conexión</a></p>
        </div>
      ) : null}
      <h2>Objetivos</h2>
      <ul>{rows.map(({ g, p }) => {
        const breakdown = formatArsBreakdown(p.raisedCents, [p.verifiedCents, p.manualCents])
        return (
          <li>
            {g.title} — {breakdown.total} / {formatArs(p.targetCents)} ({p.percent}%)
            <br />
            <small>plataforma {breakdown.parts[0]} · manual {breakdown.parts[1]}</small>
            <form method="post" action={`/admin/goal/${g.id}/manual`}>
              <input name="montoPesos" type="number" min="1" required placeholder="Monto recibido fuera de la plataforma" />
              <input name="note" placeholder="Nota (ej. transferencias por alias)" />
              <button type="submit">Registrar</button>
            </form>
          </li>
        )
      })}</ul>
      <h2>Nuevo objetivo</h2>
      <form method="post" action="/admin/goal">
        <input type="hidden" name="ngoId" value={ngoId} />
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
  const targetAmountCents = parsePesosToCents(f.get('targetPesos'))
  if (targetAmountCents === null) return c.text('Monto inválido', 400)
  await createGoal(db(c.env.DB), {
    id: crypto.randomUUID(),
    ngoId: String(f.get('ngoId')),
    title: String(f.get('title')),
    description: String(f.get('description') ?? ''),
    targetAmountCents,
  })
  return c.redirect(`/admin/ngo/${f.get('ngoId')}`)
})

adminRoutes.post('/admin/goal/:goalId/manual', async (c) => {
  const f = await c.req.formData()
  const amountCents = parsePesosToCents(f.get('montoPesos'))
  if (amountCents === null) return c.text('Monto inválido', 400)
  await addManualContribution(db(c.env.DB), {
    id: crypto.randomUUID(),
    goalId: c.req.param('goalId'),
    amountCents,
    note: String(f.get('note') ?? ''),
  })
  return c.redirect(`/g/${c.req.param('goalId')}`)
})
