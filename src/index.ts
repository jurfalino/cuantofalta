import { Hono } from 'hono'
import { publicRoutes } from './public/routes'
import { donateRoutes } from './public/donate'
import { adminRoutes } from './admin/routes'
import { connectRoutes } from './admin/connect'
import { LiveMercadoPago } from './mp/client'
import { decryptToken, encryptToken } from './credentials/crypto'
import { ingestOneNgo } from './ingest/poller'
import { refreshAccessToken } from './mp/oauth'
import {
  db, listConnectedNgos, listGoalsByNgo, getNgoSecrets,
  saveNgoTokens, upsertPlatformContribution, markNgoDisconnected,
} from './db/queries'
import type { Env } from './env'

export type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()
app.route('/', publicRoutes)
app.route('/', donateRoutes)
app.route('/', adminRoutes)
app.route('/', connectRoutes)
app.get('/', (c) => c.text('Cuánto Falta'))

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const d = db(env.DB)
      const client = new LiveMercadoPago()
      const now = new Date()
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)

      // Each NGO is ingested independently — ingestOneNgo never throws, so
      // one NGO's failure (bad decrypt, DB blip, revoked refresh token)
      // can never prevent the rest of this loop from running.
      for (const ngo of await listConnectedNgos(d)) {
        await ingestOneNgo({
          ngoId: ngo.id,
          client,
          since,
          now,
          loadSecrets: () => getNgoSecrets(d, ngo.id),
          loadGoalIds: async () => (await listGoalsByNgo(d, ngo.id)).map((g) => g.id),
          decrypt: (enc) => decryptToken(enc, env.TOKEN_KEY),
          refresh: async (refreshTokenEnc) => {
            const t = await refreshAccessToken({
              clientId: env.MP_CLIENT_ID,
              clientSecret: env.MP_CLIENT_SECRET,
              refreshToken: await decryptToken(refreshTokenEnc, env.TOKEN_KEY),
            })
            await saveNgoTokens(d, {
              ngoId: ngo.id,
              accessTokenEnc: await encryptToken(t.accessToken, env.TOKEN_KEY),
              refreshTokenEnc: await encryptToken(t.refreshToken, env.TOKEN_KEY),
              tokenExpiresAt: new Date(Date.now() + t.expiresInSeconds * 1000).toISOString(),
              mpUserId: t.mpUserId,
            })
            return t.accessToken
          },
          upsert: (c) => upsertPlatformContribution(d, {
            id: c.id, goalId: c.goalId, mpPaymentId: c.mpPaymentId!,
            amountCents: c.amountCents, status: c.status, paidAt: c.paidAt,
          }),
          markDisconnected: () => markNgoDisconnected(d, ngo.id),
          log: (message) => console.error(message),
        })
      }
    })())
  },
}
