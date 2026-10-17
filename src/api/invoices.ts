// v7 GST tax invoices — typed client + hooks (owner: invoices workstream).
import { http } from './http'
import { useApi } from './query'
import type { InvoiceParty, InvoiceSettings } from '@/types/v7'
import type { BillableHours, InvoiceDetail, InvoiceInput, InvoiceListResult, InvoiceTotals, Issue, PrefillMilestone } from '@/mock/routes/invoices'

export type { AgeBucket, BillableHours, InvoiceDetail, InvoiceDisplayStatus, InvoiceInput, InvoiceListResult, InvoiceListRow, InvoiceTotals, Issue, PrefillMilestone, TaxMode } from '@/mock/routes/invoices'
export type { InvoiceLine, InvoiceParty, InvoiceSettings } from '@/types/v7'

export type ViewSettings = InvoiceSettings & { account_masked: string; can_edit: boolean }
export interface InvoiceMeta {
  states: { code: string; name: string }[]
  units: string[]
  gst_rates: number[]
  settings: ViewSettings
  seller: InvoiceParty
  projects: { id: string; code: string; name: string; client: string; billing_model: string; status: string }[]
  clients: { id: string; name: string; gstin: string; state: string; country: string }[]
  next_number: string
  today: string
}
export interface Prefill {
  draft: InvoiceInput
  project: { id: string; code: string; name: string; client: string; billing_model: string; stream: string; status: string }
  milestones: PrefillMilestone[]
  payment_terms_days: number
  client_found: boolean
}
export interface Preview {
  totals: InvoiceTotals
  issues: Issue[]
  next_number: string
}
export type SaveBody = InvoiceInput & { id?: string; issue?: boolean; save_client?: boolean }
export interface PaymentBody {
  received_paise: number
  tds_paise: number
  paid_on: string
  reference: string
  mode: string
}

export const invoicesApi = {
  list: () => http.get<InvoiceListResult>('/finance/invoices'),
  meta: () => http.get<InvoiceMeta>('/finance/invoices/meta'),
  get: (id: string) => http.get<InvoiceDetail>(`/finance/invoices/${id}`),
  prefill: (projectId: string, milestoneIds: string[]) => http.get<Prefill>('/finance/invoices/prefill', { project_id: projectId, milestone_ids: milestoneIds.join(',') }),
  milestones: (projectId: string, invoiceId?: string) => http.get<PrefillMilestone[]>('/finance/invoices/project-milestones', { project_id: projectId, invoice_id: invoiceId ?? '' }),
  billableHours: (projectId: string, from: string, to: string, invoiceId?: string) => http.get<BillableHours>('/finance/invoices/billable-hours', { project_id: projectId, from, to, invoice_id: invoiceId ?? '' }),
  clientParty: (clientId: string) => http.get<{ party: InvoiceParty; payment_terms_days: number }>('/finance/invoices/client-party', { client_id: clientId }),
  preview: (b: SaveBody) => http.post<Preview>('/finance/invoices/preview', b),
  create: (b: SaveBody) => http.full<InvoiceDetail>('POST', '/finance/invoices', { body: b }),
  save: (id: string, b: SaveBody, version?: number) => http.full<InvoiceDetail>('PATCH', `/finance/invoices/${id}`, { body: b, ifMatch: version }),
  saveNotes: (id: string, notes: string, version?: number) => http.full<InvoiceDetail>('PATCH', `/finance/invoices/${id}`, { body: { notes }, ifMatch: version }),
  issue: (id: string, number?: string) => http.full<InvoiceDetail>('POST', `/finance/invoices/${id}/issue`, { body: { number } }),
  discard: (id: string, version?: number) => http.del<{ ok: true }>(`/finance/invoices/${id}`, version),
  cancel: (id: string, reason: string) => http.full<InvoiceDetail>('POST', `/finance/invoices/${id}/cancel`, { body: { reason } }),
  pay: (id: string, b: PaymentBody, version?: number) => http.full<{ fully_paid: boolean; detail: InvoiceDetail }>('POST', `/finance/invoices/${id}/payments`, { body: b, ifMatch: version }),
  email: (id: string, b: { to: string; cc: string; subject: string; message: string }) => http.full<{ ok: true; outbox_id: string; detail: InvoiceDetail }>('POST', `/finance/invoices/${id}/email`, { body: b }),
  duplicate: (id: string) => http.full<InvoiceDetail>('POST', `/finance/invoices/${id}/duplicate`),
  settings: () => http.get<ViewSettings>('/finance/invoices/settings'),
  saveSettings: (b: Partial<InvoiceSettings>) => http.full<ViewSettings>('PUT', '/finance/invoices/settings', { body: b }),
}

/** An invoice touches revenue, the ledger, P&L, the CEO dashboard, project money, milestones and clients. */
export const INVOICE_INVALIDATE = [['invoices'], ['invoice'], ['ledger'], ['pnl'], ['projects'], ['project'], ['dash'], ['reports'], ['finance'], ['clients'], ['invoice-next']]

export function useInvoices() {
  return useApi(['invoices'], invoicesApi.list)
}
export function useInvoiceMeta() {
  return useApi(['invoices', 'meta'], invoicesApi.meta, { staleTime: 30_000 })
}
export function useInvoice(id: string | undefined) {
  return useApi(['invoice', id], () => invoicesApi.get(id!), { enabled: !!id })
}
