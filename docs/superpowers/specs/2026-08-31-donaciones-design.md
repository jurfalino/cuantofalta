# Design: fundraising goals platform for animal protection NGOs

**Date:** 2026-08-31
**Status:** Draft for review
**Working name:** Donaciones (candidate public name: *Cuánto Falta*)

## Context

Animal protection NGOs in Argentina run fundraising campaigns with no shared way to show
supporters how close a campaign is to its target. This platform lets each NGO define goals and
publishes a live progress bar per goal, fed by donations that land in the NGO's **own** Mercado
Pago account.

Feasibility was established in a prior spike
([spike-2026-08-31-wallet-api-feasibility.md](../../spike-2026-08-31-wallet-api-feasibility.md)).
Its conclusions that carry into this design:

- Mercado Pago is the only Argentine wallet with a self-serve API that exposes incoming money.
  Belvo does not cover Argentina; Prometeo is not live there; Lemon, Belo and MODO have no public
  account API. Argentina has no open-banking regime, so there is no bank-agnostic option.
- Progress must be measured as **cumulative donations received**, never account balance. Balance
  falls when the NGO spends the money and is polluted by fees, refunds and withdrawals.
- Bare alias/CVU transfers are very likely invisible to the API. Donations must arrive through an
  MP checkout to be captured automatically.

## Goal of this build

Prove that **an NGO can connect its own Mercado Pago account and have a donation appear,
correctly attributed, on the right goal's progress bar.** Everything in scope serves that.

## Scope

**In:**
- NGO connects their MP account via OAuth, from an operator-generated connect link
- Goal CRUD (title, description, target amount), performed by the operator
- Donate flow: donor enters an amount, pays through MP Checkout
- Polling ingestion of approved payments, attributed per goal
- Public goal page with progress bar
- Manual adjustment field for donations that arrive off-platform
- Shared-secret admin authentication

**Out (deferred):** webhooks; unattributed-payment review queue; commission / Split Payments; NGO
self-signup; donor accounts, receipts or email; multi-currency; anything for donors beyond paying.

## Stack and infrastructure

| Concern | Choice | Why |
|---|---|---|
| Runtime | Hono on Cloudflare Workers, TypeScript | Single Worker serves admin, public pages and OAuth callback. No adapter layer. |
| UI | Server-rendered JSX | A progress bar and two forms do not need a client framework. |
| Database | Cloudflare D1 (SQLite) | Native, migrations via Wrangler. |
| Scheduler | Cron Triggers | The poller needs no separate host. This is the main reason Cloudflare fits. |
| Secrets | Workers Secrets | MP client secret, token-encryption key. |
| Encryption | Web Crypto AES-GCM | Available in the Workers runtime; no dependency. |
| Schema | Drizzle | Typed rows, generated migrations. |

Two environments — `dev` and `prod` — each with its own Worker and D1 instance, so MP test
credentials never share a database with production ones.

**Workers give HTTPS on `*.workers.dev` immediately**, which satisfies MP's requirement that the
OAuth Redirect URL be a static, exactly-matching URL. No tunnel is needed for development.

Known limits: Cron Triggers fire at most once per minute (irrelevant for a progress bar), and
Worker CPU time is bounded, so polling many NGOs in one invocation will eventually need batching
across cron ticks. Not a concern at POC scale.

## Architecture

Four flows.

### 1. Connect

NGO admin clicks "Conectar Mercado Pago" → redirect to MP's authorisation URL including a `state`
value we generate and verify → NGO approves → MP calls our registered redirect URL with a `code`
(valid 10 minutes) → we exchange it at `/oauth/token` for that NGO's `access_token` and
`refresh_token` → both stored encrypted.

Refresh is **lazy**: on a 401 from any MP call, exchange the refresh token, retry once. Tokens last
180 days, so a scheduled refresh job would be pure overhead at this stage.

### 2. Donate

Donor opens a goal page, enters an amount, clicks donate. We create an MP **preference per
donation** — not per goal, since donors choose their own amount — on the NGO's account using the
NGO's token, stamped `external_reference = <goal_id>`. Donor is redirected to MP Checkout.

Money lands directly in the NGO's account. We never hold funds and take no commission, so Split
Payments is not used.

### 3. Ingest

A Cron Trigger walks each connected NGO and calls `GET /v1/payments/search` with that NGO's token,
filtered by **date range only** — one call per NGO, not one per goal. Each returned payment is
attributed by matching its `external_reference` against that NGO's goal ids; approved payments are
upserted as contributions, **idempotent on `mp_payment_id`**. Payments whose `external_reference`
matches no known goal are ignored (see Open question 1 — they are the raw material for a future
review queue).

Polling rather than webhooks: it is simpler, has no public-endpoint requirement, and a minute of
latency is meaningless for a progress bar. `payments/search` only returns the last 12 months —
irrelevant now, but a real constraint for any future backfill.

### 4. Display

Public goal pages read **only our database**, never MP live. Pages stay fast, and an MP outage
degrades data freshness instead of breaking the site.

## Data model

```
ngo           id, name, slug, mp_user_id, status,
              access_token_enc, refresh_token_enc, token_expires_at, connected_at

goal          id, ngo_id, title, description, target_amount, currency, status, created_at

contribution  id, goal_id, source, mp_payment_id (unique, nullable),
              amount, status, paid_at, note, created_at
```

- Amounts are **integer centavos**. No floats anywhere.
- Currency is ARS only.
- `contribution.source` is `platform` or `manual`. This column is load-bearing: it lets us render
  either the verified total or the full total without a migration.
- `mp_payment_id` is unique and nullable — null for manual entries, unique for platform ones, which
  is what makes re-ingestion idempotent.

## What the public number means

Donations to these NGOs arrive as a **mix** of alias transfers and payment links, so the platform
will structurally under-count. Decision:

> The headline figure is **total raised** — platform-captured plus NGO-entered manual adjustments.
> The platform-verified portion is stored separately and shown as secondary detail.

The cost is explicit: once manual entries count toward the headline, the platform is a publishing
surface for the NGO's own accounting, not an independent source of truth. A number an NGO typed in
is not a number we verified. This is accepted because a bar showing 30% when a campaign is really
at 80% is worse than useless and NGOs would abandon it.

For this build, manual reconciliation is **one amount field plus a note**, not a workflow.

## Modules

| Module | Responsibility |
|---|---|
| `mp/oauth` | Authorisation URL, callback, code exchange, refresh |
| `mp/payments` | Create preference, search payments |
| `credentials` | Encrypt/decrypt token storage; the only code touching raw tokens |
| `ingest` | Poller; maps MP payments to contributions |
| `goals` | Domain logic: totals, progress, target reached |
| `public` | Goal pages and progress bar |
| `admin` | NGO connect, goal CRUD, manual adjustments |

`mp/*` is the only code that knows Mercado Pago exists. `goals` and `public` operate on our own
contributions, keeping domain logic testable without a network.

## Error handling

- **Expired token** — refresh once, retry. If refresh fails, set NGO `status = disconnected` and
  show a reconnect banner in admin. Never silently stop ingesting: a stalled bar that looks healthy
  is the worst failure mode here.
- **MP unreachable** — poller logs and retries next tick. Public pages unaffected.
- **Duplicates** — unique constraint on `mp_payment_id`; the poller is a plain upsert, so
  overlapping runs are harmless.
- **Payment status** — only `approved` counts toward the bar. Pending and rejected are stored but
  excluded.
- **OAuth `state`** — generated and verified per attempt; mismatches rejected.

## Security

- NGO tokens encrypted at rest (AES-GCM, key in Workers Secrets).
- Admin auth is a single shared secret held by the **platform operator**, who administers every
  NGO's goals. NGOs do **not** get their own logins in this build — a single shared secret cannot
  keep one NGO out of another's goals, so pretending otherwise would be a security theatre.
  Per-NGO accounts are the first thing to build after the POC.
- The connect flow is therefore operator-initiated: the operator generates a per-NGO connect link,
  the NGO opens it and approves in their own Mercado Pago account. The NGO authorises its own money
  without needing an account on our platform.
- Donor personal data is **not stored**. We keep amount, timestamp, MP payment id, goal id, and
  nothing MP returns about the payer.
- Pilot NGOs get a plain-language statement of what the token they grant can do.

## Testing

`mp/*` sits behind an interface with a fake implementation, so ingestion and attribution are fully
unit-testable with no network.

Cases that matter: idempotent re-ingestion; only-approved-counts; attribution to the correct goal;
platform and manual contributions summing correctly; refresh-on-401 retrying exactly once.

One manual end-to-end against MP test users, using the test cards with cardholder name as the
control: `APRO` (approved), `OTHE` (rejected), `CONT` (pending) — proving rejected and pending do
not move the bar.

## Pipeline

- GitHub repository, `main` as the deploy branch.
- GitHub Actions on push to `main`: install, typecheck, test, `wrangler deploy` to prod.
- Pull requests: install, typecheck, test only.
- Cloudflare API token stored as a repository secret. D1 migrations applied via Wrangler as a
  deploy step.

## Assumptions

1. Donations that must appear automatically arrive through MP Checkout. Bare alias/CVU transfers
   are out of scope for automatic capture and are handled by manual adjustment.
2. OAuth is self-serve and needs no MP partner agreement — the OAuth documentation states no
   approval requirement, but this is inferred from its absence rather than an explicit statement.
3. MP sandbox OAuth (`test_token: true`) is sufficient to build and test the full connect flow.

## Open questions

These are empirical checks for the first week. None blocks starting; the core is identical either
way.

1. **Does an NGO's OAuth token return payments our app did not create?** Undocumented. If yes, the
   NGO's own payment links become visible and could later feed a review queue for goal assignment —
   a much better reconciliation story than typed totals. Phase two regardless.
2. **Can production OAuth credentials be activated without an Empresa account?** MP's credentials
   documentation lists only industry, website URL and T&C. Third-party guides claim a business
   account is needed; unverified either way.
3. **Confirm the `.com.ar` domain and social handles** for any public name before committing to it.
