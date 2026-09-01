import { Hono } from 'hono'
import { db, getGoalById, getNgoSecrets } from '../db/queries'
import { decryptToken } from '../credentials/crypto'
import { LiveMercadoPago } from '../mp/client'
import { parsePesosToCents } from '../money'
import type { Env } from '../env'

export const donateRoutes = new Hono<{ Bindings: Env }>()

donateRoutes.get('/g/:id/donar', async (c) => {
  const d = db(c.env.DB)
  const goal = await getGoalById(d, c.req.param('id'))
  if (!goal) return c.notFound()

  const amountCents = parsePesosToCents(c.req.query('monto'))
  if (amountCents === null) return c.text('Monto inválido', 400)

  const ngo = await getNgoSecrets(d, goal.ngoId)
  if (!ngo?.accessTokenEnc) return c.text('La organización aún no conectó su cuenta', 409)

  const { initPoint } = await new LiveMercadoPago().createPreference({
    accessToken: await decryptToken(ngo.accessTokenEnc, c.env.TOKEN_KEY),
    goalId: goal.id,
    amountCents,
    title: `Donación — ${goal.title}`,
    backUrl: `${c.env.PUBLIC_BASE_URL}/g/${goal.id}`,
  })
  return c.redirect(initPoint)
})
