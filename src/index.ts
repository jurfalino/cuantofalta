import { Hono } from 'hono'
import { publicRoutes } from './public/routes'
import { donateRoutes } from './public/donate'
import { adminRoutes } from './admin/routes'
import { connectRoutes } from './admin/connect'
import { LiveMercadoPago } from './mp/client'
import { decryptToken, encryptToken } from './credentials/crypto'
import { ingestForNgo, withTokenRefresh, isAuthError, TokenRefreshFailedError } from './ingest/poller'
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

      for (const ngo of await listConnectedNgos(d)) {
        const secrets = await getNgoSecrets(d, ngo.id)
        if (!secrets?.accessTokenEnc || !secrets.refreshTokenEnc) continue
        const goals = await listGoalsByNgo(d, ngo.id)
        const stored = await decryptToken(secrets.accessTokenEnc, env.TOKEN_KEY)

        try {
          await withTokenRefresh({
            run: (token) => ingestForNgo({
              client,
              accessToken: token ?? stored,
              goalIds: goals.map((g) => g.id),
              since, now,
              upsert: (c) => upsertPlatformContribution(d, {
                id: c.id, goalId: c.goalId, mpPaymentId: c.mpPaymentId!,
                amountCents: c.amountCents, status: c.status, paidAt: c.paidAt,
              }),
            }),
            refresh: async () => {
              const t = await refreshAccessToken({
                clientId: env.MP_CLIENT_ID,
                clientSecret: env.MP_CLIENT_SECRET,
                refreshToken: await decryptToken(secrets.refreshTokenEnc!, env.TOKEN_KEY),
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
          })
        } catch (err) {
          // Refresh already had its one attempt inside withTokenRefresh.
          // Disconnect only when reconnecting is actually required: either
          // the retried attempt still 401s, or the refresh call itself
          // failed (revoked/expired refresh token) — never on a bare first
          // 401, which withTokenRefresh already absorbed.
          if (err instanceof TokenRefreshFailedError || isAuthError(err)) {
            await markNgoDisconnected(d, ngo.id)
          }
          console.error(`ingest failed for ngo ${ngo.id}: ${err}`)
        }
      }
    })())
  },
}
