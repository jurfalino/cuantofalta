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
