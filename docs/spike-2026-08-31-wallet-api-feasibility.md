# Spike: reading donations from an Argentine wallet via API

**Date:** 2026-08-31
**Question:** For a fundraising-goal web app, can we read incoming donations (and ideally balance)
from an Argentine wallet account through an API, attributed per goal?
**Status:** Answered. Research only — no code written.

## Reframe applied

The original framing was "read the wallet balance." That is the wrong signal for a progress bar:
balance *decreases* when the organisation spends the money the fundraiser was for, and is polluted
by fees, refunds, withdrawals and unrelated movements. The requirement is **cumulative incoming
donations attributable to a goal**, which is monotonic. Balance-read was demoted to an optional
reconciliation check.

## Pass/fail table

| Provider | Self-serve creds (no partner deal) | Incoming money readable | Per-goal attribution | Balance readable |
|---|---|---|---|---|
| **Mercado Pago** | Yes — Access Token from the developer panel | Yes, for money arriving through MP collection flows | Yes — `external_reference` | Partial — async CSV/XLSX report, not a live number |
| **Ualá Bis** | Yes — credentials requested in-app | Only orders created through their own API | Not documented | No |
| **Belvo** | n/a | n/a | n/a | **Argentina not covered** (Brazil + Mexico only) |
| **Prometeo** | n/a | n/a | n/a | Argentina listed as "underway", not live |
| **Lemon / Belo** | No public account-data API | No | No | No |
| **MODO** | No public developer API found | No | No | No |
| **Bank business APIs** | No — bilateral/private agreement | — | — | — |

## Key findings

### There is no open-banking regime to lean on

Argentina has **no mandated open banking / open finance regulation**. The BCRA has issued
Communications "A" 7514 and 7769 covering payment service providers offering payment accounts
(PSPCP), and has spoken about open finance directionally, but has **published no API
specification**. Bank data sharing today happens only through bilateral private agreements.
Transferencias 3.0, DEBIN and interoperable QR are *payment rails*, not account-information APIs.
Conclusion: there is no PSD2 equivalent to build against — this branch is closed.

### Mercado Pago is the only viable option, but only for money it collects

- `GET /v1/payments/search` accepts `external_reference`, `begin_date`/`end_date` (max 365-day
  interval), `range`, `status`, `sort`/`criteria`, `store_id`, `collector.id`. Auth is a Bearer
  Access Token from the developer panel.
- Webhooks fire `payment.created` and `payment.updated` to a configured HTTPS endpoint, signed
  with a secret, and retry for up to 4 days on non-2xx. This makes near-real-time updates viable
  without polling.
- `external_reference` is the per-goal attribution mechanism: **one MP account can serve N goals**.
  No need for a separate account per fundraiser.

### The significant caveat: plain CVU transfers are probably invisible

The documented `TRANSACTION_TYPE` values in the Account Money ("Todas las transacciones") report
are `SETTLEMENT`, `REFUND`, `CHARGEBACK`, `DISPUTE`, `WITHDRAWAL`, `WITHDRAWAL_CANCEL`, `PAYOUT` —
payment-centric, with the only transfer types being **outbound**. No documented type represents an
incoming P2P transfer to the account's CVU.

This matters because the most natural donation gesture in Argentina is transferring to an
alias/CVU. Such a donation would likely never reach the API at all. **Not verified against a live
account** — worth a 10-minute empirical test before committing.

Design consequence: donors must be routed through an MP **checkout / payment link** so the donation
becomes a queryable *payment*, not a bare transfer.

### Balance is a report, not an endpoint

There is no live balance field. `POST /v1/account/settlement_report` creates a report over a date
range (202 Accepted), then `GET /v1/account/settlement_report/{file_name}` downloads CSV/XLSX.
Usable as a nightly reconciliation job; unusable as a progress-bar data source.

### Credentials caveat

Production credentials require completing business details, and reports indicate a **Empresa**
(business) account may be required — personal accounts can be limited. Needs confirming against
the actual account this project will use.

## Recommendation

Provider checkout + webhook → **our own database is the source of truth**:

1. Each goal owns an MP payment preference carrying `external_reference = <goal id>`.
2. The webhook writes confirmed donations to our DB; the progress bar reads our DB, never MP live.
3. A nightly `payments/search` sweep backfills anything the webhook dropped (idempotent on payment id).
4. The settlement report reconciles periodically.
5. An **admin manual-adjustment field is required regardless** — cash donations and off-platform
   transfers will never appear in any API, and the goal total must be able to account for them.

Balance-read is not part of the architecture. Ualá Bis is a possible second payment method later,
but it adds no capability MP lacks.

## Open items before building

- Empirically confirm whether a CVU transfer surfaces in `payments/search` on a real account.
- Confirm whether the intended MP account can obtain production credentials (personal vs Empresa).
- Decide how donor identity/anonymity is handled — MP returns payer data we may not want to store.

## Sources

- https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro/search-payments/get
- https://www.mercadopago.com.ar/developers/en/docs/reports/account-money/report-fields
- https://omega.mercadopago.com.br/developers/en/reference/settlements-report/create-report/post
- https://www.mercadopago.com.mx/developers/es/docs/checkout-pro/additional-content/notifications/webhooks
- https://developers.ualabis.com.ar/v2
- https://developers.belvo.com/developer_resources/resources-available-institutions
- https://prometeoapi.com/en
- https://www.fiskil.com/es/open-finance/argentina
- https://www.openbankingtracker.com/regulator/argentina
