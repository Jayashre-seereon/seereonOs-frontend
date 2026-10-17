// Spend & commercial client: expenses, purchases (vendors, POs, bills), budgets, revenue leakage.
import { http } from './http'
import { useApi } from './query'
import type { LeakageKind, POLine, RevenueLeakage } from '@/types/business'
import type {
  BudgetStatement, ExpenseDetail, ExpenseList, ExpenseTab, LeakageResult, PurchasesResult, SpendMeta, SpendSummary,
} from '@/mock/routes/spend'
import type { ExpenseCategory } from '@/modules/spend/labels'

export type {
  AgeingBucket, BillRow, BudgetLine, BudgetStatement, ExpenseDetail, ExpenseList, ExpenseRow, ExpenseTab, LeakageResult, LeakageRow, PORow, PurchasesResult, SpendMeta, SpendSummary,
  UnbudgetedItem, VendorRow,
} from '@/mock/routes/spend'

export interface FileInput {
  name: string
  mime: string
  size_bytes: number
  data_url: string
}
export interface ExpenseInput {
  category: ExpenseCategory
  description: string
  amount_paise: number
  spent_on: string
  project_id: string | null
  billable_to_client: boolean
  receipt?: FileInput | null
  remove_receipt?: boolean
  submit?: boolean
}
export interface VendorInput {
  name: string
  category: string
  gstin: string
  pan: string
  contact: string
  email: string
  phone: string
  payment_terms_days: number
}
export interface POInput {
  vendor_id: string
  title: string
  project_id: string | null
  budget_category: string
  lines: POLine[]
  gst_pct: number
  needed_by: string | null
  justification: string | null
  submit?: boolean
}
export interface BillInput {
  vendor_id: string
  po_id: string | null
  number: string
  bill_date: string
  due_on?: string | null
  amount_paise: number
  gst_paise: number
  tds_paise: number
  category?: string | null
  description?: string
  file?: FileInput | null
}
export interface BudgetInput {
  fy_start_year: number
  kind: 'expense' | 'revenue'
  category: string
  owner_id: string | null
  monthly_paise: number[]
  notes: string
}
export interface LeakageInput {
  kind: LeakageKind
  amount_paise: number
  date: string
  client: string
  project_id: string | null
  reason: string
  recoverable: boolean
  status: RevenueLeakage['status']
  recovered_paise: number
}

export const spendApi = {
  meta: () => http.get<SpendMeta>('/spend/meta'),
  summary: () => http.get<SpendSummary>('/spend/summary'),
  expenses: (tab: ExpenseTab, f: { status?: string; q?: string } = {}) => http.get<ExpenseList>('/expenses', { tab, ...f }),
  expense: (id: string) => http.get<ExpenseDetail>(`/expenses/${id}`),
  createExpense: (b: ExpenseInput) => http.full<ExpenseDetail>('POST', '/expenses', { body: b }),
  updateExpense: (id: string, b: Partial<ExpenseInput>, version?: number) => http.full<ExpenseDetail>('PATCH', `/expenses/${id}`, { body: b, ifMatch: version }),
  submitExpense: (id: string, version?: number) => http.full('POST', `/expenses/${id}/submit`, { ifMatch: version }),
  deleteExpense: (id: string, version?: number) => http.del(`/expenses/${id}`, version),
  approveExpense: (id: string, note?: string, version?: number) => http.full('POST', `/expenses/${id}/approve`, { body: { note }, ifMatch: version }),
  rejectExpense: (id: string, reason: string, version?: number) => http.full('POST', `/expenses/${id}/reject`, { body: { reason }, ifMatch: version }),
  payExpense: (id: string, paid_on?: string, version?: number) => http.full('POST', `/expenses/${id}/pay`, { body: { paid_on }, ifMatch: version }),

  purchases: () => http.get<PurchasesResult>('/purchases'),
  createVendor: (b: VendorInput) => http.full('POST', '/vendors', { body: b }),
  updateVendor: (id: string, b: Partial<VendorInput>, version?: number) => http.full('PATCH', `/vendors/${id}`, { body: b, ifMatch: version }),
  blockVendor: (id: string, reason: string) => http.full('POST', `/vendors/${id}/block`, { body: { reason } }),
  unblockVendor: (id: string) => http.full('POST', `/vendors/${id}/unblock`, { body: {} }),
  createPO: (b: POInput) => http.full('POST', '/purchase-orders', { body: b }),
  updatePO: (id: string, b: Partial<POInput>, version?: number) => http.full('PATCH', `/purchase-orders/${id}`, { body: b, ifMatch: version }),
  submitPO: (id: string, justification?: string | null) => http.full('POST', `/purchase-orders/${id}/submit`, { body: { justification } }),
  approvePO: (id: string, version?: number) => http.full('POST', `/purchase-orders/${id}/approve`, { body: {}, ifMatch: version }),
  rejectPO: (id: string, reason: string, version?: number) => http.full('POST', `/purchase-orders/${id}/reject`, { body: { reason }, ifMatch: version }),
  closePO: (id: string) => http.full('POST', `/purchase-orders/${id}/close`, { body: {} }),
  deletePO: (id: string, version?: number) => http.del(`/purchase-orders/${id}`, version),
  createBill: (b: BillInput) => http.full('POST', '/vendor-bills', { body: b }),
  approveBill: (id: string, version?: number) => http.full('POST', `/vendor-bills/${id}/approve`, { body: {}, ifMatch: version }),
  payBill: (id: string, paid_on?: string, version?: number) => http.full('POST', `/vendor-bills/${id}/pay`, { body: { paid_on }, ifMatch: version }),
  disputeBill: (id: string, reason: string) => http.full('POST', `/vendor-bills/${id}/dispute`, { body: { reason } }),
  resolveBill: (id: string) => http.full('POST', `/vendor-bills/${id}/resolve`, { body: {} }),

  budgets: (fy: number) => http.get<BudgetStatement>('/budgets', { fy }),
  saveBudget: (b: BudgetInput, version?: number) => http.full('PUT', '/budgets', { body: b, ifMatch: version }),
  deleteBudget: (id: string, version?: number) => http.del(`/budgets/${id}`, version),
  copyBudgets: (b: { from_fy: number; to_fy: number; growth_pct: number; overwrite: boolean }) => http.full<{ created: number; replaced: number; skipped: number }>('POST', '/budgets/copy', { body: b }),

  leakage: (fy: number) => http.get<LeakageResult>('/leakage', { fy }),
  createLeakage: (b: LeakageInput) => http.full('POST', '/leakage', { body: b }),
  updateLeakage: (id: string, b: Partial<LeakageInput>, version?: number) => http.full('PATCH', `/leakage/${id}`, { body: b, ifMatch: version }),
  deleteLeakage: (id: string, version?: number) => http.del(`/leakage/${id}`, version),
}

/** Every spend write can move budgets, the ledger, P&L, dashboards and client pages. */
export const SPEND_INVALIDATE = [['expenses'], ['expense'], ['purchases'], ['budgets'], ['leakage'], ['spend-summary'], ['ledger'], ['pnl'], ['dash'], ['clients'], ['client'], ['approvals'], ['inbox']]

export function useSpendMeta() {
  return useApi(['spend-meta'], spendApi.meta, { staleTime: 60_000 })
}
export function useExpenses(tab: ExpenseTab, f: { status?: string; q?: string } = {}) {
  return useApi(['expenses', tab, f], () => spendApi.expenses(tab, f))
}
export function useExpense(id: string | null) {
  return useApi(['expense', id], () => spendApi.expense(id!), { enabled: !!id })
}
export function usePurchases() {
  return useApi(['purchases'], spendApi.purchases)
}
export function useBudgets(fy: number) {
  return useApi(['budgets', fy], () => spendApi.budgets(fy))
}
export function useLeakage(fy: number) {
  return useApi(['leakage', fy], () => spendApi.leakage(fy))
}
export function useSpendSummary(enabled = true) {
  return useApi(['spend-summary'], spendApi.summary, { enabled })
}

/** Read a picked file into the upload payload the API expects. */
export function readFile(f: File): Promise<FileInput> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res({ name: f.name, mime: f.type || 'application/octet-stream', size_bytes: f.size, data_url: String(r.result) })
    r.onerror = () => rej(r.error)
    r.readAsDataURL(f)
  })
}
