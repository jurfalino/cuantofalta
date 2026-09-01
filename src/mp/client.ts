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

export interface GetPaymentInput {
  accessToken: string
  paymentId: string
}

export interface MercadoPagoClient {
  createPreference(input: CreatePreferenceInput): Promise<{ preferenceId: string; initPoint: string }>
  searchPayments(input: SearchPaymentsInput): Promise<MpPayment[]>
  // Looks up one payment by id regardless of age — used to re-check a
  // payment still `pending` from a previous, now out-of-window, poll (see
  // recheckPendingContributions in ingest/poller.ts). Returns null when MP
  // has no such payment (404); throws (with "401" in the message) on an
  // auth failure so withTokenRefresh can retry it like any other call.
  getPayment(input: GetPaymentInput): Promise<MpPayment | null>
}

export function normalizePaymentStatus(raw: unknown): MpPayment['status'] {
  if (raw === 'approved') return 'approved'
  if (raw === 'pending' || raw === 'in_process' || raw === 'authorized' || raw === 'in_mediation') {
    return 'pending'
  }
  return 'rejected'
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
    const j = (await res.json()) as { id: string; init_point: string }
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
    const j = (await res.json()) as { results: Array<Record<string, any>> }
    return j.results.map((r) => ({
      id: String(r.id),
      status: normalizePaymentStatus(r.status),
      transactionAmountCents: Math.round(Number(r.transaction_amount) * 100),
      externalReference: r.external_reference ?? null,
      dateApproved: r.date_approved ?? null,
    }))
  }

  async getPayment(input: GetPaymentInput): Promise<MpPayment | null> {
    const res = await fetch(`${API}/v1/payments/${encodeURIComponent(input.paymentId)}`, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`MP getPayment failed: ${res.status}`)
    const r = (await res.json()) as Record<string, any>
    return {
      id: String(r.id),
      status: normalizePaymentStatus(r.status),
      transactionAmountCents: Math.round(Number(r.transaction_amount) * 100),
      externalReference: r.external_reference ?? null,
      dateApproved: r.date_approved ?? null,
    }
  }
}
