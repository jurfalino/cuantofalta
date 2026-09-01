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
  listPendingPlatformContributions,
} from './db/queries'
import type { Env } from './env'

export type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()
app.route('/', publicRoutes)
app.route('/', donateRoutes)
app.route('/', adminRoutes)
app.route('/', connectRoutes)
app.get('/', (c) => c.text('Cuánto Falta'))

// Catches whatever an unhandled throw would otherwise turn into Hono's
// bare English "Internal Server Error" — donor- and NGO-facing paths that
// have no try/catch of their own (createPreference/decryptToken in
// public/donate.tsx, exchangeCode in admin/connect.tsx, among others) hit
// this every time they fail, and the Spanish copy used everywhere else
// must not suddenly break there. The response is a fixed, static string:
// it never includes `err.message`/`err.stack`, so a decrypt failure or a
// thrown token can never end up rendered to a client. The error itself is
// still logged server-side for operators.
app.onError((err, c) => {
  console.error('unhandled error:', err)
  return c.html(
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
    + '<title>Error — Cuánto Falta</title></head><body>'
    + '<h1>Ocurrió un error</h1>'
    + '<p>Algo salió mal de nuestro lado. Probá de nuevo en unos minutos.</p>'
    + '</body></html>',
    500,
  )
})

export { app }

export default {
  fetch: app.fetch,
  // Awaited directly rather than handed to ctx.waitUntil: a Worker's
  // scheduled() return settling is what Cloudflare uses to decide whether
  // the cron tick succeeded. waitUntil detaches the work from that signal
  // entirely, so the handler returns (and is reported a success) before
  // any ingestion has actually run — every tick would report "ok"
  // regardless of outcome.
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const d = db(env.DB)
    const client = new LiveMercadoPago()
    const now = new Date()
    // 7 days, not 24 hours: Argentine efectivo tickets (Rapipago, Pago
    // Fácil) can settle 1-3 business days after creation. A payment
    // created just inside a 24h window can still be `pending` when this
    // tick runs and would otherwise never be looked at again once it ages
    // out. The second-pass recheck below (by mp_payment_id, unbounded by
    // age) is what actually closes that hole — the wider window alone
    // only buys more time before the same problem recurs.
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Fetched once for the whole tick, then filtered per NGO below, rather
    // than one query per NGO.
    const allPending = await listPendingPlatformContributions(d)

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
        loadPendingContributions: async () => allPending
          .filter((p) => p.ngoId === ngo.id)
          .map(({ id, goalId, mpPaymentId }) => ({ id, goalId, mpPaymentId })),
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
  },
}
