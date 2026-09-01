import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { isValidOperatorSecret, requireOperator, mintOperatorSessionToken, OPERATOR_SESSION_COOKIE } from './auth'
import { signPayload } from '../mp/oauth'
import { generateKeyBase64 } from '../credentials/crypto'
import type { Env } from '../env'

describe('isValidOperatorSecret', () => {
  it('accepts an exact match', () => {
    expect(isValidOperatorSecret('s3cret', 's3cret')).toBe(true)
  })
  it('rejects a mismatch', () => {
    expect(isValidOperatorSecret('wrong', 's3cret')).toBe(false)
  })
  it('rejects when no secret is configured, rather than allowing all', () => {
    expect(isValidOperatorSecret('anything', undefined)).toBe(false)
  })
  it('rejects an empty provided secret', () => {
    expect(isValidOperatorSecret('', 's3cret')).toBe(false)
  })
  it('takes the same time for equal-length wrong secrets', () => {
    expect(isValidOperatorSecret('aaaaaa', 's3cret')).toBe(false)
  })
})

describe('requireOperator', () => {
  async function buildEnv(): Promise<Env> {
    return {
      DB: {} as D1Database,
      OPERATOR_SECRET: 's3cret',
      MP_CLIENT_ID: 'cid',
      MP_CLIENT_SECRET: 'csecret',
      TOKEN_KEY: await generateKeyBase64(),
      PUBLIC_BASE_URL: 'https://app.test',
    }
  }

  function buildApp() {
    const app = new Hono<{ Bindings: Env }>()
    app.use('/admin/*', requireOperator)
    app.get('/admin/login', (c) => c.text('login form'))
    app.get('/admin/secret', (c) => c.text('secret ok'))
    app.post('/admin/secret', (c) => c.text('posted ok'))
    return app
  }

  it('exempts the login route itself, with no credential at all', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/login', {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('login form')
  })

  it('accepts a valid Bearer secret', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/secret', {
      headers: { authorization: 'Bearer s3cret' },
    }, env)
    expect(res.status).toBe(200)
  })

  it('rejects an invalid Bearer secret with a bare 401, even when the request looks like a browser GET', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/secret', {
      headers: { authorization: 'Bearer wrong', accept: 'text/html' },
      redirect: 'manual',
    }, env)
    expect(res.status).toBe(401)
  })

  it('accepts a valid operator-session cookie', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const token = await mintOperatorSessionToken(env.TOKEN_KEY)
    const res = await app.request('/admin/secret', {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    }, env)
    expect(res.status).toBe(200)
  })

  it('rejects a tampered cookie', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const token = await mintOperatorSessionToken(env.TOKEN_KEY)
    const [payload, sig] = token.split('.')
    const tampered = `${payload}x.${sig}`
    const res = await app.request('/admin/secret', {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${tampered}`, accept: 'application/json' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('rejects an expired cookie', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000)
    const token = await mintOperatorSessionToken(env.TOKEN_KEY, nineHoursAgo)
    const res = await app.request('/admin/secret', {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}`, accept: 'application/json' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('rejects a cross-purpose token (a connect-link capability) presented as a session cookie', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const connectToken = await signPayload('connect', 'operator', env.TOKEN_KEY, new Date(), 24 * 60 * 60)
    const res = await app.request('/admin/secret', {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${connectToken}`, accept: 'application/json' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('rejects a cross-purpose token (an oauth-state) presented as a session cookie', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const stateToken = await signPayload('oauth-state', 'operator', env.TOKEN_KEY, new Date(), 10 * 60)
    const res = await app.request('/admin/secret', {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${stateToken}`, accept: 'application/json' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('redirects a credential-less browser GET to the login page', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/secret', {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    }, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/login')
  })

  it('returns a bare 401 (not a redirect) for a credential-less non-browser request', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/secret', {
      headers: { accept: 'application/json' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns a bare 401 for a credential-less POST, so a submitted form is never silently redirected away', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/secret', {
      method: 'POST',
      headers: { accept: 'text/html' },
    }, env)
    expect(res.status).toBe(401)
  })

  it('rejects when no credential of any kind is present (no Accept header -> the non-browser branch)', async () => {
    const app = buildApp()
    const env = await buildEnv()
    const res = await app.request('/admin/secret', {}, env)
    expect(res.status).toBe(401)
  })
})
