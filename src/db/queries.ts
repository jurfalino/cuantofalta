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

// Every NGO regardless of status — for the operator's "all NGOs" list page,
// where a `pending` (never connected) or `disconnected` NGO is exactly what
// the operator needs to see, not just the connected ones.
export async function listNgos(d: Db): Promise<Ngo[]> {
  // Narrow projection, same reasoning as getNgoById below: never select the
  // token ciphertext columns for a page that only ever needs to render
  // id/name/slug/status.
  const rows = await d.select({
    id: s.ngo.id, name: s.ngo.name, slug: s.ngo.slug,
    mpUserId: s.ngo.mpUserId, status: s.ngo.status,
  }).from(s.ngo)
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug,
    mpUserId: r.mpUserId, status: r.status as Ngo['status'],
  }))
}

// Narrow projection for rendering (e.g. the reconnect banner): never
// includes the token ciphertext columns, so there is no risk of a careless
// spread ever putting a token anywhere near a response.
export async function getNgoById(d: Db, id: string): Promise<Ngo | null> {
  const rows = await d.select({
    id: s.ngo.id, name: s.ngo.name, slug: s.ngo.slug,
    mpUserId: s.ngo.mpUserId, status: s.ngo.status,
  }).from(s.ngo).where(eq(s.ngo.id, id)).limit(1)
  const r = rows[0]
  return r ? { id: r.id, name: r.name, slug: r.slug, mpUserId: r.mpUserId, status: r.status as Ngo['status'] } : null
}

export async function createNgo(d: Db, input: { id: string; name: string; slug: string }): Promise<void> {
  await d.insert(s.ngo).values({ id: input.id, name: input.name, slug: input.slug })
}

// drizzle-orm/d1 wraps the underlying driver error in a DrizzleQueryError,
// whose own message is just "Failed query: ..." — the actual
// "UNIQUE constraint failed" text (from D1 in production, or from
// better-sqlite3 in tests) lives on `.cause`, sometimes nested more than
// one level deep. Walks the cause chain rather than trusting
// `String(err)` alone, which would otherwise miss this every time.
export function isUniqueConstraintError(err: unknown): boolean {
  let current: unknown = err
  for (let i = 0; i < 5 && current; i++) {
    if (String(current).includes('UNIQUE constraint failed')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

export async function createGoal(d: Db, input: {
  id: string; ngoId: string; title: string; description: string; targetAmountCents: number
}): Promise<void> {
  await d.insert(s.goal).values({ ...input, createdAt: new Date().toISOString() })
}

export async function addManualContribution(d: Db, input: {
  id: string; goalId: string; amountCents: number; note: string
}): Promise<void> {
  const now = new Date().toISOString()
  await d.insert(s.contribution).values({
    id: input.id, goalId: input.goalId, source: 'manual', mpPaymentId: null,
    amountCents: input.amountCents, status: 'approved',
    paidAt: now, note: input.note, createdAt: now,
  })
}

// Returns how many rows the UPDATE actually changed. This is an UPDATE, not
// an upsert — an ngoId with no matching row updates zero rows and returns
// 0 rather than throwing, so a caller MUST check this before treating the
// save as having happened (see the OAuth callback in src/admin/connect.tsx,
// which would otherwise report "Cuenta conectada" after granting real MP
// tokens to a row that doesn't exist).
export async function saveNgoTokens(d: Db, input: {
  ngoId: string; accessTokenEnc: string; refreshTokenEnc: string
  tokenExpiresAt: string; mpUserId: string
}): Promise<{ rowsChanged: number }> {
  const result = await d.update(s.ngo).set({
    accessTokenEnc: input.accessTokenEnc,
    refreshTokenEnc: input.refreshTokenEnc,
    tokenExpiresAt: input.tokenExpiresAt,
    mpUserId: input.mpUserId,
    status: 'connected',
    connectedAt: new Date().toISOString(),
  }).where(eq(s.ngo.id, input.ngoId))
  return { rowsChanged: (result as { meta?: { changes?: number } }).meta?.changes ?? 0 }
}

export async function getNgoSecrets(d: Db, ngoId: string) {
  const rows = await d.select().from(s.ngo).where(eq(s.ngo.id, ngoId)).limit(1)
  return rows[0] ?? null
}

export async function markNgoDisconnected(d: Db, ngoId: string): Promise<void> {
  await d.update(s.ngo).set({ status: 'disconnected' }).where(eq(s.ngo.id, ngoId))
}

export async function upsertPlatformContribution(d: Db, c: {
  id: string; goalId: string; mpPaymentId: string
  amountCents: number; status: string; paidAt: string
}): Promise<void> {
  await d.insert(s.contribution).values({
    id: c.id, goalId: c.goalId, source: 'platform', mpPaymentId: c.mpPaymentId,
    amountCents: c.amountCents, status: c.status, paidAt: c.paidAt,
    note: null, createdAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: s.contribution.mpPaymentId,
    set: { status: c.status, amountCents: c.amountCents, paidAt: c.paidAt },
  })
}

// Contributions ingested from Mercado Pago that are still `pending` days or
// weeks later — the efectivo (Rapipago/Pago Fácil) settlement case the
// poller's normal lookback window would otherwise never revisit. Carries
// `ngoId` (via goal) because the recheck needs that NGO's access token,
// not just the payment id.
export async function listPendingPlatformContributions(d: Db): Promise<Array<{
  id: string; goalId: string; ngoId: string; mpPaymentId: string
}>> {
  const rows = await d.select({
    id: s.contribution.id,
    goalId: s.contribution.goalId,
    mpPaymentId: s.contribution.mpPaymentId,
    ngoId: s.goal.ngoId,
  })
    .from(s.contribution)
    .innerJoin(s.goal, eq(s.contribution.goalId, s.goal.id))
    .where(and(eq(s.contribution.source, 'platform'), eq(s.contribution.status, 'pending')))

  return rows
    .filter((r): r is typeof r & { mpPaymentId: string } => r.mpPaymentId !== null)
    .map((r) => ({ id: r.id, goalId: r.goalId, ngoId: r.ngoId, mpPaymentId: r.mpPaymentId }))
}
