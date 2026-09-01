export interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  mpUserId: string
}

const AUTH_URL = 'https://auth.mercadopago.com/authorization'
const TOKEN_URL = 'https://api.mercadopago.com/oauth/token'

export function buildAuthorizeUrl(input: {
  clientId: string; redirectUri: string; state: string
}): string {
  const u = new URL(AUTH_URL)
  u.searchParams.set('client_id', input.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('platform_id', 'mp')
  u.searchParams.set('redirect_uri', input.redirectUri)
  u.searchParams.set('state', input.state)
  return u.toString()
}

export function parseTokenResponse(payload: Record<string, any>): TokenSet {
  if (!payload.access_token) {
    throw new Error(`MP OAuth error: ${payload.error ?? 'no access_token in response'}`)
  }
  if (!payload.refresh_token) {
    throw new Error(`MP OAuth error: ${payload.error ?? 'no refresh_token in response'}`)
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresInSeconds: Number(payload.expires_in),
    mpUserId: String(payload.user_id),
  }
}

async function postToken(body: Record<string, string | boolean>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseTokenResponse(await res.json())
}

export async function exchangeCode(input: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; testToken?: boolean
}): Promise<TokenSet> {
  return postToken({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    test_token: input.testToken ?? false,
  })
}

export async function refreshAccessToken(input: {
  clientId: string; clientSecret: string; refreshToken: string
}): Promise<TokenSet> {
  return postToken({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  })
}

// --- Signed, purpose-scoped payloads ---
//
// Two different values in this flow round-trip through an outside party
// before coming back to us — the connect link we hand the NGO, and the
// `state` parameter that bounces through Mercado Pago — so neither can be
// trusted as-is. Signing closes *tampering*: only a payload we minted,
// unmodified, will verify. It does not by itself close *misuse*: without a
// `purpose` field, a 24-hour connect-link capability could be replayed
// straight into the OAuth callback as if it were a 10-minute state (or vice
// versa). `signPayload`/`verifyPayload` are one HMAC-SHA256 (over TOKEN_KEY)
// primitive shared by both call sites; `verifyPayload` only returns the
// ngoId when the signature checks out, the payload is unexpired, AND its
// `purpose` matches what the caller expects.

export const CONNECT_LINK_TTL_SECONDS = 24 * 60 * 60
export const OAUTH_STATE_TTL_SECONDS = 10 * 60

export type SignedPurpose = 'connect' | 'oauth-state'

interface SignedPayload {
  purpose: SignedPurpose
  ngoId: string
  nonce: string
  exp: number
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text))
}

function base64UrlToText(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s))
}

async function importHmacKey(keyBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keyBase64), (ch) => ch.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signPayload(
  purpose: SignedPurpose, ngoId: string, key: string, now: Date, ttlSeconds: number,
): Promise<string> {
  const payload: SignedPayload = {
    purpose,
    ngoId,
    nonce: crypto.randomUUID(),
    exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
  }
  const payloadB64 = textToBase64Url(JSON.stringify(payload))
  const hmacKey = await importHmacKey(key)
  const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export async function verifyPayload(
  token: string, key: string, now: Date, expectedPurpose: SignedPurpose,
): Promise<string | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payloadB64, sigB64] = parts
    if (!payloadB64 || !sigB64) return null

    const hmacKey = await importHmacKey(key)
    const signatureValid = await crypto.subtle.verify(
      'HMAC',
      hmacKey,
      base64UrlToBytes(sigB64),
      new TextEncoder().encode(payloadB64),
    )
    if (!signatureValid) return null

    const payload = JSON.parse(base64UrlToText(payloadB64)) as Partial<SignedPayload>
    if (typeof payload.ngoId !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.purpose !== expectedPurpose) return null
    if (Math.floor(now.getTime() / 1000) >= payload.exp) return null

    return payload.ngoId
  } catch {
    return null
  }
}
