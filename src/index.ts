import { Hono } from 'hono'
import { publicRoutes } from './public/routes'
import { adminRoutes } from './admin/routes'
import type { Env } from './env'

export type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()
app.route('/', publicRoutes)
app.route('/', adminRoutes)
app.get('/', (c) => c.text('Cuánto Falta'))

export default app
