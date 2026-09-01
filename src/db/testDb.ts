import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { db as makeDrizzleDb, type Db } from './queries'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_PATH = resolve(__dirname, '../../migrations/0000_init.sql')

/**
 * Minimal D1Database-compatible adapter over better-sqlite3.
 *
 * Covers only the surface drizzle-orm/d1's driver actually calls:
 * `prepare(sql).bind(...).run()/.all()/.raw()`, plus `exec` (for applying
 * the migration) and `batch`. This lets tests run the real `queries.ts`
 * and the real upsert SQL against a real SQLite engine, in-process, with
 * no network and no wrangler — there is no other supported way to drive D1
 * from vitest in this project (see the idempotency test in
 * `src/db/queries.test.ts` for why this exists).
 *
 * The cast to `D1Database` at the bottom is deliberately the only place
 * that happens: this object satisfies the methods drizzle-orm/d1 calls,
 * not the full (much larger) `D1Database` type, so we don't fight
 * `tsc --noEmit` over methods nothing here ever calls.
 */
function makeD1(sqlite: Database.Database): D1Database {
  function wrapStmt(stmt: Database.Statement, sqlText: string) {
    const isSelect = /^\s*(select|pragma|with)/i.test(sqlText)
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = stmt.run(...(params as unknown[]))
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
            }
          },
          async all() {
            const results = isSelect
              ? stmt.all(...(params as unknown[]))
              : (stmt.run(...(params as unknown[])), [])
            return { results, success: true, meta: {} }
          },
          async raw() {
            return stmt.raw().all(...(params as unknown[]))
          },
          async first() {
            return stmt.get(...(params as unknown[])) ?? null
          },
        }
      },
    }
  }

  return {
    prepare(sqlText: string) {
      return wrapStmt(sqlite.prepare(sqlText), sqlText)
    },
    async exec(sqlText: string) {
      sqlite.exec(sqlText)
      return { count: 0, duration: 0 }
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(stmts.map((s) => s.run()))
    },
  } as unknown as D1Database
}

/**
 * A fresh, isolated, in-memory D1-shaped database (raw, undecorated) with
 * the real migration applied — for tests that need to hand something to
 * `c.env.DB`, i.e. route-level tests that call `db(c.env.DB)` themselves.
 */
export function createTestD1(): D1Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(readFileSync(MIGRATION_PATH, 'utf8'))
  return makeD1(sqlite)
}

/** A fresh, isolated, in-memory D1-shaped SQLite database with the real migration applied. */
export function createTestDb(): Db {
  return makeDrizzleDb(createTestD1())
}
