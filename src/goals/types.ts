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
