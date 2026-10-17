// Module D — Sales CRM (deals, stages, activities, activity log, create project), performance and compensation.
// Every figure is computed here; screens only format. Deal value = one-time + 12 × monthly recurring (G12.06).
import type * as E from '@/types/entities'
import { canSeeSalaries, err, find, getDb, has, insert, logActivity, nextNumber, notify, nowISO, permissionsOf, remove, removeWhere, requireAction, rows, update, userName, type Ctx, type Router } from '../server'
import { pendingBrief, type PendingBrief } from '../makerChecker'
import { addDays, addMonths, diffDays, isRealISODate, monthOf, monthRange, periodRange, quarterOf, weekStart, fyStartYear, fyRange, type PeriodKind } from '@/domain/calendar'
import { rateOn, salesCompensation } from '@/domain/costing'
import { DEAL_STAGE, DEAL_SOURCE, ACTIVITY_TYPE } from '@/domain/labels'
// Feature Guide §11 stage names everywhere (funnel, board, deal page, reports, activity log): Lead, Qualified, Demo,
// Proposal, Negotiation, Won, Lost.
const STAGE_LABEL = Object.fromEntries(Object.entries(DEAL_STAGE).map(([k, v]) => [k, v.label])) as Record<E.DealStage, string>
import { dealValue, median, SALES_LOG_KIND, validPhone, validEmail, type SalesLogKind } from '@/domain/sales'
import { fmtMoney } from '@/domain/money'

/* ------------------------------------------------------------------ */
/* Types shared with src/api/sales.ts                                  */
/* ------------------------------------------------------------------ */
/** Deal row as stored (next step and first conversation are optional entity fields). */
export type DealRow = E.Deal

export interface DealView extends DealRow {
  owner_name: string
  created_by_name: string
  /** one-time + 12 × recurring */
  deal_value_paise: number
  weighted_paise: number
  probability: number
  opened_on: string
  stage_entered_on: string
  days_in_stage: number
  days_in_pipeline: number
  days_since_activity: number
  stale: boolean
  next_step_overdue: boolean
  project: { id: string; code: string; name: string; status: E.ProjectStatus } | null
}

export type TimelineItem =
  | { kind: 'stage'; id: string; at: string; by: string; by_name: string; from_stage: E.DealStage | null; to_stage: E.DealStage; reason: string | null }
  | { kind: 'activity'; id: string; at: string; date: string; by: string; by_name: string; type: E.ActivityType; note: string }

export interface DealDetail {
  deal: DealView
  timeline: TimelineItem[]
  activity_count: number
  can_edit: boolean
  can_delete: boolean
  can_reopen: boolean
  can_create_project: boolean
}

export interface FunnelStage { stage: E.DealStage; label: string; count: number; value: number }
export interface SalesSummary {
  open_value: number
  weighted_value: number
  open_count: number
  won_value: number
  won_count: number
  lost_count: number
  win_rate: number | null
  avg_deal: number | null
  avg_cycle_days: number | null
  stale_count: number
  by_stage: Record<E.DealStage, { count: number; value: number; weighted: number }>
  stale_days: number
  // G11.02
  quarter_label: string
  won_quarter_value: number
  won_quarter_count: number
  forecast_quarter: number
  forecast_quarter_count: number
  win_rate_180: number | null
  won_180: number
  lost_180: number
  median_cycle_days: number | null
  recurring_won_monthly: number
  new_leads_month: number
  month_label: string
  activities_week: number
  week_from: string
  week_to: string
  followups_overdue: number
  // G11.03 — current stage of each deal
  funnel: FunnelStage[]
  lost: FunnelStage
}

export interface ActivityLogItem {
  id: string
  date: string
  at: string
  who_id: string
  who_name: string
  deal_id: string
  deal_title: string
  client: string
  kind: SalesLogKind
  what: string
  detail: string
}
export interface ActivityLog {
  from: string
  to: string
  items: ActivityLogItem[]
  people: { user_id: string; name: string; count: number }[]
  total: number
  by_kind: Partial<Record<SalesLogKind, number>>
}

export interface PersonPerformance {
  user_id: string
  name: string
  role: E.Role
  calls: number
  meetings: number
  demos: number
  emails: number
  whatsapp: number
  proposals: number
  follow_ups: number
  activities: number
  new_leads: number
  won_count: number
  won_value: number
  lost_count: number
  win_rate: number | null
  avg_deal: number | null
  cycle_days: number | null
  open_value: number
  weighted_value: number
  open_count: number
  stale: number
  target: number | null
  achievement: number | null
}
export interface SixMonthRow {
  month: string
  label: string
  activities: number
  new_leads: number
  closed: number
  target: number | null
  achievement: number | null
  hit: boolean | null
  variable_earned: number | null
}
export interface SalesPerformance {
  from: string
  to: string
  label: string
  people: PersonPerformance[]
  team: Omit<PersonPerformance, 'user_id' | 'name' | 'role'>
  cost_vs_closed: { month: string; label: string; cost: number; closed: number; ratio: number | null }[]
  target_vs_achieved: { user_id: string; name: string; months: { month: string; label: string; target: number; achieved: number; hit: boolean }[] }[]
  last_six: { user_id: string; name: string; can_see_pay: boolean; months: SixMonthRow[] }[]
  funnel: { stage: E.DealStage; label: string; reached: number; value: number; conversion: number | null }[]
  activity_heat: { date: string; counts: Record<E.ActivityType, number>; total: number }[]
  can_see_cost: boolean
}

export interface CompMonth {
  month: string
  label: string
  monthly_ctc: number
  base: number
  variable: number
  target: number
  achieved: number
  achievement: number
  variable_earned: number
  payout: number
  hit: boolean
}
export interface CompPerson {
  user_id: string
  name: string
  title: string
  has_rate: boolean
  /** current rate (end of period) */
  monthly_ctc: number
  variable_pct: number
  monthly_target: number
  target_is_default: boolean
  /** sums over the counted months of the period */
  ctc_in_period: number
  base_in_period: number
  target_in_period: number
  closed: number
  achievement: number | null
  variable_earned: number
  payout: number
  months_hit: number
  deals: { id: string; title: string; client: string; value: number; won_on: string }[]
  months: CompMonth[]
  history: CompMonth[]
  pending_change: PendingBrief | null
  /** effective date a Save would use (new cost-rate row) */
  next_effective_from: string | null
  // compat with the old month view
  month: string
  label: string
  base: number
  variable: number
  target: number
  achieved: number
  hit: boolean
}
export interface CompensationResult {
  kind: PeriodKind
  from: string
  to: string
  label: string
  /** months counted (months still to come are left out) */
  months: string[]
  month: string
  threshold_pct: number
  variable_default_pct: number
  scope: 'team' | 'self'
  can_edit: boolean
  people: CompPerson[]
  /** sales_cost = base salary + variable pay earned (= payout), Feature Guide §12; ratio = closed ÷ sales_cost. ctc kept for reference. */
  totals: { ctc: number; base: number; variable: number; target: number; achieved: number; closed: number; variable_earned: number; payout: number; sales_cost: number; ratio: number | null }
  /** salary_cost = CTC (reference); sales_cost = base + variable earned; ratio = closed ÷ sales_cost */
  trend: { month: string; label: string; salary_cost: number; payout: number; sales_cost: number; closed: number; ratio: number | null }[]
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const STAGES: E.DealStage[] = ['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won', 'lost']
const OPEN: E.DealStage[] = ['lead', 'qualified', 'demo', 'proposal', 'negotiation']
export const PRODUCTS = ['EduReon', 'SeerHR', 'LeadSync', 'Munim AI', 'MineReon', 'SAP consulting', 'Custom software']
const isClosed = (s: E.DealStage) => s === 'won' || s === 'lost'
const monthLabel = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
const weightedOf = (d: E.Deal) => Math.round(dealValue(d) * DEAL_STAGE[d.stage].chance)

function requireSales(ctx: Ctx) {
  requireAction(ctx, 'deals.edit_own', 'Only admins and sales people can use the CRM.')
}
/** deals.view_all: the whole pipeline. */
const seesAll = (ctx: Ctx) => has(ctx, 'deals.view_all')
/** deals.edit_all: reassign, edit closed deals, reopen, delete, create projects. */
const isAdmin = (ctx: Ctx) => has(ctx, 'deals.edit_all')

/** Deals the viewer may see: deals.view_all → all, otherwise only their own. */
function visibleDeals(ctx: Ctx): DealRow[] {
  requireSales(ctx)
  const all = rows(ctx, 'deals') as DealRow[]
  return seesAll(ctx) ? all : all.filter((d) => d.owner_id === ctx.user.id)
}
function getDeal(ctx: Ctx, id: string): DealRow {
  requireSales(ctx)
  const d = find(ctx, 'deals', id, 'Deal') as DealRow
  if (!seesAll(ctx) && d.owner_id !== ctx.user.id) err(404, 'NOT_FOUND', 'Deal not found.')
  return d
}
/** Writes on a deal: own deals with deals.edit_own, anyone's with deals.edit_all. */
function writableDeal(ctx: Ctx, id: string): DealRow {
  const d = getDeal(ctx, id)
  if (d.owner_id !== ctx.user.id && !isAdmin(ctx)) err(403, 'FORBIDDEN', `Only ${userName(ctx, d.owner_id)} (the owner) or a sales manager can change this deal.`)
  return d
}

/** Repair rows written by the old stage-move bug ("Won → Won · Reopened by admin"): the from-stage is the stage the
 *  deal was in before (the previous row's to-stage), and a move out of an open stage carries no reopen reason. */
function repairStageHistory(ctx: Ctx) {
  const bad = rows(ctx, 'deal_stage_history').filter((h) => h.from_stage !== null && h.from_stage === h.to_stage)
  for (const h of bad) {
    const prev = rows(ctx, 'deal_stage_history')
      .filter((x) => x.deal_id === h.deal_id && x.id !== h.id && x.at <= h.at && x.from_stage !== x.to_stage)
      .sort((a, b) => b.at.localeCompare(a.at))[0]
    h.from_stage = prev ? prev.to_stage : null
    if (h.reason === 'Reopened by admin' && !(h.from_stage && isClosed(h.from_stage))) h.reason = null
  }
}

function histMap(ctx: Ctx) {
  const m = new Map<string, E.DealStageHistory[]>()
  for (const h of rows(ctx, 'deal_stage_history')) (m.get(h.deal_id) ?? m.set(h.deal_id, []).get(h.deal_id)!).push(h)
  return m
}

/** When the deal entered the pipeline: first stage-history row (imports and seeds may back-date it), else created_at. */
function openedOn(ctx: Ctx, d: E.Deal, hist?: E.DealStageHistory[]): string {
  const h = hist ?? rows(ctx, 'deal_stage_history').filter((x) => x.deal_id === d.id)
  let first = d.created_at.slice(0, 10)
  for (const x of h) if (x.at.slice(0, 10) < first) first = x.at.slice(0, 10)
  return first
}

function stageEntered(ctx: Ctx, d: E.Deal, hist?: E.DealStageHistory[]): string {
  const h = (hist ?? rows(ctx, 'deal_stage_history').filter((x) => x.deal_id === d.id)).filter((x) => x.to_stage === d.stage).sort((a, b) => b.at.localeCompare(a.at))[0]
  return (h?.at ?? d.created_at).slice(0, 10)
}

export function viewDeal(ctx: Ctx, d: DealRow, histByDeal?: Map<string, E.DealStageHistory[]>, projects?: Map<string, E.Project>): DealView {
  const staleDays = ctx.tenant.settings['sales.stale_deal_days']
  const hist = histByDeal?.get(d.id) ?? rows(ctx, 'deal_stage_history').filter((x) => x.deal_id === d.id)
  const entered = stageEntered(ctx, d, hist)
  const opened = openedOn(ctx, d, hist)
  const p = d.project_id ? (projects ? projects.get(d.project_id) : rows(ctx, 'projects').find((x) => x.id === d.project_id)) : null
  const since = diffDays(ctx.today, d.last_activity_on)
  const closedOn = d.stage === 'won' ? d.won_on : d.stage === 'lost' ? d.lost_on : null
  const creator = d.created_by ?? hist.find((h) => h.from_stage === null)?.by ?? d.owner_id
  return {
    ...d,
    first_conversation: d.first_conversation ?? null,
    next_step: d.next_step ?? null,
    next_step_on: d.next_step_on ?? null,
    owner_name: userName(ctx, d.owner_id),
    created_by_name: userName(ctx, creator),
    deal_value_paise: dealValue(d),
    probability: DEAL_STAGE[d.stage].chance,
    weighted_paise: weightedOf(d),
    opened_on: opened,
    stage_entered_on: entered,
    days_in_stage: Math.max(0, diffDays(closedOn ?? ctx.today, entered)),
    days_in_pipeline: Math.max(0, diffDays(closedOn ?? ctx.today, opened)),
    days_since_activity: Math.max(0, since),
    stale: !isClosed(d.stage) && since >= staleDays,
    next_step_overdue: !isClosed(d.stage) && !!d.next_step_on && d.next_step_on < ctx.today,
    project: p ? { id: p.id, code: p.code, name: p.name, status: p.status } : null,
  }
}

function validateDealBody(ctx: Ctx, b: Partial<DealRow>, creating: boolean) {
  const need = (k: keyof DealRow, label: string) => {
    if (creating || k in b) {
      const v = b[k]
      if (typeof v !== 'string' || !v.trim()) err(422, 'VALIDATION', `${label} is required.`, k as string)
    }
  }
  need('title', 'Opportunity')
  need('client', 'Company or school')
  for (const k of ['value_paise', 'mrr_paise'] as const) {
    if (k in b && (typeof b[k] !== 'number' || !Number.isInteger(b[k]) || (b[k] as number) < 0)) err(422, 'MONEY_INVALID', 'Enter an amount of zero or more.', k)
  }
  if ('email' in b && b.email && !validEmail(b.email)) err(422, 'VALIDATION', 'Enter a valid email address or leave it blank.', 'email')
  if ('phone' in b && b.phone && !validPhone(b.phone)) err(422, 'VALIDATION', 'Enter a phone number with 7 to 15 digits (spaces, + and - are fine) or leave it blank.', 'phone')
  if ('source' in b && b.source && !(b.source in DEAL_SOURCE)) err(422, 'VALIDATION', 'Choose a lead source from the list.', 'source')
  if ('product' in b && b.product && !PRODUCTS.includes(b.product)) err(422, 'VALIDATION', 'Choose a product from the list.', 'product')
  if (creating || 'expected_close' in b) if (!b.expected_close || !isRealISODate(b.expected_close)) err(422, 'VALIDATION', 'Pick an expected close date.', 'expected_close')
  if ('owner_id' in b) {
    const owner = rows(ctx, 'users').find((u) => u.id === b.owner_id && u.status === 'active')
    if (!owner) err(422, 'VALIDATION', 'Choose an active owner.', 'owner_id')
    if (!permissionsOf(owner).includes('deals.edit_own')) err(422, 'VALIDATION', `${owner.name} can’t work deals. Choose someone with access to the CRM.`, 'owner_id')
    if (!isAdmin(ctx) && b.owner_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only a sales manager can assign a deal to someone else.', 'owner_id')
  }
  if ('next_step_on' in b && b.next_step_on && !isRealISODate(b.next_step_on)) err(422, 'VALIDATION', 'Pick a valid date for the next step.', 'next_step_on')
  if ('first_conversation' in b && b.first_conversation && b.first_conversation.length > 2000) err(422, 'VALIDATION', 'Keep the first conversation under 2,000 characters.', 'first_conversation')
}

/** NTF-12: stale deal notice to the owner, at most once per deal per day. */
function notifyStale(ctx: Ctx, deals: DealView[]) {
  const today = ctx.today
  const sent = new Set(getDb().notifications.filter((n) => n.tenant_id === ctx.tenant.id && n.type === 'NTF-12' && n.created_at.slice(0, 10) === today).map((n) => n.user_id + '|' + n.link))
  for (const d of deals) {
    if (!d.stale) continue
    const link = `/sales/${d.id}`
    if (sent.has(d.owner_id + '|' + link)) continue
    sent.add(d.owner_id + '|' + link)
    notify(ctx, d.owner_id, 'NTF-12', 'Deal going stale', `${d.title} (${d.client}) has had no activity for ${d.days_since_activity} days.`, link)
  }
}

function listViews(ctx: Ctx, deals: DealRow[]) {
  const hist = histMap(ctx)
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  return deals.map((d) => viewDeal(ctx, d, hist, projects))
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let m = monthOf(from)
  const end = monthOf(to)
  let guard = 0
  while (m <= end && guard++ < 60) {
    out.push(m)
    m = monthOf(addMonths(m + '-01', 1))
  }
  return out
}

/** Sales people whose pay is variable (BR-14). */
function salesPeople(ctx: Ctx) {
  return rows(ctx, 'users').filter((u) => u.role === 'sales' && u.status !== 'deactivated')
}

/** Value of deals a person won in a month (G12.06 deal value). */
export function closedInMonth(deals: E.Deal[], userId: string, ym: string) {
  return deals.filter((d) => d.owner_id === userId && d.stage === 'won' && d.won_on && monthOf(d.won_on) === ym).reduce((s, d) => s + dealValue(d), 0)
}

/** One month of pay for a sales person: variable is paid only when that month's target is met (G12.04). */
export function compFor(ctx: Ctx, userId: string, ym: string, deals?: E.Deal[]): CompMonth & { has_rate: boolean; variable_pct: number; target_is_default: boolean } {
  const { to } = monthRange(ym)
  const rate = rateOn(rows(ctx, 'cost_rates'), userId, to)
  const achieved = closedInMonth(deals ?? rows(ctx, 'deals'), userId, ym)
  const ctc = rate?.monthly_ctc_paise ?? 0
  const vp = rate ? rate.variable_pct : ctx.tenant.settings['pay.variable_default_pct']
  const threshold = ctx.tenant.settings['pay.variable_threshold_pct']
  const c = salesCompensation(ctc, vp, rate?.sales_target_paise ?? null, achieved, threshold)
  return {
    month: ym,
    label: monthLabel(ym),
    monthly_ctc: ctc,
    base: c.base,
    variable: c.variable,
    target: c.target,
    achieved,
    achievement: c.achievement,
    variable_earned: c.variableEarned,
    payout: c.payout,
    hit: c.target > 0 && c.achievement * 100 >= threshold,
    has_rate: !!rate,
    variable_pct: vp,
    target_is_default: !rate || rate.sales_target_paise === null,
  }
}

/** Effective date a Save on the compensation screen would use for a new cost-rate row. */
function nextEffectiveFrom(ctx: Ctx, userId: string, ym: string): string {
  let eff = monthRange(ym).from
  const latest = rows(ctx, 'cost_rates').filter((r) => r.user_id === userId).map((r) => r.effective_from).sort().pop()
  const lastFinal = rows(ctx, 'payroll_runs').filter((p) => p.status === 'final').map((p) => p.month).sort().pop()
  if (lastFinal && eff <= monthRange(lastFinal).to) eff = addDays(monthRange(lastFinal).to, 1)
  if (latest && eff <= latest) eff = addDays(latest, 1)
  return eff
}

function periodOf(ctx: Ctx, query: Record<string, unknown>) {
  const fm = ctx.tenant.settings['company.fy_start_month']
  const kindQ = String(query.kind ?? '')
  const kind: PeriodKind = kindQ === 'quarter' || kindQ === 'fy' ? kindQ : kindQ === 'year' ? 'fy' : 'month'
  let anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(query.anchor ?? '')) ? String(query.anchor) : ctx.today
  if (/^\d{4}-\d{2}$/.test(String(query.month ?? ''))) anchor = String(query.month) + '-01'
  return { kind, ...periodRange(kind, anchor, fm) }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
export function register(r: Router) {
  /* ---------- deals list ---------- */
  r.get('/sales/deals', ({ ctx, query }) => {
    let deals = visibleDeals(ctx)
    const q = String(query.q ?? '').trim().toLowerCase()
    if (query.owner_id && seesAll(ctx)) deals = deals.filter((d) => d.owner_id === query.owner_id)
    if (query.stage) deals = deals.filter((d) => d.stage === query.stage)
    if (query.source) deals = deals.filter((d) => d.source === query.source)
    if (query.product) deals = deals.filter((d) => d.product === query.product)
    if (q) deals = deals.filter((d) => `${d.title} ${d.client} ${d.contact} ${d.product}`.toLowerCase().includes(q))
    const views = listViews(ctx, deals).sort((a, b) => b.deal_value_paise - a.deal_value_paise)
    notifyStale(ctx, views)
    return { items: views, total: views.length, page: 1, page_size: views.length }
  })

  /* ---------- pipeline KPIs + funnel (G11.02, G11.03) ---------- */
  r.get('/sales/summary', ({ ctx, query }) => {
    requireSales(ctx)
    const owner = seesAll(ctx) ? (query.owner_id as string | undefined) || undefined : ctx.user.id
    const deals = visibleDeals(ctx).filter((d) => !owner || d.owner_id === owner)
    const hist = histMap(ctx)
    const staleDays = ctx.tenant.settings['sales.stale_deal_days']
    const fm = ctx.tenant.settings['company.fy_start_month']
    const t = ctx.today
    const open = deals.filter((d) => !isClosed(d.stage))
    const won = deals.filter((d) => d.stage === 'won')
    const lost = deals.filter((d) => d.stage === 'lost')
    const by = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0, weighted: 0 }])) as SalesSummary['by_stage']
    for (const d of deals) {
      by[d.stage].count++
      by[d.stage].value += dealValue(d)
      by[d.stage].weighted += weightedOf(d)
    }
    const cycles = won.filter((d) => d.won_on).map((d) => diffDays(d.won_on!, openedOn(ctx, d, hist.get(d.id) ?? []))).filter((x) => x >= 0)
    const qtr = quarterOf(t, fm)
    const wonQ = won.filter((d) => d.won_on && d.won_on >= qtr.from && d.won_on <= qtr.to)
    const fc = open.filter((d) => d.expected_close >= qtr.from && d.expected_close <= qtr.to)
    const since180 = addDays(t, -180)
    const won180 = won.filter((d) => d.won_on && d.won_on >= since180 && d.won_on <= t).length
    const lost180 = lost.filter((d) => d.lost_on && d.lost_on >= since180 && d.lost_on <= t).length
    const mr = monthRange(monthOf(t))
    const wk = /^\d{4}-\d{2}-\d{2}$/.test(String(query.week ?? '')) ? weekStart(String(query.week)) : weekStart(t)
    const wkTo = addDays(wk, 6)
    const ids = new Set(deals.map((d) => d.id))
    const acts = rows(ctx, 'deal_activities').filter((a) => ids.has(a.deal_id) && a.date >= wk && a.date <= wkTo).length
    const sum = (ds: E.Deal[]) => ds.reduce((s, d) => s + dealValue(d), 0)
    const fun = (s: E.DealStage): FunnelStage => ({ stage: s, label: STAGE_LABEL[s], count: by[s].count, value: by[s].value })
    const out: SalesSummary = {
      open_value: sum(open),
      weighted_value: open.reduce((s, d) => s + weightedOf(d), 0),
      open_count: open.length,
      won_value: sum(won),
      won_count: won.length,
      lost_count: lost.length,
      win_rate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
      avg_deal: won.length ? Math.round(sum(won) / won.length) : null,
      avg_cycle_days: cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null,
      stale_count: open.filter((d) => diffDays(t, d.last_activity_on) >= staleDays).length,
      by_stage: by,
      stale_days: staleDays,
      quarter_label: qtr.label,
      won_quarter_value: sum(wonQ),
      won_quarter_count: wonQ.length,
      forecast_quarter: fc.reduce((s, d) => s + weightedOf(d), 0),
      forecast_quarter_count: fc.length,
      win_rate_180: won180 + lost180 ? won180 / (won180 + lost180) : null,
      won_180: won180,
      lost_180: lost180,
      median_cycle_days: median(cycles),
      recurring_won_monthly: won.reduce((s, d) => s + (d.mrr_paise || 0), 0),
      new_leads_month: deals.filter((d) => {
        const o = openedOn(ctx, d, hist.get(d.id) ?? [])
        return o >= mr.from && o <= mr.to
      }).length,
      month_label: new Date(Number(mr.from.slice(0, 4)), Number(mr.from.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      activities_week: acts,
      week_from: wk,
      week_to: wkTo,
      followups_overdue: open.filter((d) => !!d.next_step_on && d.next_step_on < t).length,
      funnel: (['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won'] as E.DealStage[]).map(fun),
      lost: fun('lost'),
    }
    return out
  })

  /* ---------- activity log (G11.05) ---------- */
  r.get('/sales/activity', ({ ctx, query }) => {
    const deals = visibleDeals(ctx)
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to ?? '')) ? String(query.to) : ctx.today
    const days = Math.min(366, Math.max(1, Number(query.days) || 30))
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from ?? '')) ? String(query.from) : addDays(to, -(days - 1))
    if (to < from) err(422, 'DATE_RANGE', 'The end date must be on or after the start date.')
    const byId = new Map(deals.map((d) => [d.id, d]))
    repairStageHistory(ctx)
    const items: ActivityLogItem[] = []
    for (const a of rows(ctx, 'deal_activities')) {
      const d = byId.get(a.deal_id)
      if (!d || a.date < from || a.date > to) continue
      items.push({ id: a.id, date: a.date, at: a.date + 'T' + a.created_at.slice(11), who_id: a.by, who_name: userName(ctx, a.by), deal_id: d.id, deal_title: d.title, client: d.client, kind: a.type, what: SALES_LOG_KIND[a.type], detail: a.note })
    }
    for (const h of rows(ctx, 'deal_stage_history')) {
      const d = byId.get(h.deal_id)
      const date = h.at.slice(0, 10)
      if (!d || date < from || date > to) continue
      if (h.from_stage === null) {
        const fc = (d.first_conversation ?? '').trim()
        items.push({ id: h.id, date, at: h.at, who_id: d.created_by ?? h.by, who_name: userName(ctx, d.created_by ?? h.by), deal_id: d.id, deal_title: d.title, client: d.client, kind: 'new_lead', what: SALES_LOG_KIND.new_lead, detail: fc ? `${DEAL_SOURCE[d.source]}: ${fc.length > 120 ? fc.slice(0, 117) + '…' : fc}` : DEAL_SOURCE[d.source] })
      } else {
        items.push({ id: h.id, date, at: h.at, who_id: h.by, who_name: userName(ctx, h.by), deal_id: d.id, deal_title: d.title, client: d.client, kind: 'stage', what: SALES_LOG_KIND.stage, detail: `${STAGE_LABEL[h.from_stage]} → ${STAGE_LABEL[h.to_stage]}${h.reason ? ` (${h.reason})` : ''}` })
      }
    }
    items.sort((a, b) => b.at.localeCompare(a.at))
    const counts = new Map<string, number>()
    for (const x of items) counts.set(x.who_id, (counts.get(x.who_id) ?? 0) + 1)
    const people = [...counts.entries()].map(([user_id, count]) => ({ user_id, name: userName(ctx, user_id), count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    const shown = query.user_id ? items.filter((x) => x.who_id === query.user_id) : items
    const by_kind: ActivityLog['by_kind'] = {}
    for (const x of shown) by_kind[x.kind] = (by_kind[x.kind] ?? 0) + 1
    const out: ActivityLog = { from, to, items: shown, people, total: items.length, by_kind }
    return out
  })

  /* ---------- create ---------- */
  r.post('/sales/deals', ({ ctx, body }) => {
    requireSales(ctx)
    const b = body as Partial<DealRow>
    const owner_id = b.owner_id || ctx.user.id
    validateDealBody(ctx, { ...b, owner_id }, true)
    const stage = (b.stage ?? 'lead') as E.DealStage
    if (!OPEN.includes(stage)) err(422, 'DEAL_STAGE', 'A new lead starts in an open stage. Move it to Won or Lost from the pipeline.', 'stage')
    const deal = insert(ctx, 'deals', {
      title: b.title!.trim(), client: b.client!.trim(), contact: (b.contact ?? '').trim(), phone: (b.phone ?? '').trim(), email: (b.email ?? '').trim(),
      product: b.product || 'Custom software', source: b.source || 'other', owner_id, stage, value_paise: b.value_paise ?? 0, mrr_paise: b.mrr_paise ?? 0,
      expected_close: b.expected_close!, won_on: null, lost_on: null, lost_reason: null, project_id: null, last_activity_on: ctx.today, notes: (b.notes ?? '').trim(),
      next_step: b.next_step?.trim() || null, next_step_on: b.next_step?.trim() ? b.next_step_on || null : null, first_conversation: b.first_conversation?.trim() || null,
      created_by: ctx.user.id,
    } as never) as DealRow
    // The first stage-history row is the "New lead" line in the activity log and the deal timeline.
    insert(ctx, 'deal_stage_history', { deal_id: deal.id, from_stage: null, to_stage: stage, by: ctx.user.id, at: nowISO(), reason: null } as never)
    logActivity(ctx, 'deal', deal.id, 'create', `New lead ${deal.title} (${deal.client}) · ${DEAL_SOURCE[deal.source]}`)
    if (owner_id !== ctx.user.id) notify(ctx, owner_id, 'NTF-14', 'New lead assigned to you', `${deal.title} — ${deal.client}`, `/sales/${deal.id}`)
    return viewDeal(ctx, deal)
  })

  /* ---------- detail ---------- */
  r.get('/sales/deals/:id', ({ ctx, params }) => {
    const d = getDeal(ctx, params.id)
    repairStageHistory(ctx)
    const acts = rows(ctx, 'deal_activities').filter((a) => a.deal_id === d.id)
    const hist = rows(ctx, 'deal_stage_history').filter((h) => h.deal_id === d.id)
    const timeline: TimelineItem[] = [
      ...hist.map<TimelineItem>((h) => ({ kind: 'stage', id: h.id, at: h.at, by: h.by, by_name: userName(ctx, h.by), from_stage: h.from_stage, to_stage: h.to_stage, reason: h.reason })),
      ...acts.map<TimelineItem>((a) => ({ kind: 'activity', id: a.id, at: a.date + 'T' + a.created_at.slice(11), date: a.date, by: a.by, by_name: userName(ctx, a.by), type: a.type, note: a.note })),
    ].sort((a, b) => b.at.localeCompare(a.at))
    const out: DealDetail = {
      deal: viewDeal(ctx, d),
      timeline,
      activity_count: acts.length,
      can_edit: (d.owner_id === ctx.user.id || isAdmin(ctx)) && (!isClosed(d.stage) || isAdmin(ctx)),
      can_delete: isAdmin(ctx),
      can_reopen: isAdmin(ctx),
      can_create_project: isAdmin(ctx) && d.stage === 'won' && !d.project_id,
    }
    return out
  })

  /* ---------- edit (never the stage) ---------- */
  r.patch('/sales/deals/:id', ({ ctx, params, body, ifMatch }) => {
    const d = writableDeal(ctx, params.id)
    const b = { ...(body as Partial<DealRow>) }
    for (const k of ['id', 'tenant_id', 'stage', 'won_on', 'lost_on', 'lost_reason', 'project_id', 'created_at', 'created_by', 'version', 'last_activity_on'] as const) delete (b as Record<string, unknown>)[k]
    if (isClosed(d.stage) && !isAdmin(ctx)) err(409, 'DEAL_STAGE', 'This deal is closed. Ask a sales manager to reopen it before editing.')
    validateDealBody(ctx, b, false)
    if (d.stage === 'won' && ('value_paise' in b || 'mrr_paise' in b) && dealValue({ value_paise: b.value_paise ?? d.value_paise, mrr_paise: b.mrr_paise ?? d.mrr_paise }) <= 0) err(422, 'DEAL_STAGE', 'A won deal must keep a value above zero.', 'value_paise')
    const patch: Partial<DealRow> = {}
    for (const k of ['title', 'client', 'contact', 'phone', 'email', 'notes', 'next_step', 'first_conversation'] as const) if (k in b) (patch as Record<string, unknown>)[k] = typeof b[k] === 'string' ? (b[k] as string).trim() : b[k]
    for (const k of ['product', 'source', 'owner_id', 'value_paise', 'mrr_paise', 'expected_close', 'next_step_on'] as const) if (k in b) (patch as Record<string, unknown>)[k] = b[k] || (k === 'next_step_on' ? null : b[k])
    if ('next_step' in patch && !patch.next_step) patch.next_step_on = null
    const u = update(ctx, 'deals', d.id, patch as never, ifMatch) as DealRow
    logActivity(ctx, 'deal', d.id, 'update', `Edited deal ${u.title}`)
    if (patch.owner_id && patch.owner_id !== d.owner_id && patch.owner_id !== ctx.user.id) notify(ctx, patch.owner_id, 'NTF-14', 'Deal assigned to you', `${u.title} — ${u.client}`, `/sales/${u.id}`)
    return viewDeal(ctx, u)
  })

  /* ---------- stage move (F23) ---------- */
  r.post('/sales/deals/:id/stage', ({ ctx, params, body, ifMatch }) => {
    const d = writableDeal(ctx, params.id)
    // update() mutates the row in place: capture the stage BEFORE it, or history reads "Won → Won · Reopened by admin".
    const from = d.stage
    const to = body.stage as E.DealStage
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!STAGES.includes(to)) err(422, 'DEAL_STAGE', 'Choose a valid stage.', 'stage')
    if (to === d.stage) return viewDeal(ctx, d)
    if (isClosed(d.stage) && !isAdmin(ctx)) err(403, 'DEAL_STAGE', `Only a sales manager can move a deal out of ${DEAL_STAGE[d.stage].label}.`)
    if (to === 'lost' && reason.length < 3) err(422, 'DEAL_STAGE', 'Record why it was lost — that is how the win rate improves.', 'reason')
    if (to === 'won' && dealValue(d) <= 0) err(422, 'DEAL_STAGE', 'Add the deal value before marking it won.', 'value_paise')
    const patch: Partial<DealRow> = { stage: to, last_activity_on: ctx.today }
    if (to === 'won') Object.assign(patch, { won_on: ctx.today, lost_on: null, lost_reason: null })
    else if (to === 'lost') Object.assign(patch, { lost_on: ctx.today, lost_reason: reason, won_on: null })
    else Object.assign(patch, { won_on: null, lost_on: null, lost_reason: null })
    const u = update(ctx, 'deals', d.id, patch as never, ifMatch) as DealRow
    insert(ctx, 'deal_stage_history', { deal_id: d.id, from_stage: from, to_stage: to, by: ctx.user.id, at: nowISO(), reason: to === 'lost' ? reason : isClosed(from) ? reason || 'Reopened by admin' : null } as never)
    logActivity(ctx, 'deal', d.id, 'stage', `${u.title}: ${DEAL_STAGE[from].label} → ${DEAL_STAGE[to].label}${to === 'lost' ? ` (${reason})` : ''}`)
    if (to === 'won' && u.owner_id !== ctx.user.id) notify(ctx, u.owner_id, 'NTF-14', 'Deal won', `${u.title} was marked won (${fmtMoney(dealValue(u))}).`, `/sales/${u.id}`)
    return viewDeal(ctx, u)
  })

  /* ---------- activities ---------- */
  r.post('/sales/deals/:id/activities', ({ ctx, params, body }) => {
    const d = writableDeal(ctx, params.id)
    const type = body.type as E.ActivityType
    if (!(type in ACTIVITY_TYPE)) err(422, 'VALIDATION', 'Choose what kind of activity this was.', 'type')
    const note = String(body.note ?? '').trim()
    if (note.length < 3) err(422, 'VALIDATION', 'Write what happened (at least 3 characters).', 'note')
    const date = String(body.date ?? ctx.today)
    if (!isRealISODate(date)) err(422, 'VALIDATION', 'Pick a valid date.', 'date')
    if (date > ctx.today) err(422, 'VALIDATION', 'Activities are logged after they happen. Use the next step for plans.', 'date')
    const a = insert(ctx, 'deal_activities', { deal_id: d.id, date, type, note, by: ctx.user.id } as never)
    const patch: Partial<DealRow> = { last_activity_on: date > d.last_activity_on ? date : d.last_activity_on }
    if ('next_step' in body) {
      patch.next_step = String(body.next_step ?? '').trim() || null
      patch.next_step_on = patch.next_step ? body.next_step_on || addDays(ctx.today, 2) : null
    }
    update(ctx, 'deals', d.id, patch as never)
    logActivity(ctx, 'deal', d.id, 'activity', `${ACTIVITY_TYPE[type]} logged on ${d.title}`)
    return a
  })

  /* ---------- create project from a won deal ---------- */
  r.post('/sales/deals/:id/create-project', ({ ctx, params, body }) => {
    requireAction(ctx, 'deals.edit_all', 'Only an admin can create a project from a deal.')
    const d = getDeal(ctx, params.id)
    if (d.stage !== 'won') err(409, 'DEAL_STAGE', 'Mark the deal won before creating its project.')
    if (d.project_id && rows(ctx, 'projects').some((p) => p.id === d.project_id)) err(409, 'DEAL_HAS_PROJECT', 'This deal already has a project.')
    const name = String(body.name ?? '').trim()
    const client = String(body.client ?? '').trim()
    if (!name) err(422, 'VALIDATION', 'Project name is required.', 'name')
    if (!client) err(422, 'VALIDATION', 'Client is required.', 'client')
    const value = Number(body.contract_value_paise ?? dealValue(d))
    if (!Number.isInteger(value) || value < 0) err(422, 'MONEY_INVALID', 'Enter a contract value of zero or more.', 'contract_value_paise')
    const type = (body.type ?? 'service') as E.ProjectType
    if (!['product', 'service', 'saas', 'ams'].includes(type)) err(422, 'VALIDATION', 'Choose a project type.', 'type')
    const start_on = String(body.start_on ?? ctx.today)
    const end_on = String(body.end_on ?? addDays(start_on, 90))
    if (end_on < start_on) err(422, 'DATE_RANGE', 'End date must be on or after the start date.', 'end_on')
    const pm_id = body.pm_id ? String(body.pm_id) : null
    if (pm_id && !rows(ctx, 'users').some((u) => u.id === pm_id && u.status === 'active' && permissionsOf(u).includes('projects.edit'))) err(422, 'VALIDATION', 'Choose an active project manager.', 'pm_id')
    const streamOf: Record<string, E.RevenueStream> = { 'SAP consulting': 'sap_consulting', EduReon: 'saas', SeerHR: 'products', LeadSync: 'saas', 'Munim AI': 'saas', MineReon: 'products', 'Custom software': 'services' }
    const stream = (body.stream ?? streamOf[d.product] ?? 'services') as E.RevenueStream
    const billing_model = (body.billing_model ?? 'fixed') as E.BillingModel
    const prefix = ctx.tenant.settings['projects.code_prefix'] || 'PRJ'
    const existing = new Set(rows(ctx, 'projects').map((p) => p.code))
    let code = ''
    do code = `${prefix}-${String(nextNumber(ctx, 'project')).padStart(3, '0')}`
    while (existing.has(code))
    const p = insert(ctx, 'projects', {
      code, name, client, type, status: 'initiated', pm_id, start_on, end_on, contract_value_paise: value, billing_model, stream,
      description: d.notes || d.first_conversation || `Created from won deal "${d.title}".`, priority: 2, deal_id: d.id, baseline_end_on: end_on, color_hue: Math.floor(Math.random() * 360),
    } as never) as E.Project
    insert(ctx, 'project_status_history', { project_id: p.id, from_status: null, to_status: 'initiated', reason: `Created from deal ${d.title}`, changed_by: ctx.user.id, changed_at: nowISO() } as never)
    update(ctx, 'deals', d.id, { project_id: p.id } as never)
    logActivity(ctx, 'project', p.id, 'create', `Created project ${code} ${name} from won deal ${d.title}`)
    if (pm_id && pm_id !== ctx.user.id) notify(ctx, pm_id, 'NTF-14', 'New project assigned', `${code} ${name} (${client}) was created from a won deal.`, `/projects/${p.id}`)
    return { id: p.id, code: p.code, name: p.name, status: p.status }
  })

  /* ---------- delete (admin) ---------- */
  r.del('/sales/deals/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'deals.edit_all', 'Only an admin can delete a deal.')
    const d = getDeal(ctx, params.id)
    remove(ctx, 'deals', d.id, ifMatch)
    removeWhere(ctx, 'deal_activities', (a) => a.deal_id === d.id)
    removeWhere(ctx, 'deal_stage_history', (h) => h.deal_id === d.id)
    for (const p of rows(ctx, 'projects').filter((x) => x.deal_id === d.id)) update(ctx, 'projects', p.id, { deal_id: null } as never)
    logActivity(ctx, 'deal', d.id, 'delete', `Deleted deal ${d.title} (${d.client})`)
    return { ok: true }
  })

  /* ---------- salesperson performance (G12.07, G12.08) ---------- */
  r.get('/sales/performance', ({ ctx, query }) => {
    requireAction(ctx, 'sales.performance_own')
    let from = String(query.from ?? '')
    let to = String(query.to ?? '')
    let label = ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const p = periodOf(ctx, query)
      from = p.from
      to = p.to
      label = p.label
    }
    if (to < from) err(422, 'DATE_RANGE', 'The period end must be after its start.')
    if (!label) label = `${from} – ${to}`
    const admin = has(ctx, 'sales.performance_all')
    const seePay = canSeeSalaries(ctx)
    const allDeals = rows(ctx, 'deals')
    const deals = admin ? allDeals : allDeals.filter((d) => d.owner_id === ctx.user.id)
    const dealIds = new Set(deals.map((d) => d.id))
    const acts = rows(ctx, 'deal_activities').filter((a) => dealIds.has(a.deal_id))
    const hist = rows(ctx, 'deal_stage_history').filter((h) => dealIds.has(h.deal_id))
    const hm = new Map<string, E.DealStageHistory[]>()
    for (const h of hist) (hm.get(h.deal_id) ?? hm.set(h.deal_id, []).get(h.deal_id)!).push(h)
    const staleDays = ctx.tenant.settings['sales.stale_deal_days']
    const users = rows(ctx, 'users')
    const opened = new Map(deals.map((d) => [d.id, openedOn(ctx, d, hm.get(d.id) ?? [])]))
    const personIds = admin ? [...new Set([...salesPeople(ctx).map((u) => u.id), ...deals.map((d) => d.owner_id)])] : [ctx.user.id]

    const metric = (ids: Set<string>, f = from, tt = to) => {
      const ds = deals.filter((d) => ids.has(d.owner_id))
      const dsIds = new Set(ds.map((d) => d.id))
      const a = acts.filter((x) => dsIds.has(x.deal_id) && x.date >= f && x.date <= tt)
      const count = (t: E.ActivityType) => a.filter((x) => x.type === t).length
      const won = ds.filter((d) => d.stage === 'won' && d.won_on && d.won_on >= f && d.won_on <= tt)
      const lost = ds.filter((d) => d.stage === 'lost' && d.lost_on && d.lost_on >= f && d.lost_on <= tt)
      const open = ds.filter((d) => !isClosed(d.stage))
      const cycles = won.map((d) => diffDays(d.won_on!, opened.get(d.id)!)).filter((x) => x >= 0)
      const wonValue = won.reduce((s, d) => s + dealValue(d), 0)
      return {
        calls: count('call'), meetings: count('meeting'), demos: count('demo'), emails: count('email'), whatsapp: count('whatsapp'), proposals: count('proposal'), follow_ups: count('follow_up'), activities: a.length,
        new_leads: ds.filter((d) => opened.get(d.id)! >= f && opened.get(d.id)! <= tt).length,
        won_count: won.length, won_value: wonValue, lost_count: lost.length,
        win_rate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
        avg_deal: won.length ? Math.round(wonValue / won.length) : null,
        cycle_days: cycles.length ? Math.round(cycles.reduce((x, y) => x + y, 0) / cycles.length) : null,
        open_value: open.reduce((s, d) => s + dealValue(d), 0),
        weighted_value: open.reduce((s, d) => s + weightedOf(d), 0),
        open_count: open.length,
        stale: open.filter((d) => diffDays(ctx.today, d.last_activity_on) >= staleDays).length,
      }
    }
    const months = monthsBetween(from, to).filter((ym) => ym <= monthOf(ctx.today))
    const people: PersonPerformance[] = personIds.map((uid) => {
      const u = users.find((x) => x.id === uid)
      const m = metric(new Set([uid]))
      let target: number | null = null
      if (u?.role === 'sales' && (seePay || uid === ctx.user.id)) target = months.reduce((s, ym) => s + compFor(ctx, uid, ym, allDeals).target, 0)
      return { user_id: uid, name: u?.name ?? '—', role: u?.role ?? 'sales', ...m, target, achievement: target ? m.won_value / target : null }
    }).sort((a, b) => b.won_value - a.won_value || b.activities - a.activities || b.open_value - a.open_value)
    const team = metric(new Set(personIds))
    const teamTarget = people.reduce((s, p) => s + (p.target ?? 0), 0)

    // Sales cost vs deals closed, by month (at least the last 6 months ending at `to`)
    const costMonths = (months.length >= 6 ? months.slice(-12) : monthsBetween(addMonths(monthOf(to) + '-01', -5), to)).filter((ym) => ym <= monthOf(ctx.today))
    // Cost of sales is pay: the team's needs cost_rates.view; anyone sees their own.
    const seeCost = !admin || seePay
    const reps = admin ? (seeCost ? salesPeople(ctx) : []) : users.filter((u) => u.id === ctx.user.id && u.role === 'sales')
    const cost_vs_closed = costMonths.map((ym) => {
      const cost = reps.reduce((s, u) => s + compFor(ctx, u.id, ym, allDeals).payout, 0)
      const closed = deals.filter((d) => d.stage === 'won' && d.won_on && monthOf(d.won_on) === ym).reduce((s, d) => s + dealValue(d), 0)
      return { month: ym, label: monthLabel(ym), cost, closed, ratio: cost ? closed / cost : null }
    })
    const endM = monthOf(to) > monthOf(ctx.today) ? monthOf(ctx.today) : monthOf(to)
    const six = monthsBetween(addMonths(endM + '-01', -5), monthRange(endM).to)
    const target_vs_achieved = reps.map((u) => ({
      user_id: u.id,
      name: u.name,
      months: six.map((ym) => {
        const c = compFor(ctx, u.id, ym, allDeals)
        return { month: ym, label: c.label, target: c.target, achieved: c.achieved, hit: c.hit }
      }),
    }))
    const last_six = people.map((p) => {
      const pay = p.role === 'sales' && (seePay || p.user_id === ctx.user.id)
      return {
        user_id: p.user_id,
        name: p.name,
        can_see_pay: pay,
        months: six.map<SixMonthRow>((ym) => {
          const mr = monthRange(ym)
          const m = metric(new Set([p.user_id]), mr.from, mr.to)
          const c = compFor(ctx, p.user_id, ym, allDeals)
          const sales = p.role === 'sales'
          return {
            month: ym, label: monthLabel(ym), activities: m.activities, new_leads: m.new_leads, closed: closedInMonth(allDeals, p.user_id, ym),
            target: pay ? c.target : sales ? null : 0, achievement: pay ? (c.target ? c.achievement : null) : null, hit: pay ? c.hit : null, variable_earned: pay ? c.variable_earned : sales ? null : 0,
          }
        }),
      }
    })

    // Funnel: deals that ever reached each stage (history), conversion from the previous stage
    const reached = new Map<E.DealStage, Set<string>>(STAGES.map((s) => [s, new Set()]))
    for (const h of hist) reached.get(h.to_stage)!.add(h.deal_id)
    for (const d of deals) {
      reached.get(d.stage)!.add(d.id)
      if (d.stage !== 'lost') for (const s of OPEN) if (DEAL_STAGE[s].order <= DEAL_STAGE[d.stage].order) reached.get(s)!.add(d.id)
    }
    const byId = new Map(deals.map((d) => [d.id, d]))
    const funnelStages: E.DealStage[] = ['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won']
    const funnel = funnelStages.map((s, i) => {
      const set = reached.get(s)!
      const prev = i ? reached.get(funnelStages[i - 1])!.size : 0
      return { stage: s, label: STAGE_LABEL[s], reached: set.size, value: [...set].reduce((sum, id) => sum + (byId.has(id) ? dealValue(byId.get(id)!) : 0), 0), conversion: i && prev ? set.size / prev : null }
    })

    // 30-day activity heat by type
    const heatFrom = addDays(ctx.today, -29)
    const activity_heat = Array.from({ length: 30 }, (_, i) => {
      const date = addDays(heatFrom, i)
      const counts = Object.fromEntries(Object.keys(ACTIVITY_TYPE).map((k) => [k, 0])) as Record<E.ActivityType, number>
      for (const a of acts) if (a.date === date) counts[a.type]++
      return { date, counts, total: Object.values(counts).reduce((x, y) => x + y, 0) }
    })

    const out: SalesPerformance = {
      from, to, label, people,
      team: { ...team, target: teamTarget || null, achievement: teamTarget ? team.won_value / teamTarget : null },
      cost_vs_closed, target_vs_achieved, last_six, funnel, activity_heat, can_see_cost: seeCost,
    }
    return out
  })

  /* ---------- sales cost vs deals closed (G12.01–G12.05, BR-14..16) ---------- */
  r.get('/sales/compensation', ({ ctx, query }) => {
    requireAction(ctx, 'sales.performance_own')
    const per = periodOf(ctx, query)
    const fm = ctx.tenant.settings['company.fy_start_month']
    // The team's pay needs sales.performance_all AND cost_rates.view; otherwise only your own.
    const team = has(ctx, 'sales.performance_all') && canSeeSalaries(ctx)
    const allDeals = rows(ctx, 'deals')
    const people = team ? salesPeople(ctx) : rows(ctx, 'users').filter((u) => u.id === ctx.user.id)
    const curM = monthOf(ctx.today)
    const months = monthsBetween(per.from, per.to).filter((ym) => ym <= curM)
    const lastM = months[months.length - 1] ?? monthOf(per.from)
    const canEdit = team && has(ctx, 'cost_rates.edit')
    const list: CompPerson[] = people.map((u) => {
      const ms = months.map((ym) => compFor(ctx, u.id, ym, allDeals))
      const cur = compFor(ctx, u.id, lastM, allDeals)
      const s = (k: keyof CompMonth) => ms.reduce((a, m) => a + (m[k] as number), 0)
      const targetIn = s('target')
      const closed = s('achieved')
      const histEnd = lastM
      const history = monthsBetween(addMonths(histEnd + '-01', -5), monthRange(histEnd).to).map((ym) => compFor(ctx, u.id, ym, allDeals)).reverse()
      const strip = ({ has_rate: _h, variable_pct: _v, target_is_default: _t, ...m }: ReturnType<typeof compFor>): CompMonth => m
      return {
        user_id: u.id, name: u.name, title: u.title, has_rate: cur.has_rate,
        monthly_ctc: cur.monthly_ctc, variable_pct: cur.variable_pct, monthly_target: cur.target, target_is_default: cur.target_is_default,
        ctc_in_period: s('monthly_ctc'), base_in_period: s('base'), target_in_period: targetIn, closed,
        achievement: targetIn ? closed / targetIn : null, variable_earned: s('variable_earned'), payout: s('payout'), months_hit: ms.filter((m) => m.hit).length,
        deals: allDeals
          .filter((d) => d.owner_id === u.id && d.stage === 'won' && d.won_on && months.includes(monthOf(d.won_on)))
          .sort((a, b) => b.won_on!.localeCompare(a.won_on!))
          .map((d) => ({ id: d.id, title: d.title, client: d.client, value: dealValue(d), won_on: d.won_on! })),
        months: ms.map(strip),
        history: history.map(strip),
        pending_change: canEdit || u.id === ctx.user.id ? pendingBrief(ctx, 'cost_rate', u.id) : null,
        next_effective_from: canEdit && cur.has_rate ? nextEffectiveFrom(ctx, u.id, lastM) : null,
        month: lastM, label: per.label, base: s('base'), variable: s('variable'), target: targetIn, achieved: closed, hit: months.length > 0 && ms.every((m) => m.hit),
      }
    })
    const sum = (k: keyof CompPerson) => list.reduce((a, p) => a + (p[k] as number), 0)
    // Trend: every month of the FY that contains the period end, up to this month.
    const fyY = fyStartYear(per.to > ctx.today ? ctx.today : per.to, fm)
    const fyR = fyRange(fyY, fm)
    const trend = monthsBetween(fyR.from, fyR.to).filter((ym) => ym <= curM).map((ym) => {
      const cs = people.map((u) => compFor(ctx, u.id, ym, allDeals))
      const salary = cs.reduce((a, c) => a + c.monthly_ctc, 0)
      const closed = cs.reduce((a, c) => a + c.achieved, 0)
      // Sales cost = base salary + variable pay earned (what was actually paid), same as the Performance page.
      const cost = cs.reduce((a, c) => a + c.payout, 0)
      return { month: ym, label: monthLabel(ym), salary_cost: salary, payout: cost, sales_cost: cost, closed, ratio: cost ? closed / cost : null }
    })
    const ctc = sum('ctc_in_period')
    const closed = sum('closed')
    const salesCost = sum('payout') // base + variable earned
    const out: CompensationResult = {
      kind: per.kind, from: per.from, to: per.to, label: per.label, months, month: lastM,
      threshold_pct: ctx.tenant.settings['pay.variable_threshold_pct'],
      variable_default_pct: ctx.tenant.settings['pay.variable_default_pct'],
      scope: team ? 'team' : 'self',
      can_edit: canEdit,
      people: list,
      totals: { ctc, base: sum('base_in_period'), variable: sum('variable'), target: sum('target_in_period'), achieved: closed, closed, variable_earned: sum('variable_earned'), payout: salesCost, sales_cost: salesCost, ratio: salesCost ? closed / salesCost : null },
      trend,
    }
    return out
  })
}
