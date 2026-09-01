import { Hono } from 'hono'
import { buildAuthorizeUrl, exchangeCode, signState, verifyState } from '../mp/oauth'
import { encryptToken } from '../credentials/crypto'
import { db, saveNgoTokens } from '../db/queries'
import type { Env } from '../env'

export const connectRoutes = new Hono<{ Bindings: Env }>()

// Operator shares this link with the NGO; the NGO clicks it from its own
// browser and approves in its own Mercado Pago account. `state` carries the
// ngo id, signed so the callback can trust it came from a link we minted.
connectRoutes.get('/conectar/:ngoId', async (c) => {
  const state = await signState(c.req.param('ngoId'), c.env.TOKEN_KEY, new Date())
  const url = buildAuthorizeUrl({
    clientId: c.env.MP_CLIENT_ID,
    redirectUri: `${c.env.PUBLIC_BASE_URL}/oauth/callback`,
    state,
  })
  return c.redirect(url)
})

connectRoutes.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.text('Faltan parámetros en el enlace de conexión.', 400)

  const ngoId = await verifyState(state, c.env.TOKEN_KEY, new Date())
  if (!ngoId) return c.text('El enlace de conexión es inválido o expiró. Pedí uno nuevo.', 400)

  const tokens = await exchangeCode({
    clientId: c.env.MP_CLIENT_ID,
    clientSecret: c.env.MP_CLIENT_SECRET,
    code,
    redirectUri: `${c.env.PUBLIC_BASE_URL}/oauth/callback`,
  })

  await saveNgoTokens(db(c.env.DB), {
    ngoId,
    accessTokenEnc: await encryptToken(tokens.accessToken, c.env.TOKEN_KEY),
    refreshTokenEnc: await encryptToken(tokens.refreshToken, c.env.TOKEN_KEY),
    tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
    mpUserId: tokens.mpUserId,
  })

  return c.html(<html lang="es"><body><h1>Cuenta conectada</h1><p>Ya podés cerrar esta ventana.</p></body></html>)
})
