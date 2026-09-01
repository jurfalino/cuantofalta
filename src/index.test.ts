import { describe, it, expect, vi, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { app } from './index'
import { createTestD1 } from './db/testDb'
import { db, createNgo, createGoal } from './db/queries'
import { signPayload } from './mp/oauth'
import { generateKeyBase64 } from './credentials/crypto'
import type { Env } from './env'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function buildEnv(dbInstance: D1Database, tokenKey: string): Promise<Env> {
  return {
    DB: dbInstance,
    OPERATOR_SECRET: 's3cret',
    MP_CLIENT_ID: 'cid',
    MP_CLIENT_SECRET: 'csecret',
    TOKEN_KEY: tokenKey,
    PUBLIC_BASE_URL: 'https://app.test',
  }
}

// Finding 14: unhandled throws in donor-/NGO-facing paths must render the
// same Spanish copy as the rest of the app, not Hono's bare default error
// text, and must never leak error details.
describe('app.onError', () => {
  it('renders a Spanish error page (not Hono\'s default) when decryptToken throws in the donate flow', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    const d = db(testDb)
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    // Save a corrupt ciphertext directly, bypassing saveNgoTokens's normal
    // encrypt step, so decryptToken throws (bad AES-GCM tag) exactly like
    // a rotated TOKEN_KEY or a corrupted row would.
    await d.run(sql`update ngo set access_token_enc = 'not-valid-ciphertext', status = 'connected' where id = 'ngo-1'`)
    await createGoal(d, { id: 'goal-1', ngoId: 'ngo-1', title: 'Techo', description: '', targetAmountCents: 100_000 })

    const env = await buildEnv(testDb, tokenKey)
    const res = await app.request('/g/goal-1/donar?monto=100', {}, env)
    const text = await res.text()

    expect(res.status).toBe(500)
    expect(text).toContain('Ocurrió un error')
    expect(text).not.toContain('Internal Server Error')
    // Never leaks the raw error message/ciphertext into the response.
    expect(text).not.toContain('not-valid-ciphertext')
  })

  it('renders the same Spanish error page when exchangeCode throws in the OAuth callback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    await createNgo(db(testDb), { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    const env = await buildEnv(testDb, tokenKey)
    const state = await signPayload('oauth-state', 'ngo-1', tokenKey, new Date(), 600)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })))

    const res = await app.request(`/oauth/callback?code=bad&state=${encodeURIComponent(state)}`, {}, env)
    const text = await res.text()

    expect(res.status).toBe(500)
    expect(text).toContain('Ocurrió un error')
    expect(text).not.toContain('Internal Server Error')
  })
})
