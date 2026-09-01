import { describe, it, expect } from 'vitest'
import {
  buildAuthorizeUrl, parseTokenResponse, signPayload, verifyPayload,
  CONNECT_LINK_TTL_SECONDS, OAUTH_STATE_TTL_SECONDS,
} from './oauth'
import { generateKeyBase64 } from '../credentials/crypto'

describe('buildAuthorizeUrl', () => {
  it('includes client id, redirect uri and state', () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: 'abc', redirectUri: 'https://app.test/oauth/callback', state: 'xyz',
    }))
    expect(url.searchParams.get('client_id')).toBe('abc')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('platform_id')).toBe('mp')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/oauth/callback')
    expect(url.searchParams.get('state')).toBe('xyz')
  })
})

describe('parseTokenResponse', () => {
  it('maps the MP payload to a TokenSet', () => {
    const t = parseTokenResponse({
      access_token: 'APP_USR-1', refresh_token: 'TG-1',
      expires_in: 15552000, user_id: 4321,
    })
    expect(t.accessToken).toBe('APP_USR-1')
    expect(t.refreshToken).toBe('TG-1')
    expect(t.expiresInSeconds).toBe(15552000)
    expect(t.mpUserId).toBe('4321')
  })

  it('throws when the payload has no access token', () => {
    expect(() => parseTokenResponse({ error: 'invalid_grant' })).toThrow()
  })

  it('throws when the payload has no refresh token', () => {
    expect(() => parseTokenResponse({ access_token: 'APP_USR-1', expires_in: 100, user_id: 1 })).toThrow()
  })
})

describe('signPayload / verifyPayload', () => {
  const now = new Date('2026-09-01T12:00:00Z')

  it('round-trips: verifying a freshly signed payload returns the ngoId', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    expect(await verifyPayload(token, key, now, 'oauth-state')).toBe('ngo-1')
  })

  it('round-trips a connect-link capability with its own TTL', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('connect', 'ngo-1', key, now, CONNECT_LINK_TTL_SECONDS)
    expect(await verifyPayload(token, key, now, 'connect')).toBe('ngo-1')
  })

  it('produces a different token each time (fresh nonce)', async () => {
    const key = await generateKeyBase64()
    const a = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    const b = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    expect(a).not.toBe(b)
  })

  it('rejects a token signed for one purpose when verified against another', async () => {
    const key = await generateKeyBase64()
    const connectToken = await signPayload('connect', 'ngo-1', key, now, CONNECT_LINK_TTL_SECONDS)
    expect(await verifyPayload(connectToken, key, now, 'oauth-state')).toBeNull()

    const stateToken = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    expect(await verifyPayload(stateToken, key, now, 'connect')).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    const [payload, sig] = token.split('.')
    expect(await verifyPayload(`${payload}x.${sig}`, key, now, 'oauth-state')).toBeNull()
  })

  it('rejects a tampered signature', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    const [payload, sig] = token.split('.')
    const flipped = sig[0] === 'a' ? 'b' : 'a'
    expect(await verifyPayload(`${payload}.${flipped}${sig.slice(1)}`, key, now, 'oauth-state')).toBeNull()
  })

  it('rejects verification with the wrong key', async () => {
    const key = await generateKeyBase64()
    const otherKey = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    expect(await verifyPayload(token, otherKey, now, 'oauth-state')).toBeNull()
  })

  it('rejects an expired oauth-state token', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    const elevenMinutesLater = new Date(now.getTime() + 11 * 60 * 1000)
    expect(await verifyPayload(token, key, elevenMinutesLater, 'oauth-state')).toBeNull()
  })

  it('rejects an expired connect-link capability', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('connect', 'ngo-1', key, now, CONNECT_LINK_TTL_SECONDS)
    const twentyFiveHoursLater = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    expect(await verifyPayload(token, key, twentyFiveHoursLater, 'connect')).toBeNull()
  })

  it('accepts a token right up to (but not past) its expiry', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    const oneSecondBeforeExpiry = new Date(now.getTime() + 599 * 1000)
    const atExpiry = new Date(now.getTime() + 600 * 1000)
    expect(await verifyPayload(token, key, oneSecondBeforeExpiry, 'oauth-state')).toBe('ngo-1')
    expect(await verifyPayload(token, key, atExpiry, 'oauth-state')).toBeNull()
  })

  it('returns null rather than throwing on malformed input', async () => {
    const key = await generateKeyBase64()
    expect(await verifyPayload('not-a-valid-token', key, now, 'oauth-state')).toBeNull()
  })

  it('returns null on empty input', async () => {
    const key = await generateKeyBase64()
    expect(await verifyPayload('', key, now, 'oauth-state')).toBeNull()
  })

  it('returns null on input missing the dot separator', async () => {
    const key = await generateKeyBase64()
    expect(await verifyPayload('nodothere', key, now, 'oauth-state')).toBeNull()
  })

  it('returns null on input with extra dots', async () => {
    const key = await generateKeyBase64()
    const token = await signPayload('oauth-state', 'ngo-1', key, now, OAUTH_STATE_TTL_SECONDS)
    expect(await verifyPayload(`${token}.extra`, key, now, 'oauth-state')).toBeNull()
  })
})
