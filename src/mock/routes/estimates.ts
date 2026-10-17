// v7 — standalone PROJECT COST CALCULATOR (cost estimates for prospective projects).
// Same rules as the Feature Guide calculator on the create-project form (src/mock/costing.ts): cost per hour =
// monthly CTC ÷ (working days in the month × minimum hours per day), resource cost = cost per hour × minimum hours ×
// alloc % × working days, month by month; contingency on resources + additional costs; markup ⇄ price; margin vs
// markup. Added here: role placeholders with an assumed CTC (people not hired yet), saved + versioned estimates,
// scenarios and comparison, cost and cash by milestone, status (draft → shared → won / lost → converted) and
// conversion into a real project (the project is created by POST /projects; /estimates/:id/convert links it).
// Every route needs estimates.manage. Named people's CTC never leaves the server; per-row cost of named people is
// shown only with cost_rates.view (totals are always shown to estimate makers).
import type * as E from '@/types/entities'
import type { CostEstimate } from '@/types/v7'
import type { CostingAdditionalInput, CostingPreview, CostingRowView, PlannedMilestone } from '@/api/projects'
import { canSeeSalaries, err, find, has, insert, logActivity, nextNumber, nowISO, remove, requireAction, rows, update, warn, type Ctx, type Router } from '../server'
import { calendarSummary, cleanAdditional, minHours, personRangeCost, priceAndMarkup, rangeCostAtCtc, spreadMilestones, validateAdditional, wd } from '../costing'
import { fmtDate, isRealISODate, maxISO, minISO } from '@/domain/calendar'
import { BILLING_MODEL, PROJECT_TYPE, STREAM } from '@/domain/labels'
import { dealValue } from '@/domain/sales'
import { fmtMoney } from '@/domain/money'

/* ------------------------------------------------------------------ */
/* Contracts shared with src/api/estimates.ts                          */
/* ------------------------------------------------------------------ */
export type EstimateStatus = CostEstimate['status']
export interface EstimateResourceInput {
  key: string
  user_id: string | null
  role_label: string | null
  monthly_ctc_paise: number | null
  milestone_index: number | null
  pct: number | null
  from_on: string | null
  to_on: string | null
}
export interface EstimateCalcInput {
  start_on: string
  end_on: string
  milestones: { name: string; billing_amount_paise: number }[]
  resources: EstimateResourceInput[]
  additional_costs: CostingAdditionalInput[]
  maintenance_paise: number
  contingency_pct: number
  markup_pct: number | null
  price_paise: number | null
  price_mode: 'markup' | 'price'
}
export interface EstimateInput extends EstimateCalcInput {
  name: string
  client: string
  client_id: string | null
  deal_id: string | null
  type: string
  billing_model: string
  stream: string | null
  description: string
  notes: string
  /** optional note for the revision history */
  revision_note?: string
}
export interface EstimateRowView extends CostingRowView {
  kind: 'person' | 'role'
  role_label: string | null
  /** assumed CTC of a role placeholder (typed by the estimator); always null for named people */
  monthly_ctc_paise: number | null
}
export interface EstimateMilestoneCash {
  index: number
  code: string
  name: string
  start: string
  end: string
  billing: number
  // cost-derived figures are null when the costing is hidden (named people, viewer without salary access)
  people_cost: number | null
  other_cost: number | null // additional (M1) + maintenance (last) + contingency share
  total_cost: number | null
  man_days: number
  net: number | null // billing − cost
  cumulative_billing: number
  cumulative_cost: number | null
  cumulative_net: number | null
}
export interface EstimatePreview extends Omit<CostingPreview, 'rows'> {
  rows: EstimateRowView[]
  by_milestone: EstimateMilestoneCash[]
  billing_total: number
  /** price − milestone billing (billed on completion in the quote when positive) */
  unscheduled_billing: number
  role_rows: number
  named_rows: number
  /** true when cost-derived figures were removed: named people's salaries and the viewer lacks cost_rates.view */
  costing_hidden: boolean
}
export interface EstimateListItem {
  id: string
  number: string
  name: string
  client: string
  status: EstimateStatus
  deal: { id: string; title: string; stage: E.DealStage } | null
  project: { id: string; code: string; name: string } | null
  start_on: string
  end_on: string
  owner_id: string
  updated_at: string
  created_at: string
  version: number
  type: string
  billing_model: string
  scenario_of: string | null
  scenario_label: string | null
  price: number
  total_cost: number | null
  profit: number | null
  margin: number | null
  markup: number | null
  man_days: number
  working_days: number
  people: number
  role_rows: number
  below_floor: boolean
  costing_hidden: boolean
}
export interface EstimateList {
  items: EstimateListItem[]
  counts: Record<EstimateStatus | 'all', number>
  kpis: { in_progress: number; in_progress_value: number; quoted_value: number; quoted_count: number; avg_margin: number | null; margin_basis: number; won_converted: number; won_value: number; floor_pct: number; hidden: number }
}
export interface EstimateCompareItem extends EstimateListItem {
  resources_cost: number | null
  additional: number
  maintenance: number
  contingency: number | null
  contingency_pct: number
  billing_total: number
  milestones: number
}
export interface EstimateDetail {
  estimate: CostEstimate
  preview: EstimatePreview
  deal: { id: string; title: string; client: string; stage: E.DealStage; value_paise: number; project_id: string | null } | null
  project: { id: string; code: string; name: string; status: E.ProjectStatus } | null
  scenarios: EstimateListItem[]
  can_edit: boolean
  can_convert: boolean
  can_plan_cost: boolean
  costing_hidden: boolean
}
export interface EstimateOptions {
  deals: { id: string; title: string; client: string; stage: E.DealStage; value_paise: number; product: string; expected_close: string }[]
  clients: { id: string; name: string }[]
  can_see_rates: boolean
  can_convert: boolean
  can_plan_cost: boolean
  floor_pct: number
  min_hours: number
}

/* ------------------------------------------------------------------ */
/* Calculation                                                          */
/* ------------------------------------------------------------------ */
const ISO = { test: (s: string) => isRealISODate(s) }
const r1 = (n: number) => Math.round(n * 10) / 10
const STATUSES: EstimateStatus[] = ['draft', 'shared', 'won', 'lost', 'converted']
const TYPES = Object.keys(PROJECT_TYPE)
const MODELS = Object.keys(BILLING_MODEL)
const STREAMS = Object.keys(STREAM)
const num = (v: unknown, def = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
const floorOf = (ctx: Ctx) => ctx.tenant.settings['projects.margin_floor_pct']

function cleanMilestones(list: unknown): { name: string; billing_amount_paise: number }[] {
  if (!Array.isArray(list)) return []
  return list
    .map((m) => (m ?? {}) as Record<string, unknown>)
    .filter((m) => String(m.name ?? '').trim())
    .map((m) => ({ name: String(m.name).trim().slice(0, 120), billing_amount_paise: Math.max(0, Math.round(num(m.billing_amount_paise))) }))
}
function cleanResources(list: unknown): EstimateResourceInput[] {
  if (!Array.isArray(list)) return []
  return list.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>
    const pct = o.pct === null || o.pct === undefined || o.pct === '' ? null : num(o.pct, NaN)
    return {
      key: typeof o.key === 'string' && o.key ? o.key : `r${i + 1}`,
      user_id: typeof o.user_id === 'string' && o.user_id ? o.user_id : null,
      role_label: typeof o.role_label === 'string' ? o.role_label.trim().slice(0, 80) || null : null,
      monthly_ctc_paise: o.monthly_ctc_paise === null || o.monthly_ctc_paise === undefined || o.monthly_ctc_paise === '' ? null : Math.round(num(o.monthly_ctc_paise, NaN)),
      milestone_index: o.milestone_index === null || o.milestone_index === undefined || o.milestone_index === '' ? null : Math.round(num(o.milestone_index, -1)),
      pct: pct !== null && Number.isFinite(pct) ? pct : pct === null ? null : NaN,
      from_on: typeof o.from_on === 'string' && ISO.test(o.from_on) ? o.from_on : null,
      to_on: typeof o.to_on === 'string' && ISO.test(o.to_on) ? o.to_on : null,
    }
  })
}
export function calcInputFromBody(b: Record<string, unknown>): EstimateCalcInput {
  return {
    start_on: String(b.start_on ?? ''),
    end_on: String(b.end_on ?? ''),
    milestones: cleanMilestones(b.milestones),
    resources: cleanResources(b.resources),
    additional_costs: cleanAdditional(b.additional_costs),
    maintenance_paise: Math.max(0, Math.round(num(b.maintenance_paise))),
    contingency_pct: Math.min(100, Math.max(0, num(b.contingency_pct))),
    markup_pct: b.markup_pct === null || b.markup_pct === undefined || b.markup_pct === '' ? null : num(b.markup_pct),
    price_paise: b.price_paise === null || b.price_paise === undefined || b.price_paise === '' ? null : Math.round(num(b.price_paise)),
    price_mode: b.price_mode === 'price' ? 'price' : 'markup',
  }
}

interface Internal {
  preview: EstimatePreview
  errors: { message: string; field: string }[]
  total: number
  price: number
  resources: number
}

/** The estimate calculator. Every number on the estimate screens, the list, compare and the PDFs comes from here. */
export function computeEstimate(ctx: Ctx, a: EstimateCalcInput): Internal {
  const seeRates = canSeeSalaries(ctx)
  const okRange = ISO.test(a.start_on) && ISO.test(a.end_on) && a.end_on >= a.start_on
  const milestones: PlannedMilestone[] = okRange ? spreadMilestones(ctx, a.start_on, a.end_on, a.milestones) : []
  const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  const errors: { message: string; field: string }[] = []
  let resTotal = 0
  let manDays = 0
  const people = new Set<string>()
  const msPeople = milestones.map(() => 0)
  const msMan = milestones.map(() => 0)
  let roleRows = 0
  let namedRows = 0
  const warnings: string[] = []
  const out: EstimateRowView[] = a.resources.map((r, i) => {
    const isPerson = !!r.user_id
    if (isPerson) namedRows++
    else roleRows++
    const ms = r.milestone_index !== null && r.milestone_index >= 0 ? milestones[r.milestone_index] ?? null : null
    const from = r.from_on ?? (ms ? maxISO(ms.planned_start, a.start_on) : okRange ? a.start_on : null)
    const to = r.to_on ?? (ms ? minISO(ms.planned_end, a.end_on) : okRange ? a.end_on : null)
    const pct = r.pct !== null && Number.isFinite(r.pct) ? Math.round(r.pct) : null
    const u = r.user_id ? users.get(r.user_id) : null
    const who = u ? u.name : r.role_label || `Row ${i + 1}`
    let error: string | null = null
    let field: string | null = null
    const fail = (f: string, m: string) => {
      if (!error) {
        error = m
        field = `resources.${i}.${f}`
      }
    }
    if (isPerson) {
      if (!u || u.status !== 'active') fail('user_id', `Row ${i + 1}: choose an active person from your team, or switch the row to a role placeholder.`)
    } else {
      if (!r.role_label) fail('role_label', `Row ${i + 1}: name the role, e.g. “Senior React developer”, or pick a person.`)
      else if (r.monthly_ctc_paise === null || !Number.isFinite(r.monthly_ctc_paise) || r.monthly_ctc_paise <= 0) fail('monthly_ctc_paise', `${who}: type the assumed monthly CTC for this role.`)
    }
    if (r.milestone_index === null) fail('milestone_id', milestones.length ? `${who}: choose the milestone. Every resource row lands on a milestone.` : `${who}: add the milestones first. Every resource row lands on a milestone.`)
    else if (!ms) fail('milestone_id', `${who}: that milestone no longer exists. Choose another milestone.`)
    if (pct === null || pct < 1 || pct > 100) fail('pct', `${who}: set an allocation between 1% and 100%.`)
    if (!from) fail('from_on', `${who}: the From date is required.`)
    if (!to) fail('to_on', `${who}: the To date is required.`)
    if (from && to && from > to) fail('to_on', `${who}: From is after To.`)
    if (from && to && okRange && (from < a.start_on || to > a.end_on)) fail(from < a.start_on ? 'from_on' : 'to_on', `${who}: dates must sit inside the estimate (${fmtDate(a.start_on)} – ${fmtDate(a.end_on)}).`)
    let days = 0, md = 0, cost = 0, cpd: number | null = null, cph: number | null = null, hours = 0
    if (!error && from && to && pct) {
      const c = isPerson ? personRangeCost(ctx, r.user_id!, pct, from, to) : rangeCostAtCtc(ctx, r.monthly_ctc_paise!, pct, from, to)
      days = c.days
      md = c.manDays
      cost = c.cost
      cpd = c.cpd
      cph = c.cph
      hours = c.hours
      resTotal += cost
      manDays += md
      msPeople[ms!.index] += cost
      msMan[ms!.index] += md
      people.add(isPerson ? r.user_id! : `role:${r.role_label}:${i}`)
      if (isPerson && cpd === null) error = `${u!.name} has no cost rate yet, so this row costs nothing.`
    }
    if (error && field) errors.push({ message: error, field })
    const showCost = !isPerson || seeRates
    return {
      key: r.key,
      id: null,
      user_id: r.user_id,
      milestone_id: null,
      milestone_index: ms ? ms.index : r.milestone_index,
      ms_code: ms ? ms.code : '—',
      pct,
      from_on: from,
      to_on: to,
      working_days: days,
      man_days: md,
      hours,
      cost_per_hour: showCost && cph !== null ? Math.round(cph) : null,
      cost_per_day: showCost ? cpd : null,
      cost: showCost ? cost : null,
      error,
      kind: isPerson ? 'person' : 'role',
      role_label: isPerson ? null : r.role_label,
      monthly_ctc_paise: isPerson ? null : r.monthly_ctc_paise,
    }
  })
  const additional = a.additional_costs as (CostingAdditionalInput & { id: string })[]
  const add = additional.reduce((s, x) => s + x.amount_paise, 0)
  const maint = Math.max(0, Math.round(a.maintenance_paise))
  const contPct = Math.min(100, Math.max(0, a.contingency_pct))
  const cont = Math.round(((resTotal + add) * contPct) / 100)
  const total = resTotal + add + maint + cont
  const { price, markup } = priceAndMarkup(total, a.price_mode, a.markup_pct, a.price_paise)
  const profit = price - total
  const margin = price > 0 ? profit / price : null
  const floor = floorOf(ctx)
  const below = margin !== null && total > 0 && margin < floor / 100
  if (below) warnings.push(`Planned margin ${(margin! * 100).toFixed(1)}% is below the ${floor}% floor.`)

  // cost and cash by milestone: people cost where the rows land, additional costs up front (first milestone),
  // maintenance / support at the end (last milestone), contingency in proportion to each milestone's cost base.
  const n = milestones.length
  const base = milestones.map((_, i) => msPeople[i] + (i === 0 ? add : 0))
  const baseSum = base.reduce((s, x) => s + x, 0)
  let contLeft = cont
  const contShare = milestones.map((_, i) => {
    if (i === n - 1) return contLeft
    const sh = baseSum > 0 ? Math.round((cont * base[i]) / baseSum) : Math.round(cont / n)
    contLeft -= sh
    return sh
  })
  let cb = 0, cc = 0, scaledSoFar = 0
  const billingTotal = milestones.reduce((s, m) => s + m.billing_amount_paise, 0)
  const by: EstimateMilestoneCash[] = milestones.map((m, i) => {
    const other = (i === 0 ? add : 0) + (i === n - 1 ? maint : 0) + contShare[i]
    const totalMs = msPeople[i] + other
    // when the milestones don't bill the whole price, the balance is billed on completion (last milestone); when they
    // bill more than the price, each is scaled down to its share of the price (the quote always adds up to the price)
    const billing = billingTotal > price ? (i === n - 1 ? price - scaledSoFar : Math.round((m.billing_amount_paise * price) / billingTotal)) : m.billing_amount_paise + (i === n - 1 ? Math.max(0, price - billingTotal) : 0)
    scaledSoFar += billing
    cb += billing
    cc += totalMs
    return { index: i, code: m.code, name: m.name, start: m.planned_start, end: m.planned_end, billing, people_cost: msPeople[i], other_cost: other, total_cost: totalMs, man_days: r1(msMan[i]), net: billing - totalMs, cumulative_billing: cb, cumulative_cost: cc, cumulative_net: cb - cc }
  })
  if (n > 0 && billingTotal > price && price > 0) warnings.push(`Milestone billing (${fmtMoney(billingTotal)}) is more than the price (${fmtMoney(price)}). The cash view and quote scale each milestone to its share of the price; adjust the amounts or raise the price.`)
  if (n > 0 && billingTotal > 0 && billingTotal < price) warnings.push(`Milestones bill ${fmtMoney(billingTotal)} of the ${fmtMoney(price)} price; the balance (${fmtMoney(price - billingTotal)}) is billed on completion.`)
  const preview: EstimatePreview = {
    summary: okRange ? calendarSummary(ctx, a.start_on, a.end_on) : null,
    milestones,
    rows: out,
    totals: { resources: resTotal, additional: add, maintenance: maint, contingency: cont, total_cost: total, price, profit, margin, markup: total > 0 ? profit / total : null, man_days: r1(manDays), resource_rows: out.length, people: people.size },
    additional_costs: additional,
    maintenance_paise: maint,
    contingency_pct: contPct,
    markup_pct: markup,
    price_paise: price,
    floor_pct: floor,
    below_floor: below,
    can_see_rates: seeRates,
    can_see_money: true,
    loading_pct: 0,
    avg_working_days_per_month: null,
    min_hours: minHours(ctx),
    saved_at: null,
    saved_by: null,
    warnings,
    by_milestone: by,
    billing_total: billingTotal,
    unscheduled_billing: Math.max(0, price - billingTotal),
    role_rows: roleRows,
    named_rows: namedRows,
    costing_hidden: false,
  }
  return { preview, errors, total, price, resources: resTotal }
}

/* ------------------------------------------------------------------ */
/* Salary privacy (guide: only the salaries permission sees pay)        */
/* With one named person (or by differencing two versions) any cost     */
/* total reveals that person's CTC, so without cost_rates.view:          */
/*  - estimates are planned with role placeholders only (named → 422);  */
/*  - estimates that contain named people show price and milestones,   */
/*    never cost, profit, margin, markup or the cash view.              */
/* ------------------------------------------------------------------ */
export const NAMED_NEEDS_SALARY = 'Named people need salary access. Plan with a role and an assumed monthly CTC; a PM or the CEO with salary access can assign people later.'
export function costingHidden(ctx: Ctx, resources: { user_id: string | null }[]) {
  return !canSeeSalaries(ctx) && resources.some((r) => !!r.user_id)
}
function refuseNamed(ctx: Ctx, resources: { user_id: string | null }[]) {
  if (canSeeSalaries(ctx)) return
  const i = resources.findIndex((r) => !!r.user_id)
  if (i >= 0) err(422, 'NAMED_NEEDS_SALARY', NAMED_NEEDS_SALARY, `resources.${i}.user_id`)
}
function redactPreview(p: EstimatePreview): EstimatePreview {
  return {
    ...p,
    rows: p.rows.map((r) => (r.kind === 'person' ? { ...r, cost: null, cost_per_day: null, cost_per_hour: null } : r)),
    totals: { ...p.totals, resources: null, contingency: null, total_cost: null, profit: null, margin: null, markup: null },
    markup_pct: null,
    below_floor: false,
    warnings: p.warnings.filter((w) => !w.includes('floor')),
    by_milestone: p.by_milestone.map((m) => ({ ...m, people_cost: null, other_cost: null, total_cost: null, net: null, cumulative_cost: null, cumulative_net: null })),
    costing_hidden: true,
  }
}
function redactEstimate(e: CostEstimate): CostEstimate {
  return { ...e, markup_pct: null, revisions: (e.revisions ?? []).map((r) => ({ ...r, total_cost_paise: null })) }
}

/** Calculator input of a saved estimate (the saved price is authoritative). */
function calcOf(e: CostEstimate): EstimateCalcInput {
  const idx = new Map(e.milestones.map((m, i) => [m.key, i]))
  return {
    start_on: e.start_on,
    end_on: e.end_on,
    milestones: e.milestones.map((m) => ({ name: m.name, billing_amount_paise: m.billing_amount_paise })),
    resources: e.resources.map((r) => ({ key: r.id, user_id: r.user_id, role_label: r.role_label, monthly_ctc_paise: r.monthly_ctc_paise, milestone_index: idx.get(r.milestone_key) ?? null, pct: r.pct, from_on: r.from_on, to_on: r.to_on })),
    additional_costs: e.additional_costs,
    maintenance_paise: e.maintenance_paise,
    contingency_pct: e.contingency_pct,
    markup_pct: e.markup_pct,
    price_paise: e.price_paise,
    price_mode: 'price',
  }
}

function listItem(ctx: Ctx, e: CostEstimate, calc?: Internal): EstimateListItem {
  const c = calc ?? computeEstimate(ctx, calcOf(e))
  const deal = e.deal_id ? rows(ctx, 'deals').find((d) => d.id === e.deal_id) ?? null : null
  const proj = e.project_id ? rows(ctx, 'projects').find((p) => p.id === e.project_id) ?? null : null
  const t = c.preview.totals
  const hide = costingHidden(ctx, e.resources)
  return {
    id: e.id,
    number: e.number ?? '—',
    name: e.name,
    client: e.client,
    status: e.status,
    deal: deal ? { id: deal.id, title: deal.title, stage: deal.stage } : null,
    project: proj ? { id: proj.id, code: proj.code, name: proj.name } : null,
    start_on: e.start_on,
    end_on: e.end_on,
    owner_id: e.owner_id,
    updated_at: e.updated_at,
    created_at: e.created_at,
    version: e.version,
    type: e.type,
    billing_model: e.billing_model,
    scenario_of: e.scenario_of ?? null,
    scenario_label: e.scenario_label ?? null,
    price: t.price ?? 0,
    total_cost: hide ? null : t.total_cost ?? 0,
    profit: hide ? null : t.profit ?? 0,
    margin: hide ? null : t.margin,
    markup: hide ? null : t.markup,
    man_days: t.man_days,
    working_days: c.preview.summary?.working_days ?? 0,
    people: t.people,
    role_rows: c.preview.role_rows,
    below_floor: hide ? false : c.preview.below_floor,
    costing_hidden: hide,
  }
}

/* ------------------------------------------------------------------ */
/* Validation for save                                                  */
/* ------------------------------------------------------------------ */
function validateBody(ctx: Ctx, b: Record<string, unknown>) {
  const name = String(b.name ?? '').trim()
  if (!name) err(422, 'VALIDATION', 'Give the estimate a name, e.g. “Kalinga Public School — EduReon rollout”.', 'name')
  if (name.length > 140) err(422, 'VALIDATION', 'Keep the name under 140 characters.', 'name')
  let client = String(b.client ?? '').trim()
  const clientId = typeof b.client_id === 'string' && b.client_id ? b.client_id : null
  if (clientId) client = find(ctx, 'clients', clientId, 'Client').name
  const dealId = typeof b.deal_id === 'string' && b.deal_id ? b.deal_id : null
  if (dealId) {
    const d = find(ctx, 'deals', dealId, 'Deal')
    if (!client) client = d.client
  }
  if (!client) err(422, 'VALIDATION', 'Who is it for? Type the client or prospect, or pick a client or deal.', 'client')
  const type = String(b.type ?? 'service')
  if (!TYPES.includes(type)) err(422, 'VALIDATION', 'Choose a project type: Product, Service, SaaS or AMS.', 'type')
  const model = String(b.billing_model ?? 'fixed')
  if (!MODELS.includes(model)) err(422, 'VALIDATION', 'Choose a commercial model.', 'billing_model')
  const stream = b.stream && STREAMS.includes(String(b.stream)) ? String(b.stream) : null
  const start = String(b.start_on ?? '')
  const end = String(b.end_on ?? '')
  if (!ISO.test(start)) err(422, 'VALIDATION', 'Pick the planned start date.', 'start_on')
  if (!ISO.test(end)) err(422, 'VALIDATION', 'Pick the planned end date.', 'end_on')
  if (end < start) err(422, 'DATE_RANGE', 'The planned end is before the start date.', 'end_on')
  if (wd(ctx, start, end) > 1200) err(422, 'DATE_RANGE', 'Keep an estimate under about five years. Split longer programmes into phases.', 'end_on')
  const ms = cleanMilestones(b.milestones)
  const seen = new Map<string, number>()
  ms.forEach((m, i) => {
    const k = m.name.toLowerCase()
    if (seen.has(k)) err(422, 'VALIDATION', `Milestone ${i + 1}: “${m.name}” is already M${seen.get(k)! + 1}. Give each milestone its own name.`, 'milestones')
    seen.set(k, i)
  })
  if (Array.isArray(b.milestones) && b.milestones.length > 30) err(422, 'VALIDATION', 'Keep it to 30 milestones or fewer.', 'milestones')
  validateAdditional(b.additional_costs)
  const cp = num(b.contingency_pct, NaN)
  if (b.contingency_pct !== undefined && b.contingency_pct !== null && (!Number.isFinite(cp) || cp < 0 || cp > 100)) err(422, 'VALIDATION', 'Contingency must be between 0% and 100%.', 'costing.contingency_pct')
  if (num(b.maintenance_paise, 0) < 0) err(422, 'MONEY_INVALID', 'Maintenance / support cost must be zero or more.', 'costing.maintenance_paise')
  if (b.price_mode === 'price' && b.price_paise !== null && b.price_paise !== undefined && num(b.price_paise, -1) < 0) err(422, 'MONEY_INVALID', 'The price must be zero or more.', 'costing.price_paise')
  if (b.price_mode !== 'price' && b.markup_pct !== null && b.markup_pct !== undefined && b.markup_pct !== '' && (!Number.isFinite(num(b.markup_pct, NaN)) || num(b.markup_pct) <= -100)) err(422, 'VALIDATION', 'Markup must be a number above −100%.', 'costing.markup_pct')
  const resources = cleanResources(b.resources)
  refuseNamed(ctx, resources)
  if (resources.length > 80) err(422, 'VALIDATION', 'Keep it to 80 resource rows or fewer.', 'resources')
  const calc = calcInputFromBody(b)
  const c = computeEstimate(ctx, calc)
  const bad = c.errors.find((x) => !x.message.includes('no cost rate'))
  if (bad) err(422, 'ALLOC_INVALID', bad.message, bad.field)
  const keys = c.preview.milestones.map((m) => m.code)
  return {
    c,
    data: {
      name: name.slice(0, 140),
      client: client.slice(0, 140),
      client_id: clientId,
      deal_id: dealId,
      type,
      billing_model: model,
      stream,
      description: String(b.description ?? '').trim().slice(0, 2000),
      notes: String(b.notes ?? '').trim().slice(0, 4000),
      start_on: start,
      end_on: end,
      milestones: c.preview.milestones.map((m) => ({ key: m.code, name: m.name, billing_amount_paise: m.billing_amount_paise, start_on: m.planned_start, end_on: m.planned_end })),
      resources: resources.map((r) => ({ id: r.key, user_id: r.user_id, role_label: r.user_id ? null : r.role_label, monthly_ctc_paise: r.user_id ? null : r.monthly_ctc_paise, milestone_key: keys[r.milestone_index ?? -1] ?? 'M1', pct: Math.round(r.pct ?? 0), from_on: r.from_on, to_on: r.to_on })),
      additional_costs: calc.additional_costs.filter((x) => x.amount_paise > 0 || x.description).map((x, i) => ({ id: x.id ?? `ac${i + 1}`, category: x.category, description: x.description, amount_paise: x.amount_paise })),
      maintenance_paise: calc.maintenance_paise,
      contingency_pct: calc.contingency_pct,
      markup_pct: c.preview.markup_pct ?? 0,
      price_paise: c.price,
    } satisfies Partial<CostEstimate>,
  }
}

function revisionOf(ctx: Ctx, version: number, c: Internal, note: string): NonNullable<CostEstimate['revisions']>[number] {
  return { version, at: nowISO(), by: ctx.user.id, note: note.slice(0, 200), price_paise: c.price, total_cost_paise: c.total, man_days: c.preview.totals.man_days }
}

function nextEstimateNumber(ctx: Ctx) {
  const taken = new Set(rows(ctx, 'cost_estimates').map((e) => e.number))
  let code = ''
  do code = `EST-${String(nextNumber(ctx, 'estimate')).padStart(3, '0')}`
  while (taken.has(code))
  return code
}

const familyOf = (ctx: Ctx, e: CostEstimate) => {
  const root = e.scenario_of ?? e.id
  return rows(ctx, 'cost_estimates').filter((x) => x.id === root || x.scenario_of === root)
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */
const MANAGE = 'Only people with the project cost calculator permission can use estimates.'
const canConvert = (ctx: Ctx) => has(ctx, 'projects.create')
const canPlanCost = (ctx: Ctx) => (has(ctx, 'margins.view') || has(ctx, 'cost_rates.view')) && has(ctx, 'allocation.edit')

export function register(r: Router) {
  r.get('/estimates', ({ ctx, query }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const all = rows(ctx, 'cost_estimates')
    const items = all.map((e) => listItem(ctx, e))
    const q = String(query.q ?? '').trim().toLowerCase()
    const owner = String(query.owner_id ?? '')
    const base = items.filter((x) => (!q || `${x.number} ${x.name} ${x.client} ${x.deal?.title ?? ''} ${x.project?.code ?? ''}`.toLowerCase().includes(q)) && (!owner || x.owner_id === owner))
    const counts = { all: base.length } as EstimateList['counts']
    for (const s of STATUSES) counts[s] = base.filter((x) => x.status === s).length
    const status = String(query.status ?? 'all')
    const list = base.filter((x) => status === 'all' || x.status === status).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const open = items.filter((x) => x.status === 'draft' || x.status === 'shared')
    const quoted = items.filter((x) => x.status === 'shared' || x.status === 'won' || x.status === 'converted')
    const withMargin = items.filter((x) => x.status !== 'lost' && x.margin !== null && x.price > 0)
    const won = items.filter((x) => x.status === 'won' || x.status === 'converted')
    return {
      items: list,
      counts,
      kpis: {
        in_progress: open.length,
        in_progress_value: open.reduce((s, x) => s + x.price, 0),
        quoted_value: quoted.reduce((s, x) => s + x.price, 0),
        quoted_count: quoted.length,
        avg_margin: withMargin.length ? withMargin.reduce((s, x) => s + (x.margin ?? 0), 0) / withMargin.length : null,
        margin_basis: withMargin.length,
        won_converted: won.length,
        won_value: won.reduce((s, x) => s + x.price, 0),
        floor_pct: floorOf(ctx),
        hidden: items.filter((x) => x.costing_hidden && x.status !== 'lost').length,
      },
    } satisfies EstimateList
  })

  r.get('/estimates/options', ({ ctx }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const seesAll = has(ctx, 'deals.view_all')
    const own = has(ctx, 'deals.edit_own')
    const deals = rows(ctx, 'deals')
      .filter((d) => d.stage !== 'lost' && (seesAll || (own && d.owner_id === ctx.user.id)))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((d) => ({ id: d.id, title: d.title, client: d.client, stage: d.stage, value_paise: dealValue(d), product: d.product, expected_close: d.expected_close }))
    const clients = rows(ctx, 'clients').map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))
    return { deals, clients, can_see_rates: canSeeSalaries(ctx), can_convert: canConvert(ctx), can_plan_cost: canPlanCost(ctx), floor_pct: floorOf(ctx), min_hours: minHours(ctx) } satisfies EstimateOptions
  })

  /** Live calculator (debounced while typing). Same body as save. */
  r.post('/estimates/preview', ({ ctx, body }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const input = calcInputFromBody((body ?? {}) as Record<string, unknown>)
    refuseNamed(ctx, input.resources)
    return computeEstimate(ctx, input).preview
  })

  r.get('/estimates/compare', ({ ctx, query }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const ids = String(query.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (ids.length < 2) err(422, 'VALIDATION', 'Pick two or three estimates to compare.', 'ids')
    if (ids.length > 3) err(422, 'VALIDATION', 'Compare up to three estimates at a time.', 'ids')
    return [...new Set(ids)].map((id) => {
      const e = find(ctx, 'cost_estimates', id, 'Estimate')
      const c = computeEstimate(ctx, calcOf(e))
      const t = c.preview.totals
      const hide = costingHidden(ctx, e.resources)
      return { ...listItem(ctx, e, c), resources_cost: hide ? null : t.resources ?? 0, additional: t.additional ?? 0, maintenance: t.maintenance ?? 0, contingency: hide ? null : t.contingency ?? 0, contingency_pct: c.preview.contingency_pct, billing_total: c.preview.billing_total, milestones: c.preview.milestones.length } satisfies EstimateCompareItem
    })
  })

  r.get('/estimates/:id', ({ ctx, params }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const e = find(ctx, 'cost_estimates', params.id, 'Estimate')
    const c = computeEstimate(ctx, calcOf(e))
    const deal = e.deal_id ? rows(ctx, 'deals').find((d) => d.id === e.deal_id) ?? null : null
    const proj = e.project_id ? rows(ctx, 'projects').find((p) => p.id === e.project_id) ?? null : null
    const fam = familyOf(ctx, e)
    const hide = costingHidden(ctx, e.resources)
    const pv = { ...c.preview, saved_at: e.updated_at, saved_by: e.revisions?.[e.revisions.length - 1]?.by ?? e.owner_id }
    return {
      estimate: hide ? redactEstimate(e) : e,
      preview: hide ? redactPreview(pv) : pv,
      deal: deal ? { id: deal.id, title: deal.title, client: deal.client, stage: deal.stage, value_paise: dealValue(deal), project_id: deal.project_id } : null,
      project: proj ? { id: proj.id, code: proj.code, name: proj.name, status: proj.status } : null,
      scenarios: fam.length > 1 ? fam.map((x) => listItem(ctx, x)).sort((a, b) => (a.scenario_of ? 1 : 0) - (b.scenario_of ? 1 : 0) || a.created_at.localeCompare(b.created_at)) : [],
      can_edit: e.status !== 'converted' && !hide,
      can_convert: canConvert(ctx) && (e.status === 'draft' || e.status === 'shared' || e.status === 'won'),
      can_plan_cost: canPlanCost(ctx),
      costing_hidden: hide,
    } satisfies EstimateDetail
  })

  r.post('/estimates', ({ ctx, body }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const { c, data } = validateBody(ctx, (body ?? {}) as Record<string, unknown>)
    const e = insert(ctx, 'cost_estimates', {
      ...data,
      number: nextEstimateNumber(ctx),
      status: 'draft',
      project_id: null,
      owner_id: ctx.user.id,
      scenario_of: null,
      scenario_label: null,
      shared_on: null,
      decided_on: null,
      lost_reason: null,
      converted_on: null,
      revisions: [revisionOf(ctx, 1, c, 'Created')],
    })
    if (c.preview.below_floor) warn(ctx, 'MARGIN_BELOW_FLOOR', `Planned margin is below the ${floorOf(ctx)}% floor.`)
    logActivity(ctx, 'estimate', e.id, 'estimate.created', `Created estimate ${e.number} ${e.name}: price ${fmtMoney(c.price)}, ${c.preview.totals.man_days} man-days`)
    return e
  })

  r.put('/estimates/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const cur = find(ctx, 'cost_estimates', params.id, 'Estimate')
    if (cur.status === 'converted') err(409, 'ESTIMATE_LOCKED', 'This estimate became a project. Change the plan on the project’s Costing & margin tab, or duplicate the estimate.')
    if (ifMatch !== undefined && ifMatch !== cur.version) err(409, 'STALE', 'Someone else saved this estimate while you were editing. Reload to see the latest version.')
    const b = (body ?? {}) as Record<string, unknown>
    const { c, data } = validateBody(ctx, b)
    const revisions = [...(cur.revisions ?? []), revisionOf(ctx, cur.version + 1, c, String(b.revision_note ?? '').trim() || 'Saved')].slice(-50)
    const e = update(ctx, 'cost_estimates', cur.id, { ...data, revisions }, ifMatch)
    if (c.preview.below_floor) warn(ctx, 'MARGIN_BELOW_FLOOR', `Planned margin is below the ${floorOf(ctx)}% floor.`)
    logActivity(ctx, 'estimate', e.id, 'estimate.saved', `Saved ${e.number} v${e.version}: price ${fmtMoney(c.price)}, cost ${fmtMoney(c.total)}`)
    return e
  })

  r.post('/estimates/:id/duplicate', ({ ctx, params, body }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const src = find(ctx, 'cost_estimates', params.id, 'Estimate')
    refuseNamed(ctx, src.resources)
    const asScenario = !!(body as { as_scenario?: boolean })?.as_scenario
    const root = src.scenario_of ?? src.id
    const rootRow = find(ctx, 'cost_estimates', root, 'Estimate')
    let name: string
    let label: string | null = null
    if (asScenario) {
      const fam = familyOf(ctx, src)
      const used = new Set(fam.map((x) => x.scenario_label ?? (x.id === root ? 'Scenario A' : '')))
      let i = 1
      while (used.has(`Scenario ${String.fromCharCode(65 + i)}`) && i < 25) i++
      label = `Scenario ${String.fromCharCode(65 + i)}`
      name = `${rootRow.name.replace(/ — Scenario [A-Z]$/, '')} — ${label}`.slice(0, 140)
      if (!rootRow.scenario_label) update(ctx, 'cost_estimates', rootRow.id, { scenario_label: 'Scenario A' })
    } else name = `Copy of ${src.name}`.slice(0, 140)
    const { id: _id, tenant_id: _t, created_at: _c, updated_at: _u, version: _v, ...rest } = src
    void [_id, _t, _c, _u, _v]
    const c = computeEstimate(ctx, calcOf(src))
    const e = insert(ctx, 'cost_estimates', {
      ...JSON.parse(JSON.stringify(rest)),
      name,
      number: nextEstimateNumber(ctx),
      status: 'draft',
      project_id: null,
      owner_id: ctx.user.id,
      scenario_of: asScenario ? root : null,
      scenario_label: label,
      shared_on: null,
      decided_on: null,
      lost_reason: null,
      converted_on: null,
      revisions: [revisionOf(ctx, 1, c, `${asScenario ? 'Scenario' : 'Copy'} of ${src.number ?? src.name}`)],
    })
    logActivity(ctx, 'estimate', e.id, 'estimate.duplicated', `${asScenario ? `${label} of` : 'Duplicated'} ${src.number} ${src.name}`)
    return e
  })

  r.post('/estimates/:id/status', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const e = find(ctx, 'cost_estimates', params.id, 'Estimate')
    const to = String((body as { status?: string })?.status ?? '') as EstimateStatus
    const reason = String((body as { reason?: string })?.reason ?? '').trim()
    if (!['draft', 'shared', 'won', 'lost'].includes(to)) err(422, 'VALIDATION', 'Choose Draft, Shared, Won or Lost. Use “Convert to project” to make it a project.', 'status')
    if (e.status === 'converted') err(409, 'ESTIMATE_LOCKED', 'This estimate is already a project; its status can’t change.')
    if (e.status === to) err(409, 'NO_CHANGE', `The estimate is already ${to}.`)
    if (to === 'lost' && reason.length < 3) err(422, 'VALIDATION', 'Say why it was lost (a few words), e.g. “Budget moved to next year”.', 'reason')
    const c = computeEstimate(ctx, calcOf(e))
    if (to === 'shared' && c.price <= 0) err(422, 'VALIDATION', 'Price the estimate before you share it.', 'price_paise')
    const patch: Partial<CostEstimate> = { status: to }
    if (to === 'shared') patch.shared_on = ctx.today
    if (to === 'won' || to === 'lost') patch.decided_on = ctx.today
    patch.lost_reason = to === 'lost' ? reason.slice(0, 300) : null
    if (to === 'draft') patch.decided_on = null
    const out = update(ctx, 'cost_estimates', e.id, patch, ifMatch)
    const label = { draft: 'reopened as a draft', shared: 'shared with the client', won: 'marked won', lost: `marked lost (${reason})` }[to as 'draft']
    logActivity(ctx, 'estimate', e.id, 'estimate.status', `${e.number} ${e.name} ${label}`)
    if (e.deal_id && (to === 'won' || to === 'lost')) {
      const d = rows(ctx, 'deals').find((x) => x.id === e.deal_id)
      if (d && d.stage !== to) warn(ctx, 'DEAL_STAGE', `The linked deal “${d.title}” is still ${d.stage}. Move it on the pipeline if the client has decided.`)
    }
    return out
  })

  /** Called after POST /projects created the project from this estimate (Convert to project). */
  r.post('/estimates/:id/convert', ({ ctx, params, body }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    if (!canConvert(ctx)) err(403, 'FORBIDDEN', 'Only people who can create projects can convert an estimate.')
    const e = find(ctx, 'cost_estimates', params.id, 'Estimate')
    if (e.status === 'converted') err(409, 'ESTIMATE_LOCKED', 'This estimate is already a project.')
    if (e.status === 'lost') err(409, 'ESTIMATE_LOST', 'Reopen the estimate before converting it; it is marked lost.')
    const pid = String((body as { project_id?: string })?.project_id ?? '')
    if (!pid) err(422, 'VALIDATION', 'Which project was created from this estimate?', 'project_id')
    const p = find(ctx, 'projects', pid, 'Project')
    const other = rows(ctx, 'cost_estimates').find((x) => x.project_id === p.id && x.id !== e.id)
    if (other) err(409, 'PROJECT_LINKED', `${p.code} is already linked to estimate ${other.number}.`)
    const out = update(ctx, 'cost_estimates', e.id, { status: 'converted', project_id: p.id, converted_on: ctx.today, decided_on: e.decided_on ?? ctx.today })
    if (e.deal_id) {
      const d = rows(ctx, 'deals').find((x) => x.id === e.deal_id)
      if (d && !d.project_id) update(ctx, 'deals', d.id, { project_id: p.id })
      if (!p.deal_id) update(ctx, 'projects', p.id, { deal_id: e.deal_id })
    }
    logActivity(ctx, 'estimate', e.id, 'estimate.converted', `${e.number} ${e.name} converted into ${p.code} ${p.name}`)
    logActivity(ctx, 'project', p.id, 'project.from_estimate', `Created from estimate ${e.number} (${fmtMoney(e.price_paise)})`)
    return out
  })

  r.del('/estimates/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'estimates.manage', MANAGE)
    const e = find(ctx, 'cost_estimates', params.id, 'Estimate')
    if (e.status !== 'draft') err(409, 'ESTIMATE_NOT_DRAFT', 'Only draft estimates can be deleted. Mark it lost instead, so the history stays.')
    // scenarios of a deleted root move under the oldest remaining scenario
    const kids = rows(ctx, 'cost_estimates').filter((x) => x.scenario_of === e.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
    remove(ctx, 'cost_estimates', e.id, ifMatch)
    if (kids.length) {
      update(ctx, 'cost_estimates', kids[0].id, { scenario_of: null })
      for (const k of kids.slice(1)) update(ctx, 'cost_estimates', k.id, { scenario_of: kids[0].id })
      if (kids.length === 1) update(ctx, 'cost_estimates', kids[0].id, { scenario_label: null })
    }
    logActivity(ctx, 'estimate', e.id, 'estimate.deleted', `Deleted draft estimate ${e.number} ${e.name}`)
    return { ok: true }
  })
}

/** For other modules: estimates linked to a deal (e.g. a future "Estimates" card on the deal page). */
export function estimatesForDeal(ctx: Ctx, dealId: string) {
  return rows(ctx, 'cost_estimates').filter((e) => e.deal_id === dealId).map((e) => ({ id: e.id, number: e.number ?? '', name: e.name, status: e.status, price_paise: e.price_paise }))
}
