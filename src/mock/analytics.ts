import { dealValue } from '@/domain/sales'
// Server-side analytics shared by mock route modules (projects, dashboards, insights, reports).
// This mirrors the backend "calculation module" (WBS 7.3): every money figure is computed here,
// screens only format what the API returns.
import type * as E from '@/types/entities'
import type { Schedule, ScheduleTask } from '@/api/projects'
import { rows, calendarFor, logActivity, notify, nowISO, persist, removeWhere, userName, type Ctx } from './server'
import { addDays, diffDays, fmtDate, isWorkingDay, maxISO, minISO, monthOf, workingDaysBetween, workingDaysInMonth, type CalendarCtx } from '@/domain/calendar'
import { costPerHour, effortRatio, marginPct, markupPct, projectHealth, rateOn, type Health } from '@/domain/costing'
import { DEAL_STAGE } from '@/domain/labels'
import { progressOf, stageOf } from '@/domain/delivery'

/* ---------------- memo per request ---------------- */
const memo = new WeakMap<Ctx, Map<string, unknown>>()
function cached<T>(ctx: Ctx, key: string, f: () => T): T {
  let m = memo.get(ctx)
  if (!m) memo.set(ctx, (m = new Map()))
  if (!m.has(key)) m.set(key, f())
  return m.get(key) as T
}

export function cal(ctx: Ctx): CalendarCtx {
  return cached(ctx, 'cal', () => calendarFor(ctx))
}

export function weekStatusMap(ctx: Ctx) {
  return cached(ctx, 'weeks', () => new Map(rows(ctx, 'timesheet_weeks').map((w) => [w.id, w])))
}

/** Entries with their week status, cost per hour and cost (paise). */
export interface CostedEntry extends E.TimesheetEntry {
  week_status: E.WeekStatus
  approved: boolean
  rate_ph: number
  cost: number
}
export function costedEntries(ctx: Ctx): CostedEntry[] {
  return cached(ctx, 'costed', () => {
    const weeks = weekStatusMap(ctx)
    const rates = rows(ctx, 'cost_rates')
    const c = cal(ctx)
    const wdm = new Map<string, number>()
    const minH = ctx.tenant.settings['calendar.min_hours_per_day']
    return rows(ctx, 'timesheet_entries').map((e) => {
      const w = weeks.get(e.week_id)
      const r = rateOn(rates, e.user_id, e.work_date)
      const ym = monthOf(e.work_date)
      if (!wdm.has(ym)) wdm.set(ym, workingDaysInMonth(ym, c))
      const rph = r ? costPerHour(r.monthly_ctc_paise, wdm.get(ym)!, minH) : 0
      return { ...e, week_status: w?.status ?? 'open', approved: w?.status === 'approved', rate_ph: rph, cost: e.kind === 'leave' ? 0 : rph * e.hours }
    })
  })
}

export function taskActuals(ctx: Ctx) {
  return cached(ctx, 'taskActuals', () => {
    const m = new Map<string, { hours: number; approved: number; cost: number; approvedCost: number }>()
    for (const e of costedEntries(ctx)) {
      if (e.kind !== 'task' || !e.task_id) continue
      const cur = m.get(e.task_id) ?? { hours: 0, approved: 0, cost: 0, approvedCost: 0 }
      cur.hours += e.hours
      cur.cost += e.cost
      if (e.approved) {
        cur.approved += e.hours
        cur.approvedCost += e.cost
      }
      m.set(e.task_id, cur)
    }
    return m
  })
}

/** Current cost/hour for a person (for estimates). */
export function currentRatePH(ctx: Ctx, userId: string | null): number {
  if (!userId) return 0
  const r = rateOn(rows(ctx, 'cost_rates'), userId, ctx.today)
  if (!r) return 0
  return costPerHour(r.monthly_ctc_paise, workingDaysInMonth(monthOf(ctx.today), cal(ctx)), ctx.tenant.settings['calendar.min_hours_per_day'])
}

/* ---------------- dependencies & blocking ---------------- */
export function depsOf(ctx: Ctx, taskId: string) {
  const all = rows(ctx, 'task_dependencies')
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  return all.filter((d) => d.task_id === taskId).map((d) => tasks.get(d.depends_on_task_id)).filter(Boolean) as E.Task[]
}
export function openBlockers(ctx: Ctx, taskId: string) {
  return depsOf(ctx, taskId).filter((t) => t.status !== 'done')
}

/* ---------------- milestones ---------------- */
export type MilestoneDelivery = 'achieved_on_time' | 'achieved_late' | 'on_track' | 'at_risk' | 'overdue' | 'not_started'
/** Earned hours of a task = estimate × progress % (Feature Guide KPI "% complete"). */
export const earnedHours = (t: E.Task) => (t.est_hours * progressOf(t)) / 100
/** Signed working days from `from` to `to` (positive when `to` is later). Baseline variance / slip. */
export function wdVariance(ctx: Ctx, from: string, to: string) {
  if (from === to) return 0
  const c = { ...cal(ctx), leaveDates: undefined }
  return to > from ? workingDaysBetween(addDays(from, 1), to, c) : -workingDaysBetween(addDays(to, 1), from, c)
}
/**
 * Milestone delivery state. The deadline is the milestone's planned_end, which always equals the target end
 * of its last task (kept in sync by syncMilestoneDates). Achieved on time / late compares the achieved date
 * with the deadline; an open milestone is at risk when its forecast end passes the deadline.
 * `forecastEnd` defaults to the project schedule's forecast for the milestone.
 */
export function milestoneState(ctx: Ctx, ms: E.Milestone, tasks: E.Task[], forecastEnd?: string | null) {
  const mine = tasks.filter((t) => t.milestone_id === ms.id)
  const open = mine.filter((t) => t.status !== 'done')
  const est = mine.reduce((s, t) => s + t.est_hours, 0)
  const doneEst = mine.filter((t) => t.status === 'done').reduce((s, t) => s + t.est_hours, 0)
  const earned = mine.reduce((s, t) => s + earnedHours(t), 0)
  const progress = est ? earned / est : mine.length ? mine.filter((t) => t.status === 'done').length / mine.length : ms.achieved_on ? 1 : 0
  const slip = wdVariance(ctx, ms.baseline_end, ms.planned_end)
  const forecast = forecastEnd !== undefined ? forecastEnd : !ms.achieved_on && open.length ? scheduleOf(ctx, ms.project_id).msForecast.get(ms.id) ?? null : null
  let state: MilestoneDelivery
  if (ms.achieved_on) state = ms.achieved_on <= ms.planned_end ? 'achieved_on_time' : 'achieved_late'
  else if (!open.length && mine.length) {
    const end = mine.reduce((mx, t) => maxISO(mx, t.done_on ?? t.due_on), '0000-01-01')
    state = end <= ms.planned_end ? 'achieved_on_time' : 'achieved_late'
  } else if (ms.planned_end < ctx.today) state = 'overdue'
  else if (forecast && forecast > ms.planned_end) state = 'at_risk'
  else if (ms.planned_start > ctx.today && !mine.some((t) => progressOf(t) > 0)) state = 'not_started'
  else state = 'on_track'
  return { state, slip, progress, taskCount: mine.length, openCount: open.length, est, doneEst, earned, forecast }
}

/* ---------------- project financials (BR-23..26) ---------------- */
export interface ProjectMetrics {
  project_id: string
  est_hours: number
  actual_hours: number
  approved_hours: number
  remaining_hours: number
  progress: number // share of estimate done
  planned_cost: number
  actual_cost: number // approved hours only
  logged_cost: number // all logged hours
  projected_cost: number
  contract_value: number
  invoiced: number
  collected: number
  outstanding: number
  uninvoiced: number
  planned_margin: number | null
  projected_margin: number | null
  actual_margin: number | null
  planned_markup: number | null
  projected_markup: number | null
  actual_markup: number | null
  effort_ratio: number | null
  spi: number | null
  health: Health
  overdue_milestones: number
  open_tasks: number
  overdue_tasks: number
  blocked_tasks: number
  team: string[]
  next_milestone: { id: string; name: string; no: number; planned_end: string; billing_amount_paise: number } | null
}

/** v5 (workstream A): the costing engine (src/mock/costing.ts) supplies planned / projected / actual cost and margins
 * from the saved costing plan and allocations, so every list and dashboard agrees with the project's Money tab. */
type MetricsOverride = (ctx: Ctx, p: E.Project, base: ProjectMetrics) => Partial<ProjectMetrics> | null
let metricsOverride: MetricsOverride | null = null
export function setProjectMetricsOverride(f: MetricsOverride | null) {
  metricsOverride = f
}
export function projectMetrics(ctx: Ctx, p: E.Project): ProjectMetrics {
  ensureSwept(ctx)
  return cached(ctx, 'pm:' + p.id, () => {
    const base = projectMetricsBase(ctx, p)
    const o = metricsOverride ? metricsOverride(ctx, p, base) : null
    return o ? { ...base, ...o } : base
  })
}
function projectMetricsBase(ctx: Ctx, p: E.Project): ProjectMetrics {
  return ((): ProjectMetrics => {
    const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
    const ms = rows(ctx, 'milestones').filter((m) => m.project_id === p.id && !m.deleted_at)
    const act = taskActuals(ctx)
    const invoices = rows(ctx, 'invoices').filter((i) => i.project_id === p.id)
    let doneEstLogged = 0
    let est = 0, actual = 0, approved = 0, remaining = 0, plannedCost = 0, actualCost = 0, loggedCost = 0, remainingCost = 0, doneEst = 0, doneActual = 0, planned = 0
    for (const t of tasks) {
      const a = act.get(t.id) ?? { hours: 0, approved: 0, cost: 0, approvedCost: 0 }
      const rate = currentRatePH(ctx, t.owner_id)
      est += t.est_hours
      actual += a.hours
      approved += a.approved
      actualCost += a.approvedCost
      loggedCost += a.cost
      plannedCost += t.est_hours * rate
      const rem = t.status === 'done' ? 0 : Math.max(0, t.est_hours - a.hours)
      remaining += rem
      remainingCost += rem * rate
      if (t.status === 'done') {
        doneEst += t.est_hours
        if (a.hours > 0) {
          doneActual += a.hours
          doneEstLogged += t.est_hours
        }
      }
      // planned value by today (linear over task window)
      if (t.due_on <= ctx.today) planned += t.est_hours
      else if (t.start_on < ctx.today) planned += (t.est_hours * Math.max(0, diffDays(ctx.today, t.start_on))) / Math.max(1, diffDays(t.due_on, t.start_on))
    }
    // internal (non-billable) time can still be booked to a project via task entries only
    const contract = p.contract_value_paise
    const invoiced = invoices.reduce((s, i) => s + i.amount_paise, 0)
    const collected = invoices.reduce((s, i) => s + i.paid_amount_paise, 0)
    const projected = loggedCost + remainingCost
    // Earned hours = estimate × progress % (Feature Guide: % complete and SPI use earned hours)
    const earned = tasks.reduce((s, t) => s + earnedHours(t), 0)
    const states = ms.map((m) => milestoneState(ctx, m, tasks))
    const overdueMs = states.filter((s) => s.state === 'overdue').length
    const pm = marginPct(contract, projected)
    // BR-26 on finished work that has logged time; otherwise open work (actual vs pro-rata estimate)
    const openEstToDate = tasks.filter((t) => t.status !== 'done' && t.start_on <= ctx.today).reduce((s2, t) => s2 + (t.est_hours * Math.min(1, Math.max(1, diffDays(ctx.today, t.start_on)) / Math.max(1, diffDays(t.due_on, t.start_on)))), 0)
    const openActual = tasks.filter((t) => t.status !== 'done').reduce((s2, t) => s2 + (act.get(t.id)?.hours ?? 0), 0)
    const er = doneActual ? effortRatio(doneActual, doneEstLogged) : effortRatio(openActual, openEstToDate)
    const health = p.status === 'completed' || p.status === 'closed' ? 'on_track' : projectHealth({ projectedMargin: contract ? pm : null, effortRatio: er, floor: ctx.tenant.settings['projects.margin_floor_pct'] / 100, alert: ctx.tenant.settings['projects.effort_ratio_alert'], overdueMilestones: overdueMs })
    const spiVal = planned > 0 ? Math.min(2, earned / planned) : null
    const healthAdj: Health = health === 'on_track' && spiVal !== null && spiVal < 0.8 && p.status === 'active' ? 'at_risk' : health
    const nextMs = ms.filter((m) => !m.achieved_on && m.billing_status === 'none').sort((a, b) => a.planned_end.localeCompare(b.planned_end))[0] ?? null
    return {
      project_id: p.id,
      est_hours: est,
      actual_hours: actual,
      approved_hours: approved,
      remaining_hours: remaining,
      progress: est ? earned / est : 0,
      planned_cost: Math.round(plannedCost),
      actual_cost: Math.round(actualCost),
      logged_cost: Math.round(loggedCost),
      projected_cost: Math.round(projected),
      contract_value: contract,
      invoiced,
      collected,
      outstanding: invoiced - collected,
      uninvoiced: ms.filter((m) => m.billing_status === 'none').reduce((s, m) => s + m.billing_amount_paise, 0),
      planned_margin: marginPct(contract, plannedCost),
      projected_margin: contract ? pm : null,
      actual_margin: marginPct(invoiced, actualCost),
      planned_markup: markupPct(contract, plannedCost),
      projected_markup: markupPct(contract, projected),
      actual_markup: markupPct(invoiced, actualCost),
      effort_ratio: er,
      spi: planned > 0 ? Math.min(2, earned / planned) : null,
      health: healthAdj,
      overdue_milestones: overdueMs,
      open_tasks: tasks.filter((t) => t.status !== 'done').length,
      overdue_tasks: tasks.filter((t) => t.status !== 'done' && t.due_on < ctx.today).length,
      blocked_tasks: tasks.filter((t) => t.status === 'blocked').length,
      team: [...new Set(tasks.map((t) => t.owner_id).filter(Boolean) as string[])],
      next_milestone: nextMs ? { id: nextMs.id, name: nextMs.name, no: nextMs.no, planned_end: nextMs.planned_end, billing_amount_paise: nextMs.billing_amount_paise } : null,
    }
  })()
}

/** Remove money fields the viewer may not see. */
export function redactMetrics(ctx: Ctx, m: ProjectMetrics, canMargins: boolean): ProjectMetrics {
  if (canMargins) return m
  const x = { ...m }
  for (const k of ['planned_cost', 'actual_cost', 'logged_cost', 'projected_cost', 'planned_margin', 'projected_margin', 'actual_margin', 'planned_markup', 'projected_markup', 'actual_markup'] as const) (x as Record<string, unknown>)[k] = null
  if (!ctx.perms.has('finance.view')) {
    for (const k of ['invoiced', 'collected', 'outstanding', 'uninvoiced'] as const) (x as Record<string, unknown>)[k] = null
    if (!ctx.perms.has('projects.edit')) (x as Record<string, unknown>).contract_value = null
  }
  return x
}

/* ---------------- revenue & finance ---------------- */
export function expandLedger(ctx: Ctx, from: string, to: string) {
  // recurring entries expand monthly until until_on (or `to`)
  const out: (E.LedgerEntry & { occurrence: string })[] = []
  for (const e of rows(ctx, 'ledger_entries')) {
    if (!e.recurring) {
      if (e.date >= from && e.date <= to) out.push({ ...e, occurrence: e.date })
      continue
    }
    let d = e.date
    const end = e.until_on && e.until_on < to ? e.until_on : to
    let guard = 0
    while (d <= end && guard++ < 240) {
      if (d >= from) out.push({ ...e, occurrence: d, status: d <= ctx.today ? (e.kind === 'income' ? 'received' : 'paid') : 'expected' })
      const dt = new Date(d)
      dt.setMonth(dt.getMonth() + 1)
      d = dt.toISOString().slice(0, 10)
    }
  }
  return out
}

/** Ledger categories that hold payroll; they are replaced by `payrollForMonth` so salaries are never counted twice. */
export const PAYROLL_CATEGORIES = new Set(['Salaries'])

/**
 * Payroll cost of one month — the ONE salary basis every screen uses (CEO dashboard, P&L statement,
 * monthly P&L, runway): the ledger's Salaries rows for that month when payroll has been booked, else the
 * monthly CTC of everyone employed that month (joined by the month end, not deactivated; the rate in force
 * today, else their latest rate). Payroll is dated on the 1st of the month, like the booked salary rows.
 */
export function payrollForMonth(ctx: Ctx, ym: string): { payroll: number; headcount: number; source: 'ledger' | 'ctc' } {
  const first = `${ym}-01`
  const last = addDays(monthOf(addDays(first, 32)) + '-01', -1)
  const rates = rows(ctx, 'cost_rates')
  let headcount = 0
  let ctc = 0
  for (const u of rows(ctx, 'users')) {
    if (u.status === 'deactivated' || u.is_super_admin || !u.joined_on || u.joined_on > last) continue
    const r = rateOn(rates, u.id, ctx.today) ?? rates.filter((x) => x.user_id === u.id).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
    if (!r) continue
    ctc += r.monthly_ctc_paise
    headcount++
  }
  const booked = expandLedger(ctx, first, last).filter((e) => e.kind === 'expense' && PAYROLL_CATEGORIES.has(e.category))
  if (booked.length) return { payroll: booked.reduce((s, e) => s + e.amount_paise, 0), headcount, source: 'ledger' }
  return { payroll: ctc, headcount, source: 'ctc' }
}

/**
 * Billed, collected and costs between two dates. Only what has happened counts: income, payments and
 * expenses dated after today are left out (a retainer scheduled for the 5th is not revenue on the 2nd),
 * unless `scheduled` asks for the whole range (forecasts). Salaries come from `payrollForMonth`, counted
 * once per month on its 1st, so a month, the weeks inside it and a quarter all add up.
 */
export function revenueBetween(ctx: Ctx, from: string, to: string, opts: { scheduled?: boolean } = {}) {
  const cap = opts.scheduled || to < ctx.today ? to : ctx.today
  const entries = from > cap ? [] : expandLedger(ctx, from, cap)
  const payments = rows(ctx, 'payments')
  const invoices = new Map(rows(ctx, 'invoices').map((i) => [i.id, i]))
  let billed = 0, collected = 0, other = 0, payroll = 0
  const byStream: Record<string, number> = {}
  for (const e of entries) {
    if (e.kind === 'income') {
      billed += e.amount_paise
      if (e.stream) byStream[e.stream] = (byStream[e.stream] ?? 0) + e.amount_paise
      if (!e.invoice_id && e.status === 'received') collected += e.amount_paise
    } else if (!PAYROLL_CATEGORIES.has(e.category)) other += e.amount_paise
  }
  for (const p of payments) if (p.paid_on >= from && p.paid_on <= cap && invoices.has(p.invoice_id)) collected += p.amount_paise
  for (let m = monthOf(from); from <= cap && m <= monthOf(cap); m = monthOf(addDays(m + '-28', 7))) {
    const first = `${m}-01`
    if (first >= from && first <= cap) payroll += payrollForMonth(ctx, m).payroll
  }
  const cost = payroll + other
  return { billed, collected, cost, payroll, other_costs: other, net: billed - cost, margin: billed ? (billed - cost) / billed : null, byStream, as_of: cap }
}

/* ---------------- pipeline ---------------- */
export function pipeline(ctx: Ctx, ownerId?: string) {
  const deals = rows(ctx, 'deals').filter((d) => !ownerId || d.owner_id === ownerId)
  const open = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost')
  const won = deals.filter((d) => d.stage === 'won')
  const lost = deals.filter((d) => d.stage === 'lost')
  const staleDays = ctx.tenant.settings['sales.stale_deal_days']
  const cycle = won.map((d) => diffDays(d.won_on!, d.created_at.slice(0, 10))).filter((x) => x >= 0)
  return {
    open_value: open.reduce((s, d) => s + dealValue(d), 0),
    weighted_value: Math.round(open.reduce((s, d) => s + dealValue(d) * DEAL_STAGE[d.stage].chance, 0)),
    open_count: open.length,
    won_value: won.reduce((s, d) => s + dealValue(d), 0),
    won_count: won.length,
    lost_count: lost.length,
    win_rate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
    avg_deal: won.length ? won.reduce((s, d) => s + dealValue(d), 0) / won.length : null,
    avg_cycle_days: cycle.length ? cycle.reduce((a, b) => a + b, 0) / cycle.length : null,
    stale: open.filter((d) => diffDays(ctx.today, d.last_activity_on) >= staleDays),
  }
}

/* ---------------- people load ---------------- */
export function allocationOn(ctx: Ctx, userId: string, date: string) {
  return rows(ctx, 'allocations').filter((a) => a.user_id === userId && a.from_on <= date && a.to_on >= date).reduce((s, a) => s + a.pct, 0)
}
export function avgAllocation(ctx: Ctx, userId: string, from: string, to: string) {
  const c = cal(ctx)
  let n = 0, sum = 0
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWorkingDay(d, c)) continue
    n++
    sum += allocationOn(ctx, userId, d)
  }
  return n ? sum / n : 0
}

/** Approval SLA due date for a submitted week (BR-10). */
export function slaDue(ctx: Ctx, submittedAt: string) {
  const c = cal(ctx)
  let d = submittedAt.slice(0, 10)
  let left = ctx.tenant.settings['approval.sla_working_days']
  while (left > 0) {
    d = addDays(d, 1)
    if (isWorkingDay(d, c)) left--
  }
  return d
}

/* ================================================================== */
/* WBS helpers, milestone upkeep and the schedule (Feature Guide §4–5)  */
/* ================================================================== */
export function liveMilestoneMap(ctx: Ctx) {
  return new Map(rows(ctx, 'milestones').filter((m) => !m.deleted_at).map((m) => [m.id, m]))
}
export function wbsCode(t: E.Task, ms: Map<string, E.Milestone>) {
  // Permanent number stored on the task (kept when it moves or its milestone is deleted); see routes/tasks.ts wbsOf.
  const frozen = (t as E.Task & { wbs_code?: string | null }).wbs_code
  if (frozen) return frozen
  const m = t.milestone_id ? ms.get(t.milestone_id) : null
  return `${m && !m.deleted_at ? m.no : 0}.${t.no}`
}
export function sortWbs(a: string, b: string) {
  const [a1, a2] = a.split('.').map(Number)
  const [b1, b2] = b.split('.').map(Number)
  return (a1 || 1e6) - (b1 || 1e6) || a2 - b2
}
/** Day a task entered its current stage (from the task log), else its last update. */
export function stageSince(ctx: Ctx, t: E.Task): string {
  let at = ''
  for (const a of rows(ctx, 'activity_log')) if (a.entity === 'task' && a.entity_id === t.id && (a.action === 'task.stage' || a.action === 'task.status') && a.at > at) at = a.at
  return (at || t.updated_at).slice(0, 10)
}

/**
 * A milestone's deadline is always the target end (due_on) of its last task; its start is the earliest task start.
 * It moves only when a task's target moves. Before it has tasks, the provisional dates stay as entered.
 * `rebaseline` (first tasks arriving in an empty milestone) also resets the baseline to that first real deadline.
 */
export function syncMilestoneDates(ctx: Ctx, msId: string | null | undefined, rebaseline = false) {
  if (!msId) return
  const m = rows(ctx, 'milestones').find((x) => x.id === msId)
  if (!m || m.deleted_at) return
  const mine = rows(ctx, 'tasks').filter((t) => t.milestone_id === m.id)
  if (!mine.length) return
  const end = mine.reduce((mx, t) => maxISO(mx, t.due_on), '0000-01-01')
  const start = mine.reduce((mn, t) => minISO(mn, t.start_on), '9999-12-31')
  let changed = false
  if (rebaseline && m.baseline_end !== end) {
    m.baseline_end = end
    changed = true
  }
  if (m.planned_end !== end || m.planned_start !== start) {
    m.planned_end = end
    m.planned_start = start
    changed = true
  }
  if (changed) {
    m.updated_at = nowISO()
    m.version += 1
    persist()
  }
}

/** BR-20 sweep (JOB-12 in the real build): deadlines follow tasks; a milestone empty for N days is removed unless invoiced. */
export function sweepMilestones(ctx: Ctx, p: E.Project) {
  const days = ctx.tenant.settings['projects.empty_milestone_days']
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  for (const m of rows(ctx, 'milestones').filter((x) => x.project_id === p.id && !x.deleted_at)) {
    const n = tasks.filter((t) => t.milestone_id === m.id).length
    if (n > 0) {
      if (m.empty_since) m.empty_since = null
      syncMilestoneDates(ctx, m.id)
    } else if (m.billing_status === 'none') {
      if (!m.empty_since) {
        m.empty_since = ctx.today
        persist()
      } else if (days > 0 && diffDays(ctx.today, m.empty_since) >= days) {
        m.deleted_at = nowISO()
        removeWhere(ctx, 'allocations', (a) => a.milestone_id === m.id)
        logActivity(ctx, 'project', p.id, 'milestone.auto_deleted', `M${m.no} ${m.name} removed automatically after ${days} days with no tasks`)
        if (p.pm_id) notify(ctx, p.pm_id, 'NTF-15', `Milestone M${m.no} removed`, `“${m.name}” on ${p.name} had no tasks for ${days} days and was removed.`, `/projects/${p.id}/wbs`)
        persist()
      }
    }
  }
}
/** Sweep every project of the tenant (list pages, dashboards). */
export function sweepAll(ctx: Ctx) {
  for (const p of rows(ctx, 'projects')) sweepMilestones(ctx, p)
}
/** Run the sweep once per request before anything reads milestones. */
export function ensureSwept(ctx: Ctx) {
  cached(ctx, 'swept', () => {
    sweepAll(ctx)
    return true
  })
}

/* ---------------- schedule: forecast + critical path ---------------- */

/** Cached schedule per project for this request, plus each milestone's forecast end. */
export function scheduleOf(ctx: Ctx, projectId: string): { schedule: Schedule; msForecast: Map<string, string | null> } {
  return cached(ctx, 'sched:' + projectId, () => {
    const p = rows(ctx, 'projects').find((x) => x.id === projectId)
    if (!p) return { schedule: null as unknown as Schedule, msForecast: new Map() }
    const schedule = computeSchedule(ctx, p)
    return { schedule, msForecast: new Map(schedule.milestones.map((m) => [m.id, m.achieved_on ?? m.forecast_end])) }
  })
}

/**
 * Prototype §6.4/§7/§8. Critical = no float to its milestone's deadline (the task that sets the deadline, and any
 * predecessor that would push it). Forecast = dependency-adjusted, remaining effort (estimate × (1 − progress))
 * at productive capacity (~75% of the minimum day) from today.
 */
export function computeSchedule(ctx: Ctx, p: E.Project): Schedule {
  const c = { ...cal(ctx), leaveDates: undefined }
  const ms = liveMilestoneMap(ctx)
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  const milestones = rows(ctx, 'milestones').filter((m) => m.project_id === p.id && !m.deleted_at).sort((a, b) => a.no - b.no)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const deps = new Map<string, string[]>()
  const succ = new Map<string, string[]>()
  for (const d of rows(ctx, 'task_dependencies')) {
    if (!byId.has(d.task_id) || !byId.has(d.depends_on_task_id)) continue
    ;(deps.get(d.task_id) ?? deps.set(d.task_id, []).get(d.task_id)!).push(d.depends_on_task_id)
    ;(succ.get(d.depends_on_task_id) ?? succ.set(d.depends_on_task_id, []).get(d.depends_on_task_id)!).push(d.task_id)
  }
  let lo = minISO(p.start_on, ctx.today)
  let hi = maxISO(p.end_on, ctx.today)
  for (const t of tasks) {
    lo = minISO(lo, minISO(t.start_on, t.due_on))
    hi = maxISO(hi, maxISO(t.start_on, t.due_on))
  }
  for (const m of milestones) hi = maxISO(hi, m.planned_end)
  lo = addDays(lo, -14)
  hi = addDays(hi, 400)
  const wdays: string[] = []
  const nextIdx = new Map<string, number>()
  for (let d = lo; d <= hi; d = addDays(d, 1)) {
    if (isWorkingDay(d, c)) wdays.push(d)
    nextIdx.set(d, wdays.length)
  }
  const wNext = (d: string) => Math.min(nextIdx.get(d) ?? (d < lo ? 0 : wdays.length - 1), wdays.length - 1)
  const wPrev = (d: string) => {
    const i = nextIdx.get(d) ?? 0
    return wdays[i] === d ? i : Math.max(0, i - 1)
  }
  const dateAt = (i: number) => wdays[Math.max(0, Math.min(wdays.length - 1, i))]
  const TI = wNext(ctx.today)

  const order: string[] = []
  const state = new Map<string, number>()
  const cycles = new Set<string>()
  const visit = (id: string, path: string[]) => {
    const s = state.get(id)
    if (s === 2) return
    if (s === 1) {
      const i = path.indexOf(id)
      path.slice(i).forEach((x) => cycles.add(x))
      return
    }
    state.set(id, 1)
    for (const d of deps.get(id) ?? []) visit(d, [...path, id])
    state.set(id, 2)
    order.push(id)
  }
  for (const t of [...tasks].sort((a, b) => a.start_on.localeCompare(b.start_on))) visit(t.id, [])

  const ES = new Map<string, number>()
  const EF = new Map<string, number>()
  for (const t of tasks) {
    const a = wNext(t.start_on)
    const b = wPrev(t.due_on)
    ES.set(t.id, Math.min(a, b))
    EF.set(t.id, Math.max(a, b))
  }
  const conflicts: Schedule['conflicts'] = []
  for (const t of tasks)
    for (const d of deps.get(t.id) ?? []) {
      const dt = byId.get(d)!
      if (ES.get(t.id)! <= EF.get(d)! && dt.status !== 'done' && t.status !== 'done')
        conflicts.push({ task_id: t.id, depends_on_id: d, message: `${wbsCode(t, ms)} ${t.title} is planned to start ${fmtDate(t.start_on)}, but it depends on ${wbsCode(dt, ms)} ${dt.title}, which ends ${fmtDate(dt.due_on)}. Move its dates or remove the dependency.` })
    }
  // Float to the milestone deadline (working days), per milestone group
  const floatOf = new Map<string, number>()
  const groups = new Map<string, E.Task[]>()
  for (const t of tasks) {
    const g = t.milestone_id && ms.has(t.milestone_id) ? t.milestone_id : '_none'
    ;(groups.get(g) ?? groups.set(g, []).get(g)!).push(t)
  }
  for (const [, g] of groups) {
    const end = Math.max(...g.map((t) => EF.get(t.id)!))
    const inG = new Set(g.map((t) => t.id))
    const LS = new Map<string, number>()
    for (const id of [...order].reverse()) {
      if (!inG.has(id)) continue
      const dur = EF.get(id)! - ES.get(id)! + 1
      let lf = end
      for (const s of succ.get(id) ?? []) if (inG.has(s) && LS.has(s)) lf = Math.min(lf, LS.get(s)! - 1)
      LS.set(id, lf - dur + 1)
      floatOf.set(id, lf - EF.get(id)!)
    }
  }
  const finishIdx = tasks.length ? Math.max(...tasks.map((t) => EF.get(t.id)!)) : null
  // Float to the project end (guide §4: "spare days before it delays the project")
  const projFloat = new Map<string, number>()
  if (finishIdx !== null) {
    const LSp = new Map<string, number>()
    for (const id of [...order].reverse()) {
      if (!EF.has(id)) continue
      const dur = EF.get(id)! - ES.get(id)! + 1
      let lf = finishIdx
      for (const s of succ.get(id) ?? []) if (LSp.has(s)) lf = Math.min(lf, LSp.get(s)! - 1)
      LSp.set(id, lf - dur + 1)
      projFloat.set(id, lf - EF.get(id)!)
    }
  }
  const path: string[] = []
  if (finishIdx !== null) {
    let cur = tasks.filter((t) => EF.get(t.id) === finishIdx).sort((a, b) => (deps.get(b.id)?.length ?? 0) - (deps.get(a.id)?.length ?? 0))[0]?.id
    let guard = 0
    while (cur && guard++ < 500 && !path.includes(cur)) {
      path.unshift(cur)
      const ds = (deps.get(cur) ?? []).filter((d) => byId.has(d))
      if (!ds.length) break
      cur = ds.sort((a, b) => EF.get(b)! - EF.get(a)!)[0]
    }
  }

  // Forecast
  const act = taskActuals(ctx)
  const cap = Math.max(1, ctx.tenant.settings['calendar.min_hours_per_day'] * 0.75)
  const FS = new Map<string, number>()
  const FF = new Map<string, number>()
  const REM = new Map<string, number>()
  const WAIT = new Map<string, string>()
  for (const id of order) {
    const t = byId.get(id)!
    if (t.status === 'done') {
      const f = wPrev(t.done_on ?? t.due_on)
      FS.set(id, Math.min(t.actual_start_on ? wNext(t.actual_start_on) : ES.get(id)!, f))
      FF.set(id, f)
      REM.set(id, 0)
      continue
    }
    const logged = act.get(id)?.hours ?? 0
    const prog = progressOf(t) / 100
    const byProgress = t.est_hours * (1 - prog)
    const rem = Math.max(0.5, prog > 0 ? byProgress : Math.max(t.est_hours - logged, t.est_hours * 0.15))
    REM.set(id, Math.round(rem * 10) / 10)
    const started = !!t.actual_start_on || t.status === 'in_progress' || t.status === 'in_review'
    let s = Math.max(TI, ES.get(id)!)
    if (started) s = TI
    let pm = -1
    for (const d of deps.get(id) ?? []) {
      const dt = byId.get(d)!
      const f = dt.status === 'done' ? Math.min(FF.get(d) ?? 0, TI - 1) : FF.get(d) ?? EF.get(d)!
      if (f > pm) {
        pm = f
        if (f + 1 > s) WAIT.set(id, d)
      }
    }
    if (pm + 1 > s) s = pm + 1
    const remDays = Math.max(1, Math.ceil(rem / cap))
    FS.set(id, started && t.actual_start_on ? Math.min(wNext(t.actual_start_on), s) : s)
    FF.set(id, s + remDays - 1)
  }

  const schedTasks: ScheduleTask[] = tasks.map((t) => {
    const m = t.milestone_id ? ms.get(t.milestone_id) : null
    const fEnd = dateAt(FF.get(t.id)!)
    let breach: ScheduleTask['breach'] = null
    if (t.status !== 'done') {
      const w = WAIT.get(t.id)
      const wt = w ? byId.get(w) : null
      if (t.due_on < ctx.today) breach = { kind: 'overdue', message: `Overdue since ${fmtDate(t.due_on)}` }
      else if (t.status === 'blocked') breach = { kind: 'blocked', message: t.blocked_reason ? `Blocked: ${t.blocked_reason}` : 'Blocked' }
      else if (fEnd > t.due_on) breach = { kind: 'forecast_late', message: wt ? `Waiting on ${wbsCode(wt, ms)} ${wt.title} (${userName(ctx, wt.owner_id)}); forecast end ${fmtDate(fEnd)}, target ${fmtDate(t.due_on)}` : `Forecast end ${fmtDate(fEnd)}, target ${fmtDate(t.due_on)}` }
      else if (m && fEnd > m.planned_end) breach = { kind: 'milestone', message: `Forecast end ${fmtDate(fEnd)} passes the M${m.no} deadline ${fmtDate(m.planned_end)}` }
    }
    const revs = t.target_revisions ?? []
    return {
      id: t.id, wbs: wbsCode(t, ms), title: t.title, owner_id: t.owner_id, status: t.status, milestone_id: m ? m.id : null, start_on: t.start_on, due_on: t.due_on, done_on: t.done_on,
      forecast_start: dateAt(FS.get(t.id)!), forecast_end: fEnd, float_days: floatOf.get(t.id) ?? 0, project_float_days: projFloat.get(t.id) ?? 0, critical: (floatOf.get(t.id) ?? 1) <= 0, deps: deps.get(t.id) ?? [], remaining_hours: REM.get(t.id) ?? 0, breach,
      stage: stageOf(t), progress: progressOf(t), est_hours: t.est_hours, logged_hours: act.get(t.id)?.hours ?? 0, baseline_due_on: t.baseline_due_on ?? (revs[0]?.from ?? null),
      revised_on: revs.length ? revs[revs.length - 1].at.slice(0, 10) : null, actual_start_on: t.actual_start_on ?? null, waiting_on_id: WAIT.get(t.id) ?? null,
    }
  })
  schedTasks.sort((a, b) => sortWbs(a.wbs, b.wbs))
  const schedMs = milestones.map((m) => {
    const mine = schedTasks.filter((t) => t.milestone_id === m.id)
    const fEnd = mine.length ? mine.reduce((mx, t) => maxISO(mx, t.status === 'done' ? t.done_on ?? t.due_on : t.forecast_end), '0000-01-01') : null
    return { id: m.id, no: m.no, name: m.name, planned_start: m.planned_start, planned_end: m.planned_end, baseline_end: m.baseline_end, forecast_end: fEnd, achieved_on: m.achieved_on, state: milestoneState(ctx, m, tasks, fEnd).state as MilestoneDelivery }
  })
  let from = minISO(p.start_on, ctx.today)
  let to = maxISO(p.end_on, ctx.today)
  for (const t of schedTasks) {
    from = minISO(from, minISO(t.start_on, t.forecast_start))
    to = maxISO(to, maxISO(t.due_on, t.forecast_end))
  }
  for (const m of schedMs) to = maxISO(to, maxISO(m.planned_end, m.baseline_end))
  const forecastFinish = schedTasks.length ? schedTasks.reduce((mx, t) => maxISO(mx, t.status === 'done' ? t.done_on ?? t.due_on : t.forecast_end), '0000-01-01') : null
  return {
    from: addDays(from, -2), to: addDays(to, 3), today: ctx.today, project_start: p.start_on, project_end: p.end_on,
    cpm_finish: finishIdx === null ? null : dateAt(finishIdx), forecast_finish: forecastFinish,
    tasks: schedTasks, milestones: schedMs, critical_path: path, conflicts,
    cycles: [...cycles].map((id) => wbsCode(byId.get(id)!, ms)).sort(sortWbs), can_edit: false,
  }
}

/* ---------------- estimation hint (G15.04) ---------------- */
function median(a: number[]) {
  if (!a.length) return 1
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** Effort-ratio samples (actual ÷ estimate) on closed tasks with logged time. */
export function effortRatioSamples(ctx: Ctx) {
  return cached(ctx, 'ratioSamples', () => {
    const act = taskActuals(ctx)
    const byPerson = new Map<string, number[]>()
    const byCx = new Map<string, number[]>()
    const byPersonCx = new Map<string, number[]>()
    const team: number[] = []
    for (const t of rows(ctx, 'tasks')) {
      if (t.status !== 'done' || !t.owner_id || t.est_hours <= 0) continue
      const a = act.get(t.id)?.hours ?? 0
      if (a <= 0) continue
      const r = a / t.est_hours
      team.push(r)
      const push = (m: Map<string, number[]>, k: string) => (m.get(k) ?? m.set(k, []).get(k)!).push(r)
      push(byPerson, t.owner_id)
      push(byCx, t.complexity)
      push(byPersonCx, `${t.owner_id}:${t.complexity}`)
    }
    return { byPerson, byCx, byPersonCx, team }
  })
}
export interface EstimateHint {
  ratio: number | null // typical effort ratio used
  basis: 'person_complexity' | 'person' | 'complexity' | 'team' | 'none'
  samples: number
  buffer_pct: number // suggested buffer (0 when estimates are sound)
  suggested_hours: number | null
  message: string | null
}
/** "Your typical effort ratio for High complexity is ×1.25 — consider 25% buffer (suggested 30h)". */
export function estimateHint(ctx: Ctx, ownerId: string | null, complexity: E.Complexity, est: number | null): EstimateHint {
  const s = effortRatioSamples(ctx)
  const cxLabel = { low: 'Low', medium: 'Medium', high: 'High', very_high: 'Very high' }[complexity] ?? complexity
  const name = ownerId ? userName(ctx, ownerId) : null
  const pick: [EstimateHint['basis'], number[] | undefined][] = [
    ['person_complexity', ownerId ? s.byPersonCx.get(`${ownerId}:${complexity}`) : undefined],
    ['person', ownerId ? s.byPerson.get(ownerId) : undefined],
    ['complexity', s.byCx.get(complexity)],
    ['team', s.team],
  ]
  const hit = pick.find(([, a]) => a && a.length >= 3)
  if (!hit) return { ratio: null, basis: 'none', samples: 0, buffer_pct: 0, suggested_hours: null, message: null }
  const [basis, arr] = hit
  const r = Math.round(median(arr!) * 100) / 100
  const buffer = r > 1.05 ? Math.round((r - 1) * 100) : 0
  const sugg = est && est > 0 ? Math.round(est * Math.max(1, r) * 2) / 2 : null
  const who = basis === 'person_complexity' ? `${name ? `${name.split(' ')[0]}’s` : 'The owner’s'} typical effort ratio for ${cxLabel} complexity` : basis === 'person' ? `${name ? `${name.split(' ')[0]}’s` : 'The owner’s'} typical effort ratio` : basis === 'complexity' ? `The team’s typical effort ratio for ${cxLabel} complexity` : 'The team’s typical effort ratio'
  const message =
    buffer > 0
      ? `${who} is ×${r.toFixed(2)} — consider a ${buffer}% buffer${sugg ? ` (suggested ${sugg}h)` : ''}.`
      : r < 0.85
        ? `${who} is ×${r.toFixed(2)} — estimates tend to run high; ${sugg ? `${est}h` : 'this estimate'} is safe.`
        : `${who} is ×${r.toFixed(2)} — estimates are sound.`
  return { ratio: r, basis, samples: arr!.length, buffer_pct: buffer, suggested_hours: buffer > 0 ? sugg : null, message }
}
