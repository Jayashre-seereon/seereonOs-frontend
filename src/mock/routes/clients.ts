// Clients & contracts: client master (seeded from projects and deals, kept in sync), computed status
// and health, revenue billed/collected/outstanding, contracts with renewal reminders.
import type * as E from '@/types/entities'
import { dealValue } from '@/domain/sales'
import type * as B from '@/types/business'
import { err, find, has, hasAny, insert, logActivity, notify, remove, requireAction, rows, update, userName, type Ctx, type Router } from '../server'
import { projectMetrics } from '../analytics'
import { addDays, diffDays, fyRange, fyStartYear } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { CONTRACT_KIND, GSTIN_RE, PAN_RE, RENEWAL_WINDOW_DAYS } from '@/modules/spend/labels'
import { EXPORT_CODE, stateCodeOf, stateName } from './invoices'
import { leakageRows, provideClientsHelpers, type ExpenseX, type LeakageRow, type SpendSummary } from './spend'


export type ContractX = B.Contract & { reminded_on?: string | null; renewed_from?: string | null; file_name?: string | null }
export type ClientX = B.Client & { notes?: string; status_manual?: boolean; city?: string; state?: string; state_code?: string; pincode?: string; pan?: string }

/* ------------------------------------------------------------------ */
/* Contracts shared with src/api/clients.ts                            */
/* ------------------------------------------------------------------ */
export interface ContractRow extends ContractX {
  client_name: string
  project_code: string | null
  days_to_renewal: number | null
  computed_status: B.Contract['status']
  file_name: string | null
}
export interface ClientRow extends ClientX {
  owner_name: string
  projects: number
  active_projects: number
  open_deals: number
  pipeline_value: number
  billed: number
  billed_fy: number
  collected: number
  outstanding: number
  overdue: number
  contracts: number
  contract_value: number
  next_renewal: string | null
  leakage_fy: number
  health_reasons: string[]
}
export interface ClientsResult {
  items: ClientRow[]
  totals: { clients: number; active: number; at_risk: number; billed_fy: number; outstanding: number; overdue: number; renewals_60: number; renewal_value: number }
  renewals: ContractRow[]
  can_edit: boolean
}
export interface ClientDetail {
  client: ClientRow
  projects: { id: string; code: string; name: string; status: E.ProjectStatus; billing_model: E.BillingModel; contract_value_paise: number | null; health: string; pm_name: string; end_on: string }[]
  deals: { id: string; title: string; stage: E.DealStage; value_paise: number; owner_name: string; expected_close: string; lost_reason: string | null }[]
  invoices: { id: string; number: string; project_code: string; invoiced_on: string; due_on: string; amount_paise: number; paid_paise: number; outstanding_paise: number; days_overdue: number }[]
  other_income: { date: string; description: string; amount_paise: number; status: string }[]
  contracts: ContractRow[]
  leakage: LeakageRow[]
  rebill: { id: string; date: string; person: string; description: string; amount_paise: number; status: B.ExpenseStatus; project_code: string | null }[]
  rebill_total: number
  contacts: { name: string; role: string; email: string; phone: string; source: string }[]
  activity: { at: string; actor: string; summary: string }[]
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const lc = (s: string) => s.trim().toLowerCase()
const INTERNAL = new Set(['internal', 'seereon', 'general & admin', ''])

function clientNames(ctx: Ctx) {
  const names = new Map<string, string>()
  for (const p of rows(ctx, 'projects')) if (!INTERNAL.has(lc(p.client)) && !p.code.endsWith('GEN') && p.code !== 'GEN') names.set(lc(p.client), p.client)
  for (const d of rows(ctx, 'deals')) if (!INTERNAL.has(lc(d.client))) names.set(lc(d.client), d.client)
  return names
}
/** Insert any client that appears on a project or deal but is not in the master yet. */
function syncClients(ctx: Ctx) {
  const have = new Set(rows(ctx, 'clients').map((c) => lc(c.name)))
  for (const [key, name] of clientNames(ctx)) {
    if (have.has(key)) continue
    const deal = rows(ctx, 'deals').find((d) => lc(d.client) === key)
    insert(ctx, 'clients', {
      name, industry: '', country: 'India', gstin: '', billing_address: '', primary_contact: deal?.contact ?? '', email: deal?.email ?? '', phone: deal?.phone ?? '',
      owner_id: deal?.owner_id ?? rows(ctx, 'projects').find((p) => lc(p.client) === key)?.pm_id ?? null, status: 'prospect', since: null, payment_terms_days: 30, health: null,
    })
  }
}
const matchesClient = (client: string, text: string) => {
  const c = lc(client)
  const t = lc(text)
  if (t.includes(c)) return true
  const first = c.split(/\s+/)[0]
  return first.length >= 5 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(t)
}
function contractStatus(ctx: Ctx, c: B.Contract): B.Contract['status'] {
  if (c.status === 'draft' || c.status === 'terminated' || c.status === 'renewed') return c.status
  if (c.end_on < ctx.today) return 'expired'
  const due = c.renewal_on ?? c.end_on
  if (diffDays(due, ctx.today) <= RENEWAL_WINDOW_DAYS) return 'expiring'
  return 'active'
}
function contractRow(ctx: Ctx, c: ContractX, clients: Map<string, B.Client>, pm: Map<string, E.Project>): ContractRow {
  const due = c.renewal_on ?? c.end_on
  const f = c.file_id ? rows(ctx, 'files').find((x) => x.id === c.file_id) : undefined
  const computed = contractStatus(ctx, c)
  return {
    ...c, client_name: clients.get(c.client_id)?.name ?? '—', project_code: c.project_id ? pm.get(c.project_id)?.code ?? null : null,
    days_to_renewal: computed === 'active' || computed === 'expiring' ? diffDays(due, ctx.today) : null, computed_status: computed, status: computed, file_name: f?.name ?? c.file_name ?? null,
  }
}
/** Renewal reminders: notify the account manager once per contract when it enters the 60-day window. */
function remindRenewals(ctx: Ctx) {
  const clients = new Map(rows(ctx, 'clients').map((c) => [c.id, c]))
  for (const c of rows(ctx, 'contracts') as ContractX[]) {
    if (contractStatus(ctx, c) !== 'expiring' || c.reminded_on) continue
    const cl = clients.get(c.client_id)
    const to = cl?.owner_id
    c.reminded_on = ctx.today
    if (!to) continue
    const due = c.renewal_on ?? c.end_on
    notify(ctx, to, 'NTF-13', 'Contract renewal due', `${cl!.name} · ${CONTRACT_KIND[c.kind]} “${c.title}” ${c.auto_renew ? 'auto-renews' : 'is up for renewal'} on ${due} (${fmtMoney(c.value_paise)}).`, `/clients/${c.client_id}`)
  }
}

function clientModel(ctx: Ctx) {
  syncClients(ctx)
  remindRenewals(ctx)
  const fy = fyStartYear(ctx.today, ctx.tenant.settings['company.fy_start_month'] ?? 4)
  const { from: fyFrom } = fyRange(fy, ctx.tenant.settings['company.fy_start_month'] ?? 4)
  const projects = rows(ctx, 'projects')
  const pm = new Map(projects.map((p) => [p.id, p]))
  const invoices = rows(ctx, 'invoices').filter((i) => i.status !== 'draft' && i.status !== 'cancelled')
  const deals = rows(ctx, 'deals')
  const contracts = rows(ctx, 'contracts') as ContractX[]
  const incomeLedger = rows(ctx, 'ledger_entries').filter((l) => l.kind === 'income' && !l.invoice_id && l.date <= ctx.today)
  const leak = leakageRows(ctx).filter((r) => r.date >= fyFrom)
  const clientsRaw = rows(ctx, 'clients') as ClientX[]
  const cmap = new Map(clientsRaw.map((c) => [c.id, c as B.Client]))
  const items: ClientRow[] = clientsRaw.map((c) => {
    const key = lc(c.name)
    const ps = projects.filter((p) => lc(p.client) === key)
    const ids = new Set(ps.map((p) => p.id))
    const inv = invoices.filter((i) => ids.has(i.project_id))
    const other = incomeLedger.filter((l) => matchesClient(c.name, l.description))
    const ds = deals.filter((d) => lc(d.client) === key)
    const cs = contracts.filter((x) => x.client_id === c.id)
    const billed = inv.reduce((a, i) => a + i.amount_paise, 0) + other.reduce((a, l) => a + l.amount_paise, 0)
    const billedFy = inv.filter((i) => i.invoiced_on >= fyFrom).reduce((a, i) => a + i.amount_paise, 0) + other.filter((l) => l.date >= fyFrom).reduce((a, l) => a + l.amount_paise, 0)
    const collected = inv.reduce((a, i) => a + i.paid_amount_paise, 0) + other.filter((l) => l.status === 'received').reduce((a, l) => a + l.amount_paise, 0)
    const overdueInv = inv.filter((i) => i.amount_paise > i.paid_amount_paise && i.due_on < ctx.today)
    const overdue = overdueInv.reduce((a, i) => a + i.amount_paise - i.paid_amount_paise, 0)
    const maxDays = overdueInv.reduce((m, i) => Math.max(m, diffDays(ctx.today, i.due_on)), 0)
    // health: overdue invoices + project health
    const reasons: string[] = []
    let score = 0
    if (maxDays > 60) {
      score = 2
      reasons.push(`Invoice overdue ${maxDays} days`)
    } else if (overdue > 0) {
      score = Math.max(score, 1)
      reasons.push(`${fmtMoney(overdue)} overdue`)
    }
    for (const p of ps.filter((x) => x.status === 'active' || x.status === 'on_hold' || x.status === 'npa')) {
      const h = projectMetrics(ctx, p).health
      if (p.status === 'npa' || h === 'off_track') {
        score = 2
        reasons.push(`${p.code} ${p.status === 'npa' ? 'is NPA' : 'is off track'}`)
      } else if (h === 'at_risk' || p.status === 'on_hold') {
        score = Math.max(score, 1)
        reasons.push(`${p.code} ${p.status === 'on_hold' ? 'on hold' : 'at risk'}`)
      }
    }
    const hasBusiness = ps.length > 0 || inv.length > 0 || other.length > 0 || cs.length > 0 || ds.some((d) => d.stage === 'won')
    const health: B.Client['health'] = hasBusiness ? (score === 2 ? 'at_risk' : score === 1 ? 'watch' : 'good') : null
    // status: churned is a manual decision; the rest follows the data
    let status: B.Client['status'] = c.status
    if (!c.status_manual) {
      const activeP = ps.some((p) => ['active', 'on_hold', 'initiated', 'npa'].includes(p.status))
      const activeC = cs.some((x) => ['active', 'expiring'].includes(contractStatus(ctx, x)))
      const recentWon = ds.some((d) => d.stage === 'won' && d.won_on && diffDays(ctx.today, d.won_on) <= 180)
      const recentIncome = other.some((l) => diffDays(ctx.today, l.date) <= 90)
      status = activeP || activeC || recentWon || recentIncome ? 'active' : billed > 0 || ps.length ? 'dormant' : 'prospect'
    }
    if (status !== c.status || health !== c.health) Object.assign(c, { status, health })
    const live = cs.filter((x) => ['active', 'expiring'].includes(contractStatus(ctx, x)))
    const next = live.map((x) => x.renewal_on ?? x.end_on).sort()[0] ?? null
    return {
      ...c, status, health, owner_name: userName(ctx, c.owner_id), projects: ps.length, active_projects: ps.filter((p) => p.status === 'active').length,
      open_deals: ds.filter((d) => d.stage !== 'won' && d.stage !== 'lost').length, pipeline_value: ds.filter((d) => d.stage !== 'won' && d.stage !== 'lost').reduce((a, d) => a + dealValue(d), 0),
      billed, billed_fy: billedFy, collected, outstanding: Math.max(0, inv.reduce((a, i) => a + i.amount_paise - i.paid_amount_paise, 0)), overdue,
      contracts: live.length, contract_value: live.reduce((a, x) => a + x.value_paise, 0), next_renewal: next,
      leakage_fy: leak.filter((l) => lc(l.client) === key).reduce((a, l) => a + l.amount_paise - l.recovered_paise, 0), health_reasons: reasons,
    }
  })
  const renewals = contracts.filter((c) => contractStatus(ctx, c) === 'expiring').map((c) => contractRow(ctx, c, cmap, pm)).sort((a, b) => (a.days_to_renewal ?? 0) - (b.days_to_renewal ?? 0))
  return { items, renewals, cmap, pm }
}

export function contractRenewals(ctx: Ctx): SpendSummary['renewals'] {
  const clients = new Map(rows(ctx, 'clients').map((c) => [c.id, c]))
  return (rows(ctx, 'contracts') as ContractX[])
    .filter((c) => contractStatus(ctx, c) === 'expiring')
    .map((c) => {
      const due = c.renewal_on ?? c.end_on
      return { id: c.id, client_id: c.client_id, client: clients.get(c.client_id)?.name ?? '—', title: c.title, kind: c.kind, renewal_on: due, value_paise: c.value_paise, days: diffDays(due, ctx.today) }
    })
    .sort((a, b) => a.days - b.days)
}

function validateClient(ctx: Ctx, body: Record<string, unknown>, existing?: ClientX) {
  const name = String(body.name ?? existing?.name ?? '').trim()
  if (name.length < 2) err(422, 'VAL_REQUIRED', 'Client name is required.', 'name')
  const dup = rows(ctx, 'clients').find((c) => lc(c.name) === lc(name) && c.id !== existing?.id)
  if (dup) err(409, 'DUPLICATE_CLIENT', `${dup.name} is already a client.`, 'name')
  const gstin = String(body.gstin ?? existing?.gstin ?? '').trim().toUpperCase()
  if (gstin && !GSTIN_RE.test(gstin)) err(422, 'VAL_GSTIN', 'GSTIN must be 15 characters (e.g. 21AAKFM9876Q1ZP). Leave it blank for overseas clients.', 'gstin')
  const email = String(body.email ?? existing?.email ?? '').trim()
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) err(422, 'VAL_EMAIL', 'Enter a valid email address.', 'email')
  const terms = Number(body.payment_terms_days ?? existing?.payment_terms_days ?? 30)
  if (!Number.isInteger(terms) || terms < 0 || terms > 180) err(422, 'VAL_RANGE', 'Payment terms must be between 0 and 180 days.', 'payment_terms_days')
  const owner_id = body.owner_id === undefined ? existing?.owner_id ?? null : (body.owner_id as string | null) || null
  if (owner_id) find(ctx, 'users', owner_id, 'Account manager')
  const status = body.status as B.Client['status'] | undefined
  // v7 GST billing address: state + GST state code must agree with the GSTIN's first two digits
  const country = String(body.country ?? existing?.country ?? 'India').trim() || 'India'
  const india = /^(india|in)$/i.test(country)
  const stateIn = String(body.state ?? existing?.state ?? '').trim()
  let state_code = String(body.state_code ?? existing?.state_code ?? '').trim() || stateCodeOf(stateIn) || (gstin ? gstin.slice(0, 2) : '')
  if (!india) state_code = EXPORT_CODE
  if (india && state_code && !stateName(state_code)) err(422, 'VAL_STATE', 'Choose a valid Indian state.', 'state')
  if (india && gstin && state_code && gstin.slice(0, 2) !== state_code) err(422, 'VAL_GSTIN', `GSTIN starts with ${gstin.slice(0, 2)} (${stateName(gstin.slice(0, 2)) || 'unknown state'}) but the state is ${stateName(state_code)}.`, 'gstin')
  if (!india && gstin) err(422, 'VAL_GSTIN', 'Overseas clients have no GSTIN. Clear it or set the country to India.', 'gstin')
  const pincode = String(body.pincode ?? existing?.pincode ?? '').trim()
  if (india && pincode && !/^\d{6}$/.test(pincode)) err(422, 'VAL_PIN', 'PIN code has 6 digits.', 'pincode')
  const pan = String(body.pan ?? existing?.pan ?? (gstin ? gstin.slice(2, 12) : '')).trim().toUpperCase()
  if (pan && !PAN_RE.test(pan)) err(422, 'VAL_PAN', 'PAN is 10 characters, e.g. AAKCS4821M.', 'pan')
  if (pan && gstin && gstin.slice(2, 12) !== pan) err(422, 'VAL_PAN', `PAN does not match the PAN inside the GSTIN (${gstin.slice(2, 12)}).`, 'pan')
  const out: Partial<ClientX> = {
    city: String(body.city ?? existing?.city ?? '').trim(), state: india ? stateIn || stateName(state_code) : stateIn, state_code, pincode, pan,
    name, gstin, email, payment_terms_days: terms, owner_id,
    industry: String(body.industry ?? existing?.industry ?? '').trim(), country,
    billing_address: String(body.billing_address ?? existing?.billing_address ?? '').trim(), primary_contact: String(body.primary_contact ?? existing?.primary_contact ?? '').trim(),
    phone: String(body.phone ?? existing?.phone ?? '').trim(), notes: String(body.notes ?? existing?.notes ?? '').trim(),
  }
  if (status) {
    if (!['prospect', 'active', 'dormant', 'churned'].includes(status)) err(422, 'VAL_STATUS', 'Unknown status.', 'status')
    out.status = status
    out.status_manual = status === 'churned'
  }
  return out
}
type FileIn = { name: string; mime: string; size_bytes: number; data_url: string }
function validateContract(ctx: Ctx, body: Record<string, unknown>, existing?: ContractX) {
  const title = String(body.title ?? existing?.title ?? '').trim()
  if (title.length < 3) err(422, 'VAL_REQUIRED', 'Give the contract a title.', 'title')
  const kind = String(body.kind ?? existing?.kind ?? '') as B.Contract['kind']
  if (!(kind in CONTRACT_KIND)) err(422, 'VAL_REQUIRED', 'Choose the contract type.', 'kind')
  const value = Number(body.value_paise ?? existing?.value_paise ?? 0)
  if (!Number.isFinite(value) || value < 0 || Math.round(value) !== value) err(422, 'VAL_AMOUNT', 'Contract value must be zero or more.', 'value_paise')
  const start_on = String(body.start_on ?? existing?.start_on ?? '')
  const end_on = String(body.end_on ?? existing?.end_on ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_on)) err(422, 'VAL_DATE', 'Start date is required.', 'start_on')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end_on)) err(422, 'VAL_DATE', 'End date is required.', 'end_on')
  if (end_on < start_on) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'end_on')
  let renewal_on = body.renewal_on === undefined ? existing?.renewal_on ?? null : (body.renewal_on as string | null) || null
  if (renewal_on && (renewal_on < start_on || renewal_on > addDays(end_on, 1))) err(422, 'DATE_RANGE', 'The renewal date must fall within the contract term.', 'renewal_on')
  if (!renewal_on && kind !== 'nda') renewal_on = end_on
  const project_id = body.project_id === undefined ? existing?.project_id ?? null : (body.project_id as string | null) || null
  if (project_id) find(ctx, 'projects', project_id, 'Project')
  const status = String(body.status ?? existing?.status ?? 'active') as B.Contract['status']
  if (!['draft', 'active', 'terminated'].includes(status) && status !== existing?.status) err(422, 'VAL_STATUS', 'A contract can be draft, active or terminated; expiry is calculated from the dates.', 'status')
  return { title, kind, value_paise: value, start_on, end_on, renewal_on, project_id, auto_renew: body.auto_renew === undefined ? existing?.auto_renew ?? false : !!body.auto_renew, status, notes: String(body.notes ?? existing?.notes ?? '').trim() }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
export function register(r: Router) {
  provideClientsHelpers({ contractRenewals })

  r.get('/clients', ({ ctx, query }): ClientsResult => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage clients.')
    const m = clientModel(ctx)
    let items = m.items
    if (query.mine) items = items.filter((c) => c.owner_id === ctx.user.id)
    return {
      items: items.sort((a, b) => b.billed_fy - a.billed_fy || a.name.localeCompare(b.name)),
      totals: {
        clients: items.length, active: items.filter((c) => c.status === 'active').length, at_risk: items.filter((c) => c.health === 'at_risk').length,
        billed_fy: items.reduce((a, c) => a + c.billed_fy, 0), outstanding: items.reduce((a, c) => a + c.outstanding, 0), overdue: items.reduce((a, c) => a + c.overdue, 0),
        renewals_60: m.renewals.length, renewal_value: m.renewals.reduce((a, c) => a + c.value_paise, 0),
      },
      renewals: m.renewals,
      can_edit: true,
    }
  })
  r.get('/clients/:id', ({ ctx, params }): ClientDetail => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage clients.')
    find(ctx, 'clients', params.id, 'Client')
    const m = clientModel(ctx)
    const c = m.items.find((x) => x.id === params.id)!
    const key = lc(c.name)
    const ps = rows(ctx, 'projects').filter((p) => lc(p.client) === key)
    const ids = new Set(ps.map((p) => p.id))
    const showMoney = has(ctx, 'finance.view')
    const deals = rows(ctx, 'deals').filter((d) => lc(d.client) === key)
    const expenses = (rows(ctx, 'expense_claims') as ExpenseX[]).filter((e) => e.billable_to_client && e.project_id && ids.has(e.project_id) && (e.status === 'approved' || e.status === 'paid'))
    const contacts: ClientDetail['contacts'] = []
    if (c.primary_contact) contacts.push({ name: c.primary_contact, role: 'Primary contact', email: c.email, phone: c.phone, source: 'Client master' })
    for (const d of deals) if (d.contact && !contacts.some((x) => lc(x.name) === lc(d.contact))) contacts.push({ name: d.contact, role: `Deal · ${d.title}`, email: d.email, phone: d.phone, source: 'Pipeline' })
    const contractIds = new Set(rows(ctx, 'contracts').filter((x) => x.client_id === c.id).map((x) => x.id))
    return {
      client: c,
      projects: ps.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, billing_model: p.billing_model, contract_value_paise: showMoney || hasAny(ctx, 'projects.edit', 'margins.view') ? p.contract_value_paise : null, health: projectMetrics(ctx, p).health, pm_name: userName(ctx, p.pm_id), end_on: p.end_on })),
      deals: deals.map((d) => ({ id: d.id, title: d.title, stage: d.stage, value_paise: dealValue(d), owner_name: userName(ctx, d.owner_id), expected_close: d.expected_close, lost_reason: d.lost_reason })).sort((a, b) => b.expected_close.localeCompare(a.expected_close)),
      invoices: rows(ctx, 'invoices').filter((i) => ids.has(i.project_id) && i.status !== 'draft' && i.status !== 'cancelled').map((i) => ({
        id: i.id, number: i.number, project_code: m.pm.get(i.project_id)?.code ?? '', invoiced_on: i.invoiced_on, due_on: i.due_on, amount_paise: i.amount_paise, paid_paise: i.paid_amount_paise,
        outstanding_paise: i.amount_paise - i.paid_amount_paise, days_overdue: i.amount_paise > i.paid_amount_paise ? Math.max(0, diffDays(ctx.today, i.due_on)) : 0,
      })).sort((a, b) => b.invoiced_on.localeCompare(a.invoiced_on)),
      other_income: rows(ctx, 'ledger_entries').filter((l) => l.kind === 'income' && !l.invoice_id && l.date <= ctx.today && matchesClient(c.name, l.description)).map((l) => ({ date: l.date, description: l.description, amount_paise: l.amount_paise, status: l.status })).sort((a, b) => b.date.localeCompare(a.date)),
      contracts: (rows(ctx, 'contracts') as ContractX[]).filter((x) => x.client_id === c.id).map((x) => contractRow(ctx, x, m.cmap, m.pm)).sort((a, b) => b.end_on.localeCompare(a.end_on)),
      leakage: leakageRows(ctx).filter((l) => lc(l.client) === key),
      rebill: expenses.map((e) => ({ id: e.id, date: e.spent_on, person: userName(ctx, e.user_id), description: e.description, amount_paise: e.amount_paise, status: e.status, project_code: m.pm.get(e.project_id!)?.code ?? null })),
      rebill_total: expenses.reduce((a, e) => a + e.amount_paise, 0),
      contacts,
      activity: rows(ctx, 'activity_log').filter((a) => (a.entity === 'client' && a.entity_id === c.id) || (a.entity === 'contract' && contractIds.has(a.entity_id))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map((a) => ({ at: a.at, actor: userName(ctx, a.actor_id), summary: a.summary })),
    }
  })
  r.post('/clients', ({ ctx, body }) => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage clients.')
    const v = validateClient(ctx, body)
    const row = insert(ctx, 'clients', { status: 'prospect', since: null, health: null, ...v } as never) as ClientX
    logActivity(ctx, 'client', row.id, 'created', `Added client ${row.name}`)
    return row
  })
  r.patch('/clients/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage clients.')
    const cur = find(ctx, 'clients', params.id, 'Client') as ClientX
    const v = validateClient(ctx, body, cur)
    if (v.name && lc(v.name) !== lc(cur.name)) {
      // keep projects and deals pointing at the renamed client
      for (const p of rows(ctx, 'projects')) if (lc(p.client) === lc(cur.name)) p.client = v.name
      for (const d of rows(ctx, 'deals')) if (lc(d.client) === lc(cur.name)) d.client = v.name
    }
    if (v.status && v.status !== 'churned') v.status_manual = false
    const row = update(ctx, 'clients', cur.id, v as Partial<B.Client>, ifMatch)
    logActivity(ctx, 'client', row.id, 'edited', `Updated client ${row.name}${body.status ? ' · status ' + body.status : ''}`)
    return row
  })

  r.post('/clients/:id/contracts', ({ ctx, params, body }) => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage contracts.')
    const c = find(ctx, 'clients', params.id, 'Client')
    const v = validateContract(ctx, body)
    const f = body.file as FileIn | null
    let file_id: string | null = null
    if (f) {
      if (!f.name || !f.data_url) err(422, 'FILE_REJECTED', 'The file could not be read. Try again.', 'file')
      if (f.size_bytes > 10 * 1024 * 1024) err(422, 'FILE_REJECTED', 'The file is larger than 10 MB.', 'file')
      file_id = insert(ctx, 'files', { name: f.name, mime: f.mime || 'application/pdf', size_bytes: f.size_bytes, entity: 'contract', entity_id: '', data_url: f.data_url } as never).id
    }
    const row = insert(ctx, 'contracts', { client_id: c.id, file_id, ...v, reminded_on: null } as never) as ContractX
    if (file_id) {
      const fr = rows(ctx, 'files').find((x) => x.id === file_id)
      if (fr) fr.entity_id = row.id
    }
    logActivity(ctx, 'contract', row.id, 'created', `Added ${CONTRACT_KIND[row.kind]} “${row.title}” for ${c.name} · ${fmtMoney(row.value_paise)}`)
    return row
  })
  r.patch('/contracts/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage contracts.')
    const cur = find(ctx, 'contracts', params.id, 'Contract') as ContractX
    const v = validateContract(ctx, body, cur)
    const patch: Partial<ContractX> = { ...v }
    if (v.end_on !== cur.end_on || v.renewal_on !== cur.renewal_on) patch.reminded_on = null
    if (body.file) {
      const f = body.file as FileIn
      patch.file_id = insert(ctx, 'files', { name: f.name, mime: f.mime || 'application/pdf', size_bytes: f.size_bytes, entity: 'contract', entity_id: cur.id, data_url: f.data_url } as never).id
    }
    const row = update(ctx, 'contracts', cur.id, patch as Partial<B.Contract>, ifMatch)
    logActivity(ctx, 'contract', row.id, 'edited', `Updated ${CONTRACT_KIND[row.kind]} “${row.title}”${v.status === 'terminated' && cur.status !== 'terminated' ? ' — terminated' : ''}`)
    return row
  })
  r.post('/contracts/:id/renew', ({ ctx, params, body }) => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage contracts.')
    const cur = find(ctx, 'contracts', params.id, 'Contract') as ContractX
    if (cur.status === 'renewed' || cur.status === 'terminated') err(409, 'INVALID_STATE', `This contract is already ${cur.status}.`)
    const months = Number(body.months ?? 12)
    if (!Number.isInteger(months) || months < 1 || months > 60) err(422, 'VAL_RANGE', 'Renew for 1 to 60 months.', 'months')
    const value = body.value_paise === undefined ? cur.value_paise : Number(body.value_paise)
    if (!Number.isFinite(value) || value < 0) err(422, 'VAL_AMOUNT', 'Contract value must be zero or more.', 'value_paise')
    const start = addDays(cur.end_on, 1)
    const d = new Date(start)
    d.setMonth(d.getMonth() + months)
    const end = addDays(d.toISOString().slice(0, 10), -1)
    update(ctx, 'contracts', cur.id, { status: 'renewed' })
    const row = insert(ctx, 'contracts', {
      client_id: cur.client_id, project_id: cur.project_id, title: cur.title, kind: cur.kind, value_paise: value, start_on: start, end_on: end, renewal_on: end, auto_renew: cur.auto_renew,
      status: 'active', file_id: null, notes: String(body.notes ?? '').trim() || `Renewal of the ${cur.start_on} – ${cur.end_on} term.`, reminded_on: null, renewed_from: cur.id,
    } as never) as ContractX
    const change = cur.value_paise ? (value - cur.value_paise) / cur.value_paise : null
    logActivity(ctx, 'contract', row.id, 'renewed', `Renewed ${CONTRACT_KIND[cur.kind]} “${cur.title}” to ${end} · ${fmtMoney(value)}${change ? ` (${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%)` : ''}`)
    return row
  })
  r.del('/contracts/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'clients.manage', 'Only admin and sales manage contracts.')
    const cur = find(ctx, 'contracts', params.id, 'Contract')
    if (cur.status !== 'draft') err(409, 'CONTRACT_LOCKED', 'Only draft contracts can be deleted. Terminate an active contract instead.')
    remove(ctx, 'contracts', cur.id, ifMatch)
    logActivity(ctx, 'contract', cur.id, 'deleted', `Deleted draft contract “${cur.title}”`)
    return { ok: true }
  })
  r.get('/clients-lite', ({ ctx }) => {
    syncClients(ctx)
    return rows(ctx, 'clients').map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))
  })
}
