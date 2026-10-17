// Module D — Finance: ledger (UI-31), tenant-wide invoice register + payments, profit & loss with runway.
// Milestone invoice raising lives in Module B (projects). This file only READS invoices and adds
// payments recorded from the register under /finance/invoices/:id/payments.
import type * as E from '@/types/entities'
import { err, find, has, insert, logActivity, remove, requireAction, rows, update, type Ctx, type Router } from '../server'
import { expandLedger, payrollForMonth, PAYROLL_CATEGORIES, revenueBetween } from '../analytics'
import { dealValue } from '@/domain/sales'
import { DEAL_STAGE } from '@/domain/labels'
import { addDays, addMonths, diffDays, fyRange, fyStartYear, fyLabel, monthOf, monthRange } from '@/domain/calendar'
import { STREAM } from '@/domain/labels'
import { fmtMoney } from '@/domain/money'

/* ------------------------------------------------------------------ */
/* Contracts shared with src/api/finance.ts                            */
/* ------------------------------------------------------------------ */
export interface LedgerRow {
  key: string // id + occurrence (recurring rows repeat)
  id: string
  version: number
  kind: E.LedgerKind
  category: string
  description: string
  amount_paise: number
  date: string // occurrence date
  origin_date: string
  recurring: boolean
  until_on: string | null
  status: E.LedgerEntry['status']
  project_id: string | null
  project_name: string | null
  project_code: string | null
  invoice_id: string | null
  stream: E.RevenueStream | null
  locked: boolean
}
export interface LedgerResult {
  from: string
  to: string
  items: LedgerRow[]
  totals: { income: number; expense: number; net: number; received: number; paid: number; expected_in: number; expected_out: number; count: number }
  categories: { income: string[]; expense: string[] }
  can_edit: boolean
}

/** G13.02 — ledger entries as entered (one line per entry; recurring ones once, not per month). */
export interface LedgerEntryRow {
  id: string
  version: number
  kind: E.LedgerKind
  category: string
  description: string
  amount_paise: number
  date: string
  recurring: boolean
  until_on: string | null
  /** one-time: received / paid / expected; recurring: running / upcoming / ended */
  status: E.LedgerEntry['status']
  run_state: 'running' | 'upcoming' | 'ended' | null
  stream: E.RevenueStream | null
  project_id: string | null
  project_code: string | null
  /** money this entry has put in the books in the chosen scope (recurring = months × amount) */
  booked_paise: number
  months: number
}
export interface LedgerEntriesResult {
  scope: 'fy' | 'all'
  fy_label: string
  from: string
  to: string
  items: LedgerEntryRow[]
  automatic: { key: 'milestone' | 'spend' | 'payroll'; label: string; count: number; amount: number }[]
  can_edit: boolean
}

export type InvoiceState = 'paid' | 'partly_paid' | 'due' | 'overdue'
export type AgeBucket = '0_30' | '31_60' | '61_90' | '90_plus'
export interface InvoiceRow {
  id: string
  version: number
  number: string
  project_id: string
  project_name: string
  project_code: string
  client: string
  milestone_id: string
  milestone_label: string
  invoiced_on: string
  due_on: string
  amount_paise: number
  paid_paise: number
  outstanding_paise: number
  paid_on: string | null
  age_days: number
  bucket: AgeBucket | null
  state: InvoiceState
  days_overdue: number
  stream: E.RevenueStream
  payments: { id: string; amount_paise: number; paid_on: string; reference: string }[]
}
export interface InvoicesResult {
  items: InvoiceRow[]
  summary: {
    fy_label: string
    billed_fy: number
    collected_fy: number
    outstanding: number
    outstanding_count: number
    overdue: number
    overdue_count: number
    dso: number | null
    ageing: Record<AgeBucket, { amount: number; count: number }>
  }
}

export interface PnlLine {
  key: string
  label: string
  amount: number
  prev: number
}
export interface PnlResult {
  from: string
  to: string
  prev_from: string
  prev_to: string
  /** last day counted: the period end, or today for a current period */
  as_of: string
  income: { by_stream: PnlLine[]; by_category: PnlLine[]; total: number; prev_total: number }
  expense: { by_category: PnlLine[]; direct: number; total: number; prev_total: number }
  gross_profit: number
  gross_margin: number | null
  net_profit: number
  net_margin: number | null
  prev_net_profit: number
  collected: number
  months: { month: string; label: string; billed: number; collected: number; cost: number; net: number; payroll: number; other_costs: number; net_pl: number }[]
  /** G13.01 — last 6 months ending this month (this month to date): payroll from payrollForMonth, other costs = non-salary ledger expenses */
  monthly: { month: string; label: string; billed: number; collected: number; payroll: number; other_costs: number; net: number; headcount: number; to_date: boolean }[]
  cash: { opening: number; balance: number; monthly_burn: number; recurring_income: number; net_burn: number; runway_months: number | null; cash_positive: boolean }
  revenue_ahead: { uninvoiced: number; uninvoiced_count: number; in_30: number; in_60: number; in_90: number; weighted_pipeline: number; open_pipeline: number; total: number }
}

/* ------------------------------------------------------------------ */
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DIRECT = new Set(['Salaries', 'Subcontractors', 'Contractors', 'Cost of delivery'])
export const INCOME_CATEGORIES = ['SAP consulting', 'Consulting', 'Subscription / AMC', 'Services', 'Milestone invoice', 'SaaS subscriptions', 'AMS', 'Product licence', 'Other income']
export const EXPENSE_CATEGORIES = ['Salaries', 'Rent', 'Tools & software', 'Marketing', 'Utilities', 'Travel', 'Equipment', 'Compliance', 'Subcontractors', 'Professional fees', 'Other']
const monthLabel = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })

function range(ctx: Ctx, query: Record<string, unknown>) {
  const def = monthRange(monthOf(ctx.today))
  const from = DATE.test(String(query.from ?? '')) ? String(query.from) : def.from
  const to = DATE.test(String(query.to ?? '')) ? String(query.to) : def.to
  if (to < from) err(422, 'DATE_RANGE', 'The end date must be on or after the start date.')
  return { from, to }
}

function validateLedger(b: Partial<E.LedgerEntry>, creating: boolean) {
  if (creating || 'kind' in b) if (b.kind !== 'income' && b.kind !== 'expense') err(422, 'VALIDATION', 'Choose Income or Expense.', 'kind')
  if (creating || 'category' in b) if (!b.category || !String(b.category).trim()) err(422, 'VALIDATION', 'Choose a category.', 'category')
  if (creating || 'description' in b) if (!b.description || String(b.description).trim().length < 3) err(422, 'VALIDATION', 'Describe the entry (at least 3 characters).', 'description')
  if (creating || 'amount_paise' in b) if (typeof b.amount_paise !== 'number' || !Number.isInteger(b.amount_paise) || b.amount_paise <= 0) err(422, 'MONEY_INVALID', 'Enter an amount above zero.', 'amount_paise')
  if (creating || 'date' in b) if (!b.date || !DATE.test(b.date)) err(422, 'VALIDATION', 'Pick a date.', 'date')
  if ('until_on' in b && b.until_on && !DATE.test(b.until_on)) err(422, 'VALIDATION', 'Pick a valid end date.', 'until_on')
  if ('status' in b && b.status && !['expected', 'received', 'paid'].includes(b.status)) err(422, 'VALIDATION', 'Choose a status.', 'status')
  if ('stream' in b && b.stream && !(b.stream in STREAM)) err(422, 'VALIDATION', 'Choose a revenue stream.', 'stream')
}

/** Cash on hand today = opening cash + money actually received − money actually paid. */
function cashPosition(ctx: Ctx) {
  const opening = ctx.tenant.settings['finance.opening_cash_paise'] ?? 0
  const all = rows(ctx, 'ledger_entries')
  const start = all.reduce((m, e) => (e.date < m ? e.date : m), ctx.today)
  const entries = expandLedger(ctx, start, ctx.today)
  let inflow = 0, outflow = 0
  for (const e of entries) {
    if (e.kind === 'income' && !e.invoice_id && e.status === 'received') inflow += e.amount_paise
    if (e.kind === 'expense' && e.status === 'paid') outflow += e.amount_paise
  }
  for (const p of rows(ctx, 'payments')) if (p.paid_on <= ctx.today) inflow += p.amount_paise
  return { opening, balance: opening + inflow - outflow }
}

/**
 * G13.01 one month: billed, collected, payroll, other costs (non-salary expenses), net = billed − costs.
 * Same numbers as the CEO dashboard for that month: both come from revenueBetween (dated items up to today,
 * salaries from the shared payrollForMonth).
 */
export function monthlyPnl(ctx: Ctx, ym: string) {
  const mr = monthRange(ym)
  const x = revenueBetween(ctx, mr.from, mr.to)
  const pay = payrollForMonth(ctx, ym)
  return { month: ym, label: monthLabel(ym), billed: x.billed, collected: x.collected, payroll: x.payroll, other_costs: x.other_costs, net: x.net, headcount: pay.headcount, to_date: mr.to > ctx.today }
}

/** Open pipeline using the Feature Guide deal value (one-time + 12 × recurring). */
function salesPipeline(ctx: Ctx) {
  const open = rows(ctx, 'deals').filter((d) => d.stage !== 'won' && d.stage !== 'lost')
  return { open_value: open.reduce((s, d) => s + dealValue(d), 0), weighted_value: Math.round(open.reduce((s, d) => s + dealValue(d) * DEAL_STAGE[d.stage].chance, 0)) }
}

/* ------------------------------------------------------------------ */
export function register(r: Router) {
  /* ---------------- Ledger ---------------- */
  r.get('/finance/ledger', ({ ctx, query }) => {
    requireAction(ctx, 'ledger.view', 'The ledger is visible to admins and operations.')
    const { from, to } = range(ctx, query)
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    let items: LedgerRow[] = expandLedger(ctx, from, to).map((e) => ({
      key: `${e.id}:${e.occurrence}`, id: e.id, version: e.version, kind: e.kind, category: e.category, description: e.description, amount_paise: e.amount_paise,
      date: e.occurrence, origin_date: e.date, recurring: e.recurring, until_on: e.until_on, status: e.status, project_id: e.project_id,
      project_name: e.project_id ? projects.get(e.project_id)?.name ?? null : null, project_code: e.project_id ? projects.get(e.project_id)?.code ?? null : null,
      invoice_id: e.invoice_id, stream: e.stream, locked: e.locked,
    }))
    const q = String(query.q ?? '').trim().toLowerCase()
    if (query.kind) items = items.filter((x) => x.kind === query.kind)
    if (query.category) items = items.filter((x) => x.category === query.category)
    if (query.status) items = items.filter((x) => x.status === query.status)
    if (query.project_id) items = items.filter((x) => x.project_id === query.project_id)
    if (query.stream) items = items.filter((x) => x.stream === query.stream)
    if (query.recurring === 'true') items = items.filter((x) => x.recurring)
    if (q) items = items.filter((x) => `${x.description} ${x.category} ${x.project_name ?? ''}`.toLowerCase().includes(q))
    items.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind))
    const t = { income: 0, expense: 0, net: 0, received: 0, paid: 0, expected_in: 0, expected_out: 0, count: items.length }
    for (const x of items) {
      if (x.kind === 'income') {
        t.income += x.amount_paise
        if (x.status === 'received') t.received += x.amount_paise
        else t.expected_in += x.amount_paise
      } else {
        t.expense += x.amount_paise
        if (x.status === 'paid') t.paid += x.amount_paise
        else t.expected_out += x.amount_paise
      }
    }
    t.net = t.income - t.expense
    const all = rows(ctx, 'ledger_entries')
    const cats = (k: E.LedgerKind, base: string[]) => [...new Set([...base, ...all.filter((e) => e.kind === k).map((e) => e.category)])].sort()
    const out: LedgerResult = { from, to, items, totals: t, categories: { income: cats('income', INCOME_CATEGORIES), expense: cats('expense', EXPENSE_CATEGORIES) }, can_edit: has(ctx, 'finance.edit') }
    return out
  })

  r.get('/finance/ledger/entries', ({ ctx, query }) => {
    requireAction(ctx, 'ledger.view', 'The ledger is visible to admins and operations.')
    const fm = ctx.tenant.settings['company.fy_start_month']
    const fy = fyStartYear(ctx.today, fm)
    const fr = fyRange(fy, fm)
    const scope = query.scope === 'all' ? 'all' : 'fy'
    const all = rows(ctx, 'ledger_entries')
    const from = scope === 'all' ? all.reduce((m, e) => (e.date < m ? e.date : m), fr.from) : fr.from
    const to = fr.to
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const occ = new Map<string, { n: number; amt: number }>()
    for (const e of expandLedger(ctx, from, to)) {
      const c = occ.get(e.id) ?? { n: 0, amt: 0 }
      c.n++
      c.amt += e.amount_paise
      occ.set(e.id, c)
    }
    const manual = (e: E.LedgerEntry) => !e.locked && !e.invoice_id && !PAYROLL_CATEGORIES.has(e.category)
    const items: LedgerEntryRow[] = all
      .filter((e) => manual(e) && (occ.has(e.id) || (e.recurring && e.date > ctx.today && e.date <= to)))
      .map((e) => {
        const run_state: LedgerEntryRow['run_state'] = !e.recurring ? null : e.date > ctx.today ? 'upcoming' : e.until_on && e.until_on < ctx.today ? 'ended' : 'running'
        return {
          id: e.id, version: e.version, kind: e.kind, category: e.category, description: e.description, amount_paise: e.amount_paise, date: e.date, recurring: e.recurring, until_on: e.until_on,
          status: e.status, run_state, stream: e.stream, project_id: e.project_id, project_code: e.project_id ? projects.get(e.project_id)?.code ?? null : null,
          booked_paise: occ.get(e.id)?.amt ?? 0, months: occ.get(e.id)?.n ?? 0,
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind))
    const inScope = expandLedger(ctx, from, to)
    const group = (key: 'milestone' | 'spend' | 'payroll', label: string, f: (e: E.LedgerEntry) => boolean) => {
      const xs = inScope.filter(f)
      return { key, label, count: xs.length, amount: xs.reduce((s2, e) => s2 + e.amount_paise, 0) }
    }
    const out: LedgerEntriesResult = {
      scope, fy_label: fyLabel(fy), from, to, items,
      automatic: [
        group('milestone', 'Milestone invoices (income added automatically)', (e) => !!e.invoice_id),
        group('spend', 'Paid expense claims and vendor bills', (e) => e.locked && !e.invoice_id),
        group('payroll', 'Monthly salaries', (e) => !e.locked && PAYROLL_CATEGORIES.has(e.category)),
      ],
      can_edit: has(ctx, 'finance.edit'),
    }
    return out
  })

  r.post('/finance/ledger', ({ ctx, body }) => {
    requireAction(ctx, 'finance.edit', 'Only an admin can add ledger entries.')
    const b = body as Partial<E.LedgerEntry>
    validateLedger(b, true)
    const recurring = !!b.recurring
    if (recurring && b.until_on && b.until_on < b.date!) err(422, 'DATE_RANGE', 'The repeat end date must be on or after the first date.', 'until_on')
    if (b.project_id) find(ctx, 'projects', b.project_id, 'Project')
    const status = b.status ?? (b.date! <= ctx.today ? (b.kind === 'income' ? 'received' : 'paid') : 'expected')
    if (b.kind === 'income' && status === 'paid') err(422, 'VALIDATION', 'Income is either Expected or Received.', 'status')
    if (b.kind === 'expense' && status === 'received') err(422, 'VALIDATION', 'An expense is either Expected or Paid.', 'status')
    const e = insert(ctx, 'ledger_entries', {
      kind: b.kind!, category: b.category!.trim(), description: b.description!.trim(), amount_paise: b.amount_paise!, date: b.date!, recurring, until_on: recurring ? b.until_on || null : null,
      status, project_id: b.project_id || null, milestone_id: null, invoice_id: null, stream: b.kind === 'income' ? b.stream || null : null, locked: false,
    } as never) as E.LedgerEntry
    logActivity(ctx, 'ledger', e.id, 'create', `Added ${e.kind} ${fmtMoney(e.amount_paise)} · ${e.description}${recurring ? ' (monthly)' : ''}`)
    return e
  })

  r.patch('/finance/ledger/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'finance.edit', 'Only an admin can edit ledger entries.')
    const e = find(ctx, 'ledger_entries', params.id, 'Ledger entry')
    const b = { ...(body as Partial<E.LedgerEntry>) }
    for (const k of ['id', 'tenant_id', 'invoice_id', 'milestone_id', 'locked', 'version', 'created_at'] as const) delete (b as Record<string, unknown>)[k]
    if (e.locked) {
      const blocked = (['kind', 'amount_paise', 'date', 'status', 'recurring', 'project_id'] as const).filter((k) => k in b && b[k] !== e[k])
      if (blocked.length) err(409, 'LEDGER_LOCKED', 'This row comes from a milestone invoice. Change the amount, date or payment on the invoice instead.')
    }
    validateLedger(b, false)
    const next = { ...e, ...b }
    if (next.recurring && next.until_on && next.until_on < next.date) err(422, 'DATE_RANGE', 'The repeat end date must be on or after the first date.', 'until_on')
    if (next.kind === 'income' && next.status === 'paid') err(422, 'VALIDATION', 'Income is either Expected or Received.', 'status')
    if (next.kind === 'expense' && next.status === 'received') err(422, 'VALIDATION', 'An expense is either Expected or Paid.', 'status')
    if (b.project_id) find(ctx, 'projects', b.project_id, 'Project')
    const patch: Partial<E.LedgerEntry> = {}
    for (const k of ['kind', 'category', 'description', 'amount_paise', 'date', 'recurring', 'until_on', 'status', 'project_id', 'stream'] as const) if (k in b) (patch as Record<string, unknown>)[k] = typeof b[k] === 'string' ? (b[k] as string).trim() || null : b[k]
    if (patch.recurring === false) patch.until_on = null
    if (next.kind === 'expense') patch.stream = null
    const u = update(ctx, 'ledger_entries', e.id, patch as never, ifMatch)
    logActivity(ctx, 'ledger', e.id, 'update', `Edited ${u.kind} · ${u.description}`)
    return u
  })

  r.del('/finance/ledger/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'finance.edit', 'Only an admin can delete ledger entries.')
    const e = find(ctx, 'ledger_entries', params.id, 'Ledger entry')
    if (e.locked || e.invoice_id) err(409, 'LEDGER_LOCKED', 'This row was created by a milestone invoice and cannot be deleted. Adjust the invoice from the project instead.')
    remove(ctx, 'ledger_entries', e.id, ifMatch)
    logActivity(ctx, 'ledger', e.id, 'delete', `Deleted ${e.kind} ${fmtMoney(e.amount_paise)} · ${e.description}`)
    return { ok: true }
  })

  /** Lightweight project list for ledger filters / links (kept here so D doesn't depend on B's contract). */
  r.get('/finance/projects-lite', ({ ctx }) => {
    requireAction(ctx, 'ledger.view')
    return rows(ctx, 'projects')
      .map((p) => ({ id: p.id, code: p.code, name: p.name, client: p.client, stream: p.stream, status: p.status }))
      .sort((a, b) => a.code.localeCompare(b.code))
  })

  /* Invoice register + payments moved to routes/invoices.ts (v7 GST invoices). */

  /* ---------------- Profit & loss ---------------- */
  r.get('/finance/pnl', ({ ctx, query }) => {
    requireAction(ctx, 'finance.view', 'Profit & loss is visible to admins only.')
    const { from, to } = range(ctx, query)
    const days = diffDays(to, from) + 1
    const prev_to = addDays(from, -1)
    const prev_from = addDays(prev_to, -(days - 1))
    // Only what has happened counts: nothing dated after today (current and future periods are "to date").
    const asOf = to < ctx.today ? to : ctx.today
    const prevAsOf = prev_to < ctx.today ? prev_to : ctx.today
    const cur = from > asOf ? [] : expandLedger(ctx, from, asOf)
    const prev = prev_from > prevAsOf ? [] : expandLedger(ctx, prev_from, prevAsOf)
    const rv = revenueBetween(ctx, from, to)
    const rvPrev = revenueBetween(ctx, prev_from, prev_to)
    const group = (list: typeof cur, kind: E.LedgerKind, key: (e: (typeof cur)[number]) => string | null) => {
      const m = new Map<string, number>()
      for (const e of list) if (e.kind === kind && !(kind === 'expense' && PAYROLL_CATEGORIES.has(e.category))) {
        const k = key(e) ?? 'unassigned'
        m.set(k, (m.get(k) ?? 0) + e.amount_paise)
      }
      return m
    }
    const lines = (a: Map<string, number>, b: Map<string, number>, label: (k: string) => string): PnlLine[] =>
      [...new Set([...a.keys(), ...b.keys()])].map((k) => ({ key: k, label: label(k), amount: a.get(k) ?? 0, prev: b.get(k) ?? 0 })).filter((l) => l.amount || l.prev).sort((x, y) => y.amount - x.amount)
    const streamLabel = (k: string) => (k in STREAM ? STREAM[k as E.RevenueStream] : 'Unassigned')
    const incStream = lines(group(cur, 'income', (e) => e.stream), group(prev, 'income', (e) => e.stream), streamLabel)
    const incCat = lines(group(cur, 'income', (e) => e.category), group(prev, 'income', (e) => e.category), (k) => k)
    // Salaries: the shared payroll basis (same as the CEO dashboard and the monthly P&L)
    const expMap = group(cur, 'expense', (e) => e.category)
    const expPrevMap = group(prev, 'expense', (e) => e.category)
    if (rv.payroll) expMap.set('Salaries', rv.payroll)
    if (rvPrev.payroll) expPrevMap.set('Salaries', rvPrev.payroll)
    const expCat = lines(expMap, expPrevMap, (k) => k)
    const income = incCat.reduce((s, l) => s + l.amount, 0)
    const prevIncome = incCat.reduce((s, l) => s + l.prev, 0)
    const expense = expCat.reduce((s, l) => s + l.amount, 0)
    const prevExpense = expCat.reduce((s, l) => s + l.prev, 0)
    const direct = expCat.filter((l) => DIRECT.has(l.key)).reduce((s, l) => s + l.amount, 0)

    // 12 months ending with the month of `to`, never beyond this month (no future months on the chart)
    const endM = monthOf(asOf)
    const months = Array.from({ length: 12 }, (_, i) => monthOf(addMonths(endM + '-01', i - 11))).map((ym) => {
      const m = monthlyPnl(ctx, ym)
      return { month: ym, label: monthLabel(ym), billed: m.billed, collected: m.collected, cost: m.payroll + m.other_costs, net: m.net, payroll: m.payroll, other_costs: m.other_costs, net_pl: m.net }
    })
    const thisM = monthOf(ctx.today)
    const monthly = Array.from({ length: 6 }, (_, i) => monthOf(addMonths(thisM + '-01', i - 5))).map((ym) => monthlyPnl(ctx, ym))

    // Cash runway: burn = average monthly expenses over the last 3 full months; recurring income likewise (cash received)
    const cash = cashPosition(ctx)
    const last3 = [1, 2, 3].map((i) => monthRange(monthOf(addMonths(monthOf(ctx.today) + '-01', -i))))
    const burn = Math.round(last3.reduce((s, m) => s + revenueBetween(ctx, m.from, m.to).cost, 0) / 3)
    const recurringIncome = Math.round(last3.reduce((s, m) => s + revenueBetween(ctx, m.from, m.to).collected, 0) / 3)
    const netBurn = burn - recurringIncome
    const runway = netBurn > 0 ? cash.balance / netBurn : null

    // Revenue ahead
    const liveProjects = new Set(rows(ctx, 'projects').filter((p) => !['closed', 'npa'].includes(p.status)).map((p) => p.id))
    const open = rows(ctx, 'milestones').filter((m) => !m.deleted_at && m.billing_status === 'none' && liveProjects.has(m.project_id) && m.billing_amount_paise > 0)
    const within = (n: number) => open.filter((m) => m.planned_end <= addDays(ctx.today, n)).reduce((s, m) => s + m.billing_amount_paise, 0)
    const uninvoiced = open.reduce((s, m) => s + m.billing_amount_paise, 0)
    const pipe = salesPipeline(ctx)

    const out: PnlResult = {
      from, to, prev_from, prev_to, as_of: asOf,
      income: { by_stream: incStream, by_category: incCat, total: income, prev_total: prevIncome },
      expense: { by_category: expCat, direct, total: expense, prev_total: prevExpense },
      gross_profit: income - direct,
      gross_margin: income ? (income - direct) / income : null,
      net_profit: income - expense,
      net_margin: income ? (income - expense) / income : null,
      prev_net_profit: prevIncome - prevExpense,
      collected: rv.collected,
      months,
      monthly,
      cash: { opening: cash.opening, balance: cash.balance, monthly_burn: burn, recurring_income: recurringIncome, net_burn: netBurn, runway_months: runway, cash_positive: netBurn <= 0 },
      revenue_ahead: { uninvoiced, uninvoiced_count: open.length, in_30: within(30), in_60: within(60), in_90: within(90), weighted_pipeline: pipe.weighted_value, open_pipeline: pipe.open_value, total: uninvoiced + pipe.weighted_value },
    }
    return out
  })
}
