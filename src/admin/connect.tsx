import { Hono } from 'hono'
import {
  buildAuthorizeUrl, exchangeCode, signPayload, verifyPayload,
  CONNECT_LINK_TTL_SECONDS, OAUTH_STATE_TTL_SECONDS,
} from '../mp/oauth'
import { encryptToken } from '../credentials/crypto'
import { db, saveNgoTokens } from '../db/queries'
import { requireOperator } from './auth'
import type { Env } from '../env'

export const connectRoutes = new Hono<{ Bindings: Env }>()

// Operator-only: mints a signed, 24h-expiring "connect" capability for one
// NGO and shows the link the operator sends to that NGO out-of-band (email,
// WhatsApp). The NGO holds no account on our platform, so it cannot log in
// to reach this step itself — that's exactly why this route is gated and
// the next one is not.
connectRoutes.get('/admin/ngo/:ngoId/connect-link', requireOperator, async (c) => {
  const token = await signPayload('connect', c.req.param('ngoId'), c.env.TOKEN_KEY, new Date(), CONNECT_LINK_TTL_SECONDS)
  const url = `${c.env.PUBLIC_BASE_URL}/conectar?t=${encodeURIComponent(token)}`
  return c.html(
    <html lang="es"><body>
      <h1>Enlace de conexión</h1>
      <p>Enviale este enlace a la ONG para que conecte su cuenta de Mercado Pago. Vence en 24 horas.</p>
      <p><a href={url}>{url}</a></p>
    </body></html>,
  )
})

// Public: the NGO reaches this from the link above, with no login of its
// own. Its only credential is the capability token in `t` — verified before
// anything else, and the ngo id used past this point comes only from that
// verified payload, never from a client-controlled id in the URL.
connectRoutes.get('/conectar', async (c) => {
  const token = c.req.query('t')
  if (!token) return c.text('Falta el enlace de conexión.', 400)

  const ngoId = await verifyPayload(token, c.env.TOKEN_KEY, new Date(), 'connect')
  if (!ngoId) return c.text('El enlace de conexión es inválido o expiró. Pedí uno nuevo.', 400)

  const state = await signPayload('oauth-state', ngoId, c.env.TOKEN_KEY, new Date(), OAUTH_STATE_TTL_SECONDS)
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

  const ngoId = await verifyPayload(state, c.env.TOKEN_KEY, new Date(), 'oauth-state')
  if (!ngoId) return c.text('El enlace de conexión es inválido o expiró. Pedí uno nuevo.', 400)

  const tokens = await exchangeCode({
    clientId: c.env.MP_CLIENT_ID,
    clientSecret: c.env.MP_CLIENT_SECRET,
    code,
    redirectUri: `${c.env.PUBLIC_BASE_URL}/oauth/callback`,
    testToken: c.env.MP_TEST_MODE === 'true',
  })

  const { rowsChanged } = await saveNgoTokens(db(c.env.DB), {
    ngoId,
    accessTokenEnc: await encryptToken(tokens.accessToken, c.env.TOKEN_KEY),
    refreshTokenEnc: await encryptToken(tokens.refreshToken, c.env.TOKEN_KEY),
    tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
    mpUserId: tokens.mpUserId,
  })

  // The connect-link token verified above only proves the ngoId was one we
  // signed — it does not prove a row with that id still exists. If it
  // doesn't, saveNgoTokens updated zero rows: real MP tokens were just
  // granted to us and would otherwise be silently discarded while this
  // page claims success. That must never read as "Cuenta conectada".
  if (rowsChanged === 0) {
    return c.html(
      <html lang="es"><body>
        <h1>No se pudo completar la conexión</h1>
        <p>
          La organización no existe en la plataforma. Pedile a la persona operadora que la cree
          antes de generar un nuevo enlace de conexión.
        </p>
      </body></html>,
      500,
    )
  }

  return c.html(<html lang="es"><body><h1>Cuenta conectada</h1><p>Ya podés cerrar esta ventana.</p></body></html>)
})
