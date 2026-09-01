import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { adminRoutes } from './routes'
import { mintOperatorSessionToken, OPERATOR_SESSION_COOKIE } from './auth'
import { createTestD1 } from '../db/testDb'
import { db, createNgo, createGoal, markNgoDisconnected } from '../db/queries'
import { generateKeyBase64 } from '../credentials/crypto'
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

function buildApp() {
  const app = new Hono<{ Bindings: Env }>()
  app.route('/', adminRoutes)
  return app
}

async function authHeaders(env: Env): Promise<Record<string, string>> {
  const token = await mintOperatorSessionToken(env.TOKEN_KEY)
  return { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` }
}

describe('POST /admin/ngo', () => {
  it('creates an ngo and redirects to the list', async () => {
    const tokenKey = await generateKeyBase64()
    const env = await buildEnv(createTestD1(), tokenKey)
    const app = buildApp()
    const form = new URLSearchParams({ name: 'Refugio', slug: 'refugio' })
    const res = await app.request('/admin/ngo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(await authHeaders(env)) },
      body: form.toString(),
    }, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/ngo')
  })

  it('rejects a blank name with a 400 rather than creating a row', async () => {
    const tokenKey = await generateKeyBase64()
    const env = await buildEnv(createTestD1(), tokenKey)
    const app = buildApp()
    const form = new URLSearchParams({ name: '  ', slug: 'refugio' })
    const res = await app.request('/admin/ngo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(await authHeaders(env)) },
      body: form.toString(),
    }, env)
    expect(res.status).toBe(400)
  })

  it('rejects a duplicate slug with a Spanish message, not a raw 500', async () => {
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    await createNgo(db(testDb), { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    const env = await buildEnv(testDb, tokenKey)
    const app = buildApp()
    const form = new URLSearchParams({ name: 'Otro Refugio', slug: 'refugio' })
    const res = await app.request('/admin/ngo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(await authHeaders(env)) },
      body: form.toString(),
    }, env)
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(text).toMatch(/organización|slug/i)
  })

  it('is gated by requireOperator (no credential -> not created)', async () => {
    const tokenKey = await generateKeyBase64()
    const env = await buildEnv(createTestD1(), tokenKey)
    const app = buildApp()
    const form = new URLSearchParams({ name: 'Refugio', slug: 'refugio' })
    const res = await app.request('/admin/ngo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, env)
    expect(res.status).toBe(401)
  })
})

describe('GET /admin/ngo', () => {
  it('lists created ngos', async () => {
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    await createNgo(db(testDb), { id: 'ngo-1', name: 'Refugio La Esperanza', slug: 'la-esperanza' })
    const env = await buildEnv(testDb, tokenKey)
    const app = buildApp()
    const res = await app.request('/admin/ngo', { headers: await authHeaders(env) }, env)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('Refugio La Esperanza')
    expect(text).toContain('/admin/ngo/ngo-1')
  })
})

describe('GET /admin/ngo/:ngoId reconnect banner', () => {
  it('shows a Spanish reconnect banner when the ngo is disconnected', async () => {
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    const d = db(testDb)
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    await markNgoDisconnected(d, 'ngo-1')
    const env = await buildEnv(testDb, tokenKey)
    const app = buildApp()
    const res = await app.request('/admin/ngo/ngo-1', { headers: await authHeaders(env) }, env)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('desconectada')
    expect(text).toContain('/admin/ngo/ngo-1/connect-link')
  })

  it('shows no banner for a connected ngo', async () => {
    const tokenKey = await generateKeyBase64()
    const testDb = createTestD1()
    const d = db(testDb)
    await createNgo(d, { id: 'ngo-1', name: 'Refugio', slug: 'refugio' })
    await createGoal(d, { id: 'goal-1', ngoId: 'ngo-1', title: 'Techo', description: '', targetAmountCents: 100_000 })
    const env = await buildEnv(testDb, tokenKey)
    const app = buildApp()
    const res = await app.request('/admin/ngo/ngo-1', { headers: await authHeaders(env) }, env)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('desconectada')
  })

  it('404s in Spanish for an unknown ngo id, rather than rendering an empty goal list', async () => {
    const tokenKey = await generateKeyBase64()
    const env = await buildEnv(createTestD1(), tokenKey)
    const app = buildApp()
    const res = await app.request('/admin/ngo/does-not-exist', { headers: await authHeaders(env) }, env)
    expect(res.status).toBe(404)
  })
})
