# CuantoFalta POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that an animal-protection NGO can connect its own Mercado Pago account and have a donation appear, correctly attributed, on the right goal's public progress bar.

**Architecture:** A single Hono app on Cloudflare Workers serves the public goal pages, the operator admin, and the OAuth callback. Cloudflare D1 stores NGOs, goals and contributions. A Cron Trigger polls Mercado Pago's `payments/search` per connected NGO and upserts approved payments as contributions, attributed to goals via `external_reference`. Domain logic is pure and network-free; all Mercado Pago access sits behind one interface with a fake for tests.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1 (SQLite), Drizzle ORM, Vitest, Wrangler.

**Spec:** [docs/superpowers/specs/2026-08-31-donaciones-design.md](../specs/2026-08-31-donaciones-design.md)

## Global Constraints

- Project/package/worker name is `cuantofalta`. Display name is *Cuánto Falta*. (The containing folder is still `Donaciones`; that is cosmetic and does not affect the codebase.)
- All money is **integer centavos**. No floating-point arithmetic on amounts anywhere.
- Currency is **ARS** only.
- Only payments with status `approved` count toward a goal's raised total.
- `contribution.source` is `'platform' | 'manual'` on every row.
- `contribution.mp_payment_id` is UNIQUE and nullable — null for manual, set for platform. This is what makes ingestion idempotent.
- Domain logic (`src/goals/`) must not import Drizzle, Hono, or any Mercado Pago module. It operates on plain objects so it tests without a network or database.
- All Mercado Pago access goes through the `MercadoPagoClient` interface. No module outside `src/mp/` may call the MP API directly.
- Tasks 1–8 run entirely offline (`--local` D1, Vitest). Only Task 9 requires a Cloudflare account.

---

## File Structure

| File | Responsibility |
|---|---|
| `wrangler.toml` | Worker config, D1 binding, cron trigger |
| `src/index.ts` | Hono app; route mounting; scheduled handler |
| `src/db/schema.ts` | Drizzle table definitions |
| `src/db/queries.ts` | All SQL access; the only module importing Drizzle |
| `src/goals/progress.ts` | Pure progress calculation |
| `src/goals/types.ts` | Domain types shared across modules |
| `src/public/routes.ts` | Public goal pages |
| `src/public/views.tsx` | Progress bar and goal page markup |
| `src/admin/routes.ts` | Operator admin: goals, manual adjustments, connect links |
| `src/admin/auth.ts` | Operator shared-secret middleware |
| `src/credentials/crypto.ts` | AES-GCM encrypt/decrypt for NGO tokens |
| `src/mp/client.ts` | `MercadoPagoClient` interface + live implementation |
| `src/mp/fake.ts` | In-memory fake used by every test |
| `src/mp/oauth.ts` | Authorize URL, code exchange, refresh |
| `src/ingest/poller.ts` | Walk NGOs, fetch payments, upsert contributions |
| `.github/workflows/deploy.yml` | CI: typecheck, test, deploy |

---

### Task 1: Scaffold, schema, and a green test run

Folds in all project configuration — no reviewer would accept the schema but reject the Vitest config.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.toml`, `drizzle.config.ts`
- Create: `src/db/schema.ts`, `src/goals/types.ts`
- Create: `migrations/0000_init.sql`
- Test: `src/goals/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Goal`, `Contribution`, `Ngo`, `ContributionSource`, `PaymentStatus` types from `src/goals/types.ts`; D1 binding named `DB`

- [ ] **Step 1: Initialise the project**

```bash
npm init -y
npm install hono drizzle-orm
npm install -D typescript vitest wrangler drizzle-kit @cloudflare/workers-types
npm pkg set name=cuantofalta
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.dev="wrangler dev"
npm pkg set scripts.migrate:local="wrangler d1 migrations apply cuantofalta --local"
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 4: Write `wrangler.toml`**

```toml
name = "cuantofalta"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[d1_databases]]
binding = "DB"
database_name = "cuantofalta"
database_id = "local"

[triggers]
crons = ["*/2 * * * *"]
```

- [ ] **Step 5: Write the domain types**

`src/goals/types.ts`:

```ts
export type ContributionSource = 'platform' | 'manual'
export type PaymentStatus = 'approved' | 'pending' | 'rejected'

export interface Ngo {
  id: string
  name: string
  slug: string
  mpUserId: string | null
  status: 'pending' | 'connected' | 'disconnected'
}

export interface Goal {
  id: string
  ngoId: string
  title: string
  description: string
  targetAmountCents: number
  status: 'active' | 'closed'
}

export interface Contribution {
  id: string
  goalId: string
  source: ContributionSource
  mpPaymentId: string | null
  amountCents: number
  status: PaymentStatus
  paidAt: string
  note: string | null
}
```

- [ ] **Step 6: Write the migration**

`migrations/0000_init.sql`:

```sql
CREATE TABLE ngo (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  mp_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  connected_at TEXT
);

CREATE TABLE goal (
  id TEXT PRIMARY KEY,
  ngo_id TEXT NOT NULL REFERENCES ngo(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE contribution (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goal(id),
  source TEXT NOT NULL,
  mp_payment_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_goal_ngo ON goal(ngo_id);
CREATE INDEX idx_contribution_goal ON contribution(goal_id);
```

- [ ] **Step 7: Write the Drizzle schema**

`src/db/schema.ts`:

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const ngo = sqliteTable('ngo', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  mpUserId: text('mp_user_id'),
  status: text('status').notNull().default('pending'),
  accessTokenEnc: text('access_token_enc'),
  refreshTokenEnc: text('refresh_token_enc'),
  tokenExpiresAt: text('token_expires_at'),
  connectedAt: text('connected_at'),
})

export const goal = sqliteTable('goal', {
  id: text('id').primaryKey(),
  ngoId: text('ngo_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  targetAmountCents: integer('target_amount_cents').notNull(),
  currency: text('currency').notNull().default('ARS'),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
})

export const contribution = sqliteTable('contribution', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').notNull(),
  source: text('source').notNull(),
  mpPaymentId: text('mp_payment_id'),
  amountCents: integer('amount_cents').notNull(),
  status: text('status').notNull(),
  paidAt: text('paid_at').notNull(),
  note: text('note'),
  createdAt: text('created_at').notNull(),
})
```

- [ ] **Step 8: Write a test that proves the toolchain runs**

`src/goals/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Contribution } from './types'

describe('domain types', () => {
  it('models a manual contribution with no MP payment id', () => {
    const c: Contribution = {
      id: 'c1', goalId: 'g1', source: 'manual', mpPaymentId: null,
      amountCents: 500000, status: 'approved',
      paidAt: '2026-08-31T10:00:00Z', note: 'Transferencia por alias',
    }
    expect(c.mpPaymentId).toBeNull()
    expect(c.amountCents).toBe(500000)
  })
})
```

- [ ] **Step 9: Run the test and the migration**

```bash
npm test
npm run migrate:local
```

Expected: test PASSES; migration reports 1 migration applied to local D1.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: scaffold cuantofalta worker with D1 schema and vitest"
```

---

### Task 2: Progress calculation

The core domain rule. Pure, no I/O.

**Files:**
- Create: `src/goals/progress.ts`
- Test: `src/goals/progress.test.ts`

**Interfaces:**
- Consumes: `Goal`, `Contribution` from `src/goals/types.ts`
- Produces: `computeProgress(goal: Goal, contributions: Contribution[]): GoalProgress` and the `GoalProgress` interface

- [ ] **Step 1: Write the failing tests**

`src/goals/progress.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeProgress } from './progress'
import type { Goal, Contribution } from './types'

const goal: Goal = {
  id: 'g1', ngoId: 'n1', title: 'Castraciones', description: '',
  targetAmountCents: 1_000_000, status: 'active',
}

const contribution = (over: Partial<Contribution>): Contribution => ({
  id: 'c', goalId: 'g1', source: 'platform', mpPaymentId: 'p',
  amountCents: 100_000, status: 'approved', paidAt: '2026-08-31T10:00:00Z',
  note: null, ...over,
})

describe('computeProgress', () => {
  it('sums approved platform and manual contributions into the headline total', () => {
    const r = computeProgress(goal, [
      contribution({ id: 'c1', amountCents: 300_000 }),
      contribution({ id: 'c2', source: 'manual', mpPaymentId: null, amountCents: 200_000 }),
    ])
    expect(r.raisedCents).toBe(500_000)
    expect(r.verifiedCents).toBe(300_000)
    expect(r.manualCents).toBe(200_000)
  })

  it('excludes pending and rejected payments', () => {
    const r = computeProgress(goal, [
      contribution({ id: 'c1', amountCents: 100_000 }),
      contribution({ id: 'c2', amountCents: 900_000, status: 'pending' }),
      contribution({ id: 'c3', amountCents: 900_000, status: 'rejected' }),
    ])
    expect(r.raisedCents).toBe(100_000)
  })

  it('ignores contributions belonging to another goal', () => {
    const r = computeProgress(goal, [contribution({ id: 'c1', goalId: 'other' })])
    expect(r.raisedCents).toBe(0)
  })

  it('reports percent and reached', () => {
    const r = computeProgress(goal, [contribution({ amountCents: 1_000_000 })])
    expect(r.percent).toBe(100)
    expect(r.reached).toBe(true)
  })

  it('allows percent above 100 but reports it honestly', () => {
    const r = computeProgress(goal, [contribution({ amountCents: 1_500_000 })])
    expect(r.percent).toBe(150)
    expect(r.reached).toBe(true)
  })

  it('returns zero percent for a zero target rather than dividing by zero', () => {
    const r = computeProgress({ ...goal, targetAmountCents: 0 }, [contribution({})])
    expect(r.percent).toBe(0)
    expect(Number.isFinite(r.percent)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/goals/progress.test.ts`
Expected: FAIL — cannot resolve `./progress`.

- [ ] **Step 3: Implement**

`src/goals/progress.ts`:

```ts
import type { Goal, Contribution } from './types'

export interface GoalProgress {
  goalId: string
  targetCents: number
  raisedCents: number
  verifiedCents: number
  manualCents: number
  percent: number
  reached: boolean
}

export function computeProgress(goal: Goal, contributions: Contribution[]): GoalProgress {
  const counted = contributions.filter(
    (c) => c.goalId === goal.id && c.status === 'approved',
  )
  const sum = (src: Contribution['source']) =>
    counted.filter((c) => c.source === src).reduce((t, c) => t + c.amountCents, 0)

  const verifiedCents = sum('platform')
  const manualCents = sum('manual')
  const raisedCents = verifiedCents + manualCents

  const percent =
    goal.targetAmountCents > 0
      ? Math.round((raisedCents / goal.targetAmountCents) * 100)
      : 0

  return {
    goalId: goal.id,
    targetCents: goal.targetAmountCents,
    raisedCents,
    verifiedCents,
    manualCents,
    percent,
    reached: goal.targetAmountCents > 0 && raisedCents >= goal.targetAmountCents,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/goals/progress.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/goals/
git commit -m "feat: compute goal progress from approved contributions"
```

---

### Task 3: Public goal page with progress bar

First demoable deliverable. Runs on local D1 with seeded rows — no Mercado Pago.

**Files:**
- Create: `src/db/queries.ts`, `src/public/views.tsx`, `src/public/routes.tsx`, `src/index.ts`
- Create: `migrations/0001_seed_dev.sql`
- Test: `src/public/views.test.ts`

**Interfaces:**
- Consumes: `computeProgress`, `GoalProgress`
- Produces: from `src/db/queries.ts` — `db(d1)`, `Db`, `getGoalById(d, id)`, `listContributions(d, goalId)`, `listGoalsByNgo(d, ngoId)`, `listConnectedNgos(d)`; from `src/public/views.tsx` — `formatArs(cents)`, `barWidthPercent(percent)`, `ProgressBar({ progress })`, `GoalPage({ goal, progress })`

- [ ] **Step 1: Write the failing test**

`src/public/views.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatArs, barWidthPercent } from './views'

describe('formatArs', () => {
  it('formats centavos as pesos with thousands separators', () => {
    expect(formatArs(1_234_500)).toBe('$12.345')
  })
  it('formats zero', () => {
    expect(formatArs(0)).toBe('$0')
  })
})

describe('barWidthPercent', () => {
  it('clamps display width at 100 even when the goal is exceeded', () => {
    expect(barWidthPercent(150)).toBe(100)
  })
  it('passes through partial progress', () => {
    expect(barWidthPercent(42)).toBe(42)
  })
  it('floors negatives at zero', () => {
    expect(barWidthPercent(-5)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/public/views.test.ts`
Expected: FAIL — cannot resolve `./views`.

- [ ] **Step 3: Implement the view helpers and markup**

`src/public/views.tsx`:

```tsx
import type { Goal } from '../goals/types'
import type { GoalProgress } from '../goals/progress'

export function formatArs(cents: number): string {
  const pesos = Math.round(cents / 100)
  return '$' + pesos.toLocaleString('es-AR')
}

export function barWidthPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent))
}

export function ProgressBar({ progress }: { progress: GoalProgress }) {
  return (
    <div class="bar" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
      <div class="bar-fill" style={`width:${barWidthPercent(progress.percent)}%`} />
    </div>
  )
}

export function GoalPage({ goal, progress }: { goal: Goal; progress: GoalProgress }) {
  return (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{goal.title} — Cuánto Falta</title>
        <style>{`
          body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
          .bar{background:#eee;border-radius:999px;height:1.25rem;overflow:hidden}
          .bar-fill{background:#2f9e44;height:100%}
          .totals{display:flex;justify-content:space-between;margin-top:.5rem;font-size:.9rem}
          .detail{color:#666;font-size:.8rem;margin-top:.25rem}
        `}</style>
      </head>
      <body>
        <h1>{goal.title}</h1>
        <p>{goal.description}</p>
        <ProgressBar progress={progress} />
        <div class="totals">
          <strong>{formatArs(progress.raisedCents)}</strong>
          <span>de {formatArs(progress.targetCents)} ({progress.percent}%)</span>
        </div>
        <p class="detail">
          Incluye {formatArs(progress.verifiedCents)} recibidos por la plataforma
          y {formatArs(progress.manualCents)} registrados por la organización.
        </p>
        <form method="get" action={`/g/${goal.id}/donar`}>
          <label>Monto (pesos): <input type="number" name="monto" min="100" required /></label>
          <button type="submit">Donar</button>
        </form>
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/public/views.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the queries module**

`src/db/queries.ts`:

```ts
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import * as s from './schema'
import type { Goal, Contribution, Ngo } from '../goals/types'

export const db = (d1: D1Database) => drizzle(d1, { schema: s })
export type Db = ReturnType<typeof db>

export async function getGoalById(d: Db, id: string): Promise<Goal | null> {
  const rows = await d.select().from(s.goal).where(eq(s.goal.id, id)).limit(1)
  const r = rows[0]
  return r ? {
    id: r.id, ngoId: r.ngoId, title: r.title, description: r.description,
    targetAmountCents: r.targetAmountCents, status: r.status as Goal['status'],
  } : null
}

export async function listContributions(d: Db, goalId: string): Promise<Contribution[]> {
  const rows = await d.select().from(s.contribution).where(eq(s.contribution.goalId, goalId))
  return rows.map((r) => ({
    id: r.id, goalId: r.goalId, source: r.source as Contribution['source'],
    mpPaymentId: r.mpPaymentId, amountCents: r.amountCents,
    status: r.status as Contribution['status'], paidAt: r.paidAt, note: r.note,
  }))
}

export async function listGoalsByNgo(d: Db, ngoId: string): Promise<Goal[]> {
  const rows = await d.select().from(s.goal).where(eq(s.goal.ngoId, ngoId))
  return rows.map((r) => ({
    id: r.id, ngoId: r.ngoId, title: r.title, description: r.description,
    targetAmountCents: r.targetAmountCents, status: r.status as Goal['status'],
  }))
}

export async function listConnectedNgos(d: Db): Promise<Ngo[]> {
  const rows = await d.select().from(s.ngo).where(eq(s.ngo.status, 'connected'))
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug,
    mpUserId: r.mpUserId, status: r.status as Ngo['status'],
  }))
}
```

- [ ] **Step 6: Write the public route and app entry**

`src/public/routes.tsx` (`.tsx`, because it returns JSX):

```tsx
import { Hono } from 'hono'
import { db, getGoalById, listContributions } from '../db/queries'
import { computeProgress } from '../goals/progress'
import { GoalPage } from './views'

export const publicRoutes = new Hono<{ Bindings: Env }>()

publicRoutes.get('/g/:id', async (c) => {
  const d = db(c.env.DB)
  const goal = await getGoalById(d, c.req.param('id'))
  if (!goal) return c.notFound()
  const progress = computeProgress(goal, await listContributions(d, goal.id))
  return c.html(<GoalPage goal={goal} progress={progress} />)
})
```

`src/index.ts`:

```ts
import { Hono } from 'hono'
import { publicRoutes } from './public/routes'

export interface Env {
  DB: D1Database
  OPERATOR_SECRET: string
  MP_CLIENT_ID: string
  MP_CLIENT_SECRET: string
  TOKEN_KEY: string
  PUBLIC_BASE_URL: string
}

const app = new Hono<{ Bindings: Env }>()
app.route('/', publicRoutes)
app.get('/', (c) => c.text('Cuánto Falta'))

export default app
```

- [ ] **Step 7: Seed dev data and view the page**

`migrations/0001_seed_dev.sql`:

```sql
INSERT INTO ngo (id, name, slug, status) VALUES ('n1', 'Refugio Patitas', 'patitas', 'pending');
INSERT INTO goal (id, ngo_id, title, description, target_amount_cents, created_at)
  VALUES ('g1', 'n1', 'Campaña de castración', 'Castrar 50 gatos comunitarios.', 100000000, '2026-08-31T00:00:00Z');
INSERT INTO contribution (id, goal_id, source, mp_payment_id, amount_cents, status, paid_at, note, created_at)
  VALUES ('c1', 'g1', 'manual', NULL, 25000000, 'approved', '2026-08-31T00:00:00Z', 'Transferencias por alias', '2026-08-31T00:00:00Z');
```

```bash
npm run migrate:local
npm run dev
```

Open `http://localhost:8787/g/g1`. Expected: the goal page renders with a bar at 25%.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: public goal page with progress bar"
```

---

### Task 4: Operator admin — goals and manual adjustments

Completes a working product with zero Mercado Pago involvement.

**Files:**
- Create: `src/admin/auth.ts`, `src/admin/routes.tsx`
- Modify: `src/db/queries.ts` (add writes), `src/index.ts` (mount admin)
- Test: `src/admin/auth.test.ts`

**Interfaces:**
- Consumes: `db`, `listGoalsByNgo`, `computeProgress`
- Produces: `requireOperator` Hono middleware; `createGoal(d, input)`, `addManualContribution(d, input)` in `src/db/queries.ts`

- [ ] **Step 1: Write the failing test**

`src/admin/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isValidOperatorSecret } from './auth'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/admin/auth.test.ts`
Expected: FAIL — cannot resolve `./auth`.

- [ ] **Step 3: Implement auth**

`src/admin/auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono'

export function isValidOperatorSecret(provided: string, expected: string | undefined): boolean {
  if (!expected || !provided) return false
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

export const requireOperator: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!isValidOperatorSecret(provided, c.env.OPERATOR_SECRET)) {
    return c.text('No autorizado', 401)
  }
  await next()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/admin/auth.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add write queries**

Append to `src/db/queries.ts`:

```ts
import * as schema from './schema'

export async function createGoal(d: Db, input: {
  id: string; ngoId: string; title: string; description: string; targetAmountCents: number
}): Promise<void> {
  await d.insert(schema.goal).values({ ...input, createdAt: new Date().toISOString() })
}

export async function addManualContribution(d: Db, input: {
  id: string; goalId: string; amountCents: number; note: string
}): Promise<void> {
  const now = new Date().toISOString()
  await d.insert(schema.contribution).values({
    id: input.id, goalId: input.goalId, source: 'manual', mpPaymentId: null,
    amountCents: input.amountCents, status: 'approved',
    paidAt: now, note: input.note, createdAt: now,
  })
}
```

- [ ] **Step 6: Implement admin routes**

`src/admin/routes.tsx`:

```tsx
import { Hono } from 'hono'
import { requireOperator } from './auth'
import { db, listGoalsByNgo, createGoal, addManualContribution, listContributions } from '../db/queries'
import { computeProgress } from '../goals/progress'
import { formatArs } from '../public/views'

export const adminRoutes = new Hono<{ Bindings: Env }>()
adminRoutes.use('/admin/*', requireOperator)

adminRoutes.get('/admin/ngo/:ngoId', async (c) => {
  const d = db(c.env.DB)
  const goals = await listGoalsByNgo(d, c.req.param('ngoId'))
  const rows = await Promise.all(goals.map(async (g) =>
    ({ g, p: computeProgress(g, await listContributions(d, g.id)) })))
  return c.html(
    <html lang="es"><body>
      <h1>Objetivos</h1>
      <ul>{rows.map(({ g, p }) => (
        <li>
          {g.title} — {formatArs(p.raisedCents)} / {formatArs(p.targetCents)} ({p.percent}%)
          <br />
          <small>plataforma {formatArs(p.verifiedCents)} · manual {formatArs(p.manualCents)}</small>
          <form method="post" action={`/admin/goal/${g.id}/manual`}>
            <input name="montoPesos" type="number" min="1" required placeholder="Monto recibido fuera de la plataforma" />
            <input name="note" placeholder="Nota (ej. transferencias por alias)" />
            <button type="submit">Registrar</button>
          </form>
        </li>
      ))}</ul>
      <h2>Nuevo objetivo</h2>
      <form method="post" action="/admin/goal">
        <input type="hidden" name="ngoId" value={c.req.param('ngoId')} />
        <input name="title" placeholder="Título" required />
        <input name="description" placeholder="Descripción" />
        <input name="targetPesos" type="number" min="1" required />
        <button type="submit">Crear</button>
      </form>
    </body></html>,
  )
})

adminRoutes.post('/admin/goal', async (c) => {
  const f = await c.req.formData()
  await createGoal(db(c.env.DB), {
    id: crypto.randomUUID(),
    ngoId: String(f.get('ngoId')),
    title: String(f.get('title')),
    description: String(f.get('description') ?? ''),
    targetAmountCents: Number(f.get('targetPesos')) * 100,
  })
  return c.redirect(`/admin/ngo/${f.get('ngoId')}`)
})

adminRoutes.post('/admin/goal/:goalId/manual', async (c) => {
  const f = await c.req.formData()
  await addManualContribution(db(c.env.DB), {
    id: crypto.randomUUID(),
    goalId: c.req.param('goalId'),
    amountCents: Number(f.get('montoPesos')) * 100,
    note: String(f.get('note') ?? ''),
  })
  return c.redirect(`/g/${c.req.param('goalId')}`)
})
```

- [ ] **Step 7: Mount admin and verify manually**

Add to `src/index.ts`: `import { adminRoutes } from './admin/routes'` and `app.route('/', adminRoutes)`.

Create `.dev.vars` (gitignored):

```
OPERATOR_SECRET=dev-secret
```

```bash
npm run dev
curl -s -H "Authorization: Bearer dev-secret" http://localhost:8787/admin/ngo/n1 | head -20
curl -s http://localhost:8787/admin/ngo/n1 -o /dev/null -w "%{http_code}\n"
```

Expected: first returns HTML listing the seeded goal; second returns `401`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: operator admin for goals and manual contributions"
```

---

### Task 5: Token encryption

**Files:**
- Create: `src/credentials/crypto.ts`
- Test: `src/credentials/crypto.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `encryptToken(plain: string, keyBase64: string): Promise<string>`, `decryptToken(cipher: string, keyBase64: string): Promise<string>`, `generateKeyBase64(): Promise<string>`

- [ ] **Step 1: Write the failing tests**

`src/credentials/crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encryptToken, decryptToken, generateKeyBase64 } from './crypto'

describe('token encryption', () => {
  it('round-trips a token', async () => {
    const key = await generateKeyBase64()
    const cipher = await encryptToken('APP_USR-12345', key)
    expect(await decryptToken(cipher, key)).toBe('APP_USR-12345')
  })

  it('does not leak the plaintext into the ciphertext', async () => {
    const key = await generateKeyBase64()
    const cipher = await encryptToken('APP_USR-12345', key)
    expect(cipher).not.toContain('APP_USR')
  })

  it('produces a different ciphertext each time for the same input', async () => {
    const key = await generateKeyBase64()
    expect(await encryptToken('same', key)).not.toBe(await encryptToken('same', key))
  })

  it('fails to decrypt with the wrong key rather than returning garbage', async () => {
    const cipher = await encryptToken('secret', await generateKeyBase64())
    await expect(decryptToken(cipher, await generateKeyBase64())).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/credentials/crypto.test.ts`
Expected: FAIL — cannot resolve `./crypto`.

- [ ] **Step 3: Implement**

`src/credentials/crypto.ts`:

```ts
const IV_BYTES = 12

const b64encode = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const b64decode = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function importKey(keyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64decode(keyBase64), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function generateKeyBase64(): Promise<string> {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)))
}

export async function encryptToken(plain: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await importKey(keyBase64),
    new TextEncoder().encode(plain),
  )
  const out = new Uint8Array(iv.length + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.length)
  return b64encode(out)
}

export async function decryptToken(cipher: string, keyBase64: string): Promise<string> {
  const raw = b64decode(cipher)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, IV_BYTES) },
    await importKey(keyBase64),
    raw.slice(IV_BYTES),
  )
  return new TextDecoder().decode(pt)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/credentials/crypto.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/
git commit -m "feat: AES-GCM encryption for stored NGO tokens"
```

---

### Task 6: Mercado Pago client interface and fake

**Verify the load-bearing assumption first.** The whole attribution model assumes an `external_reference` set on a *preference* appears on the resulting *payment*. This is not documented — Step 1 checks it.

**Files:**
- Create: `src/mp/client.ts`, `src/mp/fake.ts`
- Test: `src/mp/fake.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `MercadoPagoClient` interface with `createPreference` and `searchPayments`; `MpPayment` type; `FakeMercadoPago` class implementing the interface

- [ ] **Step 1: Verify `external_reference` propagates (manual, sandbox)**

Using a test-user access token, create a preference with `external_reference: "probe-goal-1"`, pay it with card `4509 9535 6623 3704`, CVV `123`, exp `11/30`, cardholder `APRO`, DNI `12345678`. Then:

```bash
curl -s -H "Authorization: Bearer $MP_TEST_TOKEN" \
  "https://api.mercadopago.com/v1/payments/search?external_reference=probe-goal-1" | head -40
```

Expected: one payment with `"external_reference": "probe-goal-1"` and `"status": "approved"`.

**If it does not propagate:** stop and report. The fix is to persist `preference_id → goal_id` at creation and attribute on `payment.order.id` instead. That changes Task 8, so it must be known now.

- [ ] **Step 2: Write the failing test**

`src/mp/fake.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FakeMercadoPago } from './fake'

describe('FakeMercadoPago', () => {
  it('returns an init point when creating a preference', async () => {
    const mp = new FakeMercadoPago()
    const r = await mp.createPreference({
      accessToken: 't', goalId: 'g1', amountCents: 100_000,
      title: 'Donación', backUrl: 'https://example.test/g/g1',
    })
    expect(r.initPoint).toContain('http')
    expect(r.preferenceId).toBeTruthy()
  })

  it('returns seeded payments filtered by date window', async () => {
    const mp = new FakeMercadoPago()
    mp.seedPayment({
      id: 'p1', status: 'approved', transactionAmountCents: 100_000,
      externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z',
    })
    mp.seedPayment({
      id: 'p2', status: 'approved', transactionAmountCents: 200_000,
      externalReference: 'g1', dateApproved: '2020-01-01T00:00:00Z',
    })
    const found = await mp.searchPayments({
      accessToken: 't', beginDate: '2026-08-01T00:00:00Z', endDate: '2026-09-01T00:00:00Z',
    })
    expect(found.map((p) => p.id)).toEqual(['p1'])
  })

  it('throws the configured auth error so refresh logic can be tested', async () => {
    const mp = new FakeMercadoPago()
    mp.failNextWith401 = true
    await expect(mp.searchPayments({
      accessToken: 'stale', beginDate: '2026-08-01T00:00:00Z', endDate: '2026-09-01T00:00:00Z',
    })).rejects.toThrow('401')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/mp/fake.test.ts`
Expected: FAIL — cannot resolve `./fake`.

- [ ] **Step 4: Implement the interface and the fake**

`src/mp/client.ts`:

```ts
export interface MpPayment {
  id: string
  status: 'approved' | 'pending' | 'rejected'
  transactionAmountCents: number
  externalReference: string | null
  dateApproved: string | null
}

export interface CreatePreferenceInput {
  accessToken: string
  goalId: string
  amountCents: number
  title: string
  backUrl: string
}

export interface SearchPaymentsInput {
  accessToken: string
  beginDate: string
  endDate: string
}

export interface MercadoPagoClient {
  createPreference(input: CreatePreferenceInput): Promise<{ preferenceId: string; initPoint: string }>
  searchPayments(input: SearchPaymentsInput): Promise<MpPayment[]>
}

const API = 'https://api.mercadopago.com'

export class LiveMercadoPago implements MercadoPagoClient {
  async createPreference(input: CreatePreferenceInput) {
    const res = await fetch(`${API}/checkout/preferences`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        items: [{
          title: input.title, quantity: 1, currency_id: 'ARS',
          unit_price: input.amountCents / 100,
        }],
        external_reference: input.goalId,
        back_urls: { success: input.backUrl, failure: input.backUrl, pending: input.backUrl },
      }),
    })
    if (!res.ok) throw new Error(`MP createPreference failed: ${res.status}`)
    const j = await res.json<{ id: string; init_point: string }>()
    return { preferenceId: j.id, initPoint: j.init_point }
  }

  async searchPayments(input: SearchPaymentsInput): Promise<MpPayment[]> {
    const url = new URL(`${API}/v1/payments/search`)
    url.searchParams.set('sort', 'date_created')
    url.searchParams.set('criteria', 'desc')
    url.searchParams.set('range', 'date_created')
    url.searchParams.set('begin_date', input.beginDate)
    url.searchParams.set('end_date', input.endDate)
    const res = await fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } })
    if (!res.ok) throw new Error(`MP searchPayments failed: ${res.status}`)
    const j = await res.json<{ results: Array<Record<string, any>> }>()
    return j.results.map((r) => ({
      id: String(r.id),
      status: r.status,
      transactionAmountCents: Math.round(Number(r.transaction_amount) * 100),
      externalReference: r.external_reference ?? null,
      dateApproved: r.date_approved ?? null,
    }))
  }
}
```

`src/mp/fake.ts`:

```ts
import type { MercadoPagoClient, MpPayment, CreatePreferenceInput, SearchPaymentsInput } from './client'

export class FakeMercadoPago implements MercadoPagoClient {
  payments: MpPayment[] = []
  failNextWith401 = false
  createdPreferences: CreatePreferenceInput[] = []

  seedPayment(p: MpPayment) { this.payments.push(p) }

  async createPreference(input: CreatePreferenceInput) {
    this.createdPreferences.push(input)
    const id = `pref-${this.createdPreferences.length}`
    return { preferenceId: id, initPoint: `https://fake.mp.test/checkout/${id}` }
  }

  async searchPayments(input: SearchPaymentsInput): Promise<MpPayment[]> {
    if (this.failNextWith401) {
      this.failNextWith401 = false
      throw new Error('MP searchPayments failed: 401')
    }
    return this.payments.filter((p) => {
      const when = p.dateApproved ?? ''
      return when >= input.beginDate && when <= input.endDate
    })
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/mp/fake.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/mp/
git commit -m "feat: Mercado Pago client interface with live and fake implementations"
```

---

### Task 7: OAuth connect flow

**Files:**
- Create: `src/mp/oauth.ts`, `src/admin/connect.tsx`
- Modify: `src/db/queries.ts` (store tokens), `src/index.ts` (mount connect routes)
- Test: `src/mp/oauth.test.ts`

**Interfaces:**
- Consumes: `encryptToken` from `src/credentials/crypto.ts`
- Produces: `buildAuthorizeUrl(input)`, `exchangeCode(input)`, `refreshAccessToken(input)`, `TokenSet { accessToken, refreshToken, expiresInSeconds, mpUserId }`

- [ ] **Step 1: Write the failing tests**

`src/mp/oauth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildAuthorizeUrl, parseTokenResponse } from './oauth'

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mp/oauth.test.ts`
Expected: FAIL — cannot resolve `./oauth`.

- [ ] **Step 3: Implement**

`src/mp/oauth.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mp/oauth.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add token persistence**

Append to `src/db/queries.ts`:

```ts
export async function saveNgoTokens(d: Db, input: {
  ngoId: string; accessTokenEnc: string; refreshTokenEnc: string
  tokenExpiresAt: string; mpUserId: string
}): Promise<void> {
  await d.update(schema.ngo).set({
    accessTokenEnc: input.accessTokenEnc,
    refreshTokenEnc: input.refreshTokenEnc,
    tokenExpiresAt: input.tokenExpiresAt,
    mpUserId: input.mpUserId,
    status: 'connected',
    connectedAt: new Date().toISOString(),
  }).where(eq(schema.ngo.id, input.ngoId))
}

export async function getNgoSecrets(d: Db, ngoId: string) {
  const rows = await d.select().from(schema.ngo).where(eq(schema.ngo.id, ngoId)).limit(1)
  return rows[0] ?? null
}

export async function markNgoDisconnected(d: Db, ngoId: string): Promise<void> {
  await d.update(schema.ngo).set({ status: 'disconnected' }).where(eq(schema.ngo.id, ngoId))
}
```

- [ ] **Step 6: Implement the connect routes**

`src/admin/connect.tsx`:

```tsx
import { Hono } from 'hono'
import { buildAuthorizeUrl, exchangeCode } from '../mp/oauth'
import { encryptToken } from '../credentials/crypto'
import { db, saveNgoTokens } from '../db/queries'

export const connectRoutes = new Hono<{ Bindings: Env }>()

// Operator shares this link with the NGO; state carries the ngo id.
connectRoutes.get('/conectar/:ngoId', (c) => {
  const url = buildAuthorizeUrl({
    clientId: c.env.MP_CLIENT_ID,
    redirectUri: `${c.env.PUBLIC_BASE_URL}/oauth/callback`,
    state: c.req.param('ngoId'),
  })
  return c.redirect(url)
})

connectRoutes.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const ngoId = c.req.query('state')
  if (!code || !ngoId) return c.text('Falta code o state', 400)

  const tokens = await exchangeCode({
    clientId: c.env.MP_CLIENT_ID,
    clientSecret: c.env.MP_CLIENT_SECRET,
    code,
    redirectUri: `${c.env.PUBLIC_BASE_URL}/oauth/callback`,
  })

  await saveNgoTokens(db(c.env.DB), {
    ngoId,
    accessTokenEnc: await encryptToken(tokens.accessToken, c.env.TOKEN_KEY),
    refreshTokenEnc: await encryptToken(tokens.refreshToken, c.env.TOKEN_KEY),
    tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
    mpUserId: tokens.mpUserId,
  })

  return c.html(<html lang="es"><body><h1>Cuenta conectada</h1></body></html>)
})
```

Mount in `src/index.ts` with `app.route('/', connectRoutes)`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: Mercado Pago OAuth connect flow with encrypted token storage"
```

---

### Task 8: Ingestion poller and donate route

**Files:**
- Create: `src/ingest/poller.ts`, `src/public/donate.tsx`
- Modify: `src/db/queries.ts` (upsert), `src/index.ts` (scheduled handler)
- Test: `src/ingest/poller.test.ts`

**Interfaces:**
- Consumes: `MercadoPagoClient`, `MpPayment`, `Goal`, `Contribution`
- Produces: `attributePayments(payments: MpPayment[], goalIds: string[]): Contribution[]`, `ingestForNgo(deps)` returning `{ upserted: number; ignored: number }`

- [ ] **Step 1: Write the failing tests**

`src/ingest/poller.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { attributePayments } from './poller'
import type { MpPayment } from '../mp/client'

const payment = (over: Partial<MpPayment>): MpPayment => ({
  id: 'p1', status: 'approved', transactionAmountCents: 100_000,
  externalReference: 'g1', dateApproved: '2026-08-31T10:00:00Z', ...over,
})

describe('attributePayments', () => {
  it('maps an approved payment to a platform contribution on the referenced goal', () => {
    const [c] = attributePayments([payment({})], ['g1'])
    expect(c.goalId).toBe('g1')
    expect(c.source).toBe('platform')
    expect(c.mpPaymentId).toBe('p1')
    expect(c.amountCents).toBe(100_000)
    expect(c.status).toBe('approved')
  })

  it('ignores payments whose external_reference matches no known goal', () => {
    expect(attributePayments([payment({ externalReference: 'unknown' })], ['g1'])).toEqual([])
  })

  it('ignores payments with no external_reference at all', () => {
    expect(attributePayments([payment({ externalReference: null })], ['g1'])).toEqual([])
  })

  it('keeps pending and rejected payments but marks their status', () => {
    const out = attributePayments([
      payment({ id: 'p2', status: 'pending', dateApproved: null }),
      payment({ id: 'p3', status: 'rejected' }),
    ], ['g1'])
    expect(out.map((c) => c.status)).toEqual(['pending', 'rejected'])
  })

  it('is deterministic on payment id so re-ingestion upserts rather than duplicates', () => {
    const a = attributePayments([payment({})], ['g1'])
    const b = attributePayments([payment({})], ['g1'])
    expect(a[0].id).toBe(b[0].id)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingest/poller.test.ts`
Expected: FAIL — cannot resolve `./poller`.

- [ ] **Step 3: Implement attribution**

`src/ingest/poller.ts`:

```ts
import type { MpPayment, MercadoPagoClient } from '../mp/client'
import type { Contribution } from '../goals/types'

export function attributePayments(payments: MpPayment[], goalIds: string[]): Contribution[] {
  const known = new Set(goalIds)
  return payments
    .filter((p) => p.externalReference !== null && known.has(p.externalReference))
    .map((p) => ({
      id: `mp-${p.id}`,
      goalId: p.externalReference as string,
      source: 'platform' as const,
      mpPaymentId: p.id,
      amountCents: p.transactionAmountCents,
      status: p.status,
      paidAt: p.dateApproved ?? new Date(0).toISOString(),
      note: null,
    }))
}

export async function ingestForNgo(deps: {
  client: MercadoPagoClient
  accessToken: string
  goalIds: string[]
  since: Date
  now: Date
  upsert: (c: Contribution) => Promise<void>
}): Promise<{ upserted: number; ignored: number }> {
  const payments = await deps.client.searchPayments({
    accessToken: deps.accessToken,
    beginDate: deps.since.toISOString(),
    endDate: deps.now.toISOString(),
  })
  const contributions = attributePayments(payments, deps.goalIds)
  for (const c of contributions) await deps.upsert(c)
  return { upserted: contributions.length, ignored: payments.length - contributions.length }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingest/poller.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the idempotent upsert**

Append to `src/db/queries.ts`:

```ts
export async function upsertPlatformContribution(d: Db, c: {
  id: string; goalId: string; mpPaymentId: string
  amountCents: number; status: string; paidAt: string
}): Promise<void> {
  await d.insert(schema.contribution).values({
    id: c.id, goalId: c.goalId, source: 'platform', mpPaymentId: c.mpPaymentId,
    amountCents: c.amountCents, status: c.status, paidAt: c.paidAt,
    note: null, createdAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: schema.contribution.mpPaymentId,
    set: { status: c.status, amountCents: c.amountCents, paidAt: c.paidAt },
  })
}
```

- [ ] **Step 6: Implement the donate route**

`src/public/donate.tsx`:

```tsx
import { Hono } from 'hono'
import { db, getGoalById, getNgoSecrets } from '../db/queries'
import { decryptToken } from '../credentials/crypto'
import { LiveMercadoPago } from '../mp/client'

export const donateRoutes = new Hono<{ Bindings: Env }>()

donateRoutes.get('/g/:id/donar', async (c) => {
  const d = db(c.env.DB)
  const goal = await getGoalById(d, c.req.param('id'))
  if (!goal) return c.notFound()

  const pesos = Number(c.req.query('monto'))
  if (!Number.isFinite(pesos) || pesos <= 0) return c.text('Monto inválido', 400)

  const ngo = await getNgoSecrets(d, goal.ngoId)
  if (!ngo?.accessTokenEnc) return c.text('La organización aún no conectó su cuenta', 409)

  const { initPoint } = await new LiveMercadoPago().createPreference({
    accessToken: await decryptToken(ngo.accessTokenEnc, c.env.TOKEN_KEY),
    goalId: goal.id,
    amountCents: Math.round(pesos * 100),
    title: `Donación — ${goal.title}`,
    backUrl: `${c.env.PUBLIC_BASE_URL}/g/${goal.id}`,
  })
  return c.redirect(initPoint)
})
```

- [ ] **Step 7: Write the failing test for refresh-on-401**

The spec requires: on a 401, refresh once and retry; only if the refresh itself fails do we mark
the NGO disconnected. Append to `src/ingest/poller.test.ts`:

```ts
import { withTokenRefresh } from './poller'

describe('withTokenRefresh', () => {
  it('returns the result directly when there is no auth failure', async () => {
    let refreshes = 0
    const r = await withTokenRefresh({
      run: async () => 'ok',
      refresh: async () => { refreshes++; return 'new-token' },
    })
    expect(r).toBe('ok')
    expect(refreshes).toBe(0)
  })

  it('refreshes once and retries when the first attempt 401s', async () => {
    let attempts = 0
    let refreshes = 0
    const r = await withTokenRefresh({
      run: async () => {
        attempts++
        if (attempts === 1) throw new Error('MP searchPayments failed: 401')
        return 'ok-after-refresh'
      },
      refresh: async () => { refreshes++; return 'new-token' },
    })
    expect(r).toBe('ok-after-refresh')
    expect(attempts).toBe(2)
    expect(refreshes).toBe(1)
  })

  it('does not retry more than once', async () => {
    let attempts = 0
    await expect(withTokenRefresh({
      run: async () => { attempts++; throw new Error('MP searchPayments failed: 401') },
      refresh: async () => 'new-token',
    })).rejects.toThrow('401')
    expect(attempts).toBe(2)
  })

  it('propagates non-auth errors without refreshing', async () => {
    let refreshes = 0
    await expect(withTokenRefresh({
      run: async () => { throw new Error('MP searchPayments failed: 500') },
      refresh: async () => { refreshes++; return 'new-token' },
    })).rejects.toThrow('500')
    expect(refreshes).toBe(0)
  })
})
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `npx vitest run src/ingest/poller.test.ts`
Expected: FAIL — `withTokenRefresh` is not exported.

- [ ] **Step 9: Implement `withTokenRefresh`**

Append to `src/ingest/poller.ts`:

```ts
export function isAuthError(err: unknown): boolean {
  return String(err).includes('401')
}

export async function withTokenRefresh<T>(deps: {
  run: (accessToken?: string) => Promise<T>
  refresh: () => Promise<string>
}): Promise<T> {
  try {
    return await deps.run()
  } catch (err) {
    if (!isAuthError(err)) throw err
    const fresh = await deps.refresh()
    return await deps.run(fresh)
  }
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run src/ingest/poller.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 11: Wire the scheduled handler**

Replace the default export in `src/index.ts`:

```ts
import { LiveMercadoPago } from './mp/client'
import { decryptToken, encryptToken } from './credentials/crypto'
import { ingestForNgo, withTokenRefresh, isAuthError } from './ingest/poller'
import { refreshAccessToken } from './mp/oauth'
import { db, listConnectedNgos, listGoalsByNgo, getNgoSecrets, saveNgoTokens, upsertPlatformContribution, markNgoDisconnected } from './db/queries'

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const d = db(env.DB)
      const client = new LiveMercadoPago()
      const now = new Date()
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)

      for (const ngo of await listConnectedNgos(d)) {
        const secrets = await getNgoSecrets(d, ngo.id)
        if (!secrets?.accessTokenEnc || !secrets.refreshTokenEnc) continue
        const goals = await listGoalsByNgo(d, ngo.id)
        const stored = await decryptToken(secrets.accessTokenEnc, env.TOKEN_KEY)

        try {
          await withTokenRefresh({
            run: (token) => ingestForNgo({
              client,
              accessToken: token ?? stored,
              goalIds: goals.map((g) => g.id),
              since, now,
              upsert: (c) => upsertPlatformContribution(d, {
                id: c.id, goalId: c.goalId, mpPaymentId: c.mpPaymentId!,
                amountCents: c.amountCents, status: c.status, paidAt: c.paidAt,
              }),
            }),
            refresh: async () => {
              const t = await refreshAccessToken({
                clientId: env.MP_CLIENT_ID,
                clientSecret: env.MP_CLIENT_SECRET,
                refreshToken: await decryptToken(secrets.refreshTokenEnc!, env.TOKEN_KEY),
              })
              await saveNgoTokens(d, {
                ngoId: ngo.id,
                accessTokenEnc: await encryptToken(t.accessToken, env.TOKEN_KEY),
                refreshTokenEnc: await encryptToken(t.refreshToken, env.TOKEN_KEY),
                tokenExpiresAt: new Date(Date.now() + t.expiresInSeconds * 1000).toISOString(),
                mpUserId: t.mpUserId,
              })
              return t.accessToken
            },
          })
        } catch (err) {
          // Refresh already had its one attempt inside withTokenRefresh.
          // A 401 surviving to here means the NGO must reconnect.
          if (isAuthError(err)) await markNgoDisconnected(d, ngo.id)
          console.error(`ingest failed for ngo ${ngo.id}: ${err}`)
        }
      }
    })())
  },
}
```

- [ ] **Step 12: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: poll Mercado Pago and attribute donations to goals"
```

---

### Task 9: Deploy and CI

**Requires the Cloudflare account.** Everything before this runs offline.

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `wrangler.toml` (real `database_id`)

**Interfaces:**
- Consumes: the complete app
- Produces: a deployed Worker at a `*.workers.dev` URL used as the MP OAuth Redirect URL

- [ ] **Step 1: Authenticate and create resources**

```bash
npx wrangler login
npx wrangler d1 create cuantofalta
```

Copy the returned `database_id` into `wrangler.toml`.

- [ ] **Step 2: Set secrets**

```bash
npx wrangler secret put OPERATOR_SECRET
npx wrangler secret put MP_CLIENT_ID
npx wrangler secret put MP_CLIENT_SECRET
npx wrangler secret put TOKEN_KEY      # output of generateKeyBase64()
npx wrangler secret put PUBLIC_BASE_URL
# MP_TEST_MODE (optional, omit in prod): set to the string 'true' to make
# the OAuth code exchange pass test_token: true, required when connecting
# against Mercado Pago test users (sandbox OAuth) rather than real seller
# accounts — e.g. for the Task 9 end-to-end run.
npx wrangler secret put MP_TEST_MODE
```

- [ ] **Step 3: Apply migrations and deploy**

```bash
npx wrangler d1 migrations apply cuantofalta --remote
npx wrangler deploy
```

Expected: a `https://cuantofalta.<subdomain>.workers.dev` URL.

- [ ] **Step 4: Register the Redirect URL in Mercado Pago**

In the MP developer panel, set the application's Redirect URL to exactly
`https://cuantofalta.<subdomain>.workers.dev/oauth/callback`. It must match byte-for-byte.

- [ ] **Step 5: Write the CI workflow**

`.github/workflows/deploy.yml`:

```yaml
name: deploy
on:
  push: { branches: [main] }
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: Deploy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

- [ ] **Step 6: PRE-FLIGHT — verify `external_reference` propagates**

This was Task 6's Step 1, deferred here because it needs sandbox credentials. **Run it
before Step 7.** The whole attribution model assumes an `external_reference` set on a
*preference* appears on the resulting *payment*.

Using the test-user access token, create a preference with `external_reference:
"probe-goal-1"`, pay it with card `4509 9535 6623 3704`, CVV `123`, exp `11/30`,
cardholder `APRO`, DNI `12345678`. Then:

```bash
curl -s -H "Authorization: Bearer $MP_TEST_TOKEN" \
  "https://api.mercadopago.com/v1/payments/search?external_reference=probe-goal-1" | head -40
```

Expected: one payment with `"external_reference": "probe-goal-1"` and `"status": "approved"`.

**If it does not propagate:** STOP and report. The fix is to persist `preference_id →
goal_id` at creation time and attribute on the payment's order id instead — a change to
`attributePayments` and the preference-creation path, not a redesign.

- [ ] **Step 7: End-to-end verification**

The connect flow is **two steps** (the single `/conectar/:ngoId` route was removed as a
money-redirection vulnerability: it minted a valid signed state for any NGO id to any
anonymous caller).

1. As the operator, `GET /admin/ngo/n1/connect-link` with the operator bearer token.
   Expect a URL containing a signed capability token.
2. Open that URL (`/conectar?t=...`) as the test-user NGO and approve. Expect "Cuenta
   conectada" and `ngo.status = 'connected'`.
3. Confirm a tampered or expired `t` returns 400 and does **not** redirect to Mercado Pago.
4. Create a goal via admin.
5. Donate from the public page using card `4509 9535 6623 3704`, cardholder `APRO`,
   DNI `12345678`.
6. Wait for the cron tick (≤2 min), reload the goal page. Expect the bar to move.
7. Repeat with cardholder `OTHE` and `CONT`. Expect the bar **not** to move.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "ci: deploy worker to cloudflare on push to main"
```

---

## Deferred (explicitly not in this build)

Webhooks; unattributed-payment review queue; commission / Split Payments; NGO self-signup and per-NGO logins; donor accounts, receipts or email; multi-currency; scheduled token refresh; batching the poller across cron ticks.
