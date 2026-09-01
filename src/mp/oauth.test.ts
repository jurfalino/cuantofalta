import { describe, it, expect } from 'vitest'
import { buildAuthorizeUrl, parseTokenResponse, signState, verifyState } from './oauth'
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
})

describe('signState / verifyState', () => {
  const now = new Date('2026-09-01T12:00:00Z')

  it('round-trips: verifying a freshly signed state returns the ngoId', async () => {
    const key = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    expect(await verifyState(state, key, now)).toBe('ngo-1')
  })

  it('produces a different state each time (fresh nonce)', async () => {
    const key = await generateKeyBase64()
    const a = await signState('ngo-1', key, now)
    const b = await signState('ngo-1', key, now)
    expect(a).not.toBe(b)
  })

  it('rejects a tampered payload', async () => {
    const key = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    const [payload, sig] = state.split('.')
    expect(await verifyState(`${payload}x.${sig}`, key, now)).toBeNull()
  })

  it('rejects a tampered signature', async () => {
    const key = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    const [payload, sig] = state.split('.')
    const flipped = sig[0] === 'a' ? 'b' : 'a'
    expect(await verifyState(`${payload}.${flipped}${sig.slice(1)}`, key, now)).toBeNull()
  })

  it('rejects verification with the wrong key', async () => {
    const key = await generateKeyBase64()
    const otherKey = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    expect(await verifyState(state, otherKey, now)).toBeNull()
  })

  it('rejects an expired state', async () => {
    const key = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    const elevenMinutesLater = new Date(now.getTime() + 11 * 60 * 1000)
    expect(await verifyState(state, key, elevenMinutesLater)).toBeNull()
  })

  it('accepts a state right up to (but not past) its expiry', async () => {
    const key = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    const oneSecondBeforeExpiry = new Date(now.getTime() + 599 * 1000)
    const atExpiry = new Date(now.getTime() + 600 * 1000)
    expect(await verifyState(state, key, oneSecondBeforeExpiry)).toBe('ngo-1')
    expect(await verifyState(state, key, atExpiry)).toBeNull()
  })

  it('returns null rather than throwing on malformed input', async () => {
    const key = await generateKeyBase64()
    expect(await verifyState('not-a-valid-state', key, now)).toBeNull()
  })

  it('returns null on empty input', async () => {
    const key = await generateKeyBase64()
    expect(await verifyState('', key, now)).toBeNull()
  })

  it('returns null on input missing the dot separator', async () => {
    const key = await generateKeyBase64()
    expect(await verifyState('nodothere', key, now)).toBeNull()
  })

  it('returns null on input with extra dots', async () => {
    const key = await generateKeyBase64()
    const state = await signState('ngo-1', key, now)
    expect(await verifyState(`${state}.extra`, key, now)).toBeNull()
  })
})
