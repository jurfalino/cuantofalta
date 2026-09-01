import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
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

export async function saveNgoTokens(d: Db, input: {
  ngoId: string; accessTokenEnc: string; refreshTokenEnc: string
  tokenExpiresAt: string; mpUserId: string
}): Promise<void> {
  await d.update(s.ngo).set({
    accessTokenEnc: input.accessTokenEnc,
    refreshTokenEnc: input.refreshTokenEnc,
    tokenExpiresAt: input.tokenExpiresAt,
    mpUserId: input.mpUserId,
    status: 'connected',
    connectedAt: new Date().toISOString(),
  }).where(eq(s.ngo.id, input.ngoId))
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
