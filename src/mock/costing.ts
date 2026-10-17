// Workstream A — project costing engine (Feature Guide §3 "Create project", §6 "Costing, allocation and margins").
// Server-side only: the project cost calculator (preview + save), automatic milestone date spreading, planned /
// projected / actual margins, "what moved the margin", milestone variance, resources allocated vs logged, effort
// ratios and the CEO portfolio. Screens only format what these functions return.
import type * as E from '@/types/entities'
import type {
  AllocationCostRow, CalendarSummary, CostingAdditionalInput, CostingAnalysis, CostingInput, CostingPreview, CostingResourceInput, CostingRowView, CostingTotals, CostPerHourInfo, CostRateDay, EffortTaskRow,
  MarginBridgeLine, MarginColumn, MilestoneVarianceRow, PlannedMilestone, PortfolioMarginRow, PortfolioMargins, ProjectRowInfo, ProjectSummary, ResourceUseRow, Schedule,
} from '@/api/projects'
import { canSeeMargins, canSeeSalaries, err, find, getDb, has, hasAny, insert, logActivity, nowISO, remove, rows, update, userName, warn, type Ctx, type Router } from './server'
import { allocationOn, cal, costedEntries, currentRatePH, milestoneState, scheduleOf, setProjectMetricsOverride, taskActuals, wbsCode, type ProjectMetrics } from './analytics'
import { addDays, fmtDate, fyLabel, fyRange, fyStartYear, isRealISODate, isWeeklyOff, isWorkingDay, maxISO, minISO, monthOf, monthRange, workingDaysBetween, workingDaysInMonth, type CalendarCtx } from '@/domain/calendar'
import { progressOf } from '@/domain/delivery'
import { ADDITIONAL_COST_CATEGORIES, costPerHour, marginPct, markupPct, projectHealth, rateOn } from '@/domain/costing'
import { BILLING_MODEL, PROJECT_TYPE } from '@/domain/labels'
import { fmtMoney } from '@/domain/money'

const ISO = { test: (s: string) => isRealISODate(s) }
const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100

/* ---------------- per-request memo ---------------- */
const memo = new WeakMap<Ctx, Map<string, unknown>>()
function cached<T>(ctx: Ctx, key: string, f: () => T): T {
  let m = memo.get(ctx)
  if (!m) memo.set(ctx, (m = new Map()))
  if (!m.has(key)) m.set(key, f())
  return m.get(key) as T
}

/* ---------------- schedule (analytics owns the CPM / forecast) ---------------- */
function scheduleFor(ctx: Ctx, p: E.Project): Schedule | null {
  try {
    return scheduleOf(ctx, p.id).schedule ?? null
  } catch {
    return null
  }
}

/* ================================================================== */
/* Calendar                                                            */
/* ================================================================== */
function calc(ctx: Ctx): CalendarCtx {
  return { ...cal(ctx), leaveDates: undefined }
}
function holidayMap(ctx: Ctx) {
  return cached(ctx, 'holmap', () => new Map(rows(ctx, 'holidays').filter((h) => !h.optional).map((h) => [h.date, h.name])))
}
/** Working days in [from, to] on the company calendar (weekly offs + holidays; no personal leave). */
export function wd(ctx: Ctx, from: string, to: string): number {
  if (!from || !to || to < from) return 0
  return cached(ctx, `wd:${from}:${to}`, () => workingDaysBetween(from, to, calc(ctx)))
}
/** Signed slip in working days: + when `end` is after `deadline`, − when before. */
export function slipDays(ctx: Ctx, deadline: string, end: string): number {
  if (end > deadline) return wd(ctx, addDays(deadline, 1), end)
  if (end < deadline) return -wd(ctx, addDays(end, 1), deadline)
  return 0
}
export function calendarSummary(ctx: Ctx, from: string, to: string): CalendarSummary | null {
  if (!ISO.test(from) || !ISO.test(to) || to < from) return null
  const c = calc(ctx)
  const hm = holidayMap(ctx)
  let cd = 0, we = 0, hol = 0, work = 0
  const list: { date: string; name: string }[] = []
  const stop = addDays(from, 366 * 4)
  for (let d = from; d <= to && d <= stop; d = addDays(d, 1)) {
    cd++
    if (isWeeklyOff(d, c)) we++
    else if (hm.has(d)) {
      hol++
      list.push({ date: d, name: hm.get(d)! })
    } else work++
  }
  return { from, to, calendar_days: cd, weekend_days: we, holidays: hol, working_days: work, holiday_list: list }
}

/* ================================================================== */
/* Cost per hour (Feature Guide §6, BR-23)                             */
/* cost per hour = monthly CTC ÷ (working days in the month × minimum  */
/* hours per day). An allocation costs its paid hours: working days ×   */
/* allocation % × minimum hours per day, each at its month's rate.      */
/* ================================================================== */
/** Kept for the settings screens; v6 costing does not load overheads onto salary cost. */
/** Legacy: cost loading is no longer applied (Feature Guide: cost per hour = CTC ÷ (working days × minimum hours)). */
export const loadingPct = (_ctx: Ctx) => 0
export const minHours = (ctx: Ctx) => ctx.tenant.settings['calendar.min_hours_per_day'] || 9
/** Average working days per month = working days in the financial year ÷ 12. */
export function avgWorkingDaysPerMonth(ctx: Ctx, date: string): number {
  const fsm = ctx.tenant.settings['company.fy_start_month'] || 4
  const y = fyStartYear(date, fsm)
  return cached(ctx, 'avgwd:' + y, () => {
    const r = fyRange(y, fsm)
    return Math.round((wd(ctx, r.from, r.to) / 12) * 10) / 10
  })
}
/** Working days in a calendar month (company calendar). */
export function wdMonth(ctx: Ctx, ym: string): number {
  return cached(ctx, 'wdm:' + ym, () => workingDaysInMonth(ym, calc(ctx)))
}
function rateFor(ctx: Ctx, userId: string, date: string): E.CostRate | null {
  const rates = cached(ctx, 'rates', () => rows(ctx, 'cost_rates'))
  const r = rateOn(rates, userId, date)
  if (r) return r
  // a plan that starts before the person's first rate uses their first rate
  return rates.filter((x) => x.user_id === userId).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0] ?? null
}
/** Cost per hour (paise, float) on a date = CTC ÷ (working days in that month × minimum hours). Null when no rate. */
export function costPerHourFor(ctx: Ctx, userId: string, date: string): number | null {
  return cached(ctx, `cph:${userId}:${monthOf(date)}`, () => {
    const r = rateFor(ctx, userId, date)
    if (!r) return null
    return costPerHour(r.monthly_ctc_paise, wdMonth(ctx, monthOf(date)), minHours(ctx))
  })
}
/** Cost of a full working day (paise) = minimum hours × cost per hour = CTC ÷ working days in the month. */
export function costPerDayFor(ctx: Ctx, userId: string, date: string): number | null {
  const ph = costPerHourFor(ctx, userId, date)
  return ph === null ? null : Math.round(ph * minHours(ctx))
}
/** Paid hours and cost of `pct`% of a person's time over [from, to], month by month at each month's rate. */
export function rangeCost(ctx: Ctx, userId: string, pct: number, from: string, to: string): { days: number; hours: number; cost: number; rated: boolean } {
  if (!from || !to || to < from || !pct) return { days: 0, hours: 0, cost: 0, rated: costPerHourFor(ctx, userId, from || ctx.today) !== null }
  return cached(ctx, `rc:${userId}:${pct}:${from}:${to}`, () => {
    const mh = minHours(ctx)
    let days = 0, cost = 0
    let rated = true
    for (let a = from; a <= to; ) {
      const ym = monthOf(a)
      const b = minISO(monthRange(ym).to, to)
      const d = wd(ctx, a, b)
      const ph = costPerHourFor(ctx, userId, a)
      if (ph === null) rated = false
      days += d
      cost += (d * pct * mh * (ph ?? 0)) / 100
      a = addDays(b, 1)
    }
    return { days, hours: r1((days * pct * mh) / 100), cost: Math.round(cost), rated }
  })
}
function resourceRowCost(ctx: Ctx, userId: string, pct: number, from: string, to: string) {
  const c = rangeCost(ctx, userId, pct, from, to)
  return { days: c.days, manDays: r1((c.days * pct) / 100), hours: c.hours, cpd: c.rated ? costPerDayFor(ctx, userId, from) : null, cph: costPerHourFor(ctx, userId, from), cost: c.cost }
}

/* ---------------- v7 standalone estimates (additive; used by routes/estimates.ts) ---------------- */
/** Cost of `pct`% of an ASSUMED monthly CTC (a role not hired yet) over [from, to], month by month — the same Feature
 *  Guide formula as a named person: cost per hour = CTC ÷ (working days in the month × minimum hours per day). */
export function rangeCostAtCtc(ctx: Ctx, monthlyCtcPaise: number, pct: number, from: string, to: string): { days: number; manDays: number; hours: number; cost: number; cpd: number | null; cph: number | null } {
  if (!from || !to || to < from || !pct || !(monthlyCtcPaise > 0)) return { days: 0, manDays: 0, hours: 0, cost: 0, cpd: null, cph: null }
  const mh = minHours(ctx)
  let days = 0, cost = 0
  for (let a = from; a <= to; ) {
    const ym = monthOf(a)
    const b = minISO(monthRange(ym).to, to)
    const d = wd(ctx, a, b)
    days += d
    cost += (d * pct * mh * costPerHour(monthlyCtcPaise, wdMonth(ctx, ym), mh)) / 100
    a = addDays(b, 1)
  }
  const cph = costPerHour(monthlyCtcPaise, wdMonth(ctx, monthOf(from)), mh)
  return { days, manDays: r1((days * pct) / 100), hours: r1((days * pct * mh) / 100), cost: Math.round(cost), cpd: Math.round(cph * mh), cph }
}
/** Named-person row cost (same as the project calculator's resource rows). */
export function personRangeCost(ctx: Ctx, userId: string, pct: number, from: string, to: string) {
  return resourceRowCost(ctx, userId, pct, from, to)
}
/** Price ⇄ markup exactly as the project calculator: price mode keeps the typed price; markup mode rounds to whole rupees. */
export function priceAndMarkup(total: number, mode: 'markup' | 'price', markupPct: number | null, pricePaise: number | null): { price: number; markup: number | null } {
  if (mode === 'price' && pricePaise !== null && pricePaise >= 0) return { price: Math.round(pricePaise), markup: total > 0 ? r2(((Math.round(pricePaise) - total) / total) * 100) : null }
  const markup = markupPct === null ? 0 : r2(markupPct)
  return { price: Math.round((total * (1 + markup / 100)) / 100) * 100, markup }
}

/* ================================================================== */
/* AUTO MILESTONE SETUP: provisional dates across the project range    */
/* ================================================================== */
/** Spread milestones across the project's working days, proportional to billing when every milestone bills, else evenly. */
export function spreadMilestones(ctx: Ctx, start: string, end: string, list: { name: string; billing_amount_paise: number }[]): PlannedMilestone[] {
  const n = list.length
  if (!n || !ISO.test(start) || !ISO.test(end) || end < start) return []
  const c = calc(ctx)
  let days: string[] = []
  for (let d = start; d <= end && days.length < 2000; d = addDays(d, 1)) if (isWorkingDay(d, c)) days.push(d)
  if (!days.length) days = [start, end]
  const D = days.length
  const proportional = list.every((m) => m.billing_amount_paise > 0)
  const weights = list.map((m) => (proportional ? m.billing_amount_paise : 1))
  const W = weights.reduce((a, b) => a + b, 0)
  let cum = 0
  let prev = -1
  return list.map((m, i) => {
    cum += weights[i]
    let idx = i === n - 1 ? D - 1 : Math.round((cum / W) * D) - 1
    if (D >= n) idx = Math.min(Math.max(idx, prev + 1), D - 1 - (n - 1 - i))
    else idx = Math.min(Math.max(idx, prev), D - 1)
    const s = Math.min(prev + 1, D - 1)
    prev = idx
    return { index: i, id: null, code: `M${i + 1}`, name: m.name, billing_amount_paise: m.billing_amount_paise, planned_start: i === 0 ? start : days[s], planned_end: i === n - 1 ? end : days[idx] }
  })
}

/* ================================================================== */
/* Cost calculator — preview / validation                              */
/* ================================================================== */
interface Range {
  start: string
  end: string
}
interface ResolvedRow {
  input: CostingResourceInput
  key: string
  milestone: PlannedMilestone | null
  missingMilestone: boolean
  from: string | null
  to: string | null
  pct: number | null
  error: string | null
  field: string | null
}
function resolveRows(ctx: Ctx, range: Range, milestones: PlannedMilestone[], resources: CostingResourceInput[]): ResolvedRow[] {
  const users = cached(ctx, 'usersById', () => new Map(rows(ctx, 'users').map((u) => [u.id, u])))
  return resources.map((r, i) => {
    let milestone: PlannedMilestone | null = null
    let missing = false
    let none = false
    if (typeof r.milestone_index === 'number') {
      milestone = milestones[r.milestone_index] ?? null
      missing = !milestone
    } else if (r.milestone_id) {
      milestone = milestones.find((m) => m.id === r.milestone_id) ?? null
      missing = !milestone
    } else none = true
    const from = r.from_on && ISO.test(r.from_on) ? r.from_on : milestone ? maxISO(milestone.planned_start, range.start) : ISO.test(range.start) ? range.start : null
    const to = r.to_on && ISO.test(r.to_on) ? r.to_on : milestone ? minISO(milestone.planned_end, range.end) : ISO.test(range.end) ? range.end : null
    const pct = r.pct === null || r.pct === undefined || (r.pct as unknown) === '' ? null : Number(r.pct)
    const u = r.user_id ? users.get(r.user_id) : null
    const who = u ? u.name : `Row ${i + 1}`
    let error: string | null = null
    let field: string | null = null
    const fail = (f: string, m: string) => {
      if (!error) {
        error = m
        field = `resources.${i}.${f}`
      }
    }
    if (!r.user_id) fail('user_id', `Row ${i + 1}: choose the person.`)
    else if (!u || u.status !== 'active') fail('user_id', `Row ${i + 1}: choose an active person from your team.`)
    // Feature Guide §6: person, milestone, % and both dates are all required, so cost always lands on a milestone and a period
    if (none) fail('milestone_id', milestones.length ? `${who}: choose the milestone (${milestones.slice(0, 3).map((m) => m.code).join(', ')}${milestones.length > 3 ? '…' : ''}). Every resource row lands on a milestone.` : `${who}: add the milestones first. Every resource row lands on a milestone.`)
    if (missing) fail('milestone_id', `${who}: that milestone no longer exists. Choose another milestone.`)
    if (pct === null || !Number.isFinite(pct) || pct < 1 || pct > 100) fail('pct', `${who}: set an allocation between 1% and 100%.`)
    if (!from) fail('from_on', `${who}: the From date is required.`)
    if (!to) fail('to_on', `${who}: the To date is required.`)
    if (from && to && from > to) fail('to_on', `${who}: From is after To.`)
    if (from && to && ISO.test(range.start) && ISO.test(range.end) && (from < range.start || to > range.end)) fail(from < range.start ? 'from_on' : 'to_on', `${who}: dates must sit inside the project (${fmtDate(range.start)} – ${fmtDate(range.end)}).`)
    return { input: r, key: r.key ?? r.id ?? `r${i}`, milestone, missingMilestone: missing, from, to, pct: pct !== null && Number.isFinite(pct) ? Math.round(pct) : null, error, field }
  })
}

export function cleanAdditional(list: unknown): (CostingAdditionalInput & { id: string })[] {
  if (!Array.isArray(list)) return []
  return list.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>
    const cat = ADDITIONAL_COST_CATEGORIES.some((c) => c.value === o.category) ? String(o.category) : 'other'
    const amt = Math.round(Number(o.amount_paise ?? 0))
    return { id: typeof o.id === 'string' && o.id ? o.id : `ac${i + 1}`, category: cat, description: String(o.description ?? '').trim().slice(0, 200), amount_paise: Number.isFinite(amt) && amt > 0 ? amt : 0 }
  })
}
export function validateAdditional(list: unknown) {
  if (!Array.isArray(list)) return
  list.forEach((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>
    const amt = Number(o.amount_paise ?? 0)
    if (!Number.isFinite(amt) || amt < 0 || !Number.isInteger(amt)) err(422, 'MONEY_INVALID', `Additional cost ${i + 1}: the amount must be zero or more.`, `additional_costs.${i}.amount_paise`)
    if (amt > 0 && !String(o.description ?? '').trim()) err(422, 'VALIDATION', `Additional cost ${i + 1}: describe what it is for.`, `additional_costs.${i}.description`)
  })
}
function num(v: unknown, def = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

interface PreviewArgs {
  range: Range
  milestones: PlannedMilestone[]
  resources: CostingResourceInput[]
  additional: (CostingAdditionalInput & { id: string })[]
  maintenance: number
  contingencyPct: number
  markupPct: number | null
  pricePaise: number | null
  priceMode: 'markup' | 'price'
  saved_at?: string | null
  saved_by?: string | null
}
function computePreview(ctx: Ctx, a: PreviewArgs): CostingPreview & { _resolved: ResolvedRow[]; _internal: { resources: number; total: number; price: number } } {
  const seeRates = canSeeSalaries(ctx)
  const seeMoney = seeRates || canSeeMargins(ctx)
  const resolved = resolveRows(ctx, a.range, a.milestones, a.resources)
  let resTotal = 0
  let manDays = 0
  const people = new Set<string>()
  const outRows: CostingRowView[] = resolved.map((r) => {
    let days = 0, md = 0, cpd: number | null = null, cost = 0, hours = 0, cph: number | null = null
    if (r.input.user_id && r.from && r.to && r.to >= r.from && r.pct) {
      const c = resourceRowCost(ctx, r.input.user_id, r.pct, r.from, r.to)
      days = c.days
      md = c.manDays
      cpd = c.cpd
      cph = c.cph
      hours = c.hours
      cost = c.cost
      resTotal += cost
      manDays += md
      people.add(r.input.user_id)
    }
    const noRate = r.input.user_id && cpd === null && !r.error ? `${userName(ctx, r.input.user_id)} has no cost rate yet, so this row costs nothing.` : null
    return {
      key: r.key,
      id: r.input.id ?? null,
      user_id: r.input.user_id ?? null,
      milestone_id: r.milestone?.id ?? (typeof r.input.milestone_index === 'number' ? null : r.input.milestone_id ?? null),
      milestone_index: r.milestone ? r.milestone.index : typeof r.input.milestone_index === 'number' ? r.input.milestone_index : null,
      ms_code: r.milestone ? r.milestone.code : '—',
      pct: r.pct,
      from_on: r.from,
      to_on: r.to,
      working_days: days,
      man_days: md,
      hours,
      cost_per_hour: seeRates && cph !== null ? Math.round(cph) : null,
      cost_per_day: seeRates ? cpd : null,
      cost: seeRates ? cost : null,
      error: r.error ?? noRate,
    }
  })
  const add = a.additional.reduce((s, x) => s + x.amount_paise, 0)
  const maint = Math.max(0, Math.round(a.maintenance))
  const contPct = Math.min(100, Math.max(0, a.contingencyPct))
  const cont = Math.round(((resTotal + add) * contPct) / 100)
  const total = resTotal + add + maint + cont
  let price: number
  let markup: number | null
  if (a.priceMode === 'price' && a.pricePaise !== null && a.pricePaise >= 0) {
    price = Math.round(a.pricePaise)
    markup = total > 0 ? r2(((price - total) / total) * 100) : null
  } else {
    markup = a.markupPct === null ? 0 : r2(a.markupPct)
    price = Math.round((total * (1 + markup / 100)) / 100) * 100 // whole rupees
  }
  const profit = price - total
  const margin = price > 0 ? profit / price : null
  const floor = ctx.tenant.settings['projects.margin_floor_pct']
  const totals: CostingTotals = {
    resources: seeMoney ? resTotal : null,
    additional: seeMoney ? add : null,
    maintenance: seeMoney ? maint : null,
    contingency: seeMoney ? cont : null,
    total_cost: seeMoney ? total : null,
    price: seeMoney ? price : null,
    profit: seeMoney ? profit : null,
    margin: seeMoney ? margin : null,
    markup: seeMoney ? (total > 0 ? profit / total : null) : null,
    man_days: r1(manDays),
    resource_rows: outRows.length,
    people: people.size,
  }
  const warnings: string[] = []
  if (seeMoney && margin !== null && total > 0 && margin < floor / 100) warnings.push(`Planned margin ${(margin * 100).toFixed(1)}% is below the ${floor}% floor.`)
  return {
    summary: calendarSummary(ctx, a.range.start, a.range.end),
    milestones: a.milestones,
    rows: outRows,
    totals,
    additional_costs: seeMoney ? a.additional : [],
    maintenance_paise: seeMoney ? maint : 0,
    contingency_pct: contPct,
    markup_pct: seeMoney ? markup : null,
    price_paise: seeMoney ? price : null,
    floor_pct: floor,
    below_floor: seeMoney && margin !== null && total > 0 && margin < floor / 100,
    can_see_rates: seeRates,
    can_see_money: seeMoney,
    loading_pct: 0,
    avg_working_days_per_month: seeRates && ISO.test(a.range.start) ? r2(avgWorkingDaysPerMonth(ctx, a.range.start)) : null,
    min_hours: minHours(ctx),
    saved_at: a.saved_at ?? null,
    saved_by: a.saved_by ?? null,
    warnings,
    _resolved: resolved,
    _internal: { resources: resTotal, total, price },
  }
}
function publicPreview(p: ReturnType<typeof computePreview>): CostingPreview {
  const { _resolved, _internal, ...rest } = p
  void _resolved
  void _internal
  return rest
}

function liveMilestonesOf(ctx: Ctx, pid: string) {
  return rows(ctx, 'milestones').filter((m) => m.project_id === pid && !m.deleted_at).sort((a, b) => a.no - b.no)
}
function plannedMilestonesOf(ctx: Ctx, p: E.Project): PlannedMilestone[] {
  return liveMilestonesOf(ctx, p.id).map((m, i) => ({ index: i, id: m.id, code: `M${m.no}`, name: m.name, billing_amount_paise: m.billing_amount_paise, planned_start: m.planned_start, planned_end: m.planned_end }))
}
function argsFromBody(b: Record<string, unknown>): Omit<PreviewArgs, 'range' | 'milestones'> {
  const mode = b.price_mode === 'price' ? 'price' : 'markup'
  return {
    resources: Array.isArray(b.resources) ? (b.resources as CostingResourceInput[]) : [],
    additional: cleanAdditional(b.additional_costs),
    maintenance: Math.max(0, Math.round(num(b.maintenance_paise))),
    contingencyPct: Math.min(100, Math.max(0, num(b.contingency_pct))),
    markupPct: b.markup_pct === null || b.markup_pct === undefined || b.markup_pct === '' ? null : num(b.markup_pct),
    pricePaise: b.price_paise === null || b.price_paise === undefined || b.price_paise === '' ? null : Math.round(num(b.price_paise)),
    priceMode: mode,
  }
}

/** The project's saved plan as an editable preview (allocations are the resource rows). */
export function savedPlan(ctx: Ctx, p: E.Project) {
  return cached(ctx, 'plan:' + p.id, () => {
    const c = p.costing ?? null
    const allocs = rows(ctx, 'allocations').filter((a) => a.project_id === p.id)
    const ms = plannedMilestonesOf(ctx, p)
    const resources: CostingResourceInput[] = allocs
      .map((a) => ({ key: a.id, id: a.id, user_id: a.user_id, milestone_id: a.milestone_id, pct: a.pct, from_on: a.from_on, to_on: a.to_on }))
      .sort((x, y) => {
        const mx = x.milestone_id ? ms.find((m) => m.id === x.milestone_id)?.index ?? 99 : -1
        const my = y.milestone_id ? ms.find((m) => m.id === y.milestone_id)?.index ?? 99 : -1
        return mx - my || userName(ctx, x.user_id).localeCompare(userName(ctx, y.user_id)) || (x.from_on ?? '').localeCompare(y.from_on ?? '')
      })
    return computePreview(ctx, {
      range: { start: p.start_on, end: p.end_on },
      milestones: ms,
      resources,
      additional: c?.additional_costs ?? [],
      maintenance: c?.maintenance_paise ?? 0,
      contingencyPct: c?.contingency_pct ?? 0,
      markupPct: c ? c.markup_pct : null,
      pricePaise: c ? c.price_paise : p.contract_value_paise,
      priceMode: c ? 'price' : 'price',
      saved_at: c?.saved_at ?? null,
      saved_by: c?.saved_by ?? null,
    })
  })
}

/* ================================================================== */
/* Over-allocation across projects (per person per working day)       */
/* ================================================================== */
function overAllocation(ctx: Ctx, projectId: string | null, resolved: ResolvedRow[]) {
  const max = ctx.tenant.settings['allocation.max_pct_per_person']
  const mine = projectId ? rows(ctx, 'allocations').filter((a) => a.project_id === projectId) : []
  const byUser = new Map<string, ResolvedRow[]>()
  for (const r of resolved) if (!r.error && r.input.user_id && r.from && r.to && r.pct) (byUser.get(r.input.user_id) ?? byUser.set(r.input.user_id, []).get(r.input.user_id)!).push(r)
  const out: { user_id: string; index: number; days: string[]; peak: number }[] = []
  const c = calc(ctx)
  for (const [u, list] of byUser) {
    const from = list.reduce((m, r) => minISO(m, r.from!), list[0].from!)
    const to = list.reduce((m, r) => maxISO(m, r.to!), list[0].to!)
    const over: string[] = []
    let peak = 0
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!isWorkingDay(d, c)) continue
      const others = allocationOn(ctx, u, d) - mine.filter((a) => a.user_id === u && a.from_on <= d && a.to_on >= d).reduce((s, a) => s + a.pct, 0)
      const here = list.filter((r) => r.from! <= d && r.to! >= d).reduce((s, r) => s + r.pct!, 0)
      if (others + here > max) {
        over.push(d)
        peak = Math.max(peak, others + here)
      }
    }
    if (over.length) out.push({ user_id: u, index: resolved.indexOf(list[0]), days: over, peak })
  }
  return { max, over: out }
}
function checkOverAllocation(ctx: Ctx, projectId: string | null, resolved: ResolvedRow[]) {
  const { max, over } = overAllocation(ctx, projectId, resolved)
  for (const o of over) {
    const msg = `${userName(ctx, o.user_id)} would be over ${max}% on ${o.days.length} working day${o.days.length === 1 ? '' : 's'} (${fmtDate(o.days[0])}${o.days.length > 1 ? ` – ${fmtDate(o.days[o.days.length - 1])}` : ''}, peak ${o.peak}%).`
    if (ctx.tenant.settings['allocation.block_over']) err(409, 'ALLOC_OVER', msg + ' Lower the percentage or shorten the dates.', `resources.${o.index}.pct`)
    warn(ctx, 'ALLOC_OVER', msg)
  }
}

/* ================================================================== */
/* Validation used by create + save                                    */
/* ================================================================== */
export interface ValidCosting {
  resolved: ResolvedRow[]
  costing: Omit<E.ProjectCosting, 'saved_at' | 'saved_by'>
  priceInternal: number
  totalInternal: number
}
export function validateCosting(ctx: Ctx, projectId: string | null, range: Range, milestones: PlannedMilestone[], body: Record<string, unknown>): ValidCosting {
  validateAdditional(body.additional_costs)
  const cp = num(body.contingency_pct, NaN)
  if (body.contingency_pct !== undefined && body.contingency_pct !== null && (!Number.isFinite(cp) || cp < 0 || cp > 100)) err(422, 'VALIDATION', 'Contingency must be between 0% and 100%.', 'costing.contingency_pct')
  const mp = num(body.maintenance_paise, NaN)
  if (body.maintenance_paise !== undefined && body.maintenance_paise !== null && (!Number.isFinite(mp) || mp < 0)) err(422, 'MONEY_INVALID', 'Maintenance / support cost must be zero or more.', 'costing.maintenance_paise')
  if (body.price_mode === 'price' && body.price_paise !== null && body.price_paise !== undefined && num(body.price_paise, -1) < 0) err(422, 'MONEY_INVALID', 'The project price must be zero or more.', 'costing.price_paise')
  if (body.price_mode !== 'price' && body.markup_pct !== null && body.markup_pct !== undefined && (num(body.markup_pct, NaN) < -100 || !Number.isFinite(num(body.markup_pct, NaN)))) err(422, 'VALIDATION', 'Markup must be a number above −100%.', 'costing.markup_pct')
  const args = argsFromBody(body)
  const pv = computePreview(ctx, { ...args, range, milestones })
  const bad = pv._resolved.find((r) => r.error)
  if (bad) err(422, 'ALLOC_INVALID', bad.error!, bad.field ?? undefined)
  checkOverAllocation(ctx, projectId, pv._resolved)
  const total = pv._internal.total
  const price = pv._internal.price
  return {
    resolved: pv._resolved,
    priceInternal: price,
    totalInternal: total,
    costing: {
      additional_costs: args.additional.filter((x) => x.amount_paise > 0 || x.description),
      maintenance_paise: args.maintenance,
      contingency_pct: args.contingencyPct,
      markup_pct: total > 0 ? r2(((price - total) / total) * 100) : args.markupPct ?? 0,
      price_paise: price,
    },
  }
}

/* ================================================================== */
/* Analysis: planned / projected / actual                              */
/* ================================================================== */
const col = (revenue: number, cost: number): MarginColumn => ({ revenue, cost, profit: revenue - cost, margin: marginPct(revenue, cost), markup: markupPct(revenue, cost) })

export function approvedCrValue(ctx: Ctx, pid: string) {
  return rows(ctx, 'change_requests').filter((c) => c.project_id === pid && (c.status === 'approved' || c.status === 'done')).reduce((s, c) => s + c.value_paise, 0)
}
/** % complete = earned hours ÷ total estimated hours (earned = estimate × progress). */
export function pctComplete(tasks: E.Task[], p: E.Project) {
  const est = tasks.reduce((s, t) => s + t.est_hours, 0)
  if (!est) return p.status === 'completed' || p.status === 'closed' ? 1 : 0
  return tasks.reduce((s, t) => s + (t.est_hours * progressOf(t)) / 100, 0) / est
}
function projectForecastEnd(ctx: Ctx, p: E.Project) {
  const s = scheduleFor(ctx, p)
  return s?.forecast_finish ?? null
}

interface Internal extends CostingAnalysis {
  _perPersonPlanned: Map<string, number>
}
/** Week statuses whose hours count as approved (actual cost uses approved hours only). */
const APPROVED = new Set<E.WeekStatus>(['approved', 'locked'])

/**
 * Feature Guide §6 — three margins:
 *  Planned   = contract value (original, before CRs)      vs allocation cost (estimates × rate where a milestone has no allocation) + plan extras
 *  Projected = contract value incl. approved CRs           vs actual so far (all logged hours × rate) + what's left (remaining allocation, held on
 *              late milestones, or the remaining estimate when that is larger) + plan extras
 *  Actual    = invoiced amount                             vs approved hours only × cost per hour
 * Cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day), at the rate of the month worked.
 */
export function analyse(ctx: Ctx, p: E.Project): Internal {
  return cached(ctx, 'an:' + p.id, () => {
    const today = ctx.today
    const mh = minHours(ctx)
    const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const ms = liveMilestonesOf(ctx, p.id)
    const msById = new Map(ms.map((m) => [m.id, m]))
    const sched = scheduleFor(ctx, p)
    const msForecast = new Map((sched?.milestones ?? []).map((m) => [m.id, m.forecast_end]))
    const forecastEnd = sched?.forecast_finish ?? null
    const projEnd = forecastEnd ?? p.end_on
    const allocs = rows(ctx, 'allocations').filter((a) => a.project_id === p.id)
    const costing = p.costing ?? null
    const act = taskActuals(ctx)
    const crs = approvedCrValue(ctx, p.id)
    const contract = p.contract_value_paise
    const plannedRevenue = Math.max(0, contract - crs)
    const projectedRevenue = contract
    const pct = pctComplete(tasks, p)
    const basis: CostingAnalysis['basis'] = costing ? 'costing' : allocs.length ? 'allocations' : 'estimates'
    const alert = ctx.tenant.settings['projects.effort_ratio_alert'] ?? 1.2
    const add = (costing?.additional_costs ?? []).reduce((s, x) => s + x.amount_paise, 0)
    const maint = costing?.maintenance_paise ?? 0
    const contPct = costing?.contingency_pct ?? 0
    const closed = p.status === 'completed' || p.status === 'closed'
    const rateNow = (uid: string | null) => (uid ? currentRatePH(ctx, uid) : 0)
    const entries = costedEntries(ctx).filter((e) => e.kind === 'task' && e.task_id && taskById.has(e.task_id) && e.work_date <= today)
    const msOfTask = (tid: string) => taskById.get(tid)?.milestone_id ?? null

    // ---- milestone end dates (actual, forecast or deadline)
    const msEnd = new Map<string, { end: string | null; kind: 'actual' | 'forecast' | 'deadline'; done: boolean }>()
    for (const m of ms) {
      const mine = tasks.filter((t) => t.milestone_id === m.id)
      const allDone = mine.length > 0 && mine.every((t) => t.status === 'done')
      if (m.achieved_on) msEnd.set(m.id, { end: m.achieved_on, kind: 'actual', done: true })
      else if (allDone) msEnd.set(m.id, { end: mine.reduce((x, t) => maxISO(x, t.done_on ?? t.due_on), '0000-01-01'), kind: 'actual', done: true })
      else if (msForecast.get(m.id)) msEnd.set(m.id, { end: msForecast.get(m.id)!, kind: 'forecast', done: false })
      else msEnd.set(m.id, { end: null, kind: 'deadline', done: closed })
    }
    const slipOf = (m: E.Milestone) => {
      const e = msEnd.get(m.id)!
      return slipDays(ctx, m.planned_end, e.end ?? m.planned_end)
    }

    // ---- allocations: planned cost (full range), split at today, and what's left with the milestone's real end
    const tomorrow = addDays(today, 1)
    type Grp = { past: number; future: number; futureEff: number; plannedHours: number; alloc: boolean }
    const grp = new Map<string, Grp>()
    const g = (k: string) => grp.get(k) ?? grp.set(k, { past: 0, future: 0, futureEff: 0, plannedHours: 0, alloc: false }).get(k)!
    const person = new Map<string, { hours: number; hoursToDate: number; planned: number }>()
    let breach = 0, early = 0
    const allocRows: AllocationCostRow[] = []
    for (const a of allocs) {
      const m = a.milestone_id ? msById.get(a.milestone_id) ?? null : null
      const full = rangeCost(ctx, a.user_id, a.pct, a.from_on, a.to_on)
      const past = a.from_on <= today ? rangeCost(ctx, a.user_id, a.pct, a.from_on, minISO(a.to_on, today)) : { days: 0, hours: 0, cost: 0 }
      const future = full.cost - past.cost
      // A person allocated up to the deadline stays until the milestone really closes: a late forecast holds them (breach
      // cost); a milestone achieved early releases them. Rows that end before the deadline keep their own end.
      let effTo = a.to_on
      let done = false
      if (m) {
        const e = msEnd.get(m.id)!
        done = e.done
        if (e.kind === 'actual') effTo = minISO(a.to_on, e.end!)
        else effTo = a.to_on >= m.planned_end ? maxISO(e.end ?? m.planned_end, m.planned_end) : a.to_on
      } else {
        done = closed
        effTo = a.to_on >= p.end_on ? maxISO(projEnd, p.end_on) : a.to_on
      }
      const futureEff = done ? 0 : effTo >= tomorrow ? rangeCost(ctx, a.user_id, a.pct, maxISO(a.from_on, tomorrow), effTo).cost : 0
      if (futureEff > future) breach += futureEff - future
      else early += future - futureEff
      const k = a.milestone_id && m ? m.id : '_all'
      const x = g(k)
      x.past += past.cost
      x.future += future
      x.futureEff += futureEff
      x.plannedHours += full.hours
      x.alloc = true
      const pr = person.get(a.user_id) ?? { hours: 0, hoursToDate: 0, planned: 0 }
      pr.hours += full.hours
      pr.hoursToDate += past.hours
      pr.planned += full.cost
      person.set(a.user_id, pr)
      allocRows.push({
        id: a.id, version: a.version, user_id: a.user_id, milestone_id: a.milestone_id, ms_code: m ? `M${m.no}` : a.milestone_id ? '—' : 'All', ms_name: m ? m.name : a.milestone_id ? 'Removed milestone' : 'All milestones (old row)',
        pct: a.pct, from_on: a.from_on, to_on: a.to_on, working_days: full.days, hours: full.hours, cost: full.cost,
      })
    }
    allocRows.sort((x, y) => {
      const nx = x.milestone_id ? msById.get(x.milestone_id)?.no ?? 99 : 0
      const ny = y.milestone_id ? msById.get(y.milestone_id)?.no ?? 99 : 0
      return nx - ny || x.from_on.localeCompare(y.from_on) || userName(ctx, x.user_id).localeCompare(userName(ctx, y.user_id))
    })

    // ---- actual so far: every logged hour (approved or not) at its month's rate; actual: approved hours only
    const spent = new Map<string, number>()
    const spentHours = new Map<string, number>()
    let approvedHours = 0, approvedCost = 0, pendingHours = 0, pendingCost = 0, loggedHours = 0, loggedCost = 0
    const logged = new Map<string, { hours: number; approved: number }>()
    const loggedByMsUser = new Set<string>()
    for (const e of entries) {
      const k = msOfTask(e.task_id!) ?? '_none'
      spent.set(k, (spent.get(k) ?? 0) + e.cost)
      spentHours.set(k, (spentHours.get(k) ?? 0) + e.hours)
      loggedHours += e.hours
      loggedCost += e.cost
      const ok = APPROVED.has(e.week_status)
      if (ok) {
        approvedHours += e.hours
        approvedCost += e.cost
      } else {
        pendingHours += e.hours
        pendingCost += e.cost
      }
      const l = logged.get(e.user_id) ?? { hours: 0, approved: 0 }
      l.hours += e.hours
      if (ok) l.approved += e.hours
      logged.set(e.user_id, l)
      loggedByMsUser.add(`${k}:${e.user_id}`)
    }

    // ---- per milestone: planned vs forecast (= spent so far + what's left)
    const estLeftOf = (ts: E.Task[]) => ts.reduce((s, t) => s + (t.status === 'done' || closed ? 0 : Math.max(0, t.est_hours - (act.get(t.id)?.hours ?? 0)) * rateNow(t.owner_id)), 0)
    const estCostOf = (ts: E.Task[]) => ts.reduce((s, t) => s + t.est_hours * rateNow(t.owner_id), 0)
    let resPlan = 0, estimatePlan = 0, forecastTotal = 0
    let bLogged = 0, bLate = 0, bExtra = 0, bEst = 0
    const groups: { key: string; m: E.Milestone | null; tasks: E.Task[] }[] = [
      ...ms.map((m) => ({ key: m.id, m, tasks: tasks.filter((t) => t.milestone_id === m.id) })),
      { key: '_none', m: null, tasks: tasks.filter((t) => !t.milestone_id || !msById.has(t.milestone_id)) },
    ]
    const msPlan = new Map<string, number>()
    const msProj = new Map<string, number>()
    const msSpent = new Map<string, number>()
    const msLeft = new Map<string, number>()
    for (const gr of groups) {
      const x = grp.get(gr.key)
      const sp = spent.get(gr.key) ?? 0
      const done = gr.m ? msEnd.get(gr.m.id)!.done : gr.tasks.every((t) => t.status === 'done') || closed
      let plan: number, left: number
      if (x?.alloc) {
        plan = x.past + x.future
        const estLeft = done ? 0 : estLeftOf(gr.tasks)
        left = done ? 0 : Math.max(x.futureEff, estLeft)
        const lateMs = gr.m ? slipOf(gr.m) > 0 : false
        const d1 = x.past - sp // allocated to date vs logged to date
        if (lateMs && d1 < 0) bLate += d1
        else bLogged += d1
        bExtra += x.futureEff - left // ≤ 0: remaining work above the remaining allocation
        resPlan += plan
      } else {
        plan = estCostOf(gr.tasks)
        left = done ? 0 : estLeftOf(gr.tasks)
        bEst += plan - sp - left
        estimatePlan += plan
      }
      const fc = sp + left
      forecastTotal += fc
      msPlan.set(gr.key, Math.round(plan))
      msProj.set(gr.key, Math.round(fc))
      msSpent.set(gr.key, Math.round(sp))
      msLeft.set(gr.key, Math.round(left))
    }
    // legacy "All milestones" rows (older data): planned at full range, what's left follows the project's forecast end
    const all = grp.get('_all')
    if (all) {
      resPlan += all.past + all.future
      forecastTotal += all.past + all.futureEff
      // their past is treated as spent as allocated (their hours are already in the milestones they logged against)
    }
    resPlan = Math.round(resPlan)
    estimatePlan = Math.round(estimatePlan)
    const plannedPeople = resPlan + estimatePlan
    const cont = Math.round(((plannedPeople + add) * contPct) / 100)
    const contHeld = closed ? 0 : cont
    const plannedCost = plannedPeople + add + maint + cont
    const projectedCost = Math.round(forecastTotal) + add + maint + contHeld

    const planned = col(plannedRevenue, plannedCost)
    const projected = col(projectedRevenue, projectedCost)
    const invoices = rows(ctx, 'invoices').filter((i) => i.project_id === p.id && i.status !== 'draft' && i.status !== 'cancelled')
    const invoiced = invoices.reduce((s, i) => s + i.amount_paise, 0)
    const actual = col(invoiced, Math.round(approvedCost))

    // ---- what moved the margin (planned profit → projected profit; the lines add up exactly)
    const bridge: MarginBridgeLine[] = [{ key: 'planned', label: 'Planned profit', amount: planned.profit }]
    if (crs) bridge.push({ key: 'crs', label: 'Approved change requests', amount: crs })
    const lines: MarginBridgeLine[] = [
      { key: 'logged', label: bLogged >= 0 ? 'Hours logged below allocation to date' : 'Extra hours logged above allocation to date', amount: Math.round(bLogged) },
      { key: 'late_hours', label: 'Extra hours on late milestones', amount: Math.round(bLate) },
      { key: 'breach', label: 'Breach cost: people held on late milestones', amount: -Math.round(breach) },
      { key: 'early', label: 'Early finish saving: milestones ahead of deadline', amount: Math.round(early) },
      { key: 'extra', label: 'Extra hours: remaining work above the allocation', amount: Math.round(bExtra) },
      { key: 'estimates', label: 'Effort vs estimate on milestones without an allocation', amount: Math.round(bEst) },
    ]
    for (const l of lines) {
      l.amount = Math.abs(l.amount) < 100 ? 0 : l.amount // under a rupee is noise (and no −0); the rounding step below keeps the sum exact
      if (l.amount !== 0 || l.key === 'breach' || l.key === 'early') bridge.push(l)
    }
    if (cont !== contHeld) bridge.push({ key: 'contingency', label: 'Contingency released at close', amount: cont - contHeld })
    // rounding: make the bridge add up to the projected profit to the rupee
    const sum = bridge.reduce((s, b) => s + b.amount, 0)
    const diff = projected.profit - sum
    if (diff !== 0) {
      const tgt = bridge.find((b) => b.key === 'logged') ?? bridge.find((b) => b.key === 'early')!
      tgt.amount += diff
    }
    bridge.push({ key: 'projected', label: 'Projected profit', amount: projected.profit })

    // ---- effort ratio = actual hours ÷ estimated hours (per task, milestone, project)
    // Task: hours logged so far ÷ its estimate (final once the task is finished). Milestone and project: on their
    // finished tasks, where the ratio is final; none finished yet → no ratio.
    const actH = (t: E.Task) => act.get(t.id)?.hours ?? 0
    const ratioOf = (ts: E.Task[]) => {
      const set = ts.filter((t) => t.status === 'done' && t.est_hours > 0 && actH(t) > 0)
      const e = set.reduce((s, t) => s + t.est_hours, 0)
      const a = set.reduce((s, t) => s + actH(t), 0)
      return e > 0 && a > 0 ? a / e : null
    }
    const milestones: MilestoneVarianceRow[] = ms.map((m) => {
      const e = msEnd.get(m.id)!
      const mine = tasks.filter((t) => t.milestone_id === m.id)
      const plan = msPlan.get(m.id) ?? 0
      const proj = msProj.get(m.id) ?? 0
      return {
        id: m.id,
        code: `M${m.no}`,
        name: m.name,
        done: e.done,
        deadline: m.planned_end,
        end: e.end ?? m.planned_end,
        end_kind: e.end ? e.kind : 'deadline',
        slip_days: slipOf(m),
        planned_cost: plan,
        projected_cost: proj,
        change: proj - plan,
        est_hours: mine.reduce((s, t) => s + t.est_hours, 0),
        actual_hours: r2(mine.reduce((s, t) => s + actH(t), 0)),
        effort_ratio: ratioOf(mine),
        planned_hours: r1(grp.get(m.id)?.plannedHours ?? 0),
        logged_hours: r2(spentHours.get(m.id) ?? 0),
        allocated: !!grp.get(m.id)?.alloc,
        spent_to_date: msSpent.get(m.id) ?? 0,
        left: msLeft.get(m.id) ?? 0,
      }
    })

    // ---- resources: allocated vs logged, in hours
    const resIds = new Set([...person.keys(), ...logged.keys()])
    const resources: ResourceUseRow[] = [...resIds].map((uid) => {
      const pr = person.get(uid)
      const lg = logged.get(uid)
      const lh = lg?.hours ?? 0
      return {
        user_id: uid,
        allocated_man_days: r1((pr?.hours ?? 0) / mh),
        allocated_to_date: r1((pr?.hoursToDate ?? 0) / mh),
        logged_hours: r2(lh),
        logged_days: r1(lh / mh),
        used: pr && pr.hoursToDate > 0 ? lh / pr.hoursToDate : null,
        unplanned: !pr && lh > 0,
        planned_cost: pr ? Math.round(pr.planned) : 0,
        allocated_hours: r1(pr?.hours ?? 0),
        allocated_hours_to_date: r1(pr?.hoursToDate ?? 0),
        logged_hours_to_date: r2(lh),
        approved_hours: r2(lg?.approved ?? 0),
      }
    })
    resources.sort((a, b) => Number(a.unplanned) - Number(b.unplanned) || (b.allocated_hours ?? 0) - (a.allocated_hours ?? 0) || userName(ctx, a.user_id).localeCompare(userName(ctx, b.user_id)))

    // ---- effort ratio per task (every task with an estimate and logged hours)
    const effTasks: EffortTaskRow[] = tasks
      .filter((t) => t.est_hours > 0 && actH(t) > 0)
      .map((t) => {
        const m = t.milestone_id ? msById.get(t.milestone_id) : null
        const ah = actH(t)
        return {
          id: t.id, wbs: wbsCode(t, msMapAll(ctx)), title: t.title, owner_id: t.owner_id, est_hours: t.est_hours, actual_hours: r2(ah), earned_hours: r2((t.est_hours * progressOf(t)) / 100),
          ratio: ah / t.est_hours, milestone_code: m ? `M${m.no}` : null, done: t.status === 'done', progress: progressOf(t),
        }
      })
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || a.wbs.localeCompare(b.wbs, undefined, { numeric: true }))
    const flagged = effTasks.filter((t) => (t.ratio ?? 0) > alert)

    const typeLabel = PROJECT_TYPE[p.type]
    const modelLabel = BILLING_MODEL[p.billing_model]
    const description = `${modelLabel} ${typeLabel} project. Planned is the contract value against the allocation plan${estimatePlan ? ' (task estimates where a milestone has no allocation)' : ''}${costing ? ' and the saved costing extras' : ''}; projected is the contract incl. approved CRs against cost so far plus what’s left; actual is the invoiced amount against approved hours only.`

    // ---- cost per hour (guide formula) with this month's numbers
    const ym = monthOf(today)
    const wdm = wdMonth(ctx, ym)
    const team = [...new Set([...allocs.map((a) => a.user_id), ...logged.keys()])]
    const rate: CostPerHourInfo = {
      min_hours: mh,
      month: ym,
      working_days: wdm,
      example: { ctc: 6_000_000, working_days: 22, min_hours: 9, per_hour: Math.round(costPerHour(6_000_000, 22, 9)) },
      people: team
        .map((uid) => {
          const r = rateFor(ctx, uid, today)
          return r ? { user_id: uid, monthly_ctc: r.monthly_ctc_paise, cost_per_hour: Math.round(costPerHour(r.monthly_ctc_paise, wdm, mh)) } : null
        })
        .filter(Boolean) as CostPerHourInfo['people'],
    }

    return {
      basis,
      description,
      pct_complete: pct,
      approved_crs: crs,
      planned,
      projected,
      actual,
      bridge,
      contingency_held: contHeld,
      profit_if_released: projected.profit + contHeld,
      forecast_end: forecastEnd,
      milestones,
      resources,
      effort: {
        alert, project: ratioOf(tasks), flagged: flagged.length, tasks: effTasks,
        est_hours: tasks.reduce((s, t) => s + t.est_hours, 0), actual_hours: r2(tasks.reduce((s, t) => s + actH(t), 0)),
      },
      floor_pct: ctx.tenant.settings['projects.margin_floor_pct'],
      planned_basis: { allocation_cost: resPlan, estimate_cost: estimatePlan, additional: add, maintenance: maint, contingency: cont },
      projected_basis: { cost_so_far: Math.round(loggedCost), hours_so_far: r2(loggedHours), whats_left: projectedCost - Math.round(loggedCost) - add - maint - contHeld },
      actual_basis: {
        invoiced, invoices: invoices.length, contract, approved_hours: r2(approvedHours), approved_cost: Math.round(approvedCost), pending_hours: r2(pendingHours), pending_cost: Math.round(pendingCost),
        earned_value: Math.round(projectedRevenue * pct),
        next_billing: (() => {
          const m = ms.filter((x) => x.billing_status === 'none' && x.billing_amount_paise > 0).sort((x, y) => x.planned_end.localeCompare(y.planned_end))[0]
          return m ? { code: `M${m.no}`, name: m.name, amount: m.billing_amount_paise, due: m.planned_end } : null
        })(),
        additional_excluded: add + maint,
      },
      allocations: allocRows,
      rate,
      _perPersonPlanned: new Map([...person].map(([k, v]) => [k, v.planned])),
    }
  })
}
/** Per-person money is salary-derived: only for cost_rates.view. */
export function publicAnalysis(ctx: Ctx, a: Internal): CostingAnalysis {
  const { _perPersonPlanned, ...rest } = a
  void _perPersonPlanned
  if (canSeeSalaries(ctx)) return rest
  return {
    ...rest,
    resources: rest.resources.map((r) => ({ ...r, planned_cost: null })),
    allocations: (rest.allocations ?? []).map((x) => ({ ...x, cost: null })),
    rate: rest.rate ? { ...rest.rate, people: [] } : rest.rate,
  }
}

/* ---------------- metrics override: list / dashboard margins agree with the Costing & margin tab ---------------- */
const inOverride = new Set<string>()
setProjectMetricsOverride((ctx, p, base) => {
  if (inOverride.has(p.id)) return null
  inOverride.add(p.id)
  try {
    const a = analyse(ctx, p)
    const contract = p.contract_value_paise
    const projected_margin = contract ? a.projected.margin : null
    const er = a.effort.project
    const health = p.status === 'completed' || p.status === 'closed'
      ? 'on_track'
      : projectHealth({ projectedMargin: projected_margin, effortRatio: er, floor: ctx.tenant.settings['projects.margin_floor_pct'] / 100, alert: ctx.tenant.settings['projects.effort_ratio_alert'], overdueMilestones: base.overdue_milestones })
    const adj = health === 'on_track' && base.spi !== null && base.spi < 0.8 && p.status === 'active' ? 'at_risk' : health
    const out: Partial<ProjectMetrics> = {
      planned_cost: a.planned.cost,
      projected_cost: a.projected.cost,
      actual_cost: a.actual.cost,
      planned_margin: contract ? a.planned.margin : null,
      projected_margin,
      actual_margin: a.actual.margin,
      planned_markup: a.planned.markup,
      projected_markup: a.projected.markup,
      actual_markup: a.actual.markup,
      approved_hours: a.actual_basis?.approved_hours ?? base.approved_hours,
      effort_ratio: er,
      health: adj,
    }
    return out
  } finally {
    inOverride.delete(p.id)
  }
})

/* ================================================================== */
/* List row extras, expand summary, portfolio                          */
/* ================================================================== */
export function projectRowInfo(ctx: Ctx, p: E.Project): ProjectRowInfo {
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  const fEnd = projectForecastEnd(ctx, p)
  const seeContract = hasAny(ctx, 'finance.view', 'margins.view', 'projects.edit')
  return {
    pct_complete: pctComplete(tasks, p),
    tasks_total: tasks.length,
    tasks_done: tasks.filter((t) => t.status === 'done').length,
    forecast_end: fEnd,
    slip_days: fEnd ? slipDays(ctx, p.end_on, fEnd) : null,
    contract_incl_crs: seeContract ? p.contract_value_paise : null,
    projected_margin: canSeeMargins(ctx) && p.contract_value_paise ? analyse(ctx, p).projected.margin : null,
  }
}

export function projectSummary(ctx: Ctx, p: E.Project): ProjectSummary {
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  const ms = liveMilestonesOf(ctx, p.id)
  const msById = new Map(ms.map((m) => [m.id, m]))
  const sched = scheduleFor(ctx, p)
  const fc = new Map((sched?.milestones ?? []).map((m) => [m.id, m]))
  const seeMoney = hasAny(ctx, 'finance.view', 'margins.view', 'projects.edit')
  const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => a.due_on.localeCompare(b.due_on))
  const wbs = (t: E.Task) => wbsCode(t, msById)
  const risks = (sched?.tasks ?? []).filter((t) => t.breach && (t.critical || t.breach.kind === 'overdue' || t.breach.kind === 'blocked')).sort((a, b) => Number(b.critical) - Number(a.critical)).slice(0, 5)
  return {
    project_id: p.id,
    pm_id: p.pm_id,
    start_on: p.start_on,
    end_on: p.end_on,
    forecast_end: sched?.forecast_finish ?? null,
    milestones: ms.map((m) => {
      const s = fc.get(m.id)
      const end = m.achieved_on ?? s?.forecast_end ?? null
      return {
        id: m.id, code: `M${m.no}`, name: m.name, deadline: m.planned_end, end, end_kind: m.achieved_on ? 'actual' : s?.forecast_end ? 'forecast' : 'deadline',
        state: s?.state ?? milestoneState(ctx, m, tasks).state, billing_amount_paise: seeMoney ? m.billing_amount_paise : null, billing_status: m.billing_status,
      }
    }),
    open_tasks: open.slice(0, 5).map((t) => ({ id: t.id, wbs: wbs(t), title: t.title, owner_id: t.owner_id, due_on: t.due_on, overdue: t.due_on < ctx.today })),
    open_count: open.length,
    risks: risks.map((t) => ({ id: t.id, wbs: t.wbs, title: t.title, message: t.breach!.message, critical: t.critical })),
    team_ids: [...new Set([...tasks.map((t) => t.owner_id), ...rows(ctx, 'allocations').filter((a) => a.project_id === p.id).map((a) => a.user_id)].filter(Boolean) as string[])],
  }
}

export function portfolio(ctx: Ctx, visible: E.Project[], scope: PortfolioMargins['scope']): PortfolioMargins {
  const inScope = visible.filter((p) => !p.id.startsWith('p_general') && p.code !== 'GEN' && (scope === 'all' || (scope === 'active' ? p.status === 'active' : !['completed', 'closed'].includes(p.status))))
  const list: PortfolioMarginRow[] = inScope.map((p) => {
    const a = analyse(ctx, p)
    return {
      project_id: p.id, code: p.code, name: p.name, client: p.client, status: p.status, type: p.type, billing_model: p.billing_model, pct_complete: a.pct_complete,
      contract: p.contract_value_paise, planned_cost: a.planned.cost, planned_margin: a.planned.margin, projected_margin: a.projected.margin,
      margin_delta_pts: a.projected.margin !== null && a.planned.margin !== null ? r1((a.projected.margin - a.planned.margin) * 100) : null,
      actual_margin: a.actual.margin, projected_profit: a.projected.profit, cost_to_date: a.actual.cost, projected_cost: a.projected.cost, earned: a.actual_basis?.earned_value ?? 0, basis: a.basis,
      invoiced: a.actual.revenue, effort_ratio: a.effort.project,
    }
  })
  list.sort((x, y) => y.contract - x.contract || x.name.localeCompare(y.name))
  const paid = list.filter((r) => r.contract > 0)
  const contract = paid.reduce((s, r) => s + r.contract, 0)
  const profit = paid.reduce((s, r) => s + r.projected_profit, 0)
  const earned = paid.reduce((s, r) => s + r.earned, 0)
  const invoiced = paid.reduce((s, r) => s + (r.invoiced ?? 0), 0)
  const ctd = paid.reduce((s, r) => s + r.cost_to_date, 0)
  const pcost = paid.reduce((s, r) => s + r.projected_cost, 0)
  const plannedCost = paid.reduce((s, r) => s + r.planned_cost, 0)
  const plannedRev = paid.reduce((s, r) => s + (r.planned_margin !== null ? r.planned_cost / (1 - r.planned_margin) : 0), 0)
  // milestone cash (G2.07)
  const ids = new Set(inScope.map((p) => p.id))
  const ms = rows(ctx, 'milestones').filter((m) => ids.has(m.project_id) && !m.deleted_at)
  const tasks = rows(ctx, 'tasks').filter((t) => ids.has(t.project_id))
  const achievedNotInvoiced = ms.filter((m) => m.billing_status === 'none' && milestoneState(ctx, m, tasks).state.startsWith('achieved')).reduce((s, m) => s + m.billing_amount_paise, 0)
  const awaiting = rows(ctx, 'invoices').filter((i) => ids.has(i.project_id)).reduce((s, i) => s + Math.max(0, i.amount_paise - i.paid_amount_paise), 0)
  const next30 = ms.filter((m) => m.billing_status === 'none' && !m.achieved_on && m.planned_end >= ctx.today && m.planned_end <= addDays(ctx.today, 30)).reduce((s, m) => s + m.billing_amount_paise, 0)
  return {
    scope,
    floor_pct: ctx.tenant.settings['projects.margin_floor_pct'],
    kpis: {
      contract_value: contract, projects: paid.length, projected_profit: profit, projected_margin: contract ? profit / contract : null,
      // actual = invoiced amount against approved hours only (same as each project's Actual column)
      actual_margin: invoiced ? (invoiced - ctd) / invoiced : null, earned_to_date: earned, cost_to_date: ctd,
      planned_margin: plannedRev > 0 ? (plannedRev - plannedCost) / plannedRev : null, invoiced, projected_cost: pcost,
    },
    cash: { achieved_not_invoiced: achievedNotInvoiced, invoiced_awaiting_payment: awaiting, billable_next_30: next30 },
    rows: list,
  }
}

export function costRateDays(ctx: Ctx): CostRateDay {
  const fsm = ctx.tenant.settings['company.fy_start_month'] || 4
  const y = fyStartYear(ctx.today, fsm)
  const r = fyRange(y, fsm)
  const fyWd = wd(ctx, r.from, r.to)
  const mh = minHours(ctx)
  const ym = monthOf(ctx.today)
  const wdm = wdMonth(ctx, ym)
  return {
    loading_pct: 0,
    fy_label: fyLabel(y),
    fy_working_days: fyWd,
    avg_working_days_per_month: r2(fyWd / 12),
    people: rows(ctx, 'users')
      .filter((u) => !u.is_super_admin)
      .map((u) => {
        const rate = rateOn(rows(ctx, 'cost_rates'), u.id, ctx.today)
        const ph = rate ? costPerHour(rate.monthly_ctc_paise, wdm, mh) : null
        return { user_id: u.id, monthly_ctc_paise: rate?.monthly_ctc_paise ?? null, cost_per_day_paise: ph === null ? null : Math.round(ph * mh), cost_per_hour_paise: ph === null ? null : Math.round(ph) }
      }),
    min_hours: mh,
    month: ym,
    month_working_days: wdm,
  }
}

/* ================================================================== */
/* Saving                                                              */
/* ================================================================== */
/** Insert allocations for a new project (create form). Milestone ids come from the created milestones. */
export function insertPlanAllocations(ctx: Ctx, projectId: string, v: ValidCosting, msIds: string[]) {
  for (const r of v.resolved) {
    const msId = typeof r.input.milestone_index === 'number' ? msIds[r.input.milestone_index] ?? null : null
    insert(ctx, 'allocations', { project_id: projectId, milestone_id: msId, user_id: r.input.user_id!, pct: r.pct!, from_on: r.from!, to_on: r.to! })
  }
}
/** Replace a project's allocations with the editor rows, keeping ids where rows came from an allocation. */
function replaceAllocations(ctx: Ctx, p: E.Project, v: ValidCosting) {
  const current = rows(ctx, 'allocations').filter((a) => a.project_id === p.id)
  const keep = new Set<string>()
  let added = 0, changed = 0
  for (const r of v.resolved) {
    const data = { project_id: p.id, milestone_id: r.milestone?.id ?? null, user_id: r.input.user_id!, pct: r.pct!, from_on: r.from!, to_on: r.to! }
    const existing = r.input.id ? current.find((a) => a.id === r.input.id) : null
    if (existing) {
      keep.add(existing.id)
      if (existing.milestone_id !== data.milestone_id || existing.user_id !== data.user_id || existing.pct !== data.pct || existing.from_on !== data.from_on || existing.to_on !== data.to_on) {
        update(ctx, 'allocations', existing.id, data)
        changed++
      }
    } else {
      insert(ctx, 'allocations', data)
      added++
    }
  }
  const removed = current.filter((a) => !keep.has(a.id))
  for (const a of removed) remove(ctx, 'allocations', a.id)
  return { added, changed, removed: removed.length }
}

/* ================================================================== */
/* Routes (registered from routes/projects.ts before /projects/:id)    */
/* ================================================================== */
export interface CostingDeps {
  canView: (ctx: Ctx, p: E.Project) => boolean
  canEdit: (ctx: Ctx, p: E.Project) => boolean
}
export function canPlanCost(ctx: Ctx) {
  return hasAny(ctx, 'margins.view', 'cost_rates.view')
}
export function registerCostingRoutes(r: Router, deps: CostingDeps) {
  const getProject = (ctx: Ctx, id: string) => {
    const p = find(ctx, 'projects', id, 'Project')
    if (!deps.canView(ctx, p)) err(403, 'FORBIDDEN', 'You don’t have access to this project.')
    return p
  }

  r.get('/projects/next-code', ({ ctx }) => {
    if (!has(ctx, 'projects.create')) err(403, 'FORBIDDEN', 'Only admins and project managers can create projects.')
    const prefix = ctx.tenant.settings['projects.code_prefix'] || 'PRJ'
    const seq = getDb().number_sequences.find((x) => x.tenant_id === ctx.tenant.id && x.scope === 'project')
    const taken = new Set(rows(ctx, 'projects').map((p) => p.code))
    let n = seq?.next_value ?? 1
    while (taken.has(`${prefix}-${String(n).padStart(3, '0')}`)) n++
    return { code: `${prefix}-${String(n).padStart(3, '0')}` }
  })

  r.get('/projects/calendar-summary', ({ ctx, query }) => {
    const s = calendarSummary(ctx, String(query.from ?? ''), String(query.to ?? ''))
    if (!s) err(422, 'DATE_RANGE', 'Pick a start date and an end date on or after it.', 'to')
    return s
  })

  /** Live cost calculator for the create form and the project's planned costing editor. */
  r.post('/projects/costing/preview', ({ ctx, body }) => {
    if (!hasAny(ctx, 'projects.create', 'projects.edit', 'projects.manage_all')) err(403, 'FORBIDDEN', 'Only project editors can use the cost calculator.')
    const b = (body ?? {}) as Record<string, unknown>
    let range: Range
    let milestones: PlannedMilestone[]
    if (typeof b.project_id === 'string' && b.project_id) {
      const p = getProject(ctx, b.project_id)
      range = { start: p.start_on, end: p.end_on }
      milestones = plannedMilestonesOf(ctx, p)
    } else {
      range = { start: String(b.start_on ?? ''), end: String(b.end_on ?? '') }
      const list = Array.isArray(b.milestones) ? (b.milestones as { name?: string; billing_amount_paise?: number }[]).filter((m) => String(m?.name ?? '').trim()).map((m) => ({ name: String(m.name).trim(), billing_amount_paise: Math.max(0, Math.round(num(m.billing_amount_paise))) })) : []
      milestones = spreadMilestones(ctx, range.start, range.end, list)
    }
    const pv = computePreview(ctx, { ...argsFromBody(b), range, milestones })
    if (pv.can_see_money) {
      const { over, max } = overAllocation(ctx, typeof b.project_id === 'string' ? b.project_id : null, pv._resolved)
      for (const o of over) pv.warnings.push(`${userName(ctx, o.user_id)} would be over ${max}% on ${o.days.length} working day${o.days.length === 1 ? '' : 's'} (peak ${o.peak}%).`)
    }
    return publicPreview(pv)
  })

  r.get('/projects/:id/costing', ({ ctx, params }) => {
    const p = getProject(ctx, params.id)
    if (!canPlanCost(ctx)) err(403, 'FORBIDDEN', 'Costing is visible to people with the margins or salaries permission.')
    return { can_edit: deps.canEdit(ctx, p), preview: publicPreview(savedPlan(ctx, p)) }
  })

  r.put('/projects/:id/costing', ({ ctx, params, body }) => {
    const p = getProject(ctx, params.id)
    if (!deps.canEdit(ctx, p)) err(403, 'FORBIDDEN', 'Only the project manager of this project (or an admin) can change its costing.')
    if (!canPlanCost(ctx)) err(403, 'FORBIDDEN', 'Costing needs the margins or salaries permission.')
    const b = (body ?? {}) as Record<string, unknown>
    const v = validateCosting(ctx, p.id, { start: p.start_on, end: p.end_on }, plannedMilestonesOf(ctx, p), b)
    const res = replaceAllocations(ctx, p, v)
    const costing: E.ProjectCosting = { ...v.costing, saved_at: nowISO(), saved_by: ctx.user.id }
    const out = update(ctx, 'projects', p.id, { costing })
    const floor = ctx.tenant.settings['projects.margin_floor_pct']
    const m = v.totalInternal > 0 ? marginPct(v.priceInternal, v.totalInternal) : null
    if (m !== null && m < floor / 100) warn(ctx, 'MARGIN_BELOW_FLOOR', `Planned margin is ${(m * 100).toFixed(1)}%, below the ${floor}% floor.`)
    if (out.contract_value_paise && Math.abs(out.contract_value_paise - approvedCrValue(ctx, p.id) - v.priceInternal) > 100)
      warn(ctx, 'PRICE_NOT_CONTRACT', `The planned price ${fmtMoney(v.priceInternal)} differs from the contract (${fmtMoney(out.contract_value_paise)}). Revenue uses the contract value.`)
    logActivity(ctx, 'project', p.id, 'costing.saved', `Saved planned costing: ${v.resolved.length} resource row${v.resolved.length === 1 ? '' : 's'} (${res.added} added, ${res.changed} changed, ${res.removed} removed), price ${fmtMoney(v.priceInternal)}`)
    memo.delete(ctx)
    return publicPreview(savedPlan(ctx, out))
  })

  r.get('/projects/:id/summary', ({ ctx, params }) => projectSummary(ctx, getProject(ctx, params.id)))

  r.get('/finance/margins', ({ ctx, query }) => {
    if (!has(ctx, 'margins.view')) err(403, 'FORBIDDEN', 'Profit margins are visible to the CEO and people with the margins permission.')
    const scope = (['active', 'open', 'all'] as const).includes(query.scope as 'active') ? (query.scope as PortfolioMargins['scope']) : 'active'
    return portfolio(ctx, rows(ctx, 'projects').filter((p) => deps.canView(ctx, p)), scope)
  })

  r.get('/costing/rates', ({ ctx }) => {
    if (!has(ctx, 'cost_rates.view')) err(403, 'FORBIDDEN', 'Cost per day is visible to people with the salaries permission.')
    return costRateDays(ctx)
  })
}

/* ================================================================== */
/* Documents uploaded with the create form (G3.09)                     */
/* Stored in the documents module's tables (documents → versions → files) */
/* ================================================================== */
const CREATE_DOC_MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
}
export const CREATE_DOC_MAX_BYTES = 20 * 1024 * 1024
export interface CreateDoc {
  name: string
  mime: string
  size_bytes: number
  data_url: string
}
export function validateCreateDocuments(list: unknown): CreateDoc[] {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) err(422, 'VALIDATION', 'Documents must be a list of files.', 'documents')
  if (list.length > 20) err(422, 'FILE_REJECTED', 'Attach up to 20 documents at a time.', 'documents')
  return list.map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>
    const name = String(o.name ?? '').trim().slice(0, 160)
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    if (!CREATE_DOC_MIME[ext]) err(422, 'FILE_REJECTED', `${name || `File ${i + 1}`}: use PDF, images (PNG, JPG, GIF, WebP, SVG), text (TXT, MD) or CSV.`, `documents.${i}`)
    const size = Number(o.size_bytes ?? 0)
    if (!(size > 0)) err(422, 'FILE_REJECTED', `${name} is empty. Choose another file.`, `documents.${i}`)
    if (size > CREATE_DOC_MAX_BYTES) err(422, 'FILE_REJECTED', `${name} is larger than 20 MB. Compress it or upload it later as a link.`, `documents.${i}`)
    if (typeof o.data_url !== 'string' || !o.data_url.startsWith('data:')) err(422, 'FILE_REJECTED', `${name} could not be read. Choose it again.`, `documents.${i}`)
    return { name, mime: CREATE_DOC_MIME[ext], size_bytes: size, data_url: o.data_url as string }
  })
}
export function insertProjectDocuments(ctx: Ctx, projectId: string, docs: CreateDoc[]) {
  for (const f of docs) {
    const ext = f.name.split('.').pop()!.toLowerCase()
    const category = ext === 'csv' ? 'technical' : ext === 'pdf' ? 'contract' : 'other'
    const title = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || f.name
    const d = insert(ctx, 'documents', { project_id: projectId, title, description: 'Uploaded when the project was created.', category, visibility: 'project', must_read: false, tags: ['kick-off'], owner_id: ctx.user.id, current_version: 1, archived: false } as never) as { id: string; title: string }
    const ver = insert(ctx, 'document_versions', { document_id: d.id, version: 1, file_id: null, url: null, file_name: f.name, size_bytes: f.size_bytes, mime: f.mime, note: 'First version', uploaded_by: ctx.user.id, uploaded_at: nowISO() } as never) as { id: string; file_id: string | null }
    const fr = insert(ctx, 'files', { name: f.name, mime: f.mime, size_bytes: f.size_bytes, entity: 'document_version', entity_id: ver.id, data_url: f.data_url } as never)
    ver.file_id = fr.id
    logActivity(ctx, 'document', d.id, 'created', `Uploaded “${d.title}” (v1) with the new project`)
  }
}
const msMapAll = (ctx: Ctx) => new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
