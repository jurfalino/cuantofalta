import type { MiddlewareHandler } from 'hono'
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

export const requireOperator: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!isValidOperatorSecret(provided, c.env.OPERATOR_SECRET)) {
    return c.text('No autorizado', 401)
  }
  await next()
}
