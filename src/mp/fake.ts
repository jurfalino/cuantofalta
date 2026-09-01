import type { MercadoPagoClient, MpPayment, CreatePreferenceInput, SearchPaymentsInput, GetPaymentInput } from './client'

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

  async getPayment(input: GetPaymentInput): Promise<MpPayment | null> {
    if (this.failNextWith401) {
      this.failNextWith401 = false
      throw new Error('MP getPayment failed: 401')
    }
    return this.payments.find((p) => p.id === input.paymentId) ?? null
  }
}
