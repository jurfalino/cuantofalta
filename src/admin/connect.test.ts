import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { connectRoutes } from './connect'
import { signPayload } from '../mp/oauth'
import { generateKeyBase64 } from '../credentials/crypto'
import { createTestD1 } from '../db/testDb'
import { db, createNgo } from '../db/queries'
import type { Env } from '../env'

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

function stubTokenExchange() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    access_token: 'APP_USR-1', refresh_token: 'TG-1', expires_in: 15552000, user_id: 123,
  }), { status: 200, headers: { 'content-type': 'application/json' } })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /oauth/callback', () => {
  it('never claims "Cuenta conectada" and reports an error when the ngo id in the state has no matching row', async () => {
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    const env = await buildEnv(testDb, tokenKey)
    // Deliberately no ngo row created — mirrors a bad/stale id reaching the callback.
    const state = await signPayload('oauth-state', 'ngo-does-not-exist', tokenKey, new Date(), 600)
    stubTokenExchange()

    const app = new Hono<{ Bindings: Env }>()
    app.route('/', connectRoutes)
    const res = await app.request(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, {}, env)
    const text = await res.text()

    expect(res.status).toBe(500)
    expect(text).not.toContain('Cuenta conectada')
    expect(text).toContain('No se pudo completar la conexión')
  })

  it('renders "Cuenta conectada" when the ngo row exists and tokens are actually saved', async () => {
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    await createNgo(db(testDb), { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    const env = await buildEnv(testDb, tokenKey)
    const state = await signPayload('oauth-state', 'ngo-1', tokenKey, new Date(), 600)
    stubTokenExchange()

    const app = new Hono<{ Bindings: Env }>()
    app.route('/', connectRoutes)
    const res = await app.request(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, {}, env)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain('Cuenta conectada')
  })
})
