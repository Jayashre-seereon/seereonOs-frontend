// Spend & commercial: expense claims, vendors, purchase orders, vendor bills, budgets (budget vs
// actual + unbudgeted spend) and the revenue-leakage register. Every rupee is computed here; the
// screens only format. Approval endpoints follow the shared v3 contract in CONVENTIONS.md.
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import {
  err, find, has, hasAny, insert, logActivity, notify, nextNumber, nowISO, remove, requireAction, rows, update, userName, usersWith, warn, type Ctx, type Router,
} from '../server'
import { costedEntries, expandLedger, revenueBetween } from '../analytics'
import { addDays, addMonths, diffDays, fyLabel, fyRange, fyStartYear, isRealISODate, monthOf } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { STREAM } from '@/domain/labels'
import {
  BUDGET_EXPENSE_CATEGORIES, EXPENSE_CATEGORY, EXPENSE_CATEGORY_LABEL, EXPENSE_MAX_AGE_DAYS, GSTIN_RE, LEAKAGE_KIND, MANUAL_LEAKAGE_KINDS, PAN_RE, RECEIPT_LIMIT_PAISE,
  SECOND_APPROVAL_PAISE, type ExpenseCategory,
} from '@/modules/spend/labels'
import { advanceApproval, approvalRoute, ensureWf, escalationTarget, startApproval, stepDue, stepLabel, wfClear, wfPatch, type RouteStep, type WfState } from '../workflows'
import { assertBaseVersion, needsChecker, pendingBrief, propose, registerApplier, type PendingBrief } from '../makerChecker'

/* ------------------------------------------------------------------ */
/* Stored extensions (optional fields kept on the rows)                */
/* ------------------------------------------------------------------ */
// Approval-workflow state (wf_*) is stored on claims, POs and bills — see src/mock/workflows.ts.
export type ExpenseX = B.ExpenseClaim & Partial<WfState> & { first_approved_by?: string | null; submitted_at?: string | null }
export type POX = B.PurchaseOrder & Partial<WfState> & { title?: string; over_budget?: boolean; justification?: string | null; budget_remaining_paise?: number | null }
export type BillX = B.VendorBill & Partial<WfState> & { approved_by?: string | null; approver_id?: string | null; dispute_reason?: string | null; category?: string | null; description?: string }
/** Vendor bank details are stored with the vendor (v4); bank and tax fields are maker-checked. */
export type VendorX = B.Vendor & { bank_name?: string; bank_account?: string; ifsc?: string }
const VENDOR_SENSITIVE = ['gstin', 'pan', 'bank_name', 'bank_account', 'ifsc'] as const
const VENDOR_FIELD_LABEL: Record<string, string> = { name: 'Name', category: 'Category', gstin: 'GSTIN', pan: 'PAN', contact: 'Contact', email: 'Email', phone: 'Phone', payment_terms_days: 'Payment terms (days)', bank_name: 'Bank', bank_account: 'Account number', ifsc: 'IFSC' }
export const maskAccount = (a: string | null | undefined) => (a ? (a.length > 4 ? '•••• ' + a.slice(-4) : a) : '')
export type LeakX = B.RevenueLeakage & { client_id?: string | null }

/* ------------------------------------------------------------------ */
/* Contracts shared with src/api/spend.ts                              */
/* ------------------------------------------------------------------ */
export interface ExpenseRow extends ExpenseX {
  user_name: string
  approver_name: string
  decided_by_name: string
  first_approved_by_name: string | null
  project_code: string | null
  project_name: string | null
  client: string | null
  ledger_category: string
  receipt_name: string | null
  duplicate: boolean
  step: 'manager' | 'admin' | null
  /** "Step 2 of 2 · CEO approval" on multi-step chains */
  step_label: string | null
  route: RouteStep[] | null
  due_on: string | null
  escalates_to: string | null
  can_edit: boolean
  can_approve: boolean
  can_pay: boolean
}
export type ExpenseTab = 'mine' | 'approve' | 'pay' | 'all'
export interface ExpenseList {
  tab: ExpenseTab
  items: ExpenseRow[]
  counts: Record<ExpenseTab, number | null>
  totals: { claimed: number; pending: number; approved_unpaid: number; paid: number; rejected: number; out_of_budget: number }
  can: { approve: boolean; pay: boolean; all: boolean }
}
export interface ExpenseDetail extends ExpenseRow {
  receipt: { id: string; name: string; mime: string; data_url: string | null } | null
  history: { at: string; actor: string; action: string; summary: string }[]
}
export interface SpendMeta {
  expense_categories: { value: ExpenseCategory; label: string; ledger: string }[]
  budget_categories: string[]
  revenue_streams: { value: E.RevenueStream; label: string }[]
  projects: { id: string; code: string; name: string; client: string; billing_model: E.BillingModel }[]
  vendors: { id: string; name: string; status: 'active' | 'blocked'; payment_terms_days: number; category: string }[]
  today: string
  fy_start_year: number
  fy_start_month: number
}

export interface VendorRow extends Omit<VendorX, 'bank_account'> {
  bank_account_masked: string
  /** Full number only for people who manage procurement. */
  bank_account?: string
  pending_change: PendingBrief | null
  open_pos: number
  billed_fy: number
  payable: number
  overdue: number
}
export interface PORow extends POX {
  vendor_name: string
  vendor_status: 'active' | 'blocked'
  project_code: string | null
  project_name: string | null
  requested_by_name: string
  decided_by_name: string
  total_paise: number
  gst_amount_paise: number
  billed_paise: number
  balance_paise: number
  bills: number
  approver_name: string
  step_label: string | null
  route: RouteStep[] | null
  /** Viewer may approve / reject this PO (current approver or spend authority, pending). */
  can_approve: boolean
}
export interface BillRow extends BillX {
  vendor_name: string
  po_number: string | null
  po_amount_paise: number | null
  over_po_pct: number | null
  total_paise: number // amount + GST
  net_payable_paise: number // amount + GST − TDS
  days_overdue: number
  approved_by_name: string
  file_name: string | null
  approver_name: string
  step_label: string | null
  /** Viewer may approve this bill for payment (current approver or spend authority, received). */
  can_approve: boolean
}
export interface AgeingBucket {
  key: 'not_due' | '0_30' | '31_60' | '61_90' | '90_plus'
  label: string
  amount: number
  count: number
}
export interface PurchasesResult {
  vendors: VendorRow[]
  pos: PORow[]
  bills: BillRow[]
  ageing: AgeingBucket[]
  /** Viewer holds spend authority (approves POs and bills). */
  can_approve: boolean
  /** New vendors and tax / bank changes need a second person (maker-checker on for vendors). */
  vendor_checked: boolean
  totals: { open_po_value: number; pending_po: number; payable: number; overdue: number; paid_fy: number; disputed: number }
}

export interface BudgetLine {
  id: string | null
  version: number | null
  kind: 'expense' | 'revenue'
  category: string
  label: string
  owner_id: string | null
  notes: string
  monthly_budget: number[]
  monthly_actual: number[]
  monthly_committed: number[]
  budget_total: number
  ytd_budget: number
  ytd_actual: number // actual + committed through the current month
  ytd_variance: number // budget − actual (expense: negative = over); revenue: actual − budget
  ytd_variance_pct: number | null
  fy_actual: number
  over: boolean
  has_budget: boolean
  pending_change?: PendingBrief | null
}
export interface UnbudgetedItem {
  key: string
  source: 'ledger' | 'expense' | 'bill' | 'po'
  ref_id: string
  date: string
  category: string
  description: string
  amount: number
  excess: number
  reason: 'no_budget' | 'over_budget'
  state: 'actual' | 'committed' | 'commitment'
  approved_by: string | null
  approved_by_name: string
  justification: string | null
  counted: boolean
}
export interface BudgetStatement {
  fy_start_year: number
  fy_label: string
  months: string[]
  current_month_index: number // −1 when the FY is in the future, 12 when it is over
  expense: BudgetLine[]
  revenue: BudgetLine[]
  totals: {
    expense_budget: number; expense_ytd_budget: number; expense_ytd_actual: number; expense_committed: number
    revenue_budget: number; revenue_ytd_budget: number; revenue_ytd_actual: number
    unbudgeted: number; over_lines: number
  }
  monthly: { month: string; budget: number; actual: number }[]
  unbudgeted: UnbudgetedItem[]
  has_budgets: boolean
  prev_fy_has_budgets: boolean
}

export interface LeakageRow extends LeakX {
  kind_label: string
  project_code: string | null
  project_name: string | null
  recorded_by_name: string
  open_paise: number
  source: string | null // e.g. "Deal · Jewellery catalogue app"
}
export interface LeakageResult {
  fy_start_year: number
  fy_label: string
  items: LeakageRow[]
  summary: {
    total: number
    recovered: number
    net: number
    recoverable_open: number
    billed: number
    pct_of_billed: number | null
    by_kind: { kind: B.LeakageKind; label: string; amount: number; count: number }[]
    by_month: { month: string; amount: number }[]
    top_clients: { client: string; amount: number; count: number }[]
  }
}

export interface SpendSummary {
  month: string
  month_spend: number
  month_budget: number
  month_committed: number
  unbudgeted_fy: number
  pending_reimbursement: { amount: number; count: number }
  awaiting_approval: { amount: number; count: number }
  bills_payable: { amount: number; count: number; overdue: number }
  leakage_fy: number
  leakage_top: { kind: B.LeakageKind; label: string; amount: number }[]
  renewals: { id: string; client_id: string; client: string; title: string; kind: B.Contract['kind']; renewal_on: string; value_paise: number; days: number }[]
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const fyMonth = (ctx: Ctx) => ctx.tenant.settings['company.fy_start_month'] ?? 4
const curFy = (ctx: Ctx) => fyStartYear(ctx.today, fyMonth(ctx))
function fyMonths(ctx: Ctx, fy: number) {
  const { from } = fyRange(fy, fyMonth(ctx))
  return Array.from({ length: 12 }, (_, i) => monthOf(addMonths(from, i)))
}
/** Spend authority: final approver of claims above the second-approval limit, purchase orders and vendor bills.
 *  Held through budgets.manage (the budget owner) — CEO / Administrator by default. */
export const spendAuthority = (ctx: Ctx) => has(ctx, 'budgets.manage')
/** The person who holds spend authority (the top of the reporting line first). */
export function adminId(ctx: Ctx): string | null {
  const holders = usersWith(ctx, 'budgets.manage').sort((a, b) => Number(!!a.reports_to_id) - Number(!!b.reports_to_id))
  return holders[0]?.id ?? null
}
/** Who sees every claim: people who pay claims or own the budget. */
const seesAllClaims = (ctx: Ctx) => hasAny(ctx, 'expenses.pay', 'budgets.manage')
function money(v: unknown, field: string, label: string, allowZero = false): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || Math.round(n) !== n) err(422, 'VAL_AMOUNT', `${label} must be ${allowZero ? 'zero or more' : 'more than zero'}.`, field)
  if (n > 1_00_00_00_000_00) err(422, 'VAL_AMOUNT', `${label} looks too large. Check the number of zeros.`, field)
  return n
}
function needDate(v: unknown, field: string, label: string): string {
  const s = String(v ?? '')
  if (!isRealISODate(s)) err(422, 'VAL_DATE', `${label} is required.`, field)
  return s
}
function needText(v: unknown, field: string, label: string, min = 1, max = 300): string {
  const s = String(v ?? '').trim()
  if (s.length < min) err(422, 'VAL_REQUIRED', min > 1 ? `${label} needs at least ${min} characters.` : `${label} is required.`, field)
  if (s.length > max) err(422, 'VAL_TOO_LONG', `${label} is longer than ${max} characters.`, field)
  return s
}
type FileIn = { name: string; mime: string; size_bytes: number; data_url: string }
function saveFile(ctx: Ctx, f: FileIn | null | undefined, entity: string, field: string): string | null {
  if (!f) return null
  if (!f.name || !f.data_url) err(422, 'FILE_REJECTED', 'The file could not be read. Try again.', field)
  if (f.size_bytes > 10 * 1024 * 1024) err(422, 'FILE_REJECTED', 'The file is larger than 10 MB.', field)
  return insert(ctx, 'files', { name: f.name, mime: f.mime || 'application/octet-stream', size_bytes: f.size_bytes, entity, entity_id: '', data_url: f.data_url } as never).id
}
function linkFile(ctx: Ctx, fileId: string | null, entityId: string) {
  if (!fileId) return
  const f = rows(ctx, 'files').find((x) => x.id === fileId)
  if (f) f.entity_id = entityId
}
/** Stable maker-checker key for a budget line that doesn't exist yet. */
const budgetKey = (fy: number, kind: string, category: string) => `budget_${fy}_${kind}_${category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
const projectMap = (ctx: Ctx) => new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
const lc = (s: string) => s.trim().toLowerCase()

/* ------------------------------------------------------------------ */
/* Budget model: actuals from the ledger + committed claims and bills  */
/* ------------------------------------------------------------------ */
interface SpendItem {
  source: 'ledger' | 'expense' | 'bill'
  ref_id: string
  date: string
  category: string
  description: string
  amount: number
  state: 'actual' | 'committed'
  approved_by: string | null
}
function billCategory(ctx: Ctx, b: BillX): string {
  if (b.category) return b.category
  if (b.po_id) {
    const po = rows(ctx, 'purchase_orders').find((p) => p.id === b.po_id)
    if (po) return po.budget_category
  }
  return rows(ctx, 'vendors').find((v) => v.id === b.vendor_id)?.category ?? 'Other'
}
function spendItems(ctx: Ctx, from: string, to: string): SpendItem[] {
  const expenses = rows(ctx, 'expense_claims') as ExpenseX[]
  const bills = rows(ctx, 'vendor_bills') as BillX[]
  const pos = new Map((rows(ctx, 'purchase_orders') as POX[]).map((p) => [p.id, p]))
  const byLedger = new Map<string, { approved_by: string | null; source: 'expense' | 'bill'; id: string }>()
  for (const e of expenses) if (e.ledger_entry_id) byLedger.set(e.ledger_entry_id, { approved_by: e.decided_by, source: 'expense', id: e.id })
  for (const b of bills) if (b.ledger_entry_id) byLedger.set(b.ledger_entry_id, { approved_by: b.approved_by ?? (b.po_id ? pos.get(b.po_id)?.decided_by ?? null : null), source: 'bill', id: b.id })
  const out: SpendItem[] = []
  const lastActual = to < ctx.today ? to : ctx.today
  for (const l of expandLedger(ctx, from, lastActual)) {
    if (l.kind !== 'expense') continue
    const link = byLedger.get(l.id)
    out.push({ source: 'ledger', ref_id: l.id, date: l.occurrence, category: l.category, description: l.description, amount: l.amount_paise, state: 'actual', approved_by: link?.approved_by ?? l.created_by ?? null })
  }
  for (const e of expenses) {
    if (e.status !== 'approved' || e.spent_on < from || e.spent_on > to) continue
    out.push({ source: 'expense', ref_id: e.id, date: e.spent_on, category: EXPENSE_CATEGORY[e.category], description: `${userName(ctx, e.user_id)} · ${e.description}`, amount: e.amount_paise, state: 'committed', approved_by: e.decided_by })
  }
  for (const b of bills) {
    if (b.status !== 'approved' || b.bill_date < from || b.bill_date > to) continue
    const v = rows(ctx, 'vendors').find((x) => x.id === b.vendor_id)
    out.push({ source: 'bill', ref_id: b.id, date: b.bill_date, category: billCategory(ctx, b), description: `${v?.name ?? 'Vendor'} · bill ${b.number}`, amount: b.amount_paise + b.gst_paise, state: 'committed', approved_by: b.approved_by ?? null })
  }
  return out
}

function budgetsFor(ctx: Ctx, fy: number) {
  return rows(ctx, 'budgets').filter((b) => b.fy_start_year === fy)
}

/** Remaining budget for a category in the month of `date` (budget − actual − committed). null = no budget line. */
export function monthRemaining(ctx: Ctx, category: string, date: string, excludeRef?: string): { budget: number; used: number; remaining: number } | null {
  const fy = fyStartYear(date, fyMonth(ctx))
  const b = budgetsFor(ctx, fy).find((x) => x.kind === 'expense' && lc(x.category) === lc(category))
  if (!b) return null
  const months = fyMonths(ctx, fy)
  const idx = months.indexOf(monthOf(date))
  const budget = b.monthly_paise[idx] ?? 0
  const { from, to } = { from: `${months[idx]}-01`, to: addDays(addMonths(`${months[idx]}-01`, 1), -1) }
  const used = spendItems(ctx, from, to).filter((s) => lc(s.category) === lc(category) && s.ref_id !== excludeRef).reduce((a, s) => a + s.amount, 0)
  return { budget, used, remaining: budget - used }
}

/** Remaining FY budget for a category, counting approved-but-unbilled POs as committed. */
function fyRemaining(ctx: Ctx, category: string, date: string, excludePo?: string): { budget: number; used: number; remaining: number } | null {
  const fy = fyStartYear(date, fyMonth(ctx))
  const b = budgetsFor(ctx, fy).find((x) => x.kind === 'expense' && lc(x.category) === lc(category))
  if (!b) return null
  const { from, to } = fyRange(fy, fyMonth(ctx))
  let used = spendItems(ctx, from, to).filter((s) => lc(s.category) === lc(category)).reduce((a, s) => a + s.amount, 0)
  const bills = rows(ctx, 'vendor_bills')
  for (const po of rows(ctx, 'purchase_orders') as POX[]) {
    if (po.id === excludePo || po.status !== 'approved' || lc(po.budget_category) !== lc(category)) continue
    const billed = bills.filter((x) => x.po_id === po.id && x.status !== 'disputed').reduce((a, x) => a + x.amount_paise + x.gst_paise, 0)
    used += Math.max(0, poTotal(po) - billed)
  }
  const budget = b.monthly_paise.reduce((a, x) => a + x, 0)
  return { budget, used, remaining: budget - used }
}

export function budgetStatement(ctx: Ctx, fy: number): BudgetStatement {
  const months = fyMonths(ctx, fy)
  const { from, to } = fyRange(fy, fyMonth(ctx))
  const curIdx = ctx.today < from ? -1 : ctx.today > to ? 12 : months.indexOf(monthOf(ctx.today))
  const ytdN = curIdx < 0 ? 0 : curIdx >= 12 ? 12 : curIdx + 1
  const budgets = budgetsFor(ctx, fy)
  const items = spendItems(ctx, from, to)
  const sum = (a: number[], n = 12) => a.slice(0, n).reduce((x, y) => x + y, 0)

  // expense lines
  const cats = new Map<string, string>() // lc → display
  for (const c of BUDGET_EXPENSE_CATEGORIES) cats.set(lc(c), c)
  for (const b of budgets) if (b.kind === 'expense' && !cats.has(lc(b.category))) cats.set(lc(b.category), b.category)
  for (const s of items) if (!cats.has(lc(s.category))) cats.set(lc(s.category), s.category)
  const expense: BudgetLine[] = []
  for (const [key, label] of cats) {
    const b = budgets.find((x) => x.kind === 'expense' && lc(x.category) === key)
    const actual = Array(12).fill(0) as number[]
    const committed = Array(12).fill(0) as number[]
    for (const s of items) {
      if (lc(s.category) !== key) continue
      const i = months.indexOf(monthOf(s.date))
      if (i < 0) continue
      if (s.state === 'actual') actual[i] += s.amount
      else committed[i] += s.amount
    }
    const mb = b ? b.monthly_paise.slice(0, 12) : (Array(12).fill(0) as number[])
    const ytdBudget = sum(mb, ytdN)
    const ytdActual = sum(actual, ytdN) + sum(committed, ytdN)
    const fyActual = sum(actual) + sum(committed)
    if (!b && fyActual === 0) continue
    const variance = ytdBudget - ytdActual
    expense.push({
      id: b?.id ?? null, version: b?.version ?? null, kind: 'expense', category: b?.category ?? label, label, owner_id: b?.owner_id ?? null, notes: b?.notes ?? '',
      monthly_budget: mb, monthly_actual: actual, monthly_committed: committed, budget_total: sum(mb), ytd_budget: ytdBudget, ytd_actual: ytdActual,
      ytd_variance: variance, ytd_variance_pct: ytdBudget ? variance / ytdBudget : null, fy_actual: fyActual, over: ytdActual > ytdBudget, has_budget: !!b,
      pending_change: pendingBrief(ctx, 'budget', b?.id ?? budgetKey(fy, 'expense', b?.category ?? label)),
    })
  }
  expense.sort((a, b) => b.budget_total + b.fy_actual - (a.budget_total + a.fy_actual))

  // revenue lines by stream
  const revenue: BudgetLine[] = []
  const income = expandLedger(ctx, from, to < ctx.today ? to : ctx.today).filter((l) => l.kind === 'income')
  for (const stream of Object.keys(STREAM) as E.RevenueStream[]) {
    const b = budgets.find((x) => x.kind === 'revenue' && x.category === stream)
    const actual = Array(12).fill(0) as number[]
    for (const l of income) {
      if (l.stream !== stream) continue
      const i = months.indexOf(monthOf(l.occurrence))
      if (i >= 0) actual[i] += l.amount_paise
    }
    const mb = b ? b.monthly_paise.slice(0, 12) : (Array(12).fill(0) as number[])
    if (!b && sum(actual) === 0) continue
    const ytdBudget = sum(mb, ytdN)
    const ytdActual = sum(actual, ytdN)
    const variance = ytdActual - ytdBudget
    revenue.push({
      id: b?.id ?? null, version: b?.version ?? null, kind: 'revenue', category: stream, label: STREAM[stream], owner_id: b?.owner_id ?? null, notes: b?.notes ?? '',
      monthly_budget: mb, monthly_actual: actual, monthly_committed: Array(12).fill(0), budget_total: sum(mb), ytd_budget: ytdBudget, ytd_actual: ytdActual,
      ytd_variance: variance, ytd_variance_pct: ytdBudget ? variance / ytdBudget : null, fy_actual: sum(actual), over: ytdActual < ytdBudget, has_budget: !!b,
      pending_change: pendingBrief(ctx, 'budget', b?.id ?? budgetKey(fy, 'revenue', stream)),
    })
  }

  // unbudgeted / additional spend: per category-month, everything beyond the month's budget
  const unbudgeted: UnbudgetedItem[] = []
  const running = new Map<string, number>()
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount)
  for (const s of sorted) {
    const line = expense.find((l) => lc(l.category) === lc(s.category))
    const i = months.indexOf(monthOf(s.date))
    const key = lc(s.category) + '|' + i
    const before = running.get(key) ?? 0
    const after = before + s.amount
    running.set(key, after)
    const budgetM = line?.has_budget ? line.monthly_budget[i] ?? 0 : 0
    const hasBudget = !!line?.has_budget && line.budget_total > 0
    const excess = hasBudget ? Math.max(0, Math.min(s.amount, after - budgetM)) : s.amount
    if (excess <= 0) continue
    unbudgeted.push({
      key: `${s.source}:${s.ref_id}:${s.date}`, source: s.source, ref_id: s.ref_id, date: s.date, category: line?.label ?? s.category, description: s.description, amount: s.amount, excess,
      reason: hasBudget ? 'over_budget' : 'no_budget', state: s.state, approved_by: s.approved_by, approved_by_name: s.approved_by ? userName(ctx, s.approved_by) : 'Direct ledger entry', justification: null, counted: true,
    })
  }
  for (const po of rows(ctx, 'purchase_orders') as POX[]) {
    if (!po.over_budget || !['approved', 'closed'].includes(po.status)) continue
    const d = (po.decided_at ?? po.created_at).slice(0, 10)
    if (d < from || d > to) continue
    const v = rows(ctx, 'vendors').find((x) => x.id === po.vendor_id)
    unbudgeted.push({
      key: `po:${po.id}`, source: 'po', ref_id: po.id, date: d, category: po.budget_category, description: `${po.number} · ${v?.name ?? ''}${po.title ? ' · ' + po.title : ''}`, amount: poTotal(po),
      excess: po.budget_remaining_paise === null || po.budget_remaining_paise === undefined ? poTotal(po) : Math.max(0, poTotal(po) - Math.max(0, po.budget_remaining_paise)),
      reason: po.budget_remaining_paise === null || po.budget_remaining_paise === undefined ? 'no_budget' : 'over_budget', state: 'commitment', approved_by: po.decided_by,
      approved_by_name: userName(ctx, po.decided_by), justification: po.justification ?? null, counted: false,
    })
  }
  unbudgeted.sort((a, b) => b.date.localeCompare(a.date))

  const monthly = months.map((m, i) => ({ month: m, budget: expense.reduce((a, l) => a + l.monthly_budget[i], 0), actual: expense.reduce((a, l) => a + l.monthly_actual[i] + l.monthly_committed[i], 0) }))
  return {
    fy_start_year: fy, fy_label: fyLabel(fy), months, current_month_index: curIdx, expense, revenue,
    totals: {
      expense_budget: expense.reduce((a, l) => a + l.budget_total, 0),
      expense_ytd_budget: expense.reduce((a, l) => a + l.ytd_budget, 0),
      expense_ytd_actual: expense.reduce((a, l) => a + l.ytd_actual, 0),
      expense_committed: expense.reduce((a, l) => a + sum(l.monthly_committed), 0),
      revenue_budget: revenue.reduce((a, l) => a + l.budget_total, 0),
      revenue_ytd_budget: revenue.reduce((a, l) => a + l.ytd_budget, 0),
      revenue_ytd_actual: revenue.reduce((a, l) => a + l.ytd_actual, 0),
      unbudgeted: unbudgeted.filter((u) => u.counted).reduce((a, u) => a + u.excess, 0),
      over_lines: expense.filter((l) => l.over && l.ytd_actual > 0).length,
    },
    monthly,
    unbudgeted,
    has_budgets: budgets.length > 0,
    prev_fy_has_budgets: budgetsFor(ctx, fy - 1).length > 0,
  }
}

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */
function approverFor(ctx: Ctx, userId: string, projectId: string | null): string | null {
  const u = rows(ctx, 'users').find((x) => x.id === userId)
  if (projectId) {
    const p = rows(ctx, 'projects').find((x) => x.id === projectId)
    if (p?.pm_id && p.pm_id !== userId) return p.pm_id
  }
  if (u?.reports_to_id) return u.reports_to_id
  return adminId(ctx)
}
function isDuplicate(ctx: Ctx, e: B.ExpenseClaim): boolean {
  return rows(ctx, 'expense_claims').some((x) => x.id !== e.id && x.user_id === e.user_id && x.amount_paise === e.amount_paise && x.spent_on === e.spent_on && x.status !== 'rejected')
}
function expenseRow(ctx: Ctx, e: ExpenseX, pm = projectMap(ctx)): ExpenseRow {
  const p = e.project_id ? pm.get(e.project_id) : undefined
  const f = e.receipt_file_id ? rows(ctx, 'files').find((x) => x.id === e.receipt_file_id) : undefined
  const isAdmin = spendAuthority(ctx)
  const own = e.user_id === ctx.user.id
  const admin = adminId(ctx)
  const pending = e.status === 'submitted'
  return {
    ...e,
    user_name: userName(ctx, e.user_id),
    approver_name: userName(ctx, e.approver_id),
    decided_by_name: userName(ctx, e.decided_by),
    first_approved_by_name: e.first_approved_by ? userName(ctx, e.first_approved_by) : null,
    project_code: p?.code ?? null,
    project_name: p?.name ?? null,
    client: p ? p.client : null,
    ledger_category: EXPENSE_CATEGORY[e.category],
    receipt_name: f?.name ?? null,
    duplicate: isDuplicate(ctx, e),
    step: pending ? ((e.wf_chain?.length ? (e.wf_step ?? 0) > 0 : !!e.first_approved_by) || e.approver_id === admin ? 'admin' : 'manager') : null,
    step_label: pending ? stepLabel(e) : null,
    route: approvalRoute(ctx, e, pending),
    due_on: pending ? stepDue(ctx, e) : null,
    escalates_to: pending ? escalationTarget(ctx, e)?.name ?? null : null,
    can_edit: own && (e.status === 'draft' || e.status === 'rejected'),
    can_approve: e.status === 'submitted' && (e.approver_id === ctx.user.id || isAdmin) && (!own || isAdmin),
    can_pay: e.status === 'approved' && has(ctx, 'expenses.pay'),
  }
}
function validateExpense(ctx: Ctx, body: Record<string, unknown>, submitting: boolean, existing?: B.ExpenseClaim) {
  const category = String(body.category ?? existing?.category ?? '') as ExpenseCategory
  if (!(category in EXPENSE_CATEGORY)) err(422, 'VAL_REQUIRED', 'Choose a category.', 'category')
  const description = needText(body.description ?? existing?.description, 'description', 'Description', 3, 200)
  const amount = money(body.amount_paise ?? existing?.amount_paise, 'amount_paise', 'Amount')
  const spent_on = needDate(body.spent_on ?? existing?.spent_on, 'spent_on', 'Date')
  if (spent_on > ctx.today) err(422, 'DATE_IN_FUTURE', 'The expense date is in the future. Claim it after you spend it.', 'spent_on')
  if (diffDays(ctx.today, spent_on) > EXPENSE_MAX_AGE_DAYS) err(422, 'EXPENSE_TOO_OLD', `Claims must be filed within ${EXPENSE_MAX_AGE_DAYS} days of spending. Talk to accounts for anything older.`, 'spent_on')
  const project_id = body.project_id === undefined ? existing?.project_id ?? null : (body.project_id as string | null) || null
  if (project_id) find(ctx, 'projects', project_id, 'Project')
  const billable = body.billable_to_client === undefined ? existing?.billable_to_client ?? false : !!body.billable_to_client
  if (billable && !project_id) err(422, 'VAL_REQUIRED', 'Pick the client project to re-bill this expense to.', 'project_id')
  return { category, description, amount_paise: amount, spent_on, project_id, billable_to_client: billable, submitting }
}
function requireReceipt(amount: number, fileId: string | null) {
  if (amount > RECEIPT_LIMIT_PAISE && !fileId) err(422, 'RECEIPT_REQUIRED', `Attach the receipt — it is required for claims above ${fmtMoney(RECEIPT_LIMIT_PAISE)}.`, 'receipt')
}
const expenseInput = (e: B.ExpenseClaim) => ({ requester_id: e.user_id, amount_paise: e.amount_paise, project_id: e.project_id })
function submitExpense(ctx: Ctx, e: ExpenseX) {
  // Route through the tenant's expense workflow; the v3 rule decides when the workflow names nobody.
  const wf = startApproval(ctx, 'expense', expenseInput(e), approverFor(ctx, e.user_id, e.project_id))
  const approver = wf.approver_id
  const r = update(ctx, 'expense_claims', e.id, { status: 'submitted', approver_id: approver, decided_by: null, decided_at: null, decision_reason: null, in_budget: null, submitted_at: nowISO(), first_approved_by: null, ...wfPatch(wf) } as Partial<B.ExpenseClaim>)
  if (isDuplicate(ctx, r)) warn(ctx, 'DUPLICATE_EXPENSE', `You already have a ${fmtMoney(r.amount_paise)} claim on this date. Check it isn’t the same expense.`)
  if (approver && approver !== ctx.user.id) notify(ctx, approver, 'NTF-04', 'Expense claim to approve', `${userName(ctx, e.user_id)} claimed ${fmtMoney(e.amount_paise)} — ${e.description}.`, '/expenses?tab=approve')
  logActivity(ctx, 'expense', e.id, 'submitted', `Submitted ${fmtMoney(e.amount_paise)} · ${e.description}`)
  return r
}

function expenseList(ctx: Ctx, tab: ExpenseTab, q: Record<string, unknown>): ExpenseList {
  const all = rows(ctx, 'expense_claims') as ExpenseX[]
  const canAll = seesAllClaims(ctx)
  const canPay = has(ctx, 'expenses.pay')
  const isAdmin = spendAuthority(ctx)
  const mine = all.filter((e) => e.user_id === ctx.user.id)
  const approve = all.filter((e) => e.status === 'submitted' && (e.approver_id === ctx.user.id || (isAdmin && e.user_id !== ctx.user.id) || (isAdmin && e.approver_id === ctx.user.id)))
  const pay = canPay ? all.filter((e) => e.status === 'approved') : []
  const canApprove = approve.length > 0 || isAdmin || has(ctx, 'expenses.approve')
  if (tab === 'all' && !canAll) err(403, 'FORBIDDEN', 'Only admin and HR & operations can see every claim.')
  if (tab === 'pay' && !canPay) err(403, 'FORBIDDEN', 'Only admin and HR & operations pay claims.')
  let list = tab === 'mine' ? mine : tab === 'approve' ? approve : tab === 'pay' ? pay : all
  const status = q.status ? String(q.status) : ''
  if (status) list = list.filter((e) => e.status === status)
  if (q.q) {
    const s = lc(String(q.q))
    list = list.filter((e) => lc(e.description).includes(s) || lc(userName(ctx, e.user_id)).includes(s))
  }
  const pm = projectMap(ctx)
  const items = list.map((e) => expenseRow(ctx, e, pm)).sort((a, b) => b.spent_on.localeCompare(a.spent_on) || b.created_at.localeCompare(a.created_at))
  const base = tab === 'mine' ? mine : tab === 'all' ? all : list
  const tot = (f: (e: ExpenseX) => boolean) => base.filter(f).reduce((a, e) => a + e.amount_paise, 0)
  return {
    tab, items,
    counts: { mine: mine.filter((e) => e.status === 'draft' || e.status === 'rejected').length, approve: approve.length, pay: canPay ? pay.length : null, all: canAll ? all.filter((e) => e.status === 'submitted').length : null },
    totals: {
      claimed: tot((e) => e.status !== 'draft'),
      pending: tot((e) => e.status === 'submitted'),
      approved_unpaid: tot((e) => e.status === 'approved'),
      paid: tot((e) => e.status === 'paid'),
      rejected: tot((e) => e.status === 'rejected'),
      out_of_budget: tot((e) => (e.status === 'approved' || e.status === 'paid') && e.in_budget === false),
    },
    can: { approve: canApprove, pay: canPay, all: canAll },
  }
}

/* ------------------------------------------------------------------ */
/* Purchases                                                           */
/* ------------------------------------------------------------------ */
export function poTotal(po: B.PurchaseOrder) {
  return po.amount_paise + Math.round((po.amount_paise * po.gst_pct) / 100)
}
function validateVendor(ctx: Ctx, body: Record<string, unknown>, existing?: VendorX) {
  const name = needText(body.name ?? existing?.name, 'name', 'Vendor name', 2, 120)
  const dup = rows(ctx, 'vendors').find((v) => lc(v.name) === lc(name) && v.id !== existing?.id)
  if (dup) err(409, 'DUPLICATE_VENDOR', `${dup.name} is already in the vendor list.`, 'name')
  const gstin = String(body.gstin ?? existing?.gstin ?? '').trim().toUpperCase()
  const pan = String(body.pan ?? existing?.pan ?? '').trim().toUpperCase()
  if (gstin && (gstin.length !== 15 || !GSTIN_RE.test(gstin))) err(422, 'VAL_GSTIN', 'GSTIN must be 15 characters: 2-digit state code, 10-character PAN, entity number, “Z” and a check character (e.g. 21AAKFM9876Q1ZP).', 'gstin')
  if (pan && (pan.length !== 10 || !PAN_RE.test(pan))) err(422, 'VAL_PAN', 'PAN must be 10 characters: 5 letters, 4 digits, 1 letter (e.g. AAKFM9876Q).', 'pan')
  if (gstin && pan && gstin.slice(2, 12) !== pan) err(422, 'VAL_PAN', 'The PAN does not match characters 3–12 of the GSTIN.', 'pan')
  const terms = Number(body.payment_terms_days ?? existing?.payment_terms_days ?? 30)
  if (!Number.isInteger(terms) || terms < 0 || terms > 180) err(422, 'VAL_RANGE', 'Payment terms must be between 0 and 180 days.', 'payment_terms_days')
  const email = String(body.email ?? existing?.email ?? '').trim()
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) err(422, 'VAL_EMAIL', 'Enter a valid email address.', 'email')
  const bank_name = String(body.bank_name ?? existing?.bank_name ?? '').trim().slice(0, 80)
  const bank_account = String(body.bank_account ?? existing?.bank_account ?? '').replace(/[\s-]+/g, '')
  if (bank_account && !/^\d{9,18}$/.test(bank_account)) err(422, 'VAL_BANK', 'The account number must be 9 to 18 digits.', 'bank_account')
  const ifsc = String(body.ifsc ?? existing?.ifsc ?? '').trim().toUpperCase()
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) err(422, 'VAL_IFSC', 'IFSC must be 11 characters: 4 letters, a zero, then 6 letters or digits (e.g. HDFC0001234).', 'ifsc')
  if (bank_account && !ifsc) err(422, 'VAL_IFSC', 'Add the IFSC of the bank branch for this account.', 'ifsc')
  if (bank_account && !bank_name) err(422, 'VAL_REQUIRED', 'Add the bank name for this account.', 'bank_name')
  return {
    name, gstin, pan: pan || (gstin ? gstin.slice(2, 12) : ''), payment_terms_days: terms, email,
    category: String(body.category ?? existing?.category ?? 'Other').trim() || 'Other',
    contact: String(body.contact ?? existing?.contact ?? '').trim(),
    phone: String(body.phone ?? existing?.phone ?? '').trim(),
    bank_name, bank_account, ifsc,
  }
}
type VendorData = ReturnType<typeof validateVendor>
/** Display values for the maker-checker diff (account number masked to the last four digits). */
function vendorShow(v: Partial<VendorData>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const val = (v as Record<string, unknown>)[k]
    out[VENDOR_FIELD_LABEL[k] ?? k] = k === 'bank_account' ? maskAccount(String(val ?? '')) || '—' : val === '' || val == null ? '—' : val
  }
  return out
}
function poRow(ctx: Ctx, po: POX, vendors: Map<string, B.Vendor>, pm: Map<string, E.Project>): PORow {
  const v = vendors.get(po.vendor_id)
  const p = po.project_id ? pm.get(po.project_id) : undefined
  const bills = rows(ctx, 'vendor_bills').filter((b) => b.po_id === po.id && b.status !== 'disputed')
  const billed = bills.reduce((a, b) => a + b.amount_paise, 0)
  const total = poTotal(po)
  return {
    ...po, vendor_name: v?.name ?? '—', vendor_status: v?.status ?? 'active', project_code: p?.code ?? null, project_name: p?.name ?? null,
    requested_by_name: userName(ctx, po.requested_by), decided_by_name: userName(ctx, po.decided_by), total_paise: total, gst_amount_paise: total - po.amount_paise,
    billed_paise: billed, balance_paise: Math.max(0, po.amount_paise - billed), bills: rows(ctx, 'vendor_bills').filter((b) => b.po_id === po.id).length,
    approver_name: po.status === 'pending' ? userName(ctx, po.approver_id) : '—',
    step_label: po.status === 'pending' ? stepLabel(po) : null,
    route: approvalRoute(ctx, po, po.status === 'pending'),
    can_approve: po.status === 'pending' && canDecidePO(ctx, po),
  }
}
/** Current workflow approver or spend authority; never your own PO unless you hold spend authority (v3). */
function canDecidePO(ctx: Ctx, po: POX) {
  if (spendAuthority(ctx)) return true
  return po.approver_id === ctx.user.id && po.requested_by !== ctx.user.id
}
function canDecideBill(ctx: Ctx, b: BillX) {
  return spendAuthority(ctx) || (!!b.approver_id && b.approver_id === ctx.user.id && b.created_by !== ctx.user.id)
}
const poInput = (po: POX) => ({ requester_id: po.requested_by, amount_paise: poTotal(po), project_id: po.project_id })
function billInput(ctx: Ctx, b: BillX) {
  const po = b.po_id ? rows(ctx, 'purchase_orders').find((x) => x.id === b.po_id) : null
  return { requester_id: b.created_by ?? ctx.user.id, amount_paise: b.amount_paise + b.gst_paise, project_id: po?.project_id ?? null }
}
function billRow(ctx: Ctx, b: BillX, vendors: Map<string, B.Vendor>, pos: Map<string, POX>): BillRow {
  const po = b.po_id ? pos.get(b.po_id) : undefined
  const f = b.file_id ? rows(ctx, 'files').find((x) => x.id === b.file_id) : undefined
  const over = po && po.amount_paise ? (b.amount_paise - po.amount_paise) / po.amount_paise : null
  return {
    ...b, category: billCategory(ctx, b), vendor_name: vendors.get(b.vendor_id)?.name ?? '—', po_number: po?.number ?? null, po_amount_paise: po?.amount_paise ?? null,
    over_po_pct: over !== null && over > 0 ? over : null, total_paise: b.amount_paise + b.gst_paise, net_payable_paise: b.amount_paise + b.gst_paise - b.tds_paise,
    days_overdue: b.status === 'paid' ? 0 : Math.max(0, diffDays(ctx.today, b.due_on)), approved_by_name: userName(ctx, b.approved_by), file_name: f?.name ?? null,
    approver_name: b.status === 'received' ? userName(ctx, b.approver_id ?? adminId(ctx)) : '—',
    step_label: b.status === 'received' ? stepLabel(b) : null,
    can_approve: b.status === 'received' && canDecideBill(ctx, b),
  }
}
function purchases(ctx: Ctx): PurchasesResult {
  const vendorsRaw = rows(ctx, 'vendors')
  const vendors = new Map(vendorsRaw.map((v) => [v.id, v]))
  const pm = projectMap(ctx)
  const posRaw = rows(ctx, 'purchase_orders') as POX[]
  const posMap = new Map(posRaw.map((p) => [p.id, p]))
  const pos = posRaw.map((p) => poRow(ctx, p, vendors, pm)).sort((a, b) => b.number.localeCompare(a.number))
  const bills = (rows(ctx, 'vendor_bills') as BillX[]).map((b) => billRow(ctx, b, vendors, posMap)).sort((a, b) => b.bill_date.localeCompare(a.bill_date))
  const { from } = fyRange(curFy(ctx), fyMonth(ctx))
  const unpaid = bills.filter((b) => b.status !== 'paid')
  const buckets: AgeingBucket[] = [
    { key: 'not_due', label: 'Not yet due', amount: 0, count: 0 }, { key: '0_30', label: '1–30 days', amount: 0, count: 0 }, { key: '31_60', label: '31–60 days', amount: 0, count: 0 },
    { key: '61_90', label: '61–90 days', amount: 0, count: 0 }, { key: '90_plus', label: 'Over 90 days', amount: 0, count: 0 },
  ]
  for (const b of unpaid) {
    const d = b.days_overdue
    const k = d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4
    buckets[k].amount += b.net_payable_paise
    buckets[k].count++
  }
  const fullBank = has(ctx, 'procurement.manage')
  const vendorRows: VendorRow[] = (vendorsRaw as VendorX[]).map((v) => {
    const vb = bills.filter((b) => b.vendor_id === v.id)
    const { bank_account, ...rest } = v
    return {
      ...rest, bank_name: v.bank_name ?? '', ifsc: v.ifsc ?? '', bank_account_masked: maskAccount(bank_account), ...(fullBank ? { bank_account: bank_account ?? '' } : {}),
      pending_change: pendingBrief(ctx, 'vendor', v.id), open_pos: pos.filter((p) => p.vendor_id === v.id && (p.status === 'approved' || p.status === 'pending')).length,
      billed_fy: vb.filter((b) => b.bill_date >= from).reduce((a, b) => a + b.total_paise, 0),
      payable: vb.filter((b) => b.status !== 'paid').reduce((a, b) => a + b.net_payable_paise, 0),
      overdue: vb.filter((b) => b.status !== 'paid' && b.days_overdue > 0).reduce((a, b) => a + b.net_payable_paise, 0),
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return {
    vendors: vendorRows, pos, bills, ageing: buckets, vendor_checked: needsChecker(ctx, 'vendor'), can_approve: spendAuthority(ctx) || pos.some((p) => p.can_approve) || bills.some((b) => b.can_approve),
    totals: {
      open_po_value: pos.filter((p) => p.status === 'approved').reduce((a, p) => a + p.balance_paise, 0),
      pending_po: pos.filter((p) => p.status === 'pending').length,
      payable: unpaid.filter((b) => b.status !== 'disputed').reduce((a, b) => a + b.net_payable_paise, 0),
      overdue: unpaid.filter((b) => b.status !== 'disputed' && b.days_overdue > 0).reduce((a, b) => a + b.net_payable_paise, 0),
      paid_fy: bills.filter((b) => b.status === 'paid' && (b.paid_on ?? '') >= from).reduce((a, b) => a + b.net_payable_paise, 0),
      disputed: unpaid.filter((b) => b.status === 'disputed').reduce((a, b) => a + b.total_paise, 0),
    },
  }
}
function validatePO(ctx: Ctx, body: Record<string, unknown>, existing?: POX) {
  const vendor_id = String(body.vendor_id ?? existing?.vendor_id ?? '')
  if (!vendor_id) err(422, 'VAL_REQUIRED', 'Choose a vendor.', 'vendor_id')
  const v = find(ctx, 'vendors', vendor_id, 'Vendor')
  if (v.status === 'blocked') err(409, 'VENDOR_BLOCKED', `${v.name} is blocked. Unblock the vendor before raising a PO.`, 'vendor_id')
  const linesIn = (body.lines ?? existing?.lines ?? []) as B.POLine[]
  if (!Array.isArray(linesIn) || !linesIn.length) err(422, 'VAL_REQUIRED', 'Add at least one line.', 'lines')
  const lines = linesIn.map((l, i) => {
    const description = String(l.description ?? '').trim()
    if (!description) err(422, 'VAL_REQUIRED', `Line ${i + 1} needs a description.`, 'lines')
    const qty = Number(l.qty)
    if (!Number.isFinite(qty) || qty <= 0) err(422, 'VAL_RANGE', `Line ${i + 1}: quantity must be more than zero.`, 'lines')
    const rate = money(l.rate_paise, 'lines', `Line ${i + 1} rate`)
    return { description, qty, rate_paise: rate }
  })
  const amount = lines.reduce((a, l) => a + Math.round(l.qty * l.rate_paise), 0)
  const gst = Number(body.gst_pct ?? existing?.gst_pct ?? 18)
  if (![0, 5, 12, 18, 28].includes(gst)) err(422, 'VAL_RANGE', 'GST must be 0, 5, 12, 18 or 28%.', 'gst_pct')
  const budget_category = needText(body.budget_category ?? existing?.budget_category, 'budget_category', 'Budget category')
  const project_id = body.project_id === undefined ? existing?.project_id ?? null : (body.project_id as string | null) || null
  if (project_id) find(ctx, 'projects', project_id, 'Project')
  const needed_by = body.needed_by === undefined ? existing?.needed_by ?? null : (body.needed_by as string | null) || null
  const title = String(body.title ?? existing?.title ?? lines[0].description).trim().slice(0, 120)
  const justification = String(body.justification ?? existing?.justification ?? '').trim() || null
  return { vendor_id, lines, amount_paise: amount, gst_pct: gst, budget_category, project_id, needed_by, title, justification }
}
function submitPO(ctx: Ctx, po: POX) {
  const total = poTotal(po)
  const rem = fyRemaining(ctx, po.budget_category, po.needed_by && po.needed_by > ctx.today ? po.needed_by : ctx.today, po.id)
  const over = !rem || rem.remaining < total
  if (over && (po.justification ?? '').trim().length < 15)
    err(422, 'JUSTIFICATION_REQUIRED', rem ? `This PO is ${fmtMoney(total - Math.max(0, rem.remaining))} over the remaining ${po.budget_category} budget (${fmtMoney(Math.max(0, rem.remaining))} left this FY). Add a justification of at least 15 characters.` : `There is no ${po.budget_category} budget this FY. Add a justification of at least 15 characters.`, 'justification')
  const wf = startApproval(ctx, 'purchase_order', poInput(po), adminId(ctx))
  const admin = wf.approver_id
  const r = update(ctx, 'purchase_orders', po.id, { status: 'pending', approver_id: admin, over_budget: over, budget_remaining_paise: rem ? rem.remaining : null, decided_by: null, decided_at: null, decision_reason: null, ...wfPatch(wf) } as Partial<B.PurchaseOrder>)
  if (over) warn(ctx, 'OVER_BUDGET', `Over budget: ${admin ? userName(ctx, admin) : 'the approver'} will see your justification when approving.`)
  if (admin && admin !== ctx.user.id) notify(ctx, admin, 'NTF-04', 'Purchase order to approve', `${po.number} · ${fmtMoney(total)}${over ? ' · over budget' : ''}`, '/purchases?tab=pos')
  logActivity(ctx, 'purchase_order', po.id, 'submitted', `Submitted ${po.number} for ${fmtMoney(total)}${over ? ' (over budget)' : ''}`)
  return r
}
function validateBill(ctx: Ctx, body: Record<string, unknown>, existing?: BillX) {
  const vendor_id = String(body.vendor_id ?? existing?.vendor_id ?? '')
  if (!vendor_id) err(422, 'VAL_REQUIRED', 'Choose a vendor.', 'vendor_id')
  const v = find(ctx, 'vendors', vendor_id, 'Vendor')
  const po_id = body.po_id === undefined ? existing?.po_id ?? null : (body.po_id as string | null) || null
  const number = needText(body.number ?? existing?.number, 'number', 'Bill number', 1, 40)
  const bill_date = needDate(body.bill_date ?? existing?.bill_date, 'bill_date', 'Bill date')
  if (bill_date > ctx.today) err(422, 'DATE_IN_FUTURE', 'The bill date is in the future.', 'bill_date')
  const amount = money(body.amount_paise ?? existing?.amount_paise, 'amount_paise', 'Bill amount')
  const gst = money(body.gst_paise ?? existing?.gst_paise ?? 0, 'gst_paise', 'GST', true)
  const tds = money(body.tds_paise ?? existing?.tds_paise ?? 0, 'tds_paise', 'TDS', true)
  if (tds > amount) err(422, 'VAL_RANGE', 'TDS cannot be more than the bill amount.', 'tds_paise')
  const dup = rows(ctx, 'vendor_bills').find((b) => b.vendor_id === vendor_id && lc(b.number) === lc(number) && b.id !== existing?.id)
  if (dup) err(409, 'DUPLICATE_BILL', `Bill ${number} from ${v.name} is already recorded (${dup.status}). Check you are not entering it twice.`, 'number')
  let category: string | null = null
  if (po_id) {
    const po = find(ctx, 'purchase_orders', po_id, 'Purchase order') as POX
    if (po.vendor_id !== vendor_id) err(422, 'VAL_PO', 'That PO belongs to another vendor.', 'po_id')
    if (!['approved', 'closed'].includes(po.status)) err(409, 'PO_NOT_APPROVED', `${po.number} is ${po.status}. Bills can only be booked against an approved PO.`, 'po_id')
    const others = rows(ctx, 'vendor_bills').filter((b) => b.po_id === po_id && b.id !== existing?.id && b.status !== 'disputed').reduce((a, b) => a + b.amount_paise, 0)
    const limit = Math.round(po.amount_paise * 1.05)
    if (others + amount > limit) {
      const over = (others + amount - po.amount_paise) / po.amount_paise
      err(409, 'BILL_EXCEEDS_PO', `Bills against ${po.number} would total ${fmtMoney(others + amount)} — ${(over * 100).toFixed(1)}% over the PO value of ${fmtMoney(po.amount_paise)} (5% tolerance). Raise a revised PO or dispute the bill with the vendor.`, 'amount_paise')
    }
  } else category = String(body.category ?? existing?.category ?? v.category ?? 'Other') || 'Other'
  const due_on = body.due_on ? needDate(body.due_on, 'due_on', 'Due date') : addDays(bill_date, v.payment_terms_days)
  return { vendor_id, po_id, number, bill_date, due_on, amount_paise: amount, gst_paise: gst, tds_paise: tds, category, description: String(body.description ?? existing?.description ?? '').trim() }
}

/* ------------------------------------------------------------------ */
/* Revenue leakage                                                     */
/* ------------------------------------------------------------------ */
export function leakageRows(ctx: Ctx): LeakageRow[] {
  const pm = projectMap(ctx)
  const out: LeakageRow[] = []
  const base = (id: string): Pick<E.Base, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version'> => ({ id, tenant_id: ctx.tenant.id, created_at: ctx.today + 'T00:00:00Z', updated_at: ctx.today + 'T00:00:00Z', version: 1 })
  const push = (r: LeakX, source: string | null) => {
    const p = r.project_id ? pm.get(r.project_id) : undefined
    out.push({ ...r, kind_label: LEAKAGE_KIND[r.kind].label, project_code: p?.code ?? null, project_name: p?.name ?? null, recorded_by_name: r.auto ? 'System' : userName(ctx, r.recorded_by), open_paise: r.status === 'open' ? Math.max(0, r.amount_paise - r.recovered_paise) : 0, source })
  }
  // 1. lost deals
  for (const d of rows(ctx, 'deals')) {
    if (d.stage !== 'lost') continue
    push({ ...base('auto_deal_' + d.id), kind: 'lost_deal', amount_paise: d.value_paise, date: d.lost_on ?? d.updated_at.slice(0, 10), client: d.client, project_id: null, deal_id: d.id, reason: d.lost_reason || 'No reason recorded', recorded_by: d.owner_id, recoverable: false, status: 'accepted', recovered_paise: 0, auto: true }, `Deal · ${d.title}`)
  }
  // 2. unbilled hours
  const entries = costedEntries(ctx).filter((e) => e.kind === 'task' && e.approved && e.task_id)
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  for (const p of pm.values()) {
    if (!p.contract_value_paise || (p.billing_model !== 'fixed' && p.billing_model !== 'tm')) continue
    const pt = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
    const est = pt.reduce((a, t) => a + t.est_hours, 0)
    if (!est) continue
    const rate = p.contract_value_paise / est // blended billing rate per hour
    const byTask = new Map<string, number>()
    for (const e of entries) {
      const t = tasks.get(e.task_id!)
      if (!t || t.project_id !== p.id) continue
      byTask.set(t.id, (byTask.get(t.id) ?? 0) + e.hours)
    }
    if (p.billing_model === 'fixed') {
      let over = 0
      for (const [tid, h] of byTask) over += Math.max(0, h - (tasks.get(tid)?.est_hours ?? 0))
      if (over >= 1)
        push({ ...base('auto_unbilled_' + p.id), kind: 'unbilled_hours', amount_paise: Math.round(over * rate), date: ctx.today, client: p.client, project_id: p.id, deal_id: null, reason: `${over.toFixed(1)} approved hours beyond task estimates on a fixed-price project, at the blended rate of ${fmtMoney(Math.round(rate))}/h. Raise a change request to recover.`, recorded_by: p.pm_id ?? '', recoverable: true, status: 'open', recovered_paise: 0, auto: true }, 'Timesheets beyond estimate')
    } else {
      const hours = [...byTask.values()].reduce((a, b) => a + b, 0)
      const invoiced = rows(ctx, 'invoices').filter((i) => i.project_id === p.id).reduce((a, i) => a + i.amount_paise, 0)
      const gap = Math.round(hours * rate) - invoiced
      if (gap > 0)
        push({ ...base('auto_unbilled_' + p.id), kind: 'unbilled_hours', amount_paise: gap, date: ctx.today, client: p.client, project_id: p.id, deal_id: null, reason: `${hours.toFixed(1)} approved T&M hours worth ${fmtMoney(Math.round(hours * rate))}; only ${fmtMoney(invoiced)} invoiced so far.`, recorded_by: p.pm_id ?? '', recoverable: true, status: 'open', recovered_paise: 0, auto: true }, 'Approved T&M hours not invoiced')
    }
  }
  // 3. overdue invoices > 90 days
  for (const inv of rows(ctx, 'invoices')) {
    const outstanding = inv.amount_paise - inv.paid_amount_paise
    if (outstanding <= 0) continue
    const days = diffDays(ctx.today, inv.due_on)
    if (days <= 90) continue
    const p = pm.get(inv.project_id)
    push({ ...base('auto_baddebt_' + inv.id), kind: 'bad_debt', amount_paise: outstanding, date: addDays(inv.due_on, 90), client: p?.client ?? '—', project_id: inv.project_id, deal_id: null, reason: `Invoice ${inv.number} is ${days} days past due with ${fmtMoney(outstanding)} outstanding.`, recorded_by: p?.pm_id ?? '', recoverable: true, status: 'open', recovered_paise: 0, auto: true }, `Invoice ${inv.number}`)
  }
  // 4. change requests rejected after work started
  for (const cr of rows(ctx, 'change_requests')) {
    if (cr.status !== 'rejected' || !cr.decided_at) continue
    const p = pm.get(cr.project_id)
    if (!p || cr.decided_at.slice(0, 10) < p.start_on) continue
    push({ ...base('auto_cr_' + cr.id), kind: 'scope_creep', amount_paise: cr.value_paise, date: cr.decided_at.slice(0, 10), client: p.client, project_id: p.id, deal_id: null, reason: `Change request “${cr.title}” (${cr.hours}h) was rejected after work started.`, recorded_by: cr.raised_by, recoverable: false, status: 'accepted', recovered_paise: 0, auto: true }, `Change request · ${cr.title}`)
  }
  // manual rows
  for (const r of rows(ctx, 'revenue_leakage') as LeakX[]) push(r, null)
  return out.sort((a, b) => b.date.localeCompare(a.date))
}
function leakageResult(ctx: Ctx, fy: number): LeakageResult {
  const { from, to } = fyRange(fy, fyMonth(ctx))
  const items = leakageRows(ctx).filter((r) => r.date >= from && r.date <= to)
  const total = items.reduce((a, r) => a + r.amount_paise, 0)
  const recovered = items.reduce((a, r) => a + r.recovered_paise, 0)
  const billed = revenueBetween(ctx, from, to < ctx.today ? to : ctx.today).billed
  const kinds = new Map<B.LeakageKind, { amount: number; count: number }>()
  const clients = new Map<string, { amount: number; count: number }>()
  for (const r of items) {
    const k = kinds.get(r.kind) ?? { amount: 0, count: 0 }
    k.amount += r.amount_paise - r.recovered_paise
    k.count++
    kinds.set(r.kind, k)
    const c = clients.get(r.client) ?? { amount: 0, count: 0 }
    c.amount += r.amount_paise - r.recovered_paise
    c.count++
    clients.set(r.client, c)
  }
  const months = fyMonths(ctx, fy)
  return {
    fy_start_year: fy, fy_label: fyLabel(fy), items,
    summary: {
      total, recovered, net: total - recovered,
      recoverable_open: items.filter((r) => r.recoverable && r.status === 'open').reduce((a, r) => a + r.open_paise, 0),
      billed, pct_of_billed: billed ? (total - recovered) / billed : null,
      by_kind: [...kinds.entries()].map(([kind, v]) => ({ kind, label: LEAKAGE_KIND[kind].label, ...v })).sort((a, b) => b.amount - a.amount),
      by_month: months.map((m) => ({ month: m, amount: items.filter((r) => monthOf(r.date) === m).reduce((a, r) => a + r.amount_paise - r.recovered_paise, 0) })),
      top_clients: [...clients.entries()].map(([client, v]) => ({ client, ...v })).sort((a, b) => b.amount - a.amount).slice(0, 6),
    },
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
export function register(r: Router) {
  /* ---------- meta ---------- */
  r.get('/spend/meta', ({ ctx }): SpendMeta => ({
    expense_categories: (Object.keys(EXPENSE_CATEGORY) as ExpenseCategory[]).map((value) => ({ value, label: EXPENSE_CATEGORY_LABEL[value], ledger: EXPENSE_CATEGORY[value] })),
    budget_categories: [...new Set([...BUDGET_EXPENSE_CATEGORIES, ...rows(ctx, 'budgets').filter((b) => b.kind === 'expense').map((b) => b.category)])],
    revenue_streams: (Object.keys(STREAM) as E.RevenueStream[]).map((value) => ({ value, label: STREAM[value] })),
    projects: rows(ctx, 'projects').filter((p) => p.status !== 'closed').map((p) => ({ id: p.id, code: p.code, name: p.name, client: p.client, billing_model: p.billing_model })).sort((a, b) => a.code.localeCompare(b.code)),
    vendors: rows(ctx, 'vendors').map((v) => ({ id: v.id, name: v.name, status: v.status, payment_terms_days: v.payment_terms_days, category: v.category })).sort((a, b) => a.name.localeCompare(b.name)),
    today: ctx.today,
    fy_start_year: curFy(ctx),
    fy_start_month: fyMonth(ctx),
  }))

  /* ---------- expenses ---------- */
  r.get('/expenses', ({ ctx, query }) => expenseList(ctx, (String(query.tab ?? 'mine') as ExpenseTab), query))
  r.get('/expenses/:id', ({ ctx, params }): ExpenseDetail => {
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim') as ExpenseX
    const isMine = e.user_id === ctx.user.id
    if (!isMine && e.approver_id !== ctx.user.id && e.first_approved_by !== ctx.user.id && !seesAllClaims(ctx)) {
      const p = e.project_id ? rows(ctx, 'projects').find((x) => x.id === e.project_id) : null
      if (p?.pm_id !== ctx.user.id) err(404, 'NOT_FOUND', 'Expense claim not found.')
    }
    const f = e.receipt_file_id ? rows(ctx, 'files').find((x) => x.id === e.receipt_file_id) : undefined
    return {
      ...expenseRow(ctx, e),
      receipt: f ? { id: f.id, name: f.name, mime: f.mime, data_url: f.data_url } : null,
      history: rows(ctx, 'activity_log').filter((a) => a.entity === 'expense' && a.entity_id === e.id).sort((a, b) => a.at.localeCompare(b.at)).map((a) => ({ at: a.at, actor: userName(ctx, a.actor_id), action: a.action, summary: a.summary })),
    }
  })
  r.post('/expenses', ({ ctx, body }) => {
    const v = validateExpense(ctx, body, !!body.submit)
    const fileId = saveFile(ctx, body.receipt as FileIn | null, 'expense', 'receipt')
    if (body.submit) requireReceipt(v.amount_paise, fileId)
    const e = insert(ctx, 'expense_claims', {
      user_id: ctx.user.id, project_id: v.project_id, category: v.category, description: v.description, amount_paise: v.amount_paise, spent_on: v.spent_on, receipt_file_id: fileId,
      billable_to_client: v.billable_to_client, status: 'draft', approver_id: null, decided_by: null, decided_at: null, decision_reason: null, paid_on: null, ledger_entry_id: null, in_budget: null,
    }) as ExpenseX
    linkFile(ctx, fileId, e.id)
    logActivity(ctx, 'expense', e.id, 'created', `Created claim ${fmtMoney(e.amount_paise)} · ${e.description}`)
    if (body.submit) return expenseRow(ctx, submitExpense(ctx, e))
    if (isDuplicate(ctx, e)) warn(ctx, 'DUPLICATE_EXPENSE', `You already have a ${fmtMoney(e.amount_paise)} claim on this date. Check it isn’t the same expense.`)
    return expenseRow(ctx, e)
  })
  r.patch('/expenses/:id', ({ ctx, params, body, ifMatch }) => {
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim') as ExpenseX
    if (e.user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the person who filed a claim can edit it.')
    if (e.status !== 'draft' && e.status !== 'rejected') err(409, 'EXPENSE_LOCKED', 'Submitted claims cannot be edited. Ask your approver to reject it first.')
    const v = validateExpense(ctx, body, !!body.submit, e)
    let fileId = e.receipt_file_id
    if (body.receipt) fileId = saveFile(ctx, body.receipt as FileIn, 'expense', 'receipt')
    if (body.remove_receipt) fileId = null
    linkFile(ctx, fileId, e.id)
    if (body.submit) requireReceipt(v.amount_paise, fileId)
    const u = update(ctx, 'expense_claims', e.id, { category: v.category, description: v.description, amount_paise: v.amount_paise, spent_on: v.spent_on, project_id: v.project_id, billable_to_client: v.billable_to_client, receipt_file_id: fileId, status: 'draft' }, ifMatch) as ExpenseX
    logActivity(ctx, 'expense', e.id, 'edited', `Edited claim · ${fmtMoney(u.amount_paise)}`)
    return expenseRow(ctx, body.submit ? submitExpense(ctx, u) : u)
  })
  r.post('/expenses/:id/submit', ({ ctx, params, ifMatch }) => {
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim') as ExpenseX
    if (e.user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the person who filed a claim can submit it.')
    if (e.status !== 'draft' && e.status !== 'rejected') err(409, 'INVALID_STATE', `This claim is already ${e.status}.`)
    if (ifMatch !== undefined && ifMatch !== e.version) err(409, 'STALE', 'Someone else changed this record. Reload to see the latest version.')
    validateExpense(ctx, {}, true, e)
    requireReceipt(e.amount_paise, e.receipt_file_id)
    return expenseRow(ctx, submitExpense(ctx, e))
  })
  r.del('/expenses/:id', ({ ctx, params, ifMatch }) => {
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim')
    if (e.user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the person who filed a claim can delete it.')
    if (e.status !== 'draft' && e.status !== 'rejected') err(409, 'EXPENSE_LOCKED', 'Only draft or rejected claims can be deleted.')
    remove(ctx, 'expense_claims', e.id, ifMatch)
    logActivity(ctx, 'expense', e.id, 'deleted', `Deleted claim · ${e.description}`)
    return { ok: true }
  })
  r.post('/expenses/:id/approve', ({ ctx, params, body, ifMatch }) => {
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim') as ExpenseX
    if (e.status !== 'submitted') err(409, 'INVALID_STATE', `This claim is ${e.status}; only submitted claims can be approved.`)
    const isAdmin = spendAuthority(ctx)
    if (e.approver_id !== ctx.user.id && !isAdmin) err(403, 'FORBIDDEN', `This claim is waiting for ${userName(ctx, e.approver_id)}.`)
    if (e.user_id === ctx.user.id && !isAdmin) err(403, 'SELF_APPROVAL', 'You cannot approve your own claim.')
    const note = String((body as { note?: string }).note ?? '').trim()
    // Multi-step workflow (default: manager / PM, then the CEO above ₹25,000).
    const st = ensureWf(ctx, e, 'expense', expenseInput(e), approverFor(ctx, e.user_id, e.project_id))
    const adv = advanceApproval(ctx, st, ctx.user.id)
    if (adv.next) {
      const nx = adv.next
      const of = `step ${st.wf_step + 1} of ${st.wf_chain.length}`
      const r2 = update(ctx, 'expense_claims', e.id, { approver_id: nx.approver_id, first_approved_by: e.first_approved_by ?? ctx.user.id, ...wfPatch(adv.state) } as Partial<B.ExpenseClaim>, ifMatch)
      logActivity(ctx, 'expense', e.id, 'approved_step', `${of[0].toUpperCase() + of.slice(1)} (${adv.done?.name ?? 'approval'}) approved by ${ctx.user.name}; sent to ${userName(ctx, nx.approver_id)} for ${nx.name}${note ? ' — ' + note : ''}`)
      notify(ctx, nx.approver_id, 'NTF-04', 'Expense claim to approve', `${userName(ctx, e.user_id)} · ${fmtMoney(e.amount_paise)} — approved by ${ctx.user.name}, needs your approval (${nx.name}).`, '/expenses?tab=approve')
      notify(ctx, e.user_id, 'NTF-05', 'Expense approved by manager', `${ctx.user.name} approved ${fmtMoney(e.amount_paise)} · ${e.description}. It now needs ${userName(ctx, nx.approver_id)}’s approval.`, '/expenses')
      warn(ctx, 'SECOND_APPROVAL', `${of[0].toUpperCase() + of.slice(1)} approved — sent to ${userName(ctx, nx.approver_id)} for ${nx.name.toLowerCase()}.`)
      return expenseRow(ctx, r2 as ExpenseX)
    }
    const rem = monthRemaining(ctx, EXPENSE_CATEGORY[e.category], e.spent_on, e.id)
    const inBudget = !!rem && rem.remaining >= e.amount_paise
    const r2 = update(ctx, 'expense_claims', e.id, { status: 'approved', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: note || null, in_budget: inBudget, ...wfPatch(adv.state) } as Partial<B.ExpenseClaim>, ifMatch)
    if (!inBudget) warn(ctx, 'OVER_BUDGET', rem ? `Approved over budget: ${EXPENSE_CATEGORY[e.category]} has ${fmtMoney(Math.max(0, rem.remaining))} left for ${monthOf(e.spent_on)}. It is listed under unbudgeted spend.` : `There is no ${EXPENSE_CATEGORY[e.category]} budget for this month. It is listed under unbudgeted spend.`)
    logActivity(ctx, 'expense', e.id, 'approved', `Approved ${fmtMoney(e.amount_paise)}${inBudget ? '' : ' (outside budget)'}${note ? ' — ' + note : ''}`)
    notify(ctx, e.user_id, 'NTF-05', 'Expense approved', `${ctx.user.name} approved ${fmtMoney(e.amount_paise)} · ${e.description}. Accounts will reimburse it.`, '/expenses')
    return expenseRow(ctx, r2 as ExpenseX)
  })
  r.post('/expenses/:id/reject', ({ ctx, params, body, ifMatch }) => {
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim') as ExpenseX
    if (e.status !== 'submitted') err(409, 'INVALID_STATE', `This claim is ${e.status}; only submitted claims can be rejected.`)
    if (e.approver_id !== ctx.user.id && !spendAuthority(ctx)) err(403, 'FORBIDDEN', `This claim is waiting for ${userName(ctx, e.approver_id)}.`)
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 5) err(422, 'REASON_REQUIRED', 'Say why the claim is rejected (at least 5 characters) so it can be fixed.', 'reason')
    const r2 = update(ctx, 'expense_claims', e.id, { status: 'rejected', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: reason, ...wfClear() } as Partial<B.ExpenseClaim>, ifMatch)
    logActivity(ctx, 'expense', e.id, 'rejected', `Rejected — ${reason}`)
    notify(ctx, e.user_id, 'NTF-06', 'Expense rejected', `${ctx.user.name} rejected ${fmtMoney(e.amount_paise)} · ${e.description}: ${reason}`, '/expenses')
    return expenseRow(ctx, r2 as ExpenseX)
  })
  r.post('/expenses/:id/pay', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'expenses.pay', 'Only admin and HR & operations pay claims.')
    const e = find(ctx, 'expense_claims', params.id, 'Expense claim') as ExpenseX
    if (e.status !== 'approved') err(409, 'INVALID_STATE', e.status === 'paid' ? 'This claim is already paid.' : 'Only approved claims can be paid.')
    const paid_on = body.paid_on ? needDate(body.paid_on, 'paid_on', 'Payment date') : ctx.today
    if (paid_on > ctx.today) err(422, 'DATE_IN_FUTURE', 'The payment date is in the future.', 'paid_on')
    const p = e.project_id ? rows(ctx, 'projects').find((x) => x.id === e.project_id) : null
    const le = insert(ctx, 'ledger_entries', {
      kind: 'expense', category: EXPENSE_CATEGORY[e.category], description: `Expense claim · ${userName(ctx, e.user_id)} · ${e.description}${e.billable_to_client ? ' (re-bill to client)' : ''}`,
      amount_paise: e.amount_paise, date: paid_on, recurring: false, until_on: null, status: 'paid', project_id: e.project_id, milestone_id: null, invoice_id: null, stream: p?.stream ?? null, locked: true,
    } as never) as E.LedgerEntry
    const r2 = update(ctx, 'expense_claims', e.id, { status: 'paid', paid_on, ledger_entry_id: le.id }, ifMatch)
    logActivity(ctx, 'expense', e.id, 'paid', `Reimbursed ${fmtMoney(e.amount_paise)} on ${paid_on}`)
    notify(ctx, e.user_id, 'NTF-05', 'Expense reimbursed', `${fmtMoney(e.amount_paise)} for “${e.description}” has been paid.`, '/expenses')
    return expenseRow(ctx, r2 as ExpenseX)
  })

  /* ---------- vendors, POs, bills ---------- */
  r.get('/purchases', ({ ctx }) => {
    requireAction(ctx, 'procurement.manage', 'Only admin and HR & operations manage purchases.')
    return purchases(ctx)
  })
  // Vendors: creating one, or changing its tax or bank details, is maker-checked (entity `vendor`).
  r.post('/vendors', ({ ctx, body }) => {
    requireAction(ctx, 'procurement.manage')
    const v = validateVendor(ctx, body)
    const shown = Object.keys(VENDOR_FIELD_LABEL).filter((k) => (v as Record<string, unknown>)[k] !== '' && (v as Record<string, unknown>)[k] != null)
    return propose<VendorX>(ctx, {
      entity: 'vendor', entity_id: null, action: 'create', required_permission: 'procurement.manage',
      summary: `Add vendor ${v.name}${v.gstin ? ` · GSTIN ${v.gstin}` : ''}${v.bank_account ? ` · account ${maskAccount(v.bank_account)}` : ''}`,
      before: null, after: vendorShow(v, shown), payload: { op: 'create', data: v },
    })
  })
  r.patch('/vendors/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'procurement.manage')
    const cur = find(ctx, 'vendors', params.id, 'Vendor') as VendorX
    if (ifMatch !== undefined && ifMatch !== cur.version) err(409, 'STALE', 'Someone else changed this vendor. Reload to see the latest version.')
    const pend = pendingBrief(ctx, 'vendor', cur.id)
    if (pend) err(409, 'CHANGE_PENDING', `A change to ${cur.name} is waiting for approval (${pend.maker_name}). Withdraw it or wait for the checker before editing again.`)
    const v = validateVendor(ctx, body, cur)
    const changed = Object.keys(v).filter((k) => String((v as Record<string, unknown>)[k] ?? '') !== String((cur as unknown as Record<string, unknown>)[k] ?? ''))
    if (!changed.length) return { pending: false, result: cur, result_id: cur.id }
    const sensitive = changed.filter((k) => (VENDOR_SENSITIVE as readonly string[]).includes(k))
    if (!sensitive.length || !needsChecker(ctx, 'vendor')) {
      const row = update(ctx, 'vendors', cur.id, v as Partial<B.Vendor>)
      logActivity(ctx, 'vendor', row.id, 'edited', `Edited vendor ${row.name}: ${changed.map((k) => VENDOR_FIELD_LABEL[k] ?? k).join(', ')}`)
      return { pending: false, result: row, result_id: row.id }
    }
    return propose<VendorX>(ctx, {
      entity: 'vendor', entity_id: cur.id, action: 'update', required_permission: 'procurement.manage', base_version: cur.version,
      summary: `Change ${cur.name}: ${changed.map((k) => VENDOR_FIELD_LABEL[k] ?? k).join(', ')}`,
      before: vendorShow(cur as Partial<VendorData>, changed), after: vendorShow(v, changed), payload: { op: 'update', id: cur.id, data: v },
    })
  })
  for (const action of ['block', 'unblock'] as const)
    r.post(`/vendors/:id/${action}`, ({ ctx, params, body }) => {
      requireAction(ctx, 'procurement.manage')
      const cur = find(ctx, 'vendors', params.id, 'Vendor')
      const reason = String(body.reason ?? '').trim()
      if (action === 'block' && reason.length < 5) err(422, 'REASON_REQUIRED', 'Say why the vendor is blocked (at least 5 characters).', 'reason')
      const row = update(ctx, 'vendors', cur.id, { status: action === 'block' ? 'blocked' : 'active' })
      logActivity(ctx, 'vendor', row.id, action === 'block' ? 'blocked' : 'unblocked', action === 'block' ? `Blocked ${row.name} — ${reason}` : `Unblocked ${row.name}`)
      return row
    })

  r.post('/purchase-orders', ({ ctx, body }) => {
    requireAction(ctx, 'procurement.manage')
    const v = validatePO(ctx, body)
    const fy = curFy(ctx)
    const n = nextNumber(ctx, `po-${fy}`)
    const number = `PO/${String(fy % 100).padStart(2, '0')}-${String((fy + 1) % 100).padStart(2, '0')}/${String(n).padStart(4, '0')}`
    const po = insert(ctx, 'purchase_orders', {
      number, vendor_id: v.vendor_id, project_id: v.project_id, budget_category: v.budget_category, lines: v.lines, amount_paise: v.amount_paise, gst_pct: v.gst_pct, status: 'draft',
      requested_by: ctx.user.id, approver_id: null, decided_by: null, decided_at: null, decision_reason: null, needed_by: v.needed_by, title: v.title, justification: v.justification, over_budget: false, budget_remaining_paise: null,
    } as never) as POX
    logActivity(ctx, 'purchase_order', po.id, 'created', `Created ${number} · ${fmtMoney(poTotal(po))}`)
    return body.submit ? submitPO(ctx, po) : po
  })
  r.patch('/purchase-orders/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'procurement.manage')
    const cur = find(ctx, 'purchase_orders', params.id, 'Purchase order') as POX
    if (cur.status !== 'draft' && cur.status !== 'rejected') err(409, 'PO_LOCKED', `${cur.number} is ${cur.status} and can no longer be edited.`)
    const v = validatePO(ctx, body, cur)
    const po = update(ctx, 'purchase_orders', cur.id, { ...v, status: 'draft' } as Partial<B.PurchaseOrder>, ifMatch) as POX
    logActivity(ctx, 'purchase_order', po.id, 'edited', `Edited ${po.number}`)
    return body.submit ? submitPO(ctx, po) : po
  })
  r.post('/purchase-orders/:id/submit', ({ ctx, params, body }) => {
    requireAction(ctx, 'procurement.manage')
    const cur = find(ctx, 'purchase_orders', params.id, 'Purchase order') as POX
    if (cur.status !== 'draft' && cur.status !== 'rejected') err(409, 'INVALID_STATE', `${cur.number} is already ${cur.status}.`)
    if (body.justification !== undefined) cur.justification = String(body.justification).trim() || null
    return submitPO(ctx, cur)
  })
  r.post('/purchase-orders/:id/approve', ({ ctx, params, body, ifMatch }) => {
    const po = find(ctx, 'purchase_orders', params.id, 'Purchase order') as POX
    if (po.status !== 'pending') err(409, 'INVALID_STATE', `${po.number} is ${po.status}; only pending POs can be approved.`)
    if (!canDecidePO(ctx, po)) err(403, 'FORBIDDEN', po.requested_by === ctx.user.id ? 'You raised this purchase order, so someone else approves it.' : `This purchase order is waiting for ${userName(ctx, po.approver_id)}.`)
    const v = find(ctx, 'vendors', po.vendor_id, 'Vendor')
    if (v.status === 'blocked') err(409, 'VENDOR_BLOCKED', `${v.name} is blocked. Unblock the vendor or reject the PO.`)
    const note = String(body.note ?? '').trim()
    const st = ensureWf(ctx, po, 'purchase_order', poInput(po), adminId(ctx))
    const adv = advanceApproval(ctx, st, ctx.user.id)
    if (adv.next) {
      const nx = adv.next
      const r3 = update(ctx, 'purchase_orders', po.id, { approver_id: nx.approver_id, ...wfPatch(adv.state) } as Partial<B.PurchaseOrder>, ifMatch)
      logActivity(ctx, 'purchase_order', po.id, 'approved_step', `Step ${st.wf_step + 1} of ${st.wf_chain.length} (${adv.done?.name ?? 'approval'}) approved by ${ctx.user.name}; sent to ${userName(ctx, nx.approver_id)} for ${nx.name}${note ? ' — ' + note : ''}`)
      notify(ctx, nx.approver_id, 'NTF-04', 'Purchase order to approve', `${po.number} · ${fmtMoney(poTotal(po))} — approved by ${ctx.user.name}, needs your approval (${nx.name}).`, '/purchases?tab=pos')
      warn(ctx, 'NEXT_APPROVAL', `Step ${st.wf_step + 1} of ${st.wf_chain.length} approved — sent to ${userName(ctx, nx.approver_id)} for ${nx.name.toLowerCase()}.`)
      return r3
    }
    const r2 = update(ctx, 'purchase_orders', po.id, { status: 'approved', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: note || null, ...wfPatch(adv.state) } as Partial<B.PurchaseOrder>, ifMatch)
    logActivity(ctx, 'purchase_order', po.id, 'approved', `Approved ${po.number} · ${fmtMoney(poTotal(po))}${po.over_budget ? ' (over budget: ' + (po.justification ?? '') + ')' : ''}`)
    notify(ctx, po.requested_by, 'NTF-05', 'Purchase order approved', `${po.number} · ${v.name} · ${fmtMoney(poTotal(po))} was approved. Send it to the vendor.`, '/purchases?tab=pos')
    return r2
  })
  r.post('/purchase-orders/:id/reject', ({ ctx, params, body, ifMatch }) => {
    const po = find(ctx, 'purchase_orders', params.id, 'Purchase order') as POX
    if (po.status !== 'pending') err(409, 'INVALID_STATE', `${po.number} is ${po.status}; only pending POs can be rejected.`)
    if (!canDecidePO(ctx, po)) err(403, 'FORBIDDEN', `This purchase order is waiting for ${userName(ctx, po.approver_id)}.`)
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 5) err(422, 'REASON_REQUIRED', 'Say why the PO is rejected (at least 5 characters).', 'reason')
    const r2 = update(ctx, 'purchase_orders', po.id, { status: 'rejected', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: reason, ...wfClear() } as Partial<B.PurchaseOrder>, ifMatch)
    logActivity(ctx, 'purchase_order', po.id, 'rejected', `Rejected ${po.number} — ${reason}`)
    notify(ctx, po.requested_by, 'NTF-06', 'Purchase order rejected', `${po.number}: ${reason}`, '/purchases?tab=pos')
    return r2
  })
  r.post('/purchase-orders/:id/close', ({ ctx, params }) => {
    requireAction(ctx, 'procurement.manage')
    const po = find(ctx, 'purchase_orders', params.id, 'Purchase order') as POX
    if (po.status !== 'approved') err(409, 'INVALID_STATE', 'Only approved POs can be closed.')
    const r2 = update(ctx, 'purchase_orders', po.id, { status: 'closed' })
    logActivity(ctx, 'purchase_order', po.id, 'closed', `Closed ${po.number}`)
    return r2
  })
  r.del('/purchase-orders/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'procurement.manage')
    const po = find(ctx, 'purchase_orders', params.id, 'Purchase order')
    if (po.status !== 'draft') err(409, 'PO_LOCKED', 'Only draft POs can be deleted. Reject or close it instead.')
    remove(ctx, 'purchase_orders', po.id, ifMatch)
    logActivity(ctx, 'purchase_order', po.id, 'deleted', `Deleted draft ${po.number}`)
    return { ok: true }
  })

  r.post('/vendor-bills', ({ ctx, body }) => {
    requireAction(ctx, 'procurement.manage')
    const v = validateBill(ctx, body)
    const fileId = saveFile(ctx, body.file as FileIn | null, 'vendor_bill', 'file')
    const b = insert(ctx, 'vendor_bills', { ...v, status: 'received', paid_on: null, file_id: fileId, ledger_entry_id: null, approved_by: null, dispute_reason: null } as never) as BillX
    linkFile(ctx, fileId, b.id)
    if (b.po_id) {
      const po = rows(ctx, 'purchase_orders').find((x) => x.id === b.po_id)!
      if (b.amount_paise > po.amount_paise) warn(ctx, 'BILL_OVER_PO', `This bill is ${(((b.amount_paise - po.amount_paise) / po.amount_paise) * 100).toFixed(1)}% over ${po.number} — within the 5% tolerance.`)
    }
    logActivity(ctx, 'vendor_bill', b.id, 'created', `Recorded bill ${b.number} · ${fmtMoney(b.amount_paise + b.gst_paise)}`)
    const wf = startApproval(ctx, 'vendor_bill', billInput(ctx, b), adminId(ctx))
    const admin = wf.approver_id
    update(ctx, 'vendor_bills', b.id, { approver_id: admin, ...wfPatch(wf) } as Partial<B.VendorBill>)
    if (admin && admin !== ctx.user.id) notify(ctx, admin, 'NTF-04', 'Vendor bill to approve', `Bill ${b.number} · ${fmtMoney(b.amount_paise + b.gst_paise)}, due ${b.due_on}.`, '/purchases?tab=bills')
    return b
  })
  r.patch('/vendor-bills/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'procurement.manage')
    const cur = find(ctx, 'vendor_bills', params.id, 'Vendor bill') as BillX
    if (cur.status === 'paid' || cur.status === 'approved') err(409, 'BILL_LOCKED', `This bill is ${cur.status} and can no longer be edited.`)
    const v = validateBill(ctx, body, cur)
    const b = update(ctx, 'vendor_bills', cur.id, { ...v, status: 'received', dispute_reason: null } as Partial<B.VendorBill>, ifMatch)
    logActivity(ctx, 'vendor_bill', b.id, 'edited', `Edited bill ${b.number}`)
    return b
  })
  r.post('/vendor-bills/:id/approve', ({ ctx, params, ifMatch }) => {
    const b = find(ctx, 'vendor_bills', params.id, 'Vendor bill') as BillX
    if (b.status !== 'received') err(409, 'INVALID_STATE', b.status === 'disputed' ? 'Resolve the dispute before approving this bill.' : `This bill is already ${b.status}.`)
    if (!canDecideBill(ctx, b)) err(403, 'FORBIDDEN', `This bill is waiting for ${userName(ctx, b.approver_id ?? adminId(ctx))}.`)
    const st = ensureWf(ctx, b, 'vendor_bill', billInput(ctx, b), adminId(ctx), b.approver_id ?? adminId(ctx))
    const adv = advanceApproval(ctx, st, ctx.user.id)
    if (adv.next) {
      const nx = adv.next
      const r3 = update(ctx, 'vendor_bills', b.id, { approver_id: nx.approver_id, ...wfPatch(adv.state) } as Partial<B.VendorBill>, ifMatch)
      logActivity(ctx, 'vendor_bill', b.id, 'approved_step', `Step ${st.wf_step + 1} of ${st.wf_chain.length} (${adv.done?.name ?? 'approval'}) of bill ${b.number} approved by ${ctx.user.name}; sent to ${userName(ctx, nx.approver_id)}`)
      notify(ctx, nx.approver_id, 'NTF-04', 'Vendor bill to approve', `Bill ${b.number} · ${fmtMoney(b.amount_paise + b.gst_paise)} — approved by ${ctx.user.name}, needs your approval (${nx.name}).`, '/purchases?tab=bills')
      warn(ctx, 'NEXT_APPROVAL', `Step ${st.wf_step + 1} of ${st.wf_chain.length} approved — sent to ${userName(ctx, nx.approver_id)}.`)
      return r3
    }
    const r2 = update(ctx, 'vendor_bills', b.id, { status: 'approved', approved_by: ctx.user.id, ...wfPatch(adv.state) } as Partial<B.VendorBill>, ifMatch)
    logActivity(ctx, 'vendor_bill', b.id, 'approved', `Approved bill ${b.number} for payment`)
    const creator = b.created_by
    if (creator && creator !== ctx.user.id) notify(ctx, creator, 'NTF-05', 'Vendor bill approved', `Bill ${b.number} is approved for payment by ${b.due_on}.`, '/purchases?tab=bills')
    return r2
  })
  r.post('/vendor-bills/:id/dispute', ({ ctx, params, body }) => {
    requireAction(ctx, 'procurement.manage')
    const b = find(ctx, 'vendor_bills', params.id, 'Vendor bill') as BillX
    if (b.status === 'paid') err(409, 'INVALID_STATE', 'A paid bill cannot be disputed. Ask the vendor for a credit note.')
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 10) err(422, 'REASON_REQUIRED', 'Describe the dispute (at least 10 characters) so the vendor can respond.', 'reason')
    const r2 = update(ctx, 'vendor_bills', b.id, { status: 'disputed', dispute_reason: reason } as Partial<B.VendorBill>)
    logActivity(ctx, 'vendor_bill', b.id, 'disputed', `Disputed bill ${b.number} — ${reason}`)
    return r2
  })
  r.post('/vendor-bills/:id/resolve', ({ ctx, params }) => {
    requireAction(ctx, 'procurement.manage')
    const b = find(ctx, 'vendor_bills', params.id, 'Vendor bill') as BillX
    if (b.status !== 'disputed') err(409, 'INVALID_STATE', 'This bill is not disputed.')
    const r2 = update(ctx, 'vendor_bills', b.id, { status: 'received' } as Partial<B.VendorBill>)
    logActivity(ctx, 'vendor_bill', b.id, 'resolved', `Dispute on bill ${b.number} resolved`)
    return r2
  })
  r.post('/vendor-bills/:id/pay', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'procurement.manage', 'Only admin and HR & operations pay vendor bills.')
    const b = find(ctx, 'vendor_bills', params.id, 'Vendor bill') as BillX
    if (b.status !== 'approved') err(409, 'INVALID_STATE', b.status === 'paid' ? 'This bill is already paid.' : 'Only approved bills can be paid.')
    const paid_on = body.paid_on ? needDate(body.paid_on, 'paid_on', 'Payment date') : ctx.today
    if (paid_on > ctx.today) err(422, 'DATE_IN_FUTURE', 'The payment date is in the future.', 'paid_on')
    const v = find(ctx, 'vendors', b.vendor_id, 'Vendor')
    const po = b.po_id ? (rows(ctx, 'purchase_orders').find((x) => x.id === b.po_id) as POX | undefined) : undefined
    const p = po?.project_id ? rows(ctx, 'projects').find((x) => x.id === po.project_id) : null
    const le = insert(ctx, 'ledger_entries', {
      kind: 'expense', category: billCategory(ctx, b), description: `Vendor bill ${b.number} · ${v.name}${po ? ' · ' + po.number : ''}${b.tds_paise ? ` (TDS ${fmtMoney(b.tds_paise)} deducted)` : ''}`,
      amount_paise: b.amount_paise + b.gst_paise, date: paid_on, recurring: false, until_on: null, status: 'paid', project_id: po?.project_id ?? null, milestone_id: null, invoice_id: null, stream: p?.stream ?? null, locked: true,
    } as never) as E.LedgerEntry
    const r2 = update(ctx, 'vendor_bills', b.id, { status: 'paid', paid_on, ledger_entry_id: le.id }, ifMatch)
    logActivity(ctx, 'vendor_bill', b.id, 'paid', `Paid bill ${b.number} · ${fmtMoney(b.amount_paise + b.gst_paise - b.tds_paise)} to ${v.name}`)
    if (po) {
      const billed = rows(ctx, 'vendor_bills').filter((x) => x.po_id === po.id && x.status === 'paid').reduce((a, x) => a + x.amount_paise, 0)
      if (po.status === 'approved' && billed >= po.amount_paise) {
        update(ctx, 'purchase_orders', po.id, { status: 'closed' })
        logActivity(ctx, 'purchase_order', po.id, 'closed', `${po.number} closed — fully billed and paid`)
      }
    }
    return r2
  })

  /* ---------- budgets ---------- */
  r.get('/budgets', ({ ctx, query }) => {
    requireAction(ctx, 'budgets.manage', 'Only the admin manages budgets.')
    const fy = Number(query.fy ?? curFy(ctx))
    return budgetStatement(ctx, fy)
  })
  r.put('/budgets', ({ ctx, body, ifMatch }) => {
    requireAction(ctx, 'budgets.manage', 'Only the admin manages budgets.')
    const fy = Number(body.fy_start_year)
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) err(422, 'VAL_REQUIRED', 'Choose the financial year.', 'fy_start_year')
    const kind: B.Budget['kind'] = body.kind === 'revenue' ? 'revenue' : 'expense'
    const category = needText(body.category, 'category', 'Category', 2, 60)
    if (kind === 'revenue' && !(category in STREAM)) err(422, 'VAL_CATEGORY', 'Revenue budgets are set per revenue stream.', 'category')
    const monthly = (body.monthly_paise ?? []) as number[]
    if (!Array.isArray(monthly) || monthly.length !== 12) err(422, 'VAL_PHASING', 'Phase the budget across all 12 months.', 'monthly_paise')
    monthly.forEach((m, i) => money(m, 'monthly_paise', `Month ${i + 1}`, true))
    const existing = budgetsFor(ctx, fy).find((b) => b.kind === kind && lc(b.category) === lc(category))
    if (ifMatch !== undefined && existing && ifMatch !== existing.version) err(409, 'STALE', 'Someone else changed this budget. Reload to see the latest version.')
    const data = { fy_start_year: fy, kind, category: existing?.category ?? category, owner_id: (body.owner_id as string | null) ?? existing?.owner_id ?? null, monthly_paise: monthly, notes: String(body.notes ?? existing?.notes ?? '') }
    const total = monthly.reduce((a, b) => a + b, 0)
    return propose<B.Budget>(ctx, {
      entity: 'budget', entity_id: existing?.id ?? budgetKey(fy, kind, category), action: existing ? 'update' : 'create', required_permission: 'budgets.manage', base_version: existing?.version ?? null,
      summary: `${fyLabel(fy)} ${kind} budget · ${data.category}: ${existing ? `${fmtMoney(existing.monthly_paise.reduce((a, b) => a + b, 0))} → ` : ''}${fmtMoney(total)}`,
      before: existing ? budgetShow(ctx, existing) : null, after: budgetShow(ctx, data), payload: { op: 'save', id: existing?.id ?? null, data },
    })
  })
  r.del('/budgets/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'budgets.manage', 'Only the admin manages budgets.')
    const b = find(ctx, 'budgets', params.id, 'Budget')
    if (ifMatch !== undefined && ifMatch !== b.version) err(409, 'STALE', 'Someone else changed this budget. Reload to see the latest version.')
    return propose<{ ok: true }>(ctx, {
      entity: 'budget', entity_id: b.id, action: 'delete', required_permission: 'budgets.manage', base_version: b.version,
      summary: `Remove ${fyLabel(b.fy_start_year)} ${b.kind} budget · ${b.category} (${fmtMoney(b.monthly_paise.reduce((a, x) => a + x, 0))})`,
      before: budgetShow(ctx, b), after: null, payload: { op: 'delete', id: b.id },
    })
  })
  r.post('/budgets/copy', ({ ctx, body }) => {
    requireAction(ctx, 'budgets.manage', 'Only the admin manages budgets.')
    const to = Number(body.to_fy)
    const from = Number(body.from_fy ?? to - 1)
    const growth = Number(body.growth_pct ?? 0)
    if (!Number.isFinite(growth) || growth < -50 || growth > 200) err(422, 'VAL_RANGE', 'Growth must be between −50% and 200%.', 'growth_pct')
    const src = budgetsFor(ctx, from)
    if (!src.length) err(409, 'NO_SOURCE_BUDGET', `There is no ${fyLabel(from)} budget to copy.`)
    if (!Number.isInteger(to) || to < 2000 || to > 2100) err(422, 'VAL_REQUIRED', 'Choose the financial year to copy into.', 'to_fy')
    const overwrite = !!body.overwrite
    return propose<{ created: number; replaced: number; skipped: number }>(ctx, {
      entity: 'budget', entity_id: `budget_copy_${to}`, action: 'execute', required_permission: 'budgets.manage',
      summary: `Copy ${fyLabel(from)} budgets to ${fyLabel(to)} at ${growth >= 0 ? '+' : ''}${growth}%${overwrite ? ', replacing existing lines' : ''}`,
      before: { 'Target year': fyLabel(to), 'Lines already there': budgetsFor(ctx, to).length }, after: { 'Copied from': fyLabel(from), Lines: src.length, Growth: `${growth}%`, 'Replace existing': overwrite ? 'Yes' : 'No' },
      payload: { op: 'copy', from, to, growth, overwrite },
    })
  })
  registerRest(r)
}

function budgetShow(ctx: Ctx, b: { fy_start_year: number; category: string; owner_id: string | null; monthly_paise: number[]; notes: string }): Record<string, unknown> {
  const months = fyMonths(ctx, b.fy_start_year)
  const out: Record<string, unknown> = { Category: b.category, 'Annual total': fmtMoney(b.monthly_paise.reduce((a, x) => a + x, 0)), Owner: userName(ctx, b.owner_id) }
  months.forEach((m, i) => (out[new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })] = fmtMoney(b.monthly_paise[i] ?? 0)))
  if (b.notes) out.Notes = b.notes
  return out
}

function copyBudgets(ctx: Ctx, from: number, to: number, growth: number, overwrite: boolean) {
    const src = budgetsFor(ctx, from)
    let created = 0, replaced = 0, skipped = 0
    for (const s of src) {
      const monthly = s.monthly_paise.map((m) => Math.round((m * (100 + growth)) / 100 / 100) * 100)
      const ex = budgetsFor(ctx, to).find((b) => b.kind === s.kind && lc(b.category) === lc(s.category))
      if (ex && !overwrite) {
        skipped++
        continue
      }
      if (ex) {
        update(ctx, 'budgets', ex.id, { monthly_paise: monthly, owner_id: s.owner_id, notes: s.notes })
        replaced++
      } else {
        insert(ctx, 'budgets', { fy_start_year: to, kind: s.kind, category: s.category, owner_id: s.owner_id, monthly_paise: monthly, notes: s.notes })
        created++
      }
    }
    logActivity(ctx, 'budget', `fy_${to}`, 'copied', `Copied ${fyLabel(from)} budgets to ${fyLabel(to)} at ${growth >= 0 ? '+' : ''}${growth}% (${created} new, ${replaced} replaced, ${skipped} kept)`)
    return { created, replaced, skipped }
}

/* ---------- maker-checker appliers (run directly when maker-checker is off for the entity) ---------- */
const by = (ctx: Ctx, cs: { id: string; maker_id: string }) => (cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : '')
registerApplier('vendor', (ctx, cs) => {
  const p = cs.payload as { op: 'create' | 'update'; id?: string; data: VendorData }
  if (p.op === 'create') {
    const v = validateVendor(ctx, p.data)
    const row = insert(ctx, 'vendors', { ...v, status: 'active' } as never) as VendorX
    logActivity(ctx, 'vendor', row.id, 'created', `Added vendor ${row.name}${by(ctx, cs)}`)
    return { result: row, result_id: row.id }
  }
  const cur = find(ctx, 'vendors', p.id!, 'Vendor') as VendorX
  assertBaseVersion(cs, cur.version)
  const v = validateVendor(ctx, p.data, cur)
  const row = update(ctx, 'vendors', cur.id, v as Partial<B.Vendor>)
  logActivity(ctx, 'vendor', row.id, 'edited', `${cs.summary}${by(ctx, cs)}`)
  return { result: row, result_id: row.id }
})
registerApplier('budget', (ctx, cs) => {
  const p = cs.payload as { op: 'save' | 'delete' | 'copy'; id?: string | null; data?: Omit<B.Budget, keyof E.Base>; from?: number; to?: number; growth?: number; overwrite?: boolean }
  if (p.op === 'copy') {
    const r = copyBudgets(ctx, p.from!, p.to!, p.growth!, !!p.overwrite)
    return { result: r, result_id: null }
  }
  if (p.op === 'delete') {
    const b = find(ctx, 'budgets', p.id!, 'Budget')
    assertBaseVersion(cs, b.version)
    remove(ctx, 'budgets', b.id)
    logActivity(ctx, 'budget', b.id, 'deleted', `Removed ${fyLabel(b.fy_start_year)} budget · ${b.category}${by(ctx, cs)}`)
    return { result: { ok: true }, result_id: b.id }
  }
  const d = p.data!
  const existing = p.id ? find(ctx, 'budgets', p.id, 'Budget') : budgetsFor(ctx, d.fy_start_year).find((b) => b.kind === d.kind && lc(b.category) === lc(d.category))
  if (existing) assertBaseVersion(cs, existing.version)
  const row = existing ? update(ctx, 'budgets', existing.id, d) : insert(ctx, 'budgets', d)
  logActivity(ctx, 'budget', row.id, existing ? 'edited' : 'created', `${fyLabel(d.fy_start_year)} ${d.kind} budget · ${row.category} · ${fmtMoney(d.monthly_paise.reduce((a, b) => a + b, 0))}${by(ctx, cs)}`)
  return { result: row, result_id: row.id }
})

function registerRest(r: Router) {

  /* ---------- revenue leakage ---------- */
  r.get('/leakage', ({ ctx, query }) => {
    requireAction(ctx, 'leakage.view', 'Only the admin can see lost revenue.')
    return leakageResult(ctx, Number(query.fy ?? curFy(ctx)))
  })
  const validateLeak = (ctx: Ctx, body: Record<string, unknown>, existing?: LeakX) => {
    const kind = String(body.kind ?? existing?.kind ?? '') as B.LeakageKind
    if (!MANUAL_LEAKAGE_KINDS.includes(kind)) err(422, 'VAL_KIND', 'Choose discount, write-off, credit note, penalty, scope creep or churn. Lost deals, unbilled hours and bad debts are recorded automatically.', 'kind')
    const amount = money(body.amount_paise ?? existing?.amount_paise, 'amount_paise', 'Amount')
    const date = needDate(body.date ?? existing?.date, 'date', 'Date')
    if (date > ctx.today) err(422, 'DATE_IN_FUTURE', 'The date is in the future.', 'date')
    const reason = needText(body.reason ?? existing?.reason, 'reason', 'Reason', 10, 400)
    const project_id = body.project_id === undefined ? existing?.project_id ?? null : (body.project_id as string | null) || null
    const p = project_id ? find(ctx, 'projects', project_id, 'Project') : null
    const client = String(body.client ?? existing?.client ?? p?.client ?? '').trim()
    if (!client) err(422, 'VAL_REQUIRED', 'Choose the client.', 'client')
    const status = String(body.status ?? existing?.status ?? 'open') as B.RevenueLeakage['status']
    if (!['open', 'recovered', 'accepted'].includes(status)) err(422, 'VAL_STATUS', 'Unknown status.', 'status')
    let recovered = money(body.recovered_paise ?? existing?.recovered_paise ?? 0, 'recovered_paise', 'Recovered amount', true)
    if (recovered > amount) err(422, 'VAL_RANGE', 'Recovered cannot be more than the amount lost.', 'recovered_paise')
    if (status === 'recovered' && recovered === 0) recovered = amount
    const recoverable = body.recoverable === undefined ? existing?.recoverable ?? (kind === 'penalty' || kind === 'credit_note') : !!body.recoverable
    return { kind, amount_paise: amount, date, reason, project_id, client, status, recovered_paise: recovered, recoverable, deal_id: (body.deal_id as string | null) ?? existing?.deal_id ?? null }
  }
  r.post('/leakage', ({ ctx, body }) => {
    requireAction(ctx, 'leakage.view', 'Only the admin records lost revenue.')
    const v = validateLeak(ctx, body)
    const row = insert(ctx, 'revenue_leakage', { ...v, recorded_by: ctx.user.id, auto: false })
    logActivity(ctx, 'leakage', row.id, 'created', `Recorded ${LEAKAGE_KIND[row.kind].label.toLowerCase()} ${fmtMoney(row.amount_paise)} · ${row.client}`)
    return row
  })
  r.patch('/leakage/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'leakage.view')
    if (params.id.startsWith('auto_')) err(409, 'AUTO_ROW', 'This row is calculated from deals, timesheets or invoices and cannot be edited. Fix the source record instead.')
    const cur = find(ctx, 'revenue_leakage', params.id, 'Leakage entry') as LeakX
    const v = validateLeak(ctx, body, cur)
    const row = update(ctx, 'revenue_leakage', cur.id, v, ifMatch)
    logActivity(ctx, 'leakage', row.id, 'edited', `Updated ${LEAKAGE_KIND[row.kind].label.toLowerCase()} · ${row.client} · ${row.status}${row.recovered_paise ? ` (${fmtMoney(row.recovered_paise)} recovered)` : ''}`)
    return row
  })
  r.del('/leakage/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'leakage.view')
    if (params.id.startsWith('auto_')) err(409, 'AUTO_ROW', 'Calculated rows cannot be deleted.')
    const cur = find(ctx, 'revenue_leakage', params.id, 'Leakage entry')
    remove(ctx, 'revenue_leakage', cur.id, ifMatch)
    logActivity(ctx, 'leakage', cur.id, 'deleted', `Removed ${LEAKAGE_KIND[cur.kind].label.toLowerCase()} · ${cur.client}`)
    return { ok: true }
  })

  /* ---------- CEO dashboard summary ---------- */
  r.get('/spend/summary', ({ ctx }): SpendSummary => {
    requireAction(ctx, 'budgets.manage', 'Only the admin sees the spend summary.')
    const fy = curFy(ctx)
    const st = budgetStatement(ctx, fy)
    const i = Math.max(0, Math.min(11, st.current_month_index))
    const lk = leakageResult(ctx, fy)
    const exp = rows(ctx, 'expense_claims')
    const bills = purchases(ctx).bills.filter((b) => b.status === 'approved' || b.status === 'received')
    const { contractRenewals } = getClientsHelpers()
    return {
      month: st.months[i],
      month_spend: st.expense.reduce((a, l) => a + l.monthly_actual[i], 0),
      month_committed: st.expense.reduce((a, l) => a + l.monthly_committed[i], 0),
      month_budget: st.expense.reduce((a, l) => a + l.monthly_budget[i], 0),
      unbudgeted_fy: st.totals.unbudgeted,
      pending_reimbursement: { amount: exp.filter((e) => e.status === 'approved').reduce((a, e) => a + e.amount_paise, 0), count: exp.filter((e) => e.status === 'approved').length },
      awaiting_approval: { amount: exp.filter((e) => e.status === 'submitted').reduce((a, e) => a + e.amount_paise, 0), count: exp.filter((e) => e.status === 'submitted').length },
      bills_payable: { amount: bills.reduce((a, b) => a + b.net_payable_paise, 0), count: bills.length, overdue: bills.filter((b) => b.days_overdue > 0).reduce((a, b) => a + b.net_payable_paise, 0) },
      leakage_fy: lk.summary.net,
      leakage_top: lk.summary.by_kind.slice(0, 3).map((k) => ({ kind: k.kind, label: k.label, amount: k.amount })),
      renewals: contractRenewals ? contractRenewals(ctx) : [],
    }
  })
}

/* Late-bound link to the clients module (avoids a circular import at load time). */
type ClientsHelpers = { contractRenewals?: (ctx: Ctx) => SpendSummary['renewals'] }
const helpers: ClientsHelpers = {}
export function provideClientsHelpers(h: ClientsHelpers) {
  Object.assign(helpers, h)
}
function getClientsHelpers() {
  return helpers
}
