import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { signPayload, verifyPayload, OPERATOR_SESSION_TTL_SECONDS } from '../mp/oauth'
import type { Env } from '../env'

export function isValidOperatorSecret(provided: string, expected: string | undefined): boolean {
  if (!expected || !provided) return false
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

export const OPERATOR_SESSION_COOKIE = 'operator_session'
export const OPERATOR_SESSION_SUBJECT = 'operator'

// The login form itself must be reachable with no credential at all — see
// the exemption in requireOperator below. Everything else under /admin/*
// stays gated.
const LOGIN_PATH = '/admin/login'

export async function mintOperatorSessionToken(tokenKey: string, now = new Date()): Promise<string> {
  return signPayload('operator-session', OPERATOR_SESSION_SUBJECT, tokenKey, now, OPERATOR_SESSION_TTL_SECONDS)
}

export function setOperatorSessionCookie(c: Context<{ Bindings: Env }>, token: string): void {
  setCookie(c, OPERATOR_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: OPERATOR_SESSION_TTL_SECONDS,
  })
}

// Two credentials are accepted, independently:
//
//  - `Authorization: Bearer <secret>` — for scripts/curl. If this header is
//    present at all, it is the ONLY thing we check: a present-but-wrong
//    header always 401s, even if a valid session cookie also happens to be
//    present. This keeps `curl -H "Authorization: Bearer wrong" ...`
//    unambiguous — a caller that only checks the HTTP status must never see
//    anything but 401 for a bad Bearer credential, never a 302 that a
//    naive `curl -L` would silently follow into a 200 login page.
//  - A signed, purpose-scoped `operator-session` cookie — for the browser,
//    since the admin UI is HTML forms and a browser cannot set an
//    Authorization header itself.
//
// A GET/HEAD request that fails both (and is not the login route itself)
// is redirected to the login page, since that's a human in a browser. Any
// other failing request (a form POST with an expired session, or any
// request with no Accept: text/html) gets a bare 401 instead — friendlier
// to redirect a page view, but a redirect on a POST would silently drop
// the submitted data, and a redirect on a non-browser caller would just be
// noise.
export const requireOperator: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.path === LOGIN_PATH) return next()

  const header = c.req.header('authorization') ?? ''
  if (header) {
    const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (isValidOperatorSecret(provided, c.env.OPERATOR_SECRET)) return next()
    return c.text('No autorizado', 401)
  }

  const cookie = getCookie(c, OPERATOR_SESSION_COOKIE)
  if (cookie) {
    const subject = await verifyPayload(cookie, c.env.TOKEN_KEY, new Date(), 'operator-session')
    if (subject === OPERATOR_SESSION_SUBJECT) return next()
  }

  const method = c.req.method
  const accepts = c.req.header('accept') ?? ''
  if ((method === 'GET' || method === 'HEAD') && accepts.includes('text/html')) {
    return c.redirect(LOGIN_PATH)
  }
  return c.text('No autorizado', 401)
}
