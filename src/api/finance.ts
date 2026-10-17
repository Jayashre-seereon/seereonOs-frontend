// Module D — Finance (ledger, invoice register, P&L) and Operations register clients.
import { http } from './http'
import { useApi } from './query'
import type { LedgerEntry, OpsItem, Payment, Invoice, RevenueStream } from '@/types/entities'
import type { InvoicesResult, LedgerEntriesResult, LedgerResult, PnlResult } from '@/mock/routes/finance'
import type { OpsResult, OpsRow } from '@/mock/routes/operations'

export type { AgeBucket, InvoiceRow, InvoiceState, InvoicesResult, LedgerEntriesResult, LedgerEntryRow, LedgerResult, LedgerRow, PnlLine, PnlResult } from '@/mock/routes/finance'
export type { OpsGroup, OpsResult, OpsRow } from '@/mock/routes/operations'

export interface LedgerFilters {
  from: string
  to: string
  kind?: string
  category?: string
  status?: string
  project_id?: string
  stream?: string
  q?: string
}
export type LedgerInput = Pick<LedgerEntry, 'kind' | 'category' | 'description' | 'amount_paise' | 'date' | 'recurring' | 'until_on' | 'status' | 'project_id' | 'stream'>
export type OpsInput = Pick<OpsItem, 'item' | 'category' | 'owner_id' | 'due_on' | 'recurring' | 'notes'>

export const financeApi = {
  entries: (scope: 'fy' | 'all') => http.get<LedgerEntriesResult>('/finance/ledger/entries', { scope }),
  ledger: (f: LedgerFilters) => http.get<LedgerResult>('/finance/ledger', f as unknown as Record<string, unknown>),
  addLedger: (b: LedgerInput) => http.full<LedgerEntry>('POST', '/finance/ledger', { body: b }),
  updateLedger: (id: string, b: Partial<LedgerInput>, version?: number) => http.full<LedgerEntry>('PATCH', `/finance/ledger/${id}`, { body: b, ifMatch: version }),
  removeLedger: (id: string, version?: number) => http.del<{ ok: true }>(`/finance/ledger/${id}`, version),
  invoices: () => http.get<InvoicesResult>('/finance/invoices'),
  recordPayment: (id: string, b: { amount_paise: number; paid_on: string; reference: string }, version?: number) =>
    http.full<{ invoice: Invoice; payment: Payment; fully_paid: boolean }>('POST', `/finance/invoices/${id}/payments`, { body: b, ifMatch: version }),
  pnl: (from: string, to: string) => http.get<PnlResult>('/finance/pnl', { from, to }),
  projects: () => http.get<ProjectLite[]>('/finance/projects-lite'),
}
export interface ProjectLite {
  id: string
  code: string
  name: string
  client: string
  stream: RevenueStream
  status: string
}
export function useProjectsLite() {
  return useApi(['projects', 'lite-finance'], financeApi.projects, { staleTime: 60_000 })
}

export const opsApi = {
  list: (f: { owner_id?: string; q?: string } = {}) => http.get<OpsResult>('/ops', f),
  add: (b: OpsInput) => http.full<OpsRow>('POST', '/ops', { body: b }),
  update: (id: string, b: Partial<OpsInput>, version?: number) => http.full<OpsRow>('PATCH', `/ops/${id}`, { body: b, ifMatch: version }),
  done: (id: string, done_on?: string) => http.full<{ item: OpsRow; late: boolean; next_due: string | null }>('POST', `/ops/${id}/done`, { body: { done_on } }),
  remove: (id: string, version?: number) => http.del<{ ok: true }>(`/ops/${id}`, version),
}

/** Ledger, invoices and payments all feed the P&L, project money tabs and the CEO dashboard. */
export const FINANCE_INVALIDATE = [['ledger'], ['invoices'], ['pnl'], ['projects'], ['project'], ['dash'], ['reports']]

export function useLedgerEntries(scope: 'fy' | 'all') {
  return useApi(['ledger', 'entries', scope], () => financeApi.entries(scope))
}
export function useLedger(f: LedgerFilters) {
  return useApi(['ledger', f], () => financeApi.ledger(f))
}
export function useInvoiceRegister() {
  return useApi(['invoices'], financeApi.invoices)
}
export function usePnl(from: string, to: string) {
  return useApi(['pnl', from, to], () => financeApi.pnl(from, to))
}
export function useOps(f: { owner_id?: string; q?: string }) {
  return useApi(['ops', f], () => opsApi.list(f))
}
