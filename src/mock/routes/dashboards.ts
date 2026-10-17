import { dealValue } from '@/domain/sales'
// Module E backend: role dashboards (/dashboards/*), Insights views (/insights/:view) and the weekly
// scorecard (/scorecard). Every figure is computed here from tenant rows; screens only format.
import type * as E from '@/types/entities'
import { err, rows, canSeeMargins, canSeeSalaries, type Ctx, type Router, has, hasAny, roleDef } from '../server'
import { allocationOn, cal, costedEntries, expandLedger, milestoneState, pipeline, projectMetrics, redactMetrics, revenueBetween, slaDue, taskActuals } from '../analytics'
import { addDays, addMonths, diffDays, fyLabel, fyRange, fyStartYear, isWorkingDay, monthOf, monthRange, periodRange, previousPeriod, quarterOf, weekDays, weekStart, workingDaysBetween, type PeriodKind } from '@/domain/calendar'
import { DEAL_STAGE, HEALTH, STREAM, TASK_STATUS, WEEK_STATUS, type Tone } from '@/domain/labels'
import { canDecide } from './timesheets'
import { canSeeTask } from './tasks'
import { isTop, reviewerOf } from './taskflow'
import { compFor } from './sales'
import { effectiveWeekStatus, isTimesheetUser, myProjects, nameOf, S, taskCode, teamOf, weekHistory } from './reports'
import { STAGE, TASK_STAGES, TASK_TAG, progressOf, stageOf } from '@/domain/delivery'
import { workingDayVariance } from '../performance'
import { approvalKpi, approvalKpis, type ApprovalKpi } from '../approvalKpi'

/* ------------------------------------------------------------------ */
/* Shared types (imported by src/api/dashboards.ts)                     */
/* ------------------------------------------------------------------ */
export type Health = 'on_track' | 'at_risk' | 'off_track'
export interface Money4 { billed: number; collected: number; cost: number; net: number; margin: number | null }
export interface PeriodRow extends Money4 { key: string; label: string; from: string; to: string; kind: 'sub' | 'total' | 'previous' }
export interface ProjectPill {
  id: string; code: string; name: string; client: string; status: E.ProjectStatus; health: Health; progress: number; spi: number | null; effort_ratio: number | null
  projected_margin: number | null; overdue_tasks: number; blocked_tasks: number; overdue_milestones: number; pm: string | null
  next_milestone: { id: string; label: string; planned_end: string; billing: number; days: number } | null
}
export interface MilestoneRow {
  id: string; project_id: string; project: string; client: string; label: string; planned_end: string; days: number; state: string; progress: number; billing: number; billing_status: E.MilestoneBilling
  /** v5: milestone code (M4), name, P50 forecast finish and whether it passes the deadline. */
  code?: string; name?: string; forecast?: string | null; forecast_late?: boolean
}
export interface TaskRow { id: string; code: string; title: string; project_id: string; project: string; owner_id: string | null; owner: string | null; owner_hue: number; status: E.TaskStatus; due_on: string; days: number; est: number; actual: number; reason?: string }
export interface ApproverRow { id: string; name: string; hue: number; pending: number; overdue: number; late: number; on_time: number; decided: number; score: number }
export interface DealRowLite { id: string; title: string; client: string; stage: E.DealStage; owner: string | null; value: number; weighted: number; days_idle: number; expected_close: string; next_step: string | null; next_step_on: string | null }

export interface CeoDashboard {
  period: { kind: PeriodKind; label: string; from: string; to: string; prev_label: string }
  revenue: { month: Money4 & { label: string; change: number | null; prev_label: string }; quarter: Money4 & { label: string; change: number | null; prev_label: string }; fy: Money4 & { label: string; change: number | null; prev_label: string } }
  period_rows: PeriodRow[]
  months: { key: string; label: string; billed: number; collected: number; cost: number; net: number }[]
  streams: { key: string; label: string; value: number }[]
  streams_label: string
  ahead: { in_30: number; in_60: number; in_90: number; uninvoiced: number; uninvoiced_count: number; weighted_pipeline: number; open_pipeline: number; total: number }
  projects: ProjectPill[]
  delivery: { milestones_on_time: number | null; milestones_achieved: number; milestones_on_time_count: number; spi: number | null; overdue_tasks: number; avg_lateness: number | null; late_tasks: number; blocked_tasks: number; tasks_on_time: number | null; done_4w: number; done_prev_4w: number; utilisation: number | null; at_risk_projects: number; active_projects: number }
  milestones_30: MilestoneRow[]
  milestones_30_total: number
  approvals: ApproverRow[]
  stale: { count: number; value: number; stale_days: number; deals: DealRowLite[] }
  cash: { balance: number; monthly_burn: number; recurring_income: number; net_burn: number; runway_months: number | null; cash_positive: boolean }
  can_margins: boolean
  /* v5 Feature Guide §2 */
  week: string
  /** Fixed period table: this month, this quarter, this financial year (to date), each against its previous period. */
  fixed_rows: (Money4 & { key: 'month' | 'quarter' | 'fy'; label: string; sub: string; change: number | null; change_label: string })[]
  /** Net earnings this FY to date vs the same days of last FY. */
  net_change: number | null
  stream_shares: { key: string; label: string; value: number; share: number }[]
  kpis: { cpi: number | null; forecast_breach: number; breached_open: number; red_projects: number; active_projects: number; team_score: number | null; on_time_tasks: number | null; done_week: number }
  cash_ms: { on_time: number | null; achieved: number; achieved_not_invoiced: number; invoiced_awaiting: number; billable_30: number }
  finance: {
    pnl: { key: string; label: string; billed: number; collected: number; cost: number; net: number }[]
    recurring: { id: string; kind: E.LedgerEntry['kind']; description: string; category: string; amount: number; until_on: string | null }[]
    top_expenses: { id: string; description: string; category: string; amount: number; date: string }[]
    month_income: number; month_expense: number
  }
}

export interface LoadRow { id: string; name: string; hue: number; title: string; avg: number; days: { date: string; pct: number }[] }
export interface PmDashboard {
  projects: ProjectPill[]
  kpis: { active: number; at_risk: number; overdue_tasks: number; blocked: number; due_3d: number; pending_approvals: number; open_crs: number; compliance: number | null }
  at_risk: TaskRow[]
  blocked: TaskRow[]
  load: { dates: string[]; people: LoadRow[] }
  approvals: { id: string; person: string; hue: number; week_start: string; hours: number; submitted_at: string | null; due: string | null; overdue: boolean }[]
  change_requests: { id: string; project_id: string; project: string; title: string; status: E.CRStatus; hours: number; value: number | null; age_days: number }[]
  compliance: { id: string; name: string; hue: number; last_week: E.WeekStatus | 'missing'; weeks: (E.WeekStatus | 'missing')[]; pct: number }[]
  milestones: MilestoneRow[]
  /* v5 Feature Guide §14 */
  week: string
  control: {
    active_projects: number; critical_at_risk: number; blocked_waiting: number; past_start: number; open_bugs: number; in_testing: number; in_uat: number; waiting_feedback: number; no_estimate: number; conflicts: number
    critical_list: TaskRow[]; conflict_list: { id: string; task_id: string; kind: 'dependency' | 'double_booked'; message: string }[]
  }
  pipeline: { stage: E.TaskStage | 'in_review'; label: string; count: number; tone: Tone; group: string }[]
  done_count: number
  load_hours: { from: string; to: string; days: number; people: LoadHoursRow[] }
  due_week: number
  /** "Needs attention" (v7): what to act on right now, each with a count and the filtered screen it links to. */
  attention: { key: string; label: string; count: number; to: string; hint?: string }[]
}
export interface SalesDashboard {
  scope: 'mine' | 'team'
  /** Whose target the target panel shows (team needs deals.view_all + cost_rates.view). */
  target_scope: 'mine' | 'team'
  summary: { open_value: number; weighted_value: number; open_count: number; won_value: number; won_count: number; win_rate: number | null; avg_cycle_days: number | null; stale_count: number }
  by_stage: { stage: E.DealStage; label: string; count: number; value: number; weighted: number }[]
  needs_action: (DealRowLite & { reason: 'stale' | 'closing' | 'next_step' | 'overdue_close'; reason_text: string })[]
  target: { month_label: string; target: number; achieved: number; achievement: number; threshold_pct: number; hit: boolean; variable: number; variable_earned: number; has_rate: boolean } | null
  history: { label: string; target: number; achieved: number; hit: boolean }[]
  activities: { id: string; date: string; type: E.ActivityType; deal_id: string; deal: string; client: string; note: string; by: string | null }[]
  activity_30d: number
}
export interface OpsDashboard {
  counts: { overdue: number; due_7: number; upcoming_30: number; openings: number; positions: number; on_leave_today: number }
  items: { id: string; item: string; category: E.OpsItem['category']; owner: string | null; due_on: string; days: number; recurring: E.Recurrence; group: 'overdue' | 'due' | 'upcoming' }[]
  compliance: { id: string; item: string; due_on: string; days: number; owner: string | null; status: 'open' | 'done' }[]
  openings: { id: string; role: string; project: string | null; count: number; status: E.Opening['status']; needed_by: string | null; owner: string | null }[]
  leave_today: { id: string; name: string; hue: number; type: E.LeaveType; portion: 'full' | 'half' }[]
  payroll: { month: string; label: string; status: 'not_started' | 'draft' | 'final'; run_id: string | null; last_month: { label: string; status: 'not_started' | 'draft' | 'final'; run_id: string | null } }
  timesheets: { missing_last_week: number; pending_approval: number; people: number }
}
export interface EmployeeDashboard {
  today: TaskRow[]
  week: TaskRow[]
  overdue: TaskRow[]
  blocked: TaskRow[]
  waiting_on_me: (TaskRow & { waiting: { id: string; title: string; owner: string | null }[] })[]
  timesheet: { week_start: string; status: E.WeekStatus | 'missing'; total: number; min_per_day: number; expected_to_date: number; days: { date: string; hours: number; working: boolean; min: number; future: boolean }[] }
  stats: { effort_ratio: number | null; on_time: number | null; done_4w: number; done_prev_4w: number; open: number; ratio_samples: number; allocation_10d: number }
  daily: { submitted_today: boolean; last_date: string | null; proof_required: boolean }
  /* v5 Feature Guide §1 employee view */
  viewed_week: string
  person: { id: string; name: string; title: string; hue: number }
  is_self: boolean
  /** People whose employee view this viewer may open (themselves first). */
  viewable: { id: string; name: string; title: string }[]
  mentions: MentionRow[]
  covering: CoveringRow[]
  numbers: { score: number | null; score_cells: ScoreCell[]; on_time: number | null; effort_ratio: number | null; utilisation: number | null; booked: number; capacity: number; open: number; overdue: number; avg_lateness: number | null; forecast_breach: number }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
const r1 = (v: number) => Math.round(v * 10) / 10
const r3 = (v: number) => Math.round(v * 1000) / 1000
const chg = (cur: number, prev: number): number | null => (prev ? (cur - prev) / Math.abs(prev) : cur ? null : 0)
function money4(ctx: Ctx, from: string, to: string): Money4 {
  const r = revenueBetween(ctx, from, to)
  return { billed: r.billed, collected: r.collected, cost: r.cost, net: r.net, margin: r.margin }
}
const monthLabel = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
function usersMap(ctx: Ctx) {
  return new Map(rows(ctx, 'users').map((u) => [u.id, u]))
}

function pill(ctx: Ctx, p: E.Project, cm: boolean, nm: (id: string | null) => string | null): ProjectPill {
  const m = redactMetrics(ctx, projectMetrics(ctx, p), cm)
  const nx = m.next_milestone
  return {
    id: p.id, code: p.code, name: p.name, client: p.client, status: p.status, health: m.health, progress: m.progress, spi: m.spi === null ? null : r3(m.spi), effort_ratio: m.effort_ratio === null ? null : r3(m.effort_ratio),
    projected_margin: m.projected_margin, overdue_tasks: m.overdue_tasks, blocked_tasks: m.blocked_tasks, overdue_milestones: m.overdue_milestones, pm: nm(p.pm_id),
    next_milestone: nx ? { id: nx.id, label: `M${nx.no} ${nx.name}`, planned_end: nx.planned_end, billing: nx.billing_amount_paise, days: diffDays(nx.planned_end, ctx.today) } : null,
  }
}
const LIVE: E.ProjectStatus[] = ['initiated', 'active', 'on_hold']
const healthOrder: Record<Health, number> = { off_track: 0, at_risk: 1, on_track: 2 }

function milestoneRows(ctx: Ctx, projects: E.Project[], from: string, to: string): MilestoneRow[] {
  const pmap = new Map(projects.map((p) => [p.id, p]))
  const tasks = rows(ctx, 'tasks')
  return rows(ctx, 'milestones')
    .filter((m) => !m.deleted_at && pmap.has(m.project_id) && !m.achieved_on && m.planned_end >= from && m.planned_end <= to)
    .map((m) => {
      const p = pmap.get(m.project_id)!
      const st = milestoneState(ctx, m, tasks)
      return { id: m.id, project_id: p.id, project: p.name, client: p.client, label: `M${m.no} ${m.name}`, planned_end: m.planned_end, days: diffDays(m.planned_end, ctx.today), state: st.state, progress: st.progress, billing: m.billing_amount_paise, billing_status: m.billing_status }
    })
    .filter((m) => m.state !== 'achieved_on_time' && m.state !== 'achieved_late')
    .sort((a, b) => a.planned_end.localeCompare(b.planned_end))
}

function taskRow(ctx: Ctx, t: E.Task, maps: { projects: Map<string, E.Project>; ms: Map<string, E.Milestone>; users: Map<string, E.User>; act: Map<string, { hours: number }> }, reason?: string): TaskRow {
  const owner = t.owner_id ? maps.users.get(t.owner_id) : undefined
  return {
    id: t.id, code: taskCode(t.milestone_id ? maps.ms.get(t.milestone_id) : undefined, t), title: t.title, project_id: t.project_id, project: maps.projects.get(t.project_id)?.name ?? '—',
    owner_id: t.owner_id, owner: owner?.name ?? null, owner_hue: owner?.avatar_hue ?? 150, status: t.status, due_on: t.due_on, days: diffDays(t.due_on, ctx.today), est: t.est_hours, actual: r1(maps.act.get(t.id)?.hours ?? 0), ...(reason ? { reason } : {}),
  }
}
function maps(ctx: Ctx) {
  return { projects: new Map(rows(ctx, 'projects').map((p) => [p.id, p])), ms: new Map(rows(ctx, 'milestones').map((m) => [m.id, m])), users: usersMap(ctx), act: taskActuals(ctx) }
}

/** Cash on hand = opening cash + received − paid (mirrors the finance module). */
function cashPosition(ctx: Ctx) {
  const opening = S(ctx)['finance.opening_cash_paise'] ?? 0
  const all = rows(ctx, 'ledger_entries')
  const start = all.reduce((m, e) => (e.date < m ? e.date : m), ctx.today)
  let inflow = 0, outflow = 0
  for (const e of expandLedger(ctx, start, ctx.today)) {
    if (e.kind === 'income' && !e.invoice_id && e.status === 'received') inflow += e.amount_paise
    if (e.kind === 'expense' && e.status === 'paid') outflow += e.amount_paise
  }
  for (const p of rows(ctx, 'payments')) if (p.paid_on <= ctx.today) inflow += p.amount_paise
  const balance = opening + inflow - outflow
  const last3 = [1, 2, 3].map((i) => monthRange(monthOf(addMonths(monthOf(ctx.today) + '-01', -i))))
  const burn = Math.round(last3.reduce((s, m) => s + revenueBetween(ctx, m.from, m.to).cost, 0) / 3)
  const rec = Math.round(last3.reduce((s, m) => s + revenueBetween(ctx, m.from, m.to).collected, 0) / 3)
  const net = burn - rec
  return { balance, monthly_burn: burn, recurring_income: rec, net_burn: net, runway_months: net > 0 ? balance / net : null, cash_positive: net <= 0 }
}

/** Approval KPI per manager (BR-11): score = −(late decisions + overdue pending) over the window. */
function approverRows(ctx: Ctx, fromMonday: string, scope?: Set<string>): ApproverRow[] {
  const users = usersMap(ctx)
  const out = new Map<string, ApproverRow>()
  for (const w of rows(ctx, 'timesheet_weeks')) {
    if (w.week_start < fromMonday || !w.approver_id || w.decided_by === w.user_id) continue
    // decisions are credited to whoever decided (a delegate counts for themselves); pending stays with the approver
    const who = (w.status === 'approved' || w.status === 'rejected') && w.decided_by ? w.decided_by : w.approver_id
    if (scope && !scope.has(who)) continue
    const ap = users.get(who)
    if (!ap) continue
    let m = out.get(ap.id)
    if (!m) out.set(ap.id, (m = { id: ap.id, name: ap.name, hue: ap.avatar_hue, pending: 0, overdue: 0, late: 0, on_time: 0, decided: 0, score: 0 }))
    if (w.status === 'approved' || w.status === 'rejected') {
      m.decided++
      if (w.late) m.late++
      else m.on_time++
    } else if (w.status === 'submitted' && w.submitted_at) {
      m.pending++
      if (ctx.today > slaDue(ctx, w.submitted_at)) m.overdue++
    }
  }
  return [...out.values()].map((m) => ({ ...m, score: -(m.late + m.overdue) })).sort((a, b) => a.score - b.score || b.pending - a.pending)
}

function dealLite(ctx: Ctx, d: E.Deal & { next_step?: string | null; next_step_on?: string | null }, nm: (id: string | null) => string | null): DealRowLite {
  return {
    id: d.id, title: d.title, client: d.client, stage: d.stage, owner: nm(d.owner_id), value: dealValue(d), weighted: Math.round(dealValue(d) * DEAL_STAGE[d.stage].chance),
    days_idle: diffDays(ctx.today, d.last_activity_on), expected_close: d.expected_close, next_step: d.next_step ?? null, next_step_on: d.next_step_on ?? null,
  }
}

function nextWorkingDays(ctx: Ctx, n: number) {
  const c = cal(ctx)
  const out: string[] = []
  let d = ctx.today
  let guard = 0
  while (out.length < n && guard++ < 60) {
    if (isWorkingDay(d, c)) out.push(d)
    d = addDays(d, 1)
  }
  return out
}

/** People a PM is responsible for: reports (direct + indirect) and anyone owning tasks on their projects. */
function pmPeople(ctx: Ctx): Set<string> {
  const team = teamOf(ctx, ctx.user.id)
  const mine = new Set(myProjects(ctx).map((p) => p.id))
  for (const t of rows(ctx, 'tasks')) if (mine.has(t.project_id) && t.owner_id) team.add(t.owner_id)
  if (has(ctx, 'people.view_all')) for (const u of rows(ctx, 'users')) if (isTimesheetUser(u)) team.add(u.id)
  team.delete(ctx.user.id)
  return team
}

/* ------------------------------------------------------------------ */
/* v5 shared delivery calculations (Feature Guide §1, §2, §14, §15)     */
/* ------------------------------------------------------------------ */
/** The week a request asks about (Monday ISO); defaults to this week. */
function weekOf(ctx: Ctx, q: unknown): string {
  const s = String(q ?? '')
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? weekStart(s) : weekStart(ctx.today)
}
const memo = new WeakMap<object, Map<string, unknown>>()
/** Per-request memo (ctx is created per request). */
function once<T>(ctx: Ctx, key: string, fn: () => T): T {
  let m = memo.get(ctx)
  if (!m) memo.set(ctx, (m = new Map()))
  if (!m.has(key)) m.set(key, fn())
  return m.get(key) as T
}
/** P50 finish date per open task (each owner's queue re-run with their typical effort ratio). */
function p50Finish(ctx: Ctx): Map<string, string> {
  return once(ctx, 'p50', () => simulate(ctx, 0.5, ratioSamples(ctx)))
}
/** Open tasks already past their target end, and open tasks not yet late whose P50 finish passes it. */
function breachSets(ctx: Ctx, scope?: Set<string>) {
  const run = p50Finish(ctx)
  const open = rows(ctx, 'tasks').filter((t) => t.status !== 'done' && (!scope || scope.has(t.project_id)))
  return {
    breached: open.filter((t) => t.due_on < ctx.today),
    forecast: open.filter((t) => t.due_on >= ctx.today && (run.get(t.id) ?? t.due_on) > t.due_on),
    run,
  }
}
/**
 * Critical tasks (KPI definitions): the task that sets its milestone's deadline (latest planned end in the
 * milestone) plus every predecessor with no float before it — a delay on any of them moves the milestone.
 */
function criticalIds(ctx: Ctx, tasks: E.Task[]): Set<string> {
  const c = cal(ctx)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const preds = new Map<string, string[]>()
  for (const d of rows(ctx, 'task_dependencies')) if (byId.has(d.task_id) && byId.has(d.depends_on_task_id)) (preds.get(d.task_id) ?? preds.set(d.task_id, []).get(d.task_id)!).push(d.depends_on_task_id)
  const groups = new Map<string, E.Task[]>()
  for (const t of tasks) {
    const k = t.milestone_id ?? `${t.project_id}:none`
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(t)
  }
  const out = new Set<string>()
  for (const g of groups.values()) {
    const end = g.reduce((m, t) => (t.due_on > m ? t.due_on : m), '0000-01-01')
    const stack = g.filter((t) => t.due_on === end)
    while (stack.length) {
      const t = stack.pop()!
      if (out.has(t.id)) continue
      out.add(t.id)
      for (const pid of preds.get(t.id) ?? []) {
        const p = byId.get(pid)!
        // float = working days strictly between the predecessor's end and this task's start
        const gap = p.due_on >= t.start_on ? 0 : workingDaysBetween(addDays(p.due_on, 1), addDays(t.start_on, -1), c)
        if (gap <= 0) stack.push(p)
      }
    }
  }
  return out
}
/** Earned progress of a set of tasks: Σ(est × progress) ÷ Σ est. */
function earnedPct(tasks: E.Task[]): number {
  const est = tasks.reduce((s, t) => s + t.est_hours, 0)
  return est ? tasks.reduce((s, t) => s + (t.est_hours * progressOf(t)) / 100, 0) / est : tasks.length && tasks.every((t) => t.status === 'done') ? 1 : 0
}
const productiveHours = (ctx: Ctx, u: E.User) => (typeof u.productive_hours === 'number' && u.productive_hours > 0 ? u.productive_hours : S(ctx)['team.default_productive_hours'] ?? 6)

export interface LoadHoursRow { id: string; name: string; hue: number; title: string; booked: number; capacity: number; pct: number | null; double_booked: boolean; leave_days: number; open_tasks: number }
/**
 * Resource load over the given working days: booked hours = each open task's remaining hours spread over its
 * remaining working days (overdue work lands on the first day), or the person's allocation × productive hours
 * if that is higher on a day; capacity = productive hours a day × working days, minus leave.
 */
function loadHours(ctx: Ctx, users: E.User[], days: string[]): LoadHoursRow[] {
  const c = cal(ctx)
  const act = taskActuals(ctx)
  const open = rows(ctx, 'tasks').filter((t) => t.status !== 'done' && t.owner_id)
  const leave = rows(ctx, 'leave')
  const daySet = new Set(days)
  const last = days[days.length - 1] ?? ctx.today
  return users.map((u) => {
    const prod = productiveHours(ctx, u)
    const lv = new Map(leave.filter((l) => l.user_id === u.id && daySet.has(l.date)).map((l) => [l.date, l.portion]))
    const full = new Set([...lv].filter(([, p]) => p === 'full').map(([d]) => d))
    const leaveDays = [...lv.values()].reduce((s, p) => s + (p === 'full' ? 1 : 0.5), 0)
    const capacity = Math.max(0, prod * (days.length - leaveDays))
    const perDay = new Map<string, number>()
    const mine = open.filter((t) => t.owner_id === u.id)
    for (const t of mine) {
      const rem = Math.max(0, t.est_hours - (act.get(t.id)?.hours ?? 0))
      if (rem <= 0) continue
      const from = t.start_on > ctx.today ? t.start_on : ctx.today
      if (from > last) continue
      const to = t.due_on < from ? from : t.due_on
      const span: string[] = []
      let g = 0
      for (let d = from; d <= to && g++ < 400; d = addDays(d, 1)) if (isWorkingDay(d, c) && !full.has(d)) span.push(d)
      if (!span.length) span.push(days.find((d) => d >= from && !full.has(d)) ?? from)
      const share = rem / span.length
      for (const d of span) if (daySet.has(d)) perDay.set(d, (perDay.get(d) ?? 0) + share)
    }
    let booked = 0
    for (const d of days) {
      if (full.has(d)) continue
      const alloc = (allocationOn(ctx, u.id, d) / 100) * prod
      booked += Math.max(perDay.get(d) ?? 0, alloc)
    }
    const pct = capacity > 0 ? booked / capacity : null
    return { id: u.id, name: u.name, hue: u.avatar_hue, title: u.title, booked: Math.round(booked), capacity: Math.round(capacity), pct, double_booked: pct !== null && pct > 1, leave_days: leaveDays, open_tasks: mine.length }
  })
}

export interface MentionRow { id: string; task_id: string; task_code: string; task_title: string; project: string; tag: string | null; tag_tone: Tone | null; author: string; author_hue: number; at: string; body: string }
/** Comments that @mention a person, newest first (Feature Guide §7 "Tagged you"). */
export function mentionsOf(ctx: Ctx, userId: string, limit = 10): MentionRow[] {
  const mp = maps(ctx)
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  return rows(ctx, 'comments')
    .filter((c) => (c.mentions ?? []).includes(userId) && c.author_id !== userId && tasks.has(c.task_id) && canSeeTask(ctx, tasks.get(c.task_id)!))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((c) => {
      const t = tasks.get(c.task_id)!
      const a = mp.users.get(c.author_id)
      const tag = t.tag ?? null
      return {
        id: c.id, task_id: t.id, task_code: taskCode(t.milestone_id ? mp.ms.get(t.milestone_id) : undefined, t), task_title: t.title, project: mp.projects.get(t.project_id)?.name ?? '—',
        tag: tag ? TASK_TAG[tag].label : null, tag_tone: tag ? TASK_TAG[tag].tone : null, author: a?.name ?? 'Someone', author_hue: a?.avatar_hue ?? 150, at: c.created_at, body: c.body,
      }
    })
}

export interface CoveringRow extends TaskRow { for_name: string; why: string }
/** Tasks a person covers this week: they are the backup and the owner is on leave, or a delegation hands them over. */
function coveringOf(ctx: Ctx, userId: string, wk: string): CoveringRow[] {
  const mp = maps(ctx)
  const days = weekDays(wk)
  const from = days[0]
  const to = days[days.length - 1]
  const leave = rows(ctx, 'leave').filter((l) => l.portion === 'full' && l.date >= from && l.date <= to)
  const out = new Map<string, CoveringRow>()
  for (const t of rows(ctx, 'tasks')) {
    if (t.status === 'done' || t.backup_id !== userId || !t.owner_id || t.owner_id === userId || !canSeeTask(ctx, t)) continue
    const off = leave.filter((l) => l.user_id === t.owner_id).map((l) => l.date).sort()
    if (!off.length) continue
    const owner = mp.users.get(t.owner_id)?.name ?? 'Owner'
    out.set(t.id, { ...taskRow(ctx, t, mp), for_name: owner, why: `${owner.split(' ')[0]} on leave ${off.length === 1 ? fmtDay(off[0]) : `${fmtDay(off[0])} – ${fmtDay(off[off.length - 1])}`}` })
  }
  for (const d of rows(ctx, 'delegations')) {
    if (d.to_user_id !== userId || d.include_tasks === false || d.to_on < from || d.from_on > to) continue
    const owner = mp.users.get(d.from_user_id)?.name ?? 'Colleague'
    for (const t of rows(ctx, 'tasks')) {
      // the delegation itself makes the task visible to the delegate (G7.02 / G16.05) in whichever week the header shows;
      // canSeeTask only resolves covering for the current week, so it only gates someone else looking at this person
      if (t.status === 'done' || t.owner_id !== d.from_user_id || (d.project_id && t.project_id !== d.project_id) || out.has(t.id) || (userId !== ctx.user.id && !canSeeTask(ctx, t))) continue
      if (t.due_on < from && t.start_on > to) continue
      out.set(t.id, { ...taskRow(ctx, t, mp), for_name: owner, why: `Delegated by ${owner.split(' ')[0]} ${fmtDay(d.from_on)} – ${fmtDay(d.to_on)}` })
    }
  }
  return [...out.values()].sort((a, b) => a.due_on.localeCompare(b.due_on))
}
const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

/* ------------------------------------------------------------------ */
/* CEO                                                                   */
/* ------------------------------------------------------------------ */
function ceo(ctx: Ctx, kind: PeriodKind, anchor: string, wk: string): CeoDashboard {
  if (!has(ctx, 'finance.view')) err(403, 'FORBIDDEN', 'The CEO dashboard is for admins.')
  const fyS = S(ctx)['company.fy_start_month']
  const t = ctx.today
  // headline cards: month / quarter / FY-to-date vs the comparable previous period
  const mr = monthRange(monthOf(t))
  const pm = monthRange(monthOf(addMonths(monthOf(t) + '-01', -1)))
  const q = quarterOf(t, fyS)
  const pq = quarterOf(addDays(q.from, -1), fyS)
  const fy = fyStartYear(t, fyS)
  const fyr = fyRange(fy, fyS)
  const pfy = fyRange(fy - 1, fyS)
  const days = diffDays(t, fyr.from)
  const mCur = money4(ctx, mr.from, mr.to)
  // like-for-like: the same number of days into the previous month / quarter (avoids a false −100% on day 2)
  const capAt = (from: string, to: string, n: number) => { const e = addDays(from, n); return e < to ? e : to }
  const mPrev = money4(ctx, pm.from, capAt(pm.from, pm.to, diffDays(t, mr.from)))
  const qCur = money4(ctx, q.from, q.to)
  const qPrev = money4(ctx, pq.from, capAt(pq.from, pq.to, diffDays(t, q.from)))
  // every figure counts only what is dated up to today (revenueBetween caps the range at today)
  const fCur = money4(ctx, fyr.from, fyr.to)
  const fPrev = money4(ctx, pfy.from, addDays(pfy.from, days))
  const revenue = {
    month: { ...mCur, label: `${periodRange('month', t, fyS).label} to date`, change: chg(mCur.billed, mPrev.billed), prev_label: `same days of ${periodRange('month', pm.from, fyS).label}` },
    quarter: { ...qCur, label: `${q.label} to date`, change: chg(qCur.billed, qPrev.billed), prev_label: `same days of ${pq.label}` },
    fy: { ...fCur, label: `${fyLabel(fy)} to date`, change: chg(fCur.billed, fPrev.billed), prev_label: `same days of ${fyLabel(fy - 1)}` },
  }

  // selected period table
  const pr = periodRange(kind, anchor, fyS)
  const prev = previousPeriod(kind, anchor, fyS)
  const period_rows: PeriodRow[] = []
  if (kind !== 'month') {
    for (let m = pr.from; m <= pr.to; m = addMonths(m, 1)) {
      const r = monthRange(monthOf(m))
      if (r.from > t) break
      period_rows.push({ key: monthOf(m), label: monthLabel(monthOf(m)), from: r.from, to: r.to, kind: 'sub', ...money4(ctx, r.from, r.to) })
    }
  } else {
    // weeks of the month
    for (let w = weekStart(pr.from); w <= pr.to; w = addDays(w, 7)) {
      const from = w < pr.from ? pr.from : w
      const to = addDays(w, 6) > pr.to ? pr.to : addDays(w, 6)
      if (from > t) break
      period_rows.push({ key: from, label: `${new Date(from + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(to + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, from, to, kind: 'sub', ...money4(ctx, from, to) })
    }
  }
  period_rows.push({ key: 'total', label: pr.label, from: pr.from, to: pr.to, kind: 'total', ...money4(ctx, pr.from, pr.to) })
  period_rows.push({ key: 'previous', label: prev.label, from: prev.from, to: prev.to, kind: 'previous', ...money4(ctx, prev.from, prev.to) })

  // 12 months ending in the anchor month (never beyond this month)
  const endM = monthOf(anchor > t ? t : pr.to > t ? t : pr.to)
  const months = Array.from({ length: 12 }, (_, i) => monthOf(addMonths(endM + '-01', i - 11))).map((ym) => {
    const r = monthRange(ym)
    const x = revenueBetween(ctx, r.from, r.to)
    return { key: ym, label: monthLabel(ym), billed: x.billed, collected: x.collected, cost: x.cost, net: x.net }
  })

  // streams for the FY containing the anchor (to date)
  const sfy = fyStartYear(anchor, fyS)
  const sr = fyRange(sfy, fyS)
  const bs = revenueBetween(ctx, sr.from, sr.to < t ? sr.to : t).byStream
  const streams = (Object.keys(STREAM) as E.RevenueStream[]).map((k) => ({ key: k, label: STREAM[k], value: bs[k] ?? 0 })).filter((s) => s.value > 0).sort((a, b) => b.value - a.value)

  // revenue ahead
  const live = new Set(rows(ctx, 'projects').filter((p) => !['closed', 'npa'].includes(p.status)).map((p) => p.id))
  const openMs = rows(ctx, 'milestones').filter((m) => !m.deleted_at && m.billing_status === 'none' && live.has(m.project_id) && m.billing_amount_paise > 0)
  const within = (n: number) => openMs.filter((m) => m.planned_end <= addDays(t, n)).reduce((s, m) => s + m.billing_amount_paise, 0)
  const uninvoiced = openMs.reduce((s, m) => s + m.billing_amount_paise, 0)
  const pipe = pipeline(ctx)

  // portfolio + delivery
  const cm = canSeeMargins(ctx)
  const nm = nameOf(ctx)
  const activeProjects = rows(ctx, 'projects').filter((p) => LIVE.includes(p.status))
  const projects = activeProjects.map((p) => pill(ctx, p, cm, nm)).sort((a, b) => healthOrder[a.health] - healthOrder[b.health] || a.name.localeCompare(b.name))
  const tasks = rows(ctx, 'tasks')
  const allMs = rows(ctx, 'milestones').filter((m) => !m.deleted_at)
  const achieved = allMs.filter((m) => m.achieved_on)
  const onTimeMs = achieved.filter((m) => m.achieved_on! <= m.baseline_end).length
  const spis = projects.map((p) => p.spi).filter((x): x is number => x !== null)
  const done = tasks.filter((x) => x.status === 'done' && x.done_on)
  // Average lateness (Feature Guide §2): working days late, averaged over completed tasks that finished after their target end
  const lateDays = done.filter((x) => x.done_on! > x.due_on).map((x) => workingDayVariance(ctx, x.due_on, x.done_on!)).filter((v) => v > 0)
  const liveIds = new Set(activeProjects.map((p) => p.id))
  const next10 = nextWorkingDays(ctx, 10)
  const delivery = rows(ctx, 'users').filter((u) => isTimesheetUser(u) && (u.department === 'delivery'))
  const util = delivery.length ? delivery.reduce((s, u) => s + next10.reduce((a, d) => a + allocationOn(ctx, u.id, d), 0) / next10.length, 0) / delivery.length / 100 : null

  const ms30 = milestoneRows(ctx, activeProjects, addDays(t, -3650), addDays(t, 30))
  const staleDays = S(ctx)['sales.stale_deal_days']

  /* ---- v5: fixed period table, stream shares, delivery KPIs, milestones and cash, finance highlights ---- */
  const fixed_rows: CeoDashboard['fixed_rows'] = [
    { key: 'month', label: 'This month', sub: `${periodRange('month', t, fyS).label} to date`, ...mCur, change: revenue.month.change, change_label: 'vs same days last month' },
    { key: 'quarter', label: `This quarter (${q.label})`, sub: `${q.label} to date`, ...qCur, change: revenue.quarter.change, change_label: 'vs same days last quarter' },
    { key: 'fy', label: 'This financial year', sub: `${fyLabel(fy)} to date`, ...fCur, change: revenue.fy.change, change_label: 'vs same period last year' },
  ]
  // Feature Guide §2 stream names (STREAM): SAP consulting, Products, Services, Subscriptions, AMS
  const sTotal = streams.reduce((a, x) => a + x.value, 0)
  const stream_shares = streams.map((x) => ({ key: x.key, label: x.label, value: x.value, share: sTotal ? x.value / sTotal : 0 }))
  const act = taskActuals(ctx)
  const closed = done.filter((x) => x.est_hours > 0 && (act.get(x.id)?.hours ?? 0) > 0)
  const cEst = closed.reduce((a, x) => a + x.est_hours, 0)
  const cAct = closed.reduce((a, x) => a + (act.get(x.id)?.hours ?? 0), 0)
  const br = breachSets(ctx, liveIds)
  const p50 = br.run
  const people = rows(ctx, 'users').filter(isTimesheetUser)
  const loads = loadHours(ctx, delivery.length ? delivery : people, next10)
  const capSum = loads.reduce((a, x) => a + x.capacity, 0)
  const msForecast = (m: E.Milestone) => {
    const open = tasks.filter((x) => x.milestone_id === m.id && x.status !== 'done')
    if (!open.length) return m.achieved_on ?? null
    return open.reduce((mx, x) => {
      const f = p50.get(x.id) ?? x.due_on
      return f > mx ? f : mx
    }, '0000-01-01')
  }
  const msById = new Map(allMs.map((m) => [m.id, m]))
  const milestones_30 = ms30.map((r) => {
    const m = msById.get(r.id)!
    const mine = tasks.filter((x) => x.milestone_id === m.id)
    const f = msForecast(m)
    return { ...r, code: `M${m.no}`, name: m.name, progress: earnedPct(mine), forecast: f, forecast_late: !!f && f > m.planned_end }
  })
  const liveMs = allMs.filter((m) => live.has(m.project_id))
  const achievedNotInvoiced = liveMs.filter((m) => m.billing_status === 'none' && m.billing_amount_paise > 0 && (m.achieved_on || milestoneState(ctx, m, tasks).state.startsWith('achieved'))).reduce((a, m) => a + m.billing_amount_paise, 0)
  const invoicedAwaiting = rows(ctx, 'invoices').reduce((a, i) => a + Math.max(0, i.amount_paise - i.paid_amount_paise), 0)
  const billable30 = liveMs
    .filter((m) => m.billing_status === 'none' && m.billing_amount_paise > 0 && !m.achieved_on)
    .filter((m) => {
      const f = msForecast(m)
      return !!f && f <= addDays(t, 30)
    })
    .reduce((a, m) => a + m.billing_amount_paise, 0)
  const ledgerRows = rows(ctx, 'ledger_entries')
  const thisMonth = expandLedger(ctx, mr.from, mr.to)
  const finance: CeoDashboard['finance'] = {
    pnl: months.slice(-6),
    recurring: ledgerRows
      .filter((e) => e.recurring && (!e.until_on || e.until_on >= t))
      .sort((a, b) => b.amount_paise - a.amount_paise)
      .slice(0, 8)
      .map((e) => ({ id: e.id, kind: e.kind, description: e.description, category: e.category, amount: e.amount_paise, until_on: e.until_on })),
    top_expenses: thisMonth
      .filter((e) => e.kind === 'expense')
      .sort((a, b) => b.amount_paise - a.amount_paise)
      .slice(0, 6)
      .map((e) => ({ id: `${e.id}:${e.occurrence}`, description: e.description, category: e.category, amount: e.amount_paise, date: e.occurrence })),
    month_income: thisMonth.filter((e) => e.kind === 'income').reduce((a, e) => a + e.amount_paise, 0),
    month_expense: thisMonth.filter((e) => e.kind === 'expense').reduce((a, e) => a + e.amount_paise, 0),
  }
  return {
    week: wk,
    fixed_rows,
    net_change: chg(fCur.net, fPrev.net),
    stream_shares,
    kpis: {
      cpi: cAct ? r3(cEst / cAct) : null,
      forecast_breach: br.forecast.length,
      breached_open: br.breached.length,
      red_projects: projects.filter((p) => p.health === 'off_track').length,
      active_projects: projects.length,
      team_score: teamWeekScore(ctx, people, wk),
      on_time_tasks: done.length ? done.filter((x) => x.done_on! <= x.due_on).length / done.length : null,
      done_week: done.filter((x) => x.done_on! >= wk && x.done_on! <= addDays(wk, 6)).length,
    },
    cash_ms: { on_time: achieved.length ? onTimeMs / achieved.length : null, achieved: achieved.length, achieved_not_invoiced: achievedNotInvoiced, invoiced_awaiting: invoicedAwaiting, billable_30: billable30 },
    finance,
    period: { kind, label: pr.label, from: pr.from, to: pr.to, prev_label: prev.label },
    revenue,
    period_rows,
    months,
    streams,
    streams_label: sfy === fy ? `${fyLabel(sfy)} to date` : fyLabel(sfy),
    ahead: { in_30: within(30), in_60: within(60), in_90: within(90), uninvoiced, uninvoiced_count: openMs.length, weighted_pipeline: pipe.weighted_value, open_pipeline: pipe.open_value, total: uninvoiced + pipe.weighted_value },
    projects,
    delivery: {
      milestones_on_time: achieved.length ? onTimeMs / achieved.length : null,
      milestones_achieved: achieved.length,
      milestones_on_time_count: onTimeMs,
      avg_lateness: lateDays.length ? r1(lateDays.reduce((a, b) => a + b, 0) / lateDays.length) : null,
      late_tasks: lateDays.length,
      spi: spis.length ? r3(spis.reduce((a, b) => a + b, 0) / spis.length) : null,
      overdue_tasks: tasks.filter((x) => x.status !== 'done' && x.due_on < t && liveIds.has(x.project_id)).length,
      blocked_tasks: tasks.filter((x) => x.status === 'blocked' && liveIds.has(x.project_id)).length,
      tasks_on_time: done.length ? done.filter((x) => x.done_on! <= x.due_on).length / done.length : null,
      done_4w: done.filter((x) => x.done_on! > addDays(t, -28)).length,
      done_prev_4w: done.filter((x) => x.done_on! > addDays(t, -56) && x.done_on! <= addDays(t, -28)).length,
      utilisation: capSum ? loads.reduce((a, x) => a + x.booked, 0) / capSum : util,
      at_risk_projects: projects.filter((p) => p.health !== 'on_track').length,
      active_projects: projects.length,
    },
    milestones_30,
    milestones_30_total: ms30.reduce((s, m) => s + (m.billing_status === 'none' ? m.billing : 0), 0),
    approvals: approverRows(ctx, addDays(weekStart(t), -7 * 7)),
    stale: { count: pipe.stale.length, value: pipe.stale.reduce((s, d) => s + dealValue(d), 0), stale_days: staleDays, deals: pipe.stale.map((d) => dealLite(ctx, d, nm)).sort((a, b) => b.days_idle - a.days_idle).slice(0, 6) },
    cash: cashPosition(ctx),
    can_margins: cm,
  }
}

/* ------------------------------------------------------------------ */
/* PM                                                                    */
/* ------------------------------------------------------------------ */
function pmDash(ctx: Ctx, wk: string): PmDashboard {
  if (!canDeliveryInsights(ctx)) err(403, 'FORBIDDEN', 'The delivery dashboard is for people who manage projects.')
  const t = ctx.today
  const cm = canSeeMargins(ctx)
  const nm = nameOf(ctx)
  const mine = myProjects(ctx).filter((p) => LIVE.includes(p.status))
  const mineIds = new Set(mine.map((p) => p.id))
  const projects = mine.map((p) => pill(ctx, p, cm, nm)).sort((a, b) => healthOrder[a.health] - healthOrder[b.health] || a.name.localeCompare(b.name))
  const mp = maps(ctx)
  // task lists use the same visibility rule as the Tasks screens (canSeeTask); aggregates below use allMine
  const tasks = rows(ctx, 'tasks').filter((x) => mineIds.has(x.project_id) && x.status !== 'done' && canSeeTask(ctx, x))
  const due3 = addDays(t, 3)
  const atRisk = tasks
    .filter((x) => x.status !== 'blocked' && (x.due_on < t || (x.due_on <= due3 && x.status === 'todo')))
    .map((x) => taskRow(ctx, x, mp, x.due_on < t ? `Overdue by ${diffDays(t, x.due_on)}d` : `Due ${x.due_on === t ? 'today' : `in ${diffDays(x.due_on, t)}d`}, not started`))
    .sort((a, b) => a.days - b.days)
  const blocked = tasks.filter((x) => x.status === 'blocked').map((x) => taskRow(ctx, x, mp, x.blocked_reason ?? 'Blocked')).sort((a, b) => a.days - b.days)

  // resource load: allocation % per working day for the next 10
  const people = pmPeople(ctx)
  const dates = nextWorkingDays(ctx, 10)
  const load: LoadRow[] = [...people]
    .map((id) => mp.users.get(id))
    .filter((u): u is E.User => !!u && isTimesheetUser(u) && ['employee', 'pm'].includes(u.role))
    .map((u) => {
      const ds = dates.map((d) => ({ date: d, pct: allocationOn(ctx, u.id, d) / 100 }))
      return { id: u.id, name: u.name, hue: u.avatar_hue, title: u.title, avg: ds.reduce((s, x) => s + x.pct, 0) / (ds.length || 1), days: ds }
    })
    .sort((a, b) => b.avg - a.avg)

  // approvals waiting on me
  const users = mp.users
  const entries = rows(ctx, 'timesheet_entries')
  const approvals = rows(ctx, 'timesheet_weeks')
    .filter((w) => w.status === 'submitted' && canDecide(ctx, w).ok)
    .map((w) => {
      const due = w.submitted_at ? slaDue(ctx, w.submitted_at) : null
      const u = users.get(w.user_id)
      return { id: w.id, person: u?.name ?? '—', hue: u?.avatar_hue ?? 150, week_start: w.week_start, hours: r1(entries.filter((e) => e.week_id === w.id).reduce((s, e) => s + e.hours, 0)), submitted_at: w.submitted_at, due, overdue: !!due && t > due }
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.week_start.localeCompare(b.week_start))

  const crs = rows(ctx, 'change_requests')
    .filter((c) => mineIds.has(c.project_id) && (c.status === 'raised' || c.status === 'estimated'))
    .map((c) => ({ id: c.id, project_id: c.project_id, project: mp.projects.get(c.project_id)?.name ?? '—', title: c.title, status: c.status, hours: c.hours, value: hasAny(ctx, 'change_requests.manage', 'finance.view') ? c.value_paise : null, age_days: diffDays(t, c.created_at.slice(0, 10)) }))
    .sort((a, b) => b.age_days - a.age_days)

  const compliance = [...people]
    .map((id) => users.get(id))
    .filter((u): u is E.User => !!u && isTimesheetUser(u))
    .map((u) => {
      const h = weekHistory(ctx, u.id, 8)
      const ok = h.filter((x) => x.status === 'approved' || x.status === 'submitted').length
      return { id: u.id, name: u.name, hue: u.avatar_hue, last_week: h[h.length - 1].status, weeks: h.map((x) => x.status), pct: ok / h.length }
    })
    .sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name))

  /* ---- v5 delivery control, task pipeline, resource load in hours ---- */
  const allMine = rows(ctx, 'tasks').filter((x) => mineIds.has(x.project_id))
  const crit = criticalIds(ctx, allMine)
  const run = p50Finish(ctx)
  const critRisk = tasks
    .filter((x) => crit.has(x.id) && (x.due_on < t || x.status === 'blocked' || STAGE[stageOf(x)].group === 'waiting' || (run.get(x.id) ?? x.due_on) > x.due_on))
    .map((x) => taskRow(ctx, x, mp, x.due_on < t ? `Critical · overdue by ${diffDays(t, x.due_on)}d` : STAGE[stageOf(x)].group === 'waiting' ? `Critical · ${STAGE[stageOf(x)].label.toLowerCase()}` : `Critical · forecast ${fmtDay(run.get(x.id)!)} vs target ${fmtDay(x.due_on)}`))
    .sort((a, b) => a.due_on.localeCompare(b.due_on))
  const deps = rows(ctx, 'task_dependencies')
  const byId = new Map(allMine.map((x) => [x.id, x]))
  const conflict_list: PmDashboard['control']['conflict_list'] = []
  for (const d of deps) {
    const a = byId.get(d.task_id)
    const b = byId.get(d.depends_on_task_id)
    if (!a || !b || a.status === 'done' || b.status === 'done') continue
    if (a.start_on <= b.due_on) {
      const ca = taskCode(a.milestone_id ? mp.ms.get(a.milestone_id) : undefined, a)
      const cb = taskCode(b.milestone_id ? mp.ms.get(b.milestone_id) : undefined, b)
      conflict_list.push({ id: d.id, task_id: a.id, kind: 'dependency', message: `${ca} ${a.title} starts ${fmtDay(a.start_on)} but depends on ${cb} ${b.title}, which ends ${fmtDay(b.due_on)}.` })
    }
  }
  const dates10 = nextWorkingDays(ctx, 10)
  const loadPeople = [...people, ...(has(ctx, 'timesheet.own') ? [ctx.user.id] : [])].map((id) => mp.users.get(id)).filter((u): u is E.User => !!u && isTimesheetUser(u))
  const load_hours = loadHours(ctx, [...new Map(loadPeople.map((u) => [u.id, u])).values()], dates10).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
  for (const l of load_hours) if (l.double_booked) conflict_list.push({ id: `db_${l.id}`, task_id: '', kind: 'double_booked', message: `${l.name} is double-booked: ${l.booked}h of work against ${l.capacity}h available in the next 10 working days.` })
  const control: PmDashboard['control'] = {
    active_projects: mine.filter((p) => p.status === 'active').length,
    critical_at_risk: critRisk.length,
    blocked_waiting: tasks.filter((x) => STAGE[stageOf(x)].group === 'waiting').length,
    past_start: tasks.filter((x) => STAGE[stageOf(x)].group === 'not_started' && x.start_on < t).length,
    open_bugs: tasks.filter((x) => x.tag === 'bug').length,
    in_testing: tasks.filter((x) => ['unit_testing', 'functional_testing'].includes(stageOf(x))).length,
    in_uat: tasks.filter((x) => stageOf(x) === 'uat').length,
    waiting_feedback: tasks.filter((x) => stageOf(x) === 'waiting_feedback').length,
    no_estimate: tasks.filter((x) => !(x.est_hours > 0)).length,
    conflicts: conflict_list.length,
    critical_list: critRisk.slice(0, 12),
    conflict_list, // every counted conflict is listed (count = list length)
  }
  // Task pipeline (Feature Guide §14): open tasks by stage, plus "In review" — tasks sent for approval (status in_review),
  // counted only there so the bars add up to the open tasks and a pile-up waiting for review is obvious.
  const inReview = tasks.filter((x) => x.status === 'in_review')
  const pipelineRows: PmDashboard['pipeline'] = TASK_STAGES.filter((st) => st.key !== 'completed').map((st) => ({ stage: st.key, label: st.label, count: tasks.filter((x) => x.status !== 'in_review' && stageOf(x) === st.key).length, tone: st.tone, group: st.group }))
  pipelineRows.splice(pipelineRows.findIndex((r) => r.stage === 'waiting_feedback'), 0, { stage: 'in_review', label: 'In review', count: inReview.length, tone: 'accent', group: 'review' })
  /* "Needs attention" (v7 persona round): one compact answer to "what needs me right now", each count linking to the screen that clears it. */
  const msForecastLate = rows(ctx, 'milestones').filter((m) => {
    if (m.deleted_at || m.achieved_on || !mineIds.has(m.project_id)) return false
    const open = allMine.filter((x) => x.milestone_id === m.id && x.status !== 'done')
    if (!open.length) return false
    const f = open.reduce((mx, x) => { const v = run.get(x.id) ?? x.due_on; return v > mx ? v : mx }, '0000-01-01')
    return f > m.planned_end
  }).length
  const me = ctx.user.id
  const reviewQueue = rows(ctx, 'tasks').filter((x) => x.status === 'in_review' && reviewerOf(ctx, x) === me && (x.owner_id !== me || isTop(ctx, me))).length
  const attention: PmDashboard['attention'] = [
    // "overdue" matches the Tasks tab's Overdue chip: past the target end and not waiting for review
    { key: 'overdue', label: 'Overdue tasks', count: tasks.filter((x) => x.due_on < t && x.status !== 'in_review').length, to: '/tasks?chip=overdue', hint: 'Open tasks past their target end on your projects (tasks waiting for review not counted).' },
    { key: 'blocked', label: 'Tasks blocked', count: blocked.length, to: '/insights/blocked', hint: 'Marked blocked or waiting on an open dependency.' },
    { key: 'timesheets', label: 'Timesheets waiting', count: approvals.length, to: '/approvals', hint: 'Submitted weeks waiting for your approval.' },
    { key: 'milestones', label: 'Milestones at risk', count: msForecastLate, to: '/delivery/milestones', hint: 'Open milestones whose P50 forecast finish passes the deadline.' },
    { key: 'reviews', label: 'Reviews waiting on me', count: reviewQueue, to: '/team-tasks?tab=review', hint: 'Tasks submitted for your review.' },
    { key: 'crs', label: 'CRs pending', count: crs.length, to: '/delivery/change-requests', hint: 'Change requests raised or estimated, awaiting a decision.' },
  ]
  return {
    week: wk,
    control,
    attention,
    pipeline: pipelineRows,
    done_count: allMine.filter((x) => x.status === 'done').length,
    load_hours: { from: dates10[0] ?? t, to: dates10[dates10.length - 1] ?? t, days: dates10.length, people: load_hours },
    due_week: tasks.filter((x) => x.due_on >= wk && x.due_on <= addDays(wk, 6)).length,
    projects,
    kpis: {
      active: projects.length,
      at_risk: projects.filter((p) => p.health !== 'on_track').length,
      overdue_tasks: tasks.filter((x) => x.due_on < t).length,
      blocked: blocked.length,
      due_3d: tasks.filter((x) => x.due_on >= t && x.due_on <= due3).length,
      pending_approvals: approvals.length,
      open_crs: crs.length,
      compliance: compliance.length ? compliance.reduce((s, c) => s + c.pct, 0) / compliance.length : null,
    },
    at_risk: atRisk.slice(0, 25),
    blocked,
    load: { dates, people: load },
    approvals,
    change_requests: crs,
    compliance,
    milestones: milestoneRows(ctx, mine, addDays(t, -3650), addDays(t, 45)).slice(0, 10),
  }
}

/* ------------------------------------------------------------------ */
/* Sales                                                                 */
/* ------------------------------------------------------------------ */
function salesDash(ctx: Ctx): SalesDashboard {
  if (!has(ctx, 'deals.edit_own')) err(403, 'FORBIDDEN', 'The sales dashboard is for sales and admins.')
  const t = ctx.today
  // deals.view_all → the whole pipeline; otherwise only their own deals.
  const mineOnly = !has(ctx, 'deals.view_all')
  const owner = mineOnly ? ctx.user.id : undefined
  // The team's target and variable pay are pay data (cost_rates.view); without it show their own target.
  const teamTarget = !mineOnly && canSeeSalaries(ctx)
  const nm = nameOf(ctx)
  const p = pipeline(ctx, owner)
  const deals = rows(ctx, 'deals').filter((d) => !owner || d.owner_id === owner) as (E.Deal & { next_step?: string | null; next_step_on?: string | null })[]
  const open = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost')
  const by_stage = (['lead', 'qualified', 'demo', 'proposal', 'negotiation'] as E.DealStage[]).map((s) => {
    const ds = open.filter((d) => d.stage === s)
    return { stage: s, label: DEAL_STAGE[s].label, count: ds.length, value: ds.reduce((a, d) => a + dealValue(d), 0), weighted: Math.round(ds.reduce((a, d) => a + dealValue(d) * DEAL_STAGE[s].chance, 0)) }
  })
  const staleDays = S(ctx)['sales.stale_deal_days']
  const mEnd = monthRange(monthOf(t)).to
  const needs: SalesDashboard['needs_action'] = []
  for (const d of open) {
    const lite = dealLite(ctx, d, nm)
    if (d.expected_close < t) needs.push({ ...lite, reason: 'overdue_close', reason_text: `Expected close passed ${diffDays(t, d.expected_close)}d ago — update the date or stage` })
    else if (lite.days_idle >= staleDays) needs.push({ ...lite, reason: 'stale', reason_text: `No activity for ${lite.days_idle} days` })
    else if (d.next_step_on && d.next_step_on < t) needs.push({ ...lite, reason: 'next_step', reason_text: `Next step “${d.next_step ?? 'follow-up'}” was due ${diffDays(t, d.next_step_on)}d ago` })
    else if (d.expected_close <= mEnd) needs.push({ ...lite, reason: 'closing', reason_text: `Closing this month (${new Date(d.expected_close + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})` })
  }
  const order = { overdue_close: 0, stale: 1, next_step: 2, closing: 3 }
  needs.sort((a, b) => order[a.reason] - order[b.reason] || b.value - a.value)

  let target: SalesDashboard['target'] = null
  const history: SalesDashboard['history'] = []
  const ym = monthOf(t)
  const threshold = S(ctx)['pay.variable_threshold_pct']
  if (!teamTarget) {
    const c = compFor(ctx, ctx.user.id, ym)
    target = { month_label: c.label, target: c.target, achieved: c.achieved, achievement: c.achievement, threshold_pct: threshold, hit: c.hit, variable: c.variable, variable_earned: c.variable_earned, has_rate: c.has_rate }
    for (let i = 5; i >= 0; i--) {
      const m = monthOf(addMonths(ym + '-01', -i))
      const x = compFor(ctx, ctx.user.id, m)
      history.push({ label: x.label, target: x.target, achieved: x.achieved, hit: x.hit })
    }
  } else {
    const sellers = rows(ctx, 'users').filter((u) => u.role === 'sales' && u.status === 'active')
    const agg = (m: string) => sellers.map((u) => compFor(ctx, u.id, m)).reduce((s, c) => ({ target: s.target + c.target, achieved: s.achieved + c.achieved, variable: s.variable + c.variable, earned: s.earned + c.variable_earned, label: c.label }), { target: 0, achieved: 0, variable: 0, earned: 0, label: monthLabel(m) })
    const c = agg(ym)
    const ach = c.target ? c.achieved / c.target : 0
    target = { month_label: c.label, target: c.target, achieved: c.achieved, achievement: ach, threshold_pct: threshold, hit: ach * 100 >= threshold, variable: c.variable, variable_earned: c.earned, has_rate: sellers.length > 0 }
    for (let i = 5; i >= 0; i--) {
      const m = monthOf(addMonths(ym + '-01', -i))
      const x = agg(m)
      history.push({ label: x.label, target: x.target, achieved: x.achieved, hit: x.target > 0 && (x.achieved / x.target) * 100 >= threshold })
    }
  }
  const dealMap = new Map(rows(ctx, 'deals').map((d) => [d.id, d]))
  const acts = rows(ctx, 'deal_activities').filter((a) => (!owner || a.by === owner) && dealMap.has(a.deal_id))
  const activities = [...acts]
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, 10)
    .map((a) => ({ id: a.id, date: a.date, type: a.type, deal_id: a.deal_id, deal: dealMap.get(a.deal_id)!.title, client: dealMap.get(a.deal_id)!.client, note: a.note, by: nm(a.by) }))
  return {
    scope: mineOnly ? 'mine' : 'team',
    target_scope: teamTarget ? 'team' : 'mine',
    summary: { open_value: p.open_value, weighted_value: p.weighted_value, open_count: p.open_count, won_value: p.won_value, won_count: p.won_count, win_rate: p.win_rate, avg_cycle_days: p.avg_cycle_days === null ? null : Math.round(p.avg_cycle_days), stale_count: p.stale.length },
    by_stage,
    needs_action: needs.slice(0, 12),
    target,
    history,
    activities,
    activity_30d: acts.filter((a) => a.date > addDays(t, -30)).length,
  }
}

/* ------------------------------------------------------------------ */
/* Ops                                                                   */
/* ------------------------------------------------------------------ */
function opsDash(ctx: Ctx): OpsDashboard {
  if (!has(ctx, 'ops.manage')) err(403, 'FORBIDDEN', 'The operations dashboard is for operations and admins.')
  const t = ctx.today
  const nm = nameOf(ctx)
  const open = rows(ctx, 'ops_items').filter((o) => o.status === 'open')
  const items = open
    .filter((o) => o.due_on <= addDays(t, 30))
    .map((o) => ({ id: o.id, item: o.item, category: o.category, owner: nm(o.owner_id), due_on: o.due_on, days: diffDays(o.due_on, t), recurring: o.recurring, group: (o.due_on < t ? 'overdue' : o.due_on <= addDays(t, 7) ? 'due' : 'upcoming') as 'overdue' | 'due' | 'upcoming' }))
    .sort((a, b) => a.due_on.localeCompare(b.due_on))
  const compliance = rows(ctx, 'ops_items')
    .filter((o) => o.category === 'compliance' || o.category === 'payroll' || o.category === 'finance')
    .filter((o) => o.due_on <= addDays(t, 60) && (o.status === 'open' || (o.last_done_on && o.last_done_on >= addDays(t, -30))))
    .map((o) => ({ id: o.id, item: o.item, due_on: o.due_on, days: diffDays(o.due_on, t), owner: nm(o.owner_id), status: o.status }))
    .sort((a, b) => a.due_on.localeCompare(b.due_on))
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const op = rows(ctx, 'openings').filter((o) => o.status !== 'filled')
  const users = usersMap(ctx)
  const leave_today = rows(ctx, 'leave')
    .filter((l) => l.date === t)
    .map((l) => ({ id: l.user_id, name: users.get(l.user_id)?.name ?? '—', hue: users.get(l.user_id)?.avatar_hue ?? 150, type: l.type, portion: l.portion }))
  const runs = rows(ctx, 'payroll_runs')
  const ym = monthOf(t)
  const lm = monthOf(addMonths(ym + '-01', -1))
  const runOf = (m: string) => runs.find((r) => r.month === m)
  const cur = runOf(ym)
  const last = runOf(lm)
  const people = rows(ctx, 'users').filter(isTimesheetUser)
  const lastMon = addDays(weekStart(t), -7)
  const weeks = rows(ctx, 'timesheet_weeks')
  const missing = people.filter((u) => {
    const s = effectiveWeekStatus(ctx, weeks.find((w) => w.user_id === u.id && w.week_start === lastMon), lastMon)
    return s !== 'approved' && s !== 'submitted'
  }).length
  return {
    counts: {
      overdue: items.filter((i) => i.group === 'overdue').length,
      due_7: items.filter((i) => i.group === 'due').length,
      upcoming_30: items.filter((i) => i.group === 'upcoming').length,
      openings: op.length,
      positions: op.filter((o) => o.status !== 'on_hold').reduce((s, o) => s + o.count, 0),
      on_leave_today: leave_today.length,
    },
    items,
    compliance,
    openings: op.map((o) => ({ id: o.id, role: o.role, project: o.project_id ? projects.get(o.project_id)?.name ?? null : null, count: o.count, status: o.status, needed_by: o.needed_by, owner: nm(o.owner_id) })).sort((a, b) => (a.needed_by ?? '9').localeCompare(b.needed_by ?? '9')),
    leave_today,
    payroll: {
      month: ym, label: monthLabel(ym), status: cur ? cur.status : 'not_started', run_id: cur?.id ?? null,
      last_month: { label: monthLabel(lm), status: last ? last.status : 'not_started', run_id: last?.id ?? null },
    },
    timesheets: { missing_last_week: missing, pending_approval: weeks.filter((w) => w.status === 'submitted').length, people: people.length },
  }
}

/* ------------------------------------------------------------------ */
/* Employee                                                              */
/* ------------------------------------------------------------------ */
/** People whose employee view the viewer may open: everyone (people.view_all), their team and project people (team.view / projects.edit), else only themselves. */
function viewablePeople(ctx: Ctx): E.User[] {
  const all = rows(ctx, 'users').filter((u) => isTimesheetUser(u) || u.id === ctx.user.id)
  if (has(ctx, 'people.view_all')) return all
  if (hasAny(ctx, 'team.view', 'projects.edit')) {
    const s = pmPeople(ctx)
    s.add(ctx.user.id)
    return all.filter((u) => s.has(u.id))
  }
  return all.filter((u) => u.id === ctx.user.id)
}
function employeeDash(ctx: Ctx, userQ: unknown, wkIn: string): EmployeeDashboard {
  const t = ctx.today
  const allowed = viewablePeople(ctx)
  const want = typeof userQ === 'string' && userQ ? userQ : ctx.user.id
  if (want !== ctx.user.id && !allowed.some((u) => u.id === want)) err(403, 'FORBIDDEN', 'You can only open the employee view of people in your team.')
  const person = rows(ctx, 'users').find((u) => u.id === want) ?? err(404, 'NOT_FOUND', 'That person doesn’t exist.')
  const me = person.id
  const wk = wkIn
  const mp = maps(ctx)
  const all = rows(ctx, 'tasks')
  const mine = all.filter((x) => x.owner_id === me)
  const open = mine.filter((x) => x.status !== 'done' && canSeeTask(ctx, x))
  const wkEnd = addDays(wk, 6)
  const wkFrom = wk > t ? wk : addDays(t, 1)
  const deps = rows(ctx, 'task_dependencies')
  const byId = new Map(all.map((x) => [x.id, x]))
  const today = open.filter((x) => x.due_on === t || (x.status === 'in_progress' && x.due_on >= t && x.due_on <= t)).map((x) => taskRow(ctx, x, mp))
  const week = open.filter((x) => x.due_on >= wkFrom && x.due_on <= wkEnd).map((x) => taskRow(ctx, x, mp)).sort((a, b) => a.due_on.localeCompare(b.due_on))
  const overdue = open.filter((x) => x.due_on < t).map((x) => taskRow(ctx, x, mp, `${diffDays(t, x.due_on)}d overdue`)).sort((a, b) => a.due_on.localeCompare(b.due_on))
  const blocked = open
    .filter((x) => x.status === 'blocked' || deps.some((d) => d.task_id === x.id && byId.get(d.depends_on_task_id)?.status !== 'done'))
    .map((x) => {
      const waits = deps.filter((d) => d.task_id === x.id).map((d) => byId.get(d.depends_on_task_id)).filter((p): p is E.Task => !!p && p.status !== 'done')
      return taskRow(ctx, x, mp, x.blocked_reason ?? (waits.length ? `Waiting on “${waits[0].title}” (${mp.users.get(waits[0].owner_id ?? '')?.name ?? 'unassigned'})` : 'Blocked'))
    })
  const waiting_on_me = open
    .map((x) => {
      // Feature Guide §7 (G7.05): dependencies name the task and its owner so the conversation goes to the right person.
      // Like "Blockers" above (which names the task I wait on), this names who waits on MY task even when the v7 rule
      // keeps their task out of my Tasks tab — the row itself stays mine; only the waiting task's title and owner are shown.
      const succ = deps.filter((d) => d.depends_on_task_id === x.id).map((d) => byId.get(d.task_id)).filter((s): s is E.Task => !!s && s.status !== 'done' && s.owner_id !== me)
      return { ...taskRow(ctx, x, mp), waiting: succ.map((s) => ({ id: s.id, title: s.title, owner: mp.users.get(s.owner_id ?? '')?.name ?? null })) }
    })
    .filter((x) => x.waiting.length)

  // the viewed week's timesheet
  const mon = wk
  const w = rows(ctx, 'timesheet_weeks').find((x) => x.user_id === me && x.week_start === mon)
  const es = w ? rows(ctx, 'timesheet_entries').filter((e) => e.week_id === w.id) : []
  const c = { ...cal(ctx), leaveDates: new Set(rows(ctx, 'leave').filter((l) => l.user_id === me && l.portion === 'full').map((l) => l.date)) }
  const minH = S(ctx)['calendar.min_hours_per_day']
  const days = weekDays(mon).map((d) => {
    const working = isWorkingDay(d, c)
    return { date: d, hours: r1(es.filter((e) => e.work_date === d).reduce((s, e) => s + e.hours, 0)), working, min: working ? minH : 0, future: d > t }
  })

  // delivery stats
  const act = mp.act
  const done = mine.filter((x) => x.status === 'done' && x.done_on)
  const ratios = done.filter((x) => x.est_hours > 0 && (act.get(x.id)?.hours ?? 0) > 0)
  const estSum = ratios.reduce((s, x) => s + x.est_hours, 0)
  const actSum = ratios.reduce((s, x) => s + (act.get(x.id)?.hours ?? 0), 0)
  const next10 = nextWorkingDays(ctx, 10)
  const ups = rows(ctx, 'daily_updates').filter((d) => d.user_id === me).sort((a, b) => b.date.localeCompare(a.date))
  return {
    today, week, overdue, blocked, waiting_on_me,
    timesheet: { week_start: mon, status: w ? effectiveWeekStatus(ctx, w, mon) : 'missing', total: r1(days.reduce((s, d) => s + d.hours, 0)), min_per_day: minH, expected_to_date: days.filter((d) => d.date < t && d.working).length * minH, days },
    stats: {
      effort_ratio: estSum ? r3(actSum / estSum) : null,
      on_time: done.length ? done.filter((x) => x.done_on! <= x.due_on).length / done.length : null,
      done_4w: done.filter((x) => x.done_on! > addDays(t, -28)).length,
      done_prev_4w: done.filter((x) => x.done_on! > addDays(t, -56) && x.done_on! <= addDays(t, -28)).length,
      open: open.length,
      ratio_samples: ratios.length,
      allocation_10d: next10.reduce((s, d) => s + allocationOn(ctx, me, d), 0) / (next10.length || 1) / 100,
    },
    daily: { submitted_today: ups[0]?.date === t, last_date: ups[0]?.date ?? null, proof_required: S(ctx)['daily.proof_required'] },
    ...employeeNumbers(ctx, person, wk, allowed),
  }
}
function employeeNumbers(ctx: Ctx, person: E.User, wk: string, allowed: E.User[]) {
  const t = ctx.today
  const mine = rows(ctx, 'tasks').filter((x) => x.owner_id === person.id)
  const done = mine.filter((x) => x.status === 'done' && x.done_on)
  const open = mine.filter((x) => x.status !== 'done')
  const own = ratioSamples(ctx).byPerson.get(person.id) ?? []
  // Average lateness: working days late over completed tasks that finished after their target end (open late work is "overdue")
  const late = done.filter((x) => x.done_on! > x.due_on).map((x) => workingDayVariance(ctx, x.due_on, x.done_on!)).filter((v) => v > 0)
  const load = loadHours(ctx, [person], nextWorkingDays(ctx, 10))[0]
  const sc = personWeekScore(ctx, person, wk)
  return {
    viewed_week: wk,
    person: { id: person.id, name: person.name, title: person.title, hue: person.avatar_hue },
    is_self: person.id === ctx.user.id,
    viewable: [...allowed].sort((a, b) => (a.id === ctx.user.id ? -1 : b.id === ctx.user.id ? 1 : a.name.localeCompare(b.name))).map((u) => ({ id: u.id, name: u.name, title: u.title })),
    mentions: mentionsOf(ctx, person.id),
    covering: coveringOf(ctx, person.id, wk),
    numbers: {
      score: sc.score,
      score_cells: sc.cells,
      on_time: done.length ? done.filter((x) => x.done_on! <= x.due_on).length / done.length : null,
      effort_ratio: own.length ? r3(median(own)) : null,
      utilisation: load?.pct ?? null,
      booked: load?.booked ?? 0,
      capacity: load?.capacity ?? 0,
      open: open.length,
      overdue: open.filter((x) => x.due_on < t).length,
      avg_lateness: late.length ? r1(late.reduce((a, b) => a + b, 0) / late.length) : null,
      forecast_breach: breachSets(ctx).forecast.filter((x) => x.owner_id === person.id).length,
    },
  }
}

/* ------------------------------------------------------------------ */
/* Insights                                                              */
/* ------------------------------------------------------------------ */
export type InsightViewId = 'tasks_at_risk' | 'blocked' | 'overdue_milestones' | 'effort_ratio' | 'allocation' | 'timesheet_compliance' | 'approval_kpi' | 'stale_deals' | 'predictions' | 'estimation'
export type InsightColType = 'string' | 'number' | 'money' | 'percent' | 'date' | 'hours' | 'days' | 'ratio' | 'person' | 'badge' | 'weeks' | 'task' | 'project' | 'chance' | 'deal'
export interface InsightColumn { key: string; label: string; type: InsightColType; align?: 'left' | 'right' | 'center'; hideBelow?: 'md' | 'lg' | 'xl' }
export type InsightCell = string | number | boolean | null | (string | null)[]
export interface InsightResult {
  view: InsightViewId
  title: string
  explanation: string
  kpis: { label: string; value: number | null; format: 'number' | 'money' | 'percent' | 'ratio' | 'hours' | 'days'; tone?: Tone; hint?: string }[]
  columns: InsightColumn[]
  rows: Record<string, InsightCell>[]
  empty: string
  ask: string
  sections?: { title: string; subtitle?: string; columns: InsightColumn[]; rows: Record<string, InsightCell>[]; empty: string }[]
  weeks?: string[]
  /** Heading over the main table when the view has several tables. */
  main_title?: string
}
export interface InsightTab { id: InsightViewId; label: string; count: number | null; group: 'delivery' | 'people' | 'sales' | 'prediction' }

/** projects.view_all → every live project; otherwise the projects they PM / work on. */
function scopeProjects(ctx: Ctx) {
  return myProjects(ctx).filter((p) => LIVE.includes(p.status))
}
/** people.view_all → everyone; otherwise reports + people on their projects. */
function scopePeople(ctx: Ctx): E.User[] {
  const all = rows(ctx, 'users').filter(isTimesheetUser)
  if (has(ctx, 'people.view_all')) return all
  const s = pmPeople(ctx)
  s.add(ctx.user.id)
  return all.filter((u) => s.has(u.id))
}
/** Delivery insights / PM dashboard: people who manage projects. */
function canDeliveryInsights(ctx: Ctx) {
  return hasAny(ctx, 'projects.edit', 'projects.manage_all')
}
/** Insight tabs by permission (insights.view is checked by the route): delivery views for project managers,
 *  people views for project managers and HR (people.view_all), stale deals for anyone working deals. */
function viewsFor(ctx: Ctx): InsightViewId[] {
  const out: InsightViewId[] = []
  const delivery = canDeliveryInsights(ctx)
  const people = delivery || has(ctx, 'people.view_all')
  if (delivery) out.push('tasks_at_risk', 'blocked', 'overdue_milestones', 'effort_ratio')
  if (people) out.push('allocation', 'timesheet_compliance', 'approval_kpi')
  if (has(ctx, 'deals.edit_own')) out.push('stale_deals')
  if (delivery) out.push('predictions', 'estimation')
  return out
}
const LABELS: Record<InsightViewId, [string, InsightTab['group']]> = {
  tasks_at_risk: ['Tasks at risk', 'delivery'], blocked: ['Blocked', 'delivery'], overdue_milestones: ['Overdue milestones', 'delivery'], effort_ratio: ['Effort overruns', 'delivery'],
  allocation: ['Allocation', 'people'], timesheet_compliance: ['Timesheet compliance', 'people'], approval_kpi: ['Approval KPI', 'people'], stale_deals: ['Stale deals', 'sales'],
  predictions: ['Delivery predictions', 'prediction'], estimation: ['Estimation accuracy', 'prediction'],
}

function quant(a: number[], q: number): number {
  if (!a.length) return 1
  const s = [...a].sort((x, y) => x - y)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const median = (a: number[]) => quant(a, 0.5)
const fmtPct0 = (v: number) => `${Math.round(v * 100)}%`

/** Effort-ratio samples: actual ÷ estimate on done tasks with both. */
function ratioSamples(ctx: Ctx) {
  const act = taskActuals(ctx)
  const byPerson = new Map<string, number[]>()
  const byCx = new Map<string, number[]>()
  const team: number[] = []
  for (const t of rows(ctx, 'tasks')) {
    if (t.status !== 'done' || !t.owner_id || t.est_hours <= 0) continue
    const a = act.get(t.id)?.hours ?? 0
    if (a <= 0) continue
    const r = a / t.est_hours
    team.push(r)
    if (!byPerson.has(t.owner_id)) byPerson.set(t.owner_id, [])
    byPerson.get(t.owner_id)!.push(r)
    if (!byCx.has(t.complexity)) byCx.set(t.complexity, [])
    byCx.get(t.complexity)!.push(r)
  }
  return { byPerson, byCx, team }
}

const QS = [0.2, 0.35, 0.5, 0.65, 0.8, 0.9]
/**
 * Prototype §15.1: re-run each person's queue with their own effort ratio at quantile q (person if ≥3
 * closed tasks, else team if ≥3, else 1). Tasks are worked sequentially by due date at productive
 * capacity per working day; a dependency pushes a task's start past its predecessor's finish.
 */
function simulate(ctx: Ctx, q: number, samples: ReturnType<typeof ratioSamples>) {
  const c = cal(ctx)
  const act = taskActuals(ctx)
  const cap = S(ctx)['calendar.min_hours_per_day'] * 0.7
  const ratioOf = (pid: string) => {
    const own = samples.byPerson.get(pid) ?? []
    return own.length >= 3 ? quant(own, q) : samples.team.length >= 3 ? quant(samples.team, q) : 1
  }
  const tasks = rows(ctx, 'tasks').filter((t) => t.status !== 'done')
  const deps = rows(ctx, 'task_dependencies')
  const finish = new Map<string, string>()
  const byOwner = new Map<string, E.Task[]>()
  for (const t of tasks) {
    const k = t.owner_id ?? '~'
    if (!byOwner.has(k)) byOwner.set(k, [])
    byOwner.get(k)!.push(t)
  }
  const nextWork = (d: string) => {
    let x = d
    let g = 0
    while (!isWorkingDay(x, c) && g++ < 30) x = addDays(x, 1)
    return x
  }
  const leaveOf = new Map<string, Set<string>>()
  for (const l of rows(ctx, 'leave')) if (l.portion === 'full') {
    if (!leaveOf.has(l.user_id)) leaveOf.set(l.user_id, new Set())
    leaveOf.get(l.user_id)!.add(l.date)
  }
  for (const [pid, list] of byOwner) {
    list.sort((a, b) => a.due_on.localeCompare(b.due_on) || a.start_on.localeCompare(b.start_on))
    const ratio = pid === '~' ? 1 : ratioOf(pid)
    const lv = leaveOf.get(pid) ?? new Set()
    let day = nextWork(ctx.today)
    let left = cap
    for (const t of list) {
      const st = t.start_on > day ? nextWork(t.start_on) : day
      if (st > day) {
        day = st
        left = cap
      }
      let h = Math.max(0.5, t.est_hours * ratio - (act.get(t.id)?.hours ?? 0))
      let guard = 0
      while (h > 0 && guard++ < 800) {
        if (lv.has(day)) {
          day = nextWork(addDays(day, 1))
          left = cap
          continue
        }
        const take = Math.min(h, left)
        h -= take
        left -= take
        if (h > 0) {
          day = nextWork(addDays(day, 1))
          left = cap
        }
      }
      finish.set(t.id, day)
      if (left <= 0.01) {
        day = nextWork(addDays(day, 1))
        left = cap
      }
    }
  }
  // dependency push (one ordered pass by due date)
  const order = [...tasks].sort((a, b) => a.due_on.localeCompare(b.due_on))
  for (let pass = 0; pass < 2; pass++)
    for (const t of order) {
      const preds = deps.filter((d) => d.task_id === t.id).map((d) => finish.get(d.depends_on_task_id)).filter((x): x is string => !!x)
      if (!preds.length) continue
      const pm = preds.reduce((m, x) => (x > m ? x : m))
      const cur = finish.get(t.id)!
      const remDays = Math.max(1, Math.ceil(Math.max(0.5, t.est_hours - (act.get(t.id)?.hours ?? 0)) / cap))
      let f = nextWork(addDays(pm, 1))
      for (let i = 1; i < remDays; i++) f = nextWork(addDays(f, 1))
      if (f > cur) finish.set(t.id, f)
    }
  return finish
}

function insight(ctx: Ctx, view: InsightViewId): InsightResult {
  const allowed = viewsFor(ctx)
  if (!allowed.includes(view)) err(403, 'FORBIDDEN', 'This insight isn’t available for your role.')
  const t = ctx.today
  const mp = maps(ctx)
  const projects = scopeProjects(ctx)
  const pids = new Set(projects.map((p) => p.id))
  const alert = S(ctx)['projects.effort_ratio_alert']
  const openTasks = rows(ctx, 'tasks').filter((x) => pids.has(x.project_id) && x.status !== 'done')
  const person = (id: string | null | undefined) => (id ? mp.users.get(id) : undefined)
  const taskCols: InsightColumn[] = [
    { key: 'task', label: 'Task', type: 'task' },
    { key: 'project', label: 'Project', type: 'project', hideBelow: 'lg' },
    { key: 'owner', label: 'Owner', type: 'person' },
    { key: 'status', label: 'Status', type: 'badge', hideBelow: 'md' },
    { key: 'due_on', label: 'Due', type: 'date', align: 'right' },
  ]
  const trow = (x: E.Task, extra: Record<string, InsightCell> = {}): Record<string, InsightCell> => {
    const ms = x.milestone_id ? mp.ms.get(x.milestone_id) : undefined
    const u = person(x.owner_id)
    return {
      id: x.id, task: `${taskCode(ms, x)} ${x.title}`, task_id: x.id, project: mp.projects.get(x.project_id)?.name ?? '—', project_id: x.project_id,
      owner: u?.name ?? 'Unassigned', owner_hue: u?.avatar_hue ?? 150, status: TASK_STATUS[x.status].label, status_tone: TASK_STATUS[x.status].tone, due_on: x.due_on, ...extra,
    }
  }
  const base = { view, kpis: [] as InsightResult['kpis'] }

  switch (view) {
    case 'tasks_at_risk': {
      const list = openTasks.filter((x) => x.status === 'todo' && x.due_on >= t && x.due_on <= addDays(t, 3)).sort((a, b) => a.due_on.localeCompare(b.due_on))
      const overdueNotStarted = openTasks.filter((x) => x.status === 'todo' && x.due_on < t).length
      return {
        ...base, title: 'Tasks at risk', explanation: 'Open tasks due within the next 3 days that nobody has started. Start them today, move the date, or reassign.',
        kpis: [
          { label: 'At risk', value: list.length, format: 'number', tone: list.length ? 'warning' : 'success' },
          { label: 'Estimated hours left', value: r1(list.reduce((s, x) => s + Math.max(0, x.est_hours - (mp.act.get(x.id)?.hours ?? 0)), 0)), format: 'hours' },
          { label: 'Already overdue, not started', value: overdueNotStarted, format: 'number', tone: overdueNotStarted ? 'danger' : undefined },
        ],
        columns: [...taskCols, { key: 'days', label: 'Days left', type: 'days', align: 'right' }, { key: 'est', label: 'Estimate', type: 'hours', align: 'right', hideBelow: 'lg' }],
        rows: list.map((x) => trow(x, { days: diffDays(x.due_on, t), est: x.est_hours })),
        empty: 'Nothing due in the next 3 days is waiting to start.',
        ask: 'Which tasks are due in the next 3 days and not started?',
      }
    }
    case 'blocked': {
      const deps = rows(ctx, 'task_dependencies')
      const byId = new Map(rows(ctx, 'tasks').map((x) => [x.id, x]))
      const list = openTasks.filter((x) => x.status === 'blocked')
      const since = (x: E.Task) => diffDays(t, x.updated_at.slice(0, 10))
      return {
        ...base, title: 'Blocked tasks', explanation: 'Tasks marked Blocked, with the reason and the open dependency they wait on. Clear the oldest first — each day blocked pushes the milestone.',
        kpis: [
          { label: 'Blocked', value: list.length, format: 'number', tone: list.length ? 'danger' : 'success' },
          { label: 'Hours stuck', value: r1(list.reduce((s, x) => s + x.est_hours, 0)), format: 'hours' },
          { label: 'Longest blocked', value: list.length ? Math.max(...list.map(since)) : null, format: 'days' },
        ],
        columns: [...taskCols.slice(0, 3), { key: 'reason', label: 'Reason / waiting on', type: 'string', hideBelow: 'md' }, { key: 'since', label: 'Blocked for', type: 'days', align: 'right' }, taskCols[4]],
        rows: list
          .map((x) => {
            const w = deps.filter((d) => d.task_id === x.id).map((d) => byId.get(d.depends_on_task_id)).find((p) => p && p.status !== 'done')
            return trow(x, { reason: x.blocked_reason || (w ? `Waiting on “${w.title}” (${person(w.owner_id)?.name ?? 'unassigned'})` : '—'), since: since(x) })
          })
          .sort((a, b) => (b.since as number) - (a.since as number)),
        empty: 'No blocked tasks. Nothing is waiting on anyone.',
        ask: 'What is blocked right now and why?',
      }
    }
    case 'overdue_milestones': {
      const tasks = rows(ctx, 'tasks')
      const list = rows(ctx, 'milestones')
        .filter((m) => !m.deleted_at && pids.has(m.project_id) && !m.achieved_on)
        .map((m) => ({ m, st: milestoneState(ctx, m, tasks) }))
        .filter((x) => x.st.state === 'overdue')
        .sort((a, b) => a.m.planned_end.localeCompare(b.m.planned_end))
      const billing = list.reduce((s, x) => s + (x.m.billing_status === 'none' ? x.m.billing_amount_paise : 0), 0)
      const money = has(ctx, 'finance.view') || canSeeMargins(ctx)
      return {
        ...base, title: 'Overdue milestones', explanation: 'Milestones past their planned end with work still open. Billing on these is delayed until they are achieved.',
        kpis: [
          { label: 'Overdue', value: list.length, format: 'number', tone: list.length ? 'danger' : 'success' },
          ...(money ? [{ label: 'Billing held up', value: billing, format: 'money' as const, tone: billing ? ('warning' as Tone) : undefined }] : []),
          { label: 'Open tasks inside', value: list.reduce((s, x) => s + x.st.openCount, 0), format: 'number' },
        ],
        columns: [
          { key: 'milestone', label: 'Milestone', type: 'string' }, { key: 'project', label: 'Project', type: 'project' }, { key: 'planned_end', label: 'Deadline', type: 'date', align: 'right' },
          { key: 'late', label: 'Late by', type: 'days', align: 'right' }, { key: 'progress', label: 'Progress', type: 'percent', align: 'right', hideBelow: 'md' }, { key: 'open', label: 'Open tasks', type: 'number', align: 'right', hideBelow: 'lg' },
          ...(money ? [{ key: 'billing', label: 'Billing', type: 'money' as const, align: 'right' as const }] : []),
        ],
        rows: list.map((x) => ({ id: x.m.id, milestone: `M${x.m.no} ${x.m.name}`, project: mp.projects.get(x.m.project_id)?.name ?? '—', project_id: x.m.project_id, planned_end: x.m.planned_end, late: diffDays(t, x.m.planned_end), progress: x.st.progress, open: x.st.openCount, billing: money ? x.m.billing_amount_paise : null })),
        empty: 'No milestone is past its deadline.',
        ask: 'Which milestones are overdue and how much billing is held up?',
      }
    }
    case 'effort_ratio': {
      const act = mp.act
      const list = rows(ctx, 'tasks')
        .filter((x) => pids.has(x.project_id) && x.est_hours > 0)
        .map((x) => ({ x, a: act.get(x.id)?.hours ?? 0 }))
        .filter((v) => v.a / v.x.est_hours > alert)
        .sort((a, b) => b.a / b.x.est_hours - a.a / a.x.est_hours)
      const extra = list.reduce((s, v) => s + (v.a - v.x.est_hours), 0)
      return {
        ...base, title: 'Effort overruns', explanation: `Tasks whose actual hours exceed ${alert}× the estimate (the tenant alert, projects.effort_ratio_alert). Open ones need a re-estimate; closed ones feed estimation accuracy.`,
        kpis: [
          { label: 'Tasks over alert', value: list.length, format: 'number', tone: list.length ? 'warning' : 'success' },
          { label: 'Still open', value: list.filter((v) => v.x.status !== 'done').length, format: 'number' },
          { label: 'Hours over estimate', value: r1(extra), format: 'hours', tone: extra > 0 ? 'danger' : undefined },
        ],
        columns: [taskCols[0], taskCols[1], taskCols[2], taskCols[3], { key: 'est', label: 'Estimate', type: 'hours', align: 'right', hideBelow: 'md' }, { key: 'actual', label: 'Actual', type: 'hours', align: 'right' }, { key: 'ratio', label: 'Ratio', type: 'ratio', align: 'right' }],
        rows: list.map((v) => trow(v.x, { est: v.x.est_hours, actual: r1(v.a), ratio: r3(v.a / v.x.est_hours) })),
        empty: `No task is above ${alert}× its estimate.`,
        ask: 'Which tasks are running over their estimate and by how much?',
      }
    }
    case 'allocation': {
      const next10 = nextWorkingDays(ctx, 10)
      const people = scopePeople(ctx).filter((u) => ['employee', 'pm'].includes(u.role))
      const list = people
        .map((u) => {
          const avg = next10.reduce((s, d) => s + allocationOn(ctx, u.id, d), 0) / (next10.length || 1) / 100
          const peak = Math.max(0, ...next10.map((d) => allocationOn(ctx, u.id, d))) / 100
          return { u, avg, peak, open: rows(ctx, 'tasks').filter((x) => x.owner_id === u.id && x.status !== 'done').length }
        })
        .filter((v) => v.avg < 0.8 || v.avg > 1.1)
        .sort((a, b) => b.avg - a.avg)
      const over = list.filter((v) => v.avg > 1.1)
      const under = list.filter((v) => v.avg < 0.8)
      return {
        ...base, title: 'Allocation outliers', explanation: 'People whose average allocation over the next 10 working days is under 80% (spare capacity) or over 110% (overloaded). Rebalance before the work slips.',
        kpis: [
          { label: 'Over 110%', value: over.length, format: 'number', tone: over.length ? 'danger' : 'success' },
          { label: 'Under 80%', value: under.length, format: 'number', tone: under.length ? 'warning' : 'success' },
          { label: 'People checked', value: people.length, format: 'number' },
        ],
        columns: [{ key: 'person', label: 'Person', type: 'person' }, { key: 'title', label: 'Title', type: 'string', hideBelow: 'lg' }, { key: 'avg', label: 'Avg next 10 days', type: 'percent', align: 'right' }, { key: 'peak', label: 'Peak day', type: 'percent', align: 'right', hideBelow: 'md' }, { key: 'open', label: 'Open tasks', type: 'number', align: 'right', hideBelow: 'md' }, { key: 'flag', label: 'Flag', type: 'badge' }],
        rows: list.map((v) => ({ id: v.u.id, person: v.u.name, person_hue: v.u.avatar_hue, title: v.u.title, avg: r3(v.avg), peak: r3(v.peak), open: v.open, flag: v.avg > 1.1 ? 'Overloaded' : 'Spare capacity', flag_tone: v.avg > 1.1 ? 'danger' : 'warning' })),
        empty: 'Everyone is between 80% and 110% allocated for the next 10 working days.',
        ask: 'Who is over-allocated or under-allocated in the next two weeks?',
      }
    }
    case 'timesheet_compliance': {
      const people = scopePeople(ctx)
      const endMon = addDays(weekStart(t), -7)
      const weeks = Array.from({ length: 8 }, (_, i) => addDays(endMon, -7 * (7 - i)))
      const list = people.map((u) => {
        const h = weekHistory(ctx, u.id, 8, endMon)
        const ok = h.filter((x) => x.status === 'approved' || x.status === 'submitted').length
        return { u, h, ok, pct: ok / h.length }
      })
      const avg = list.length ? list.reduce((s, v) => s + v.pct, 0) / list.length : null
      return {
        ...base, title: 'Timesheet compliance', weeks, explanation: 'Submitted or approved weeks out of the last 8 completed weeks. Locked, rejected or draft weeks count against compliance and delay payroll.',
        kpis: [
          { label: 'Team compliance', value: avg, format: 'percent', tone: avg === null ? undefined : avg >= 0.9 ? 'success' : avg >= 0.75 ? 'warning' : 'danger' },
          { label: 'Missing last week', value: list.filter((v) => !['approved', 'submitted'].includes(v.h[v.h.length - 1].status)).length, format: 'number' },
          { label: 'Fully compliant', value: list.filter((v) => v.ok === 8).length, format: 'number', tone: 'success' },
        ],
        columns: [{ key: 'person', label: 'Person', type: 'person' }, { key: 'weeks', label: 'Last 8 weeks', type: 'weeks', hideBelow: 'md' }, { key: 'missed', label: 'Missed', type: 'number', align: 'right' }, { key: 'pct', label: 'Compliance', type: 'percent', align: 'right' }],
        rows: list.sort((a, b) => a.pct - b.pct || a.u.name.localeCompare(b.u.name)).map((v) => ({ id: v.u.id, person: v.u.name, person_hue: v.u.avatar_hue, weeks: v.h.map((x) => x.status), missed: 8 - v.ok, pct: v.pct })),
        empty: 'No people in scope.',
        ask: 'Who has not submitted timesheets in the last 8 weeks?',
      }
    }
    case 'approval_kpi': {
      const scope = has(ctx, 'people.view_all') ? undefined : new Set([ctx.user.id, ...scopePeople(ctx).map((u) => u.id)])
      const list = approverRows(ctx, addDays(weekStart(t), -7 * 7), scope)
      return {
        ...base, title: 'Approval KPI', explanation: `Managers ranked by approval discipline over the last 8 weeks. Score = −(late decisions + pending past the ${S(ctx)['approval.sla_working_days']}-working-day SLA). 0 is perfect; it never blocks anyone (BR-11).`,
        kpis: [
          { label: 'Pending now', value: list.reduce((s, m) => s + m.pending, 0), format: 'number' },
          { label: 'Past SLA', value: list.reduce((s, m) => s + m.overdue, 0), format: 'number', tone: list.some((m) => m.overdue) ? 'danger' : 'success' },
          { label: 'Late decisions', value: list.reduce((s, m) => s + m.late, 0), format: 'number', tone: list.some((m) => m.late) ? 'warning' : undefined },
        ],
        columns: [{ key: 'person', label: 'Manager', type: 'person' }, { key: 'decided', label: 'Decided', type: 'number', align: 'right', hideBelow: 'md' }, { key: 'on_time', label: 'On time', type: 'number', align: 'right', hideBelow: 'md' }, { key: 'late', label: 'Late', type: 'number', align: 'right' }, { key: 'pending', label: 'Pending', type: 'number', align: 'right', hideBelow: 'md' }, { key: 'overdue', label: 'Past SLA', type: 'number', align: 'right' }, { key: 'score', label: 'Score', type: 'badge', align: 'right' }],
        rows: list.map((m) => ({ id: m.id, person: m.name, person_hue: m.hue, decided: m.decided, on_time: m.on_time, late: m.late, pending: m.pending, overdue: m.overdue, score: String(m.score), score_tone: m.score === 0 ? 'success' : m.score >= -2 ? 'warning' : 'danger' })),
        empty: 'No approvals in the last 8 weeks.',
        ask: 'Which managers approve timesheets late?',
      }
    }
    case 'stale_deals': {
      const owner = has(ctx, 'deals.view_all') ? undefined : ctx.user.id
      const p = pipeline(ctx, owner)
      const nm = nameOf(ctx)
      const list = p.stale.map((d) => dealLite(ctx, d, nm)).sort((a, b) => b.days_idle - a.days_idle)
      return {
        ...base, title: 'Stale deals', explanation: `Open deals with no logged activity for ${S(ctx)['sales.stale_deal_days']} days or more. Call, email or close them out — stale deals inflate the pipeline.`,
        kpis: [
          { label: 'Stale deals', value: list.length, format: 'number', tone: list.length ? 'warning' : 'success' },
          { label: 'Value at stake', value: list.reduce((s, d) => s + d.value, 0), format: 'money' },
          { label: 'Weighted', value: list.reduce((s, d) => s + d.weighted, 0), format: 'money' },
        ],
        columns: [{ key: 'deal', label: 'Deal', type: 'deal' }, { key: 'client', label: 'Client', type: 'string', hideBelow: 'md' }, { key: 'stage', label: 'Stage', type: 'badge' }, { key: 'owner', label: 'Owner', type: 'person', hideBelow: 'lg' }, { key: 'value', label: 'Value', type: 'money', align: 'right' }, { key: 'days_idle', label: 'Idle', type: 'days', align: 'right' }],
        rows: list.map((d) => ({ id: d.id, deal: d.title, deal_id: d.id, client: d.client, stage: DEAL_STAGE[d.stage].label, stage_tone: DEAL_STAGE[d.stage].tone, owner: d.owner, owner_hue: 150, value: d.value, days_idle: d.days_idle })),
        empty: 'Every open deal has had activity recently.',
        ask: 'Which deals have gone stale and what are they worth?',
      }
    }
    case 'predictions': {
      const samples = ratioSamples(ctx)
      const runs = QS.map((q) => simulate(ctx, q, samples))
      const p50 = runs[2]
      const p80 = runs[4]
      const tasks = rows(ctx, 'tasks')
      const c = cal(ctx)
      const endOf = (ids: string[], run: Map<string, string>) => ids.reduce<string | null>((m, id) => {
        const f = run.get(id)
        return f && (!m || f > m) ? f : m
      }, null)
      const money = has(ctx, 'finance.view') || canSeeMargins(ctx)
      const msRows = rows(ctx, 'milestones')
        .filter((m) => !m.deleted_at && pids.has(m.project_id) && !m.achieved_on)
        .map((m) => {
          const ids = tasks.filter((x) => x.milestone_id === m.id && x.status !== 'done').map((x) => x.id)
          if (!ids.length) return null
          const e50 = endOf(ids, p50)
          const e80 = endOf(ids, p80)
          const chance = runs.filter((r) => (endOf(ids, r) ?? '') <= m.planned_end).length / runs.length
          const pname = mp.projects.get(m.project_id)?.name ?? '—'
          return { id: m.id, milestone: `${pname} M${m.no} ${m.name}`, milestone_sub: `${fmtPct0(earnedPct(tasks.filter((x) => x.milestone_id === m.id)))} done`, project: pname, project_id: m.project_id, planned_end: m.planned_end, p50: e50, p80: e80, chance, billing: money ? m.billing_amount_paise : null, open: ids.length }
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => a.planned_end.localeCompare(b.planned_end))
      const entries = costedEntries(ctx)
      const from20 = (() => {
        let d = t
        let n = 0
        let g = 0
        while (n < 20 && g++ < 60) {
          d = addDays(d, -1)
          if (isWorkingDay(d, c)) n++
        }
        return d
      })()
      const projRows = projects
        .filter((p) => !p.id.startsWith('p_general_'))
        .map((p) => {
          const mine = tasks.filter((x) => x.project_id === p.id)
          const ids = mine.filter((x) => x.status !== 'done').map((x) => x.id)
          if (!ids.length) return null
          const plan = p.end_on
          const idSet = new Set(mine.map((x) => x.id))
          const recent = entries.filter((e) => e.task_id && idSet.has(e.task_id) && e.work_date >= from20 && e.work_date < t).reduce((s, e) => s + e.hours, 0)
          const remaining = mine.filter((x) => x.status !== 'done').reduce((s, x) => s + x.est_hours * (1 - progressOf(x) / 100), 0)
          const perDay = recent / 20
          let pace: string | null = null
          if (perDay > 0) {
            let d = t
            let n = Math.ceil(remaining / perDay)
            let g = 0
            while (n > 0 && g++ < 2000) {
              d = addDays(d, 1)
              if (isWorkingDay(d, c)) n--
            }
            pace = d
          }
          const weekly = Math.round(perDay * 5)
          return {
            id: p.id, project: p.name, project_id: p.id, project_sub: `${fmtPct0(earnedPct(mine))} done, ${Math.round(remaining)}h left`, planned_end: plan, p50: endOf(ids, p50), p80: endOf(ids, p80),
            pace, pace_sub: perDay > 0 ? `${weekly}h a week lately` : 'No hours logged lately', weekly, remaining: r1(remaining), progress: earnedPct(mine), chance: runs.filter((r) => (endOf(ids, r) ?? '') <= plan).length / runs.length,
          }
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => a.chance - b.chance)
      const slip = tasks
        .filter((x) => pids.has(x.project_id) && x.status !== 'done')
        .map((x) => ({ x, chance: runs.filter((r) => (r.get(x.id) ?? '') <= x.due_on).length / runs.length }))
        .filter((v) => v.chance < 0.8)
        .sort((a, b) => a.chance - b.chance || a.x.due_on.localeCompare(b.x.due_on))
        .slice(0, 12)
      const atRisk = msRows.filter((m) => m.chance < 0.5)
      return {
        ...base, title: 'Delivery predictions',
        explanation: 'Each person’s plan is re-run with their own history: P50 uses their typical effort ratio, P80 a bad-but-realistic one. Chance on time is the share of six runs (from their best 20% to worst 10% of tasks) that land by the date. Velocity-based uses the hours actually logged on the project in the last 20 working days.',
        kpis: [
          { label: 'Open milestones', value: msRows.length, format: 'number' },
          { label: 'Below 50% chance', value: atRisk.length, format: 'number', tone: atRisk.length ? 'danger' : 'success' },
          ...(money ? [{ label: 'Billing below 50% chance', value: atRisk.reduce((s, m) => s + (m.billing ?? 0), 0), format: 'money' as const, tone: 'warning' as Tone }] : []),
          { label: 'Team typical effort ratio', value: samples.team.length ? r3(median(samples.team)) : null, format: 'ratio', hint: `${samples.team.length} closed tasks with actual hours` },
        ],
        columns: [
          { key: 'project', label: 'Project', type: 'project' }, { key: 'planned_end', label: 'Planned end', type: 'date', align: 'right' }, { key: 'p50', label: 'P50', type: 'date', align: 'right' },
          { key: 'p80', label: 'P80', type: 'date', align: 'right', hideBelow: 'md' }, { key: 'pace', label: 'At current pace', type: 'date', align: 'right' }, { key: 'chance', label: 'Chance on time', type: 'chance', align: 'right' },
        ],
        rows: projRows,
        main_title: 'Projects',
        empty: 'No live projects with open work.',
        ask: 'Which milestones are unlikely to finish on time?',
        sections: [
          {
            title: 'Milestones', subtitle: 'Open milestones with their forecast finish and the billing that rides on them.',
            columns: [
              { key: 'milestone', label: 'Milestone', type: 'string' }, { key: 'planned_end', label: 'Deadline', type: 'date', align: 'right' },
              { key: 'p50', label: 'P50', type: 'date', align: 'right' }, { key: 'p80', label: 'P80', type: 'date', align: 'right', hideBelow: 'md' }, { key: 'chance', label: 'Chance on time', type: 'chance', align: 'right' },
              ...(money ? [{ key: 'billing', label: 'Billing at stake', type: 'money' as const, align: 'right' as const, hideBelow: 'md' as const }] : []),
            ],
            rows: msRows, empty: 'No open milestones with open tasks.',
          },
          {
            title: 'Tasks most likely to slip', subtitle: 'Open tasks below an 80% chance of finishing by their target, with the owner and their backup.',
            columns: [{ key: 'task', label: 'Task', type: 'task' }, { key: 'owner', label: 'Owner', type: 'person' }, { key: 'due_on', label: 'Target', type: 'date', align: 'right' }, { key: 'p50', label: 'P50', type: 'date', align: 'right', hideBelow: 'md' }, { key: 'p80', label: 'P80', type: 'date', align: 'right', hideBelow: 'md' }, { key: 'chance', label: 'Chance on time', type: 'chance', align: 'right' }],
            rows: slip.map((v) => trow(v.x, { task_sub: mp.projects.get(v.x.project_id)?.name ?? null, owner_sub: v.x.backup_id ? `backup ${person(v.x.backup_id)?.name ?? '—'}` : 'no backup', p50: p50.get(v.x.id) ?? null, p80: p80.get(v.x.id) ?? null, chance: v.chance })),
            empty: 'No open task is below an 80% chance of finishing on time.',
          },
        ],
      }
    }
    case 'estimation': {
      const s = ratioSamples(ctx)
      const people = new Set(scopePeople(ctx).map((u) => u.id))
      const act = mp.act
      const done = rows(ctx, 'tasks').filter((x) => x.status === 'done' && x.done_on)
      // The measured set: closed tasks with an owner, an estimate and actual hours — the same tasks the ratios use,
      // so "Tasks" and "On time" always describe one set (on time = finished on or before the target end).
      const measured = done.filter((x) => x.owner_id && x.est_hours > 0 && (act.get(x.id)?.hours ?? 0) > 0)
      const onTimeOf = (xs: E.Task[]) => (xs.length ? xs.filter((x) => x.done_on! <= x.due_on).length / xs.length : null)
      const action = (m: number) => (m > 1.05 ? `Add ${Math.round((m - 1) * 100)}% to estimates` : m < 0.8 ? `Estimates run ${Math.round((1 - m) * 100)}% high` : 'Estimates are sound')
      const tone = (m: number): Tone => (m <= 1.05 ? 'success' : m <= 1.3 ? 'warning' : 'danger')
      const personRows = [...s.byPerson.entries()]
        .filter(([id]) => people.has(id))
        .map(([id, a]) => {
          const u = mp.users.get(id)
          const mine = measured.filter((x) => x.owner_id === id)
          const m = median(a)
          const est = mine.reduce((acc, x) => acc + x.est_hours, 0)
          const actual = mine.reduce((acc, x) => acc + (act.get(x.id)?.hours ?? 0), 0)
          return { id, person: u?.name ?? '—', person_hue: u?.avatar_hue ?? 150, tasks: mine.length, tasks_sub: `${mine.filter((x) => x.done_on! <= x.due_on).length} on time`, typical: r3(m), typical_tone: tone(m), p80: r3(quant(a, 0.8)), on_time: onTimeOf(mine), est: r1(est), actual: r1(actual), action: action(m) }
        })
        .sort((a, b) => (b.typical as number) - (a.typical as number))
      const CX_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', very_high: 'Very high' }
      const cxRows = (['low', 'medium', 'high', 'very_high'] as E.Complexity[])
        .filter((k) => s.byCx.has(k))
        .map((k) => {
          const a = s.byCx.get(k)!
          const m = median(a)
          const mine = measured.filter((x) => x.complexity === k)
          return { id: k, complexity: CX_LABEL[k] ?? k, tasks: mine.length, tasks_sub: `${mine.filter((x) => x.done_on! <= x.due_on).length} on time`, typical: r3(m), typical_tone: tone(m), p80: r3(quant(a, 0.8)), on_time: onTimeOf(mine), action: action(m) }
        })
      const tm = s.team.length ? median(s.team) : null
      return {
        ...base, title: 'Estimation accuracy', explanation: 'Compares estimates to actual hours on closed tasks, by task complexity and by person, and suggests how much buffer to add to future estimates. Effort ratio = actual ÷ estimated hours: ×1.00 is perfect; ×1.30 means work takes 30% longer than planned, so add 30% to estimates. New task estimates are checked against this in the Tasks form.',
        kpis: [
          { label: 'Team typical ratio', value: tm === null ? null : r3(tm), format: 'ratio', tone: tm === null ? undefined : tone(tm) },
          { label: 'Team P80 ratio', value: s.team.length ? r3(quant(s.team, 0.8)) : null, format: 'ratio' },
          { label: 'Closed tasks measured', value: s.team.length, format: 'number' },
          { label: 'On time, measured tasks', value: onTimeOf(measured), format: 'percent', hint: `${measured.filter((x) => x.done_on! <= x.due_on).length} of ${measured.length} closed tasks finished on or before their target end` },
        ],
        main_title: 'By complexity',
        columns: [{ key: 'complexity', label: 'Complexity', type: 'string' }, { key: 'tasks', label: 'Tasks', type: 'number', align: 'right' }, { key: 'typical', label: 'Typical ratio', type: 'ratio', align: 'right' }, { key: 'p80', label: 'P80 ratio', type: 'ratio', align: 'right' }, { key: 'on_time', label: 'On time', type: 'percent', align: 'right' }, { key: 'action', label: 'Action', type: 'string', hideBelow: 'md' }],
        rows: cxRows,
        empty: 'No closed tasks with actual hours yet. Close tasks with honest hours to build this.',
        ask: 'How accurate are our estimates by person?',
        sections: [
          {
            title: 'By person',
            columns: [{ key: 'person', label: 'Person', type: 'person' }, { key: 'tasks', label: 'Tasks', type: 'number', align: 'right' }, { key: 'typical', label: 'Typical ratio', type: 'ratio', align: 'right' }, { key: 'p80', label: 'P80 ratio', type: 'ratio', align: 'right', hideBelow: 'md' }, { key: 'on_time', label: 'On time', type: 'percent', align: 'right', hideBelow: 'md' }, { key: 'est', label: 'Estimated', type: 'hours', align: 'right', hideBelow: 'lg' }, { key: 'actual', label: 'Actual', type: 'hours', align: 'right', hideBelow: 'lg' }, { key: 'action', label: 'Action', type: 'string', hideBelow: 'md' }],
            rows: personRows, empty: 'No closed tasks yet.',
          },
        ],
      }
    }
  }
}

function insightTabs(ctx: Ctx): InsightTab[] {
  const t = ctx.today
  const pids = new Set(scopeProjects(ctx).map((p) => p.id))
  const open = rows(ctx, 'tasks').filter((x) => pids.has(x.project_id) && x.status !== 'done')
  const alert = S(ctx)['projects.effort_ratio_alert']
  const act = taskActuals(ctx)
  const count: Partial<Record<InsightViewId, () => number>> = {
    tasks_at_risk: () => open.filter((x) => x.status === 'todo' && x.due_on >= t && x.due_on <= addDays(t, 3)).length,
    blocked: () => open.filter((x) => x.status === 'blocked').length,
    overdue_milestones: () => {
      const tasks = rows(ctx, 'tasks')
      return rows(ctx, 'milestones').filter((m) => !m.deleted_at && pids.has(m.project_id) && !m.achieved_on && milestoneState(ctx, m, tasks).state === 'overdue').length
    },
    effort_ratio: () => rows(ctx, 'tasks').filter((x) => pids.has(x.project_id) && x.est_hours > 0 && (act.get(x.id)?.hours ?? 0) / x.est_hours > alert).length,
    stale_deals: () => pipeline(ctx, has(ctx, 'deals.view_all') ? undefined : ctx.user.id).stale.length,
  }
  return viewsFor(ctx).map((id) => ({ id, label: LABELS[id][0], group: LABELS[id][1], count: count[id]?.() ?? null }))
}

/* ------------------------------------------------------------------ */
/* Weekly scorecard (Feature Guide §15, prototype §9, §14)              */
/* ------------------------------------------------------------------ */
export interface ScoreCell { key: string; label: string; value: number | null; detail: string; weight: number }
export interface ScoreRow {
  id: string; name: string; title: string; role: E.Role; role_name: string; hue: number; kind: 'delivery' | 'sales' | 'ops'
  cells: ScoreCell[]; score: number | null; trend: (number | null)[]; flags: string[]; red_twice: boolean; forecast_breach: number
}
export interface Scorecard {
  week: string; label: string; weeks: { week: string; label: string }[]; is_current: boolean; is_future: boolean
  team: { score: number | null; green: number; amber: number; red: number; none: number; trend: (number | null)[] }
  people: ScoreRow[]
  thresholds: { green: number; amber: number }
}
/** Component weights of the weekly score (shown on the Rules page). A component with nothing to measure is left out and the rest re-weighted. */
export const SCORE_WEIGHTS: Record<string, { label: string; weight: number; kind: ScoreRow['kind'] | 'all' | 'managers'; rule: string }> = {
  // Feature Guide §15: "a score for the week from on-time delivery, effort accuracy, daily updates and the Friday demo. Managers also carry their approval KPI"
  delivery: { label: 'On-time delivery', weight: 30, kind: 'delivery', rule: 'Tasks due this week finished on or before their target end ÷ tasks due this week.' },
  effort_accuracy: { label: 'Effort accuracy', weight: 15, kind: 'delivery', rule: 'Tasks closed this week: 100 − |1 − effort ratio| × 100, where effort ratio = actual ÷ estimated hours (×1.00 scores 100; ×1.25 or ×0.75 scores 75).' },
  updates: { label: 'Daily updates', weight: 15, kind: 'all', rule: 'End-of-day updates posted ÷ working days so far (proof link required when the company setting says so).' },
  demo: { label: 'Friday demo', weight: 10, kind: 'delivery', rule: 'Friday demo of working software shown this week (100) or not (0).' },
  timesheet: { label: 'Timesheet', weight: 20, kind: 'all', rule: 'Hours logged ÷ (working days × minimum hours a day); leave rows count.' },
  early_warning: { label: 'Early warning', weight: 10, kind: 'delivery', rule: 'Of the tasks that slipped (or are forecast to), the share whose slip was flagged before the due date.' },
  approvals: { label: 'Approval KPI', weight: 10, kind: 'managers', rule: 'The approval KPI (Approvals page): decisions on time ÷ (on time + lapses), where a lapse is a week decided after the deadline or still waiting past it; credited to whoever decided, including a delegate. The running week uses the last 30 days, like the Approvals page.' },
  activities: { label: 'Activities', weight: 35, kind: 'sales', rule: 'Sales activities logged ÷ 15 a week.' },
  followups: { label: 'Follow-ups', weight: 20, kind: 'sales', rule: '100 minus 25 for each overdue next step.' },
  leads: { label: 'New leads', weight: 10, kind: 'sales', rule: 'New leads created ÷ 2 a week.' },
  ops: { label: 'Duties on time', weight: 35, kind: 'ops', rule: 'Recurring duties done by their due date ÷ duties due this week.' },
}
export const SCORE_THRESHOLDS = { green: 90, amber: 75 }

function scoreFor(ctx: Ctx, u: E.User, wk: string, data: ScoreData): { cells: ScoreCell[]; score: number | null; kind: ScoreRow['kind'] } {
  const t = ctx.today
  const kind: ScoreRow['kind'] = u.role === 'sales' ? 'sales' : u.role === 'ops' ? 'ops' : 'delivery'
  if (t < wk) return { cells: [], score: null, kind }
  // Mon..Sat window; in the running week only finished days count (today is still in progress)
  const end = addDays(wk, 5) < t ? addDays(wk, 5) : addDays(t, -1) < wk ? wk : addDays(t, -1)
  const c = { ...data.cal, leaveDates: data.leave.get(u.id) }
  const minH = S(ctx)['calendar.min_hours_per_day']
  const wdays: string[] = []
  for (let d = wk; d <= end; d = addDays(d, 1)) if (isWorkingDay(d, c)) wdays.push(d)
  const cells: ScoreCell[] = []
  const W = (k: string) => SCORE_WEIGHTS[k].weight
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : null)
  // Updates: daily updates / elapsed working days
  const ups = data.updates.filter((x) => x.user_id === u.id && x.date >= wk && x.date <= end)
  const upd = pct(new Set(ups.map((x) => x.date)).size, wdays.length)
  // Timesheet: hours logged (leave counts) / expected hours
  const hrs = data.entries.filter((e) => e.user_id === u.id && e.work_date >= wk && e.work_date <= end).reduce((s, e) => s + e.hours, 0)
  const ts = pct(hrs, wdays.length * minH)
  if (kind === 'delivery') {
    const due = data.tasks.filter((x) => x.owner_id === u.id && x.due_on >= wk && x.due_on <= addDays(wk, 6) && x.due_on <= t)
    const ok = due.filter((x) => x.status === 'done' && x.done_on && x.done_on <= x.due_on).length
    const fail = due.filter((x) => (x.status === 'done' && x.done_on && x.done_on > x.due_on) || (x.status !== 'done' && x.due_on < t)).length
    cells.push({ key: 'delivery', label: 'On-time delivery', weight: W('delivery'), value: ok + fail ? Math.round((ok / (ok + fail)) * 100) : null, detail: ok + fail ? `${ok} of ${ok + fail} due tasks on time` : 'No tasks due' })
    // Effort accuracy: how close actual hours came to the estimate on tasks closed this week
    const closed = data.tasks.filter((x) => x.owner_id === u.id && x.status === 'done' && x.done_on && x.done_on >= wk && x.done_on <= addDays(wk, 6) && x.est_hours > 0 && (data.act.get(x.id)?.hours ?? 0) > 0)
    const cEst = closed.reduce((a, x) => a + x.est_hours, 0)
    const cAct = closed.reduce((a, x) => a + (data.act.get(x.id)?.hours ?? 0), 0)
    const ratio = cEst ? cAct / cEst : null
    cells.push({ key: 'effort_accuracy', label: 'Effort accuracy', weight: W('effort_accuracy'), value: ratio === null ? null : Math.max(0, Math.round(100 - Math.abs(1 - ratio) * 100)), detail: ratio === null ? 'No tasks closed' : `Effort ratio ×${ratio.toFixed(2)} on ${closed.length} closed task${closed.length === 1 ? '' : 's'}` })
    const demo = ups.some((x) => x.demo_shown) ? 100 : addDays(wk, 4) <= t ? 0 : null
    cells.push({ key: 'demo', label: 'Friday demo', weight: W('demo'), value: demo, detail: demo === 100 ? 'Friday demo shown' : demo === 0 ? 'No demo this week' : 'Friday not reached' })
    // Early warning: slips this week (late, or forecast to breach a target in this week) flagged before the due date
    const slipped = data.tasks.filter((x) => {
      if (x.owner_id !== u.id || x.due_on < wk || x.due_on > addDays(wk, 6)) return false
      if (x.status === 'done') return !!x.done_on && x.done_on > x.due_on
      return x.due_on < t || (data.p50.get(x.id) ?? x.due_on) > x.due_on
    })
    const flagged = slipped.filter((x) => x.slip_flagged_on && x.slip_flagged_on <= x.due_on).length
    cells.push({ key: 'early_warning', label: 'Early warning', weight: W('early_warning'), value: slipped.length ? Math.round((flagged / slipped.length) * 100) : null, detail: slipped.length ? `${flagged} of ${slipped.length} slips flagged early` : 'No slips this week' })
  } else if (kind === 'sales') {
    const acts = data.activities.filter((a) => a.by === u.id && a.date >= wk && a.date <= end).length
    cells.push({ key: 'activities', label: 'Activities', weight: W('activities'), value: Math.min(100, Math.round((acts / 15) * 100)), detail: `${acts} of 15 logged` })
    const myOpen = data.deals.filter((d) => d.owner_id === u.id && d.stage !== 'won' && d.stage !== 'lost') as (E.Deal & { next_step_on?: string | null })[]
    const od = myOpen.filter((d) => d.next_step_on && d.next_step_on < (end < t ? end : t)).length
    cells.push({ key: 'followups', label: 'Follow-ups', weight: W('followups'), value: myOpen.length ? Math.max(0, 100 - 25 * od) : null, detail: myOpen.length ? `${od} overdue next step${od === 1 ? '' : 's'}` : 'No open deals' })
    const leads = data.deals.filter((d) => d.owner_id === u.id && d.created_at.slice(0, 10) >= wk && d.created_at.slice(0, 10) <= end).length
    cells.push({ key: 'leads', label: 'New leads', weight: W('leads'), value: Math.min(100, leads * 50), detail: `${leads} of 2 new leads` })
  } else {
    const items = data.ops.filter((o) => o.owner_id === u.id)
    const hist = items.flatMap((o) => ((o as OpsItemX).history ?? []).filter((h) => h.due_on >= wk && h.due_on <= end))
    const onTime = hist.filter((h) => h.on_time).length
    const late = hist.length - onTime
    const missed = items.filter((o) => o.status === 'open' && o.due_on >= wk && o.due_on < t).length
    const n = onTime + late + missed
    cells.push({ key: 'ops', label: 'Duties on time', weight: W('ops'), value: n ? Math.round((onTime / n) * 100) : null, detail: n ? `${onTime} on time, ${late + missed} late or missed` : 'Nothing due' })
  }
  cells.push({ key: 'updates', label: 'Daily updates', weight: W('updates'), value: upd, detail: `${new Set(ups.map((x) => x.date)).size} of ${wdays.length} days` })
  cells.push({ key: 'timesheet', label: 'Timesheet', weight: W('timesheet'), value: ts, detail: `${r1(hrs)}h of ${wdays.length * minH}h` })
  // Managers carry their approval KPI (Feature Guide §9/§15) — the same calculation as the Approvals page
  // (src/mock/approvalKpi.ts): decisions credited to whoever decided (a delegate earns the credit); weeks still
  // waiting past the deadline count against the current approver. The running week uses the rolling 30 days the
  // Approvals page shows; a past week counts decisions made that week and weeks left waiting past the deadline.
  if (data.managers.has(u.id) || data.kpi30.has(u.id)) {
    if (wk === weekStart(t)) {
      const k = data.kpi30.get(u.id) ?? approvalKpi(ctx, u.id, 30)
      const base = k.on_time + k.lapses
      cells.push({ key: 'approvals', label: 'Approval KPI', weight: W('approvals'), value: base ? Math.round((k.on_time / base) * 100) : null, detail: base ? `${k.on_time} on time, ${k.lapses} lapse${k.lapses === 1 ? '' : 's'}${k.overdue_now ? ` (${k.overdue_now} overdue now)` : ''} · last 30 days` : 'Nothing to approve in the last 30 days' })
    } else {
      const wkEnd = addDays(wk, 6)
      const decided = data.weeks.filter((w) => (w.status === 'approved' || w.status === 'rejected') && w.decided_by === u.id && w.decided_by !== w.user_id && w.decided_at && w.decided_at.slice(0, 10) >= wk && w.decided_at.slice(0, 10) <= wkEnd)
      const late = decided.filter((w) => w.late || (!!w.submitted_at && w.decided_at!.slice(0, 10) > slaDue(ctx, w.submitted_at))).length
      const waiting = data.weeks.filter((w) => w.approver_id === u.id && w.user_id !== u.id && w.submitted_at && slaDue(ctx, w.submitted_at) < wkEnd && (w.status === 'submitted' ? true : !!w.decided_at && w.decided_at.slice(0, 10) > wkEnd)).length
      const onTime = decided.length - late
      const lapses = late + waiting
      cells.push({ key: 'approvals', label: 'Approval KPI', weight: W('approvals'), value: onTime + lapses ? Math.round((onTime / (onTime + lapses)) * 100) : null, detail: onTime + lapses ? `${onTime} on time, ${lapses} lapse${lapses === 1 ? '' : 's'}` : 'Nothing to approve' })
    }
  }
  const scored = cells.filter((x) => x.value !== null)
  const wsum = scored.reduce((s, x) => s + x.weight, 0)
  return { cells, score: wsum ? Math.round(scored.reduce((s, x) => s + x.value! * x.weight, 0) / wsum) : null, kind }
}
type OpsItemX = E.OpsItem & { history?: { due_on: string; done_on: string; period: string; on_time: boolean; by: string | null }[] }
interface ScoreData {
  cal: ReturnType<typeof cal>
  leave: Map<string, Set<string>>
  updates: E.DailyUpdate[]
  entries: E.TimesheetEntry[]
  tasks: E.Task[]
  activities: E.DealActivity[]
  deals: E.Deal[]
  ops: E.OpsItem[]
  weeks: E.TimesheetWeek[]
  managers: Set<string>
  p50: Map<string, string>
  act: Map<string, { hours: number }>
  /** approval KPI over the last 30 days (same as the Approvals page), by approver */
  kpi30: Map<string, ApprovalKpi>
}
function scoreData(ctx: Ctx): ScoreData {
  return once(ctx, 'scoredata', () => {
    const leave = new Map<string, Set<string>>()
    for (const l of rows(ctx, 'leave')) if (l.portion === 'full') {
      if (!leave.has(l.user_id)) leave.set(l.user_id, new Set())
      leave.get(l.user_id)!.add(l.date)
    }
    const users = rows(ctx, 'users').filter(isTimesheetUser)
    return {
      cal: cal(ctx), leave, updates: rows(ctx, 'daily_updates'), entries: rows(ctx, 'timesheet_entries'), tasks: rows(ctx, 'tasks'), activities: rows(ctx, 'deal_activities'), deals: rows(ctx, 'deals'), ops: rows(ctx, 'ops_items'), weeks: rows(ctx, 'timesheet_weeks'),
      managers: new Set(users.map((u) => u.reports_to_id).filter((x): x is string => !!x)), p50: p50Finish(ctx), act: taskActuals(ctx), kpi30: approvalKpis(ctx, 30),
    }
  })
}
/** Score of one person for a week (null = nothing to score yet). */
export function personWeekScore(ctx: Ctx, u: E.User, wk: string) {
  return scoreFor(ctx, u, wk, scoreData(ctx))
}
/** Average score of the given people for a week. */
function teamWeekScore(ctx: Ctx, users: E.User[], wk: string): number | null {
  const v = users.filter((u) => u.joined_on <= addDays(wk, 6)).map((u) => personWeekScore(ctx, u, wk).score).filter((x): x is number => x !== null)
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null
}

function scorecard(ctx: Ctx, weekQ: string | undefined): Scorecard {
  if (!has(ctx, 'insights.view')) err(403, 'FORBIDDEN', 'The scorecard is for managers, sales and operations.')
  const t = ctx.today
  const cur = weekStart(t)
  const wk = weekQ && /^\d{4}-\d{2}-\d{2}$/.test(weekQ) ? weekStart(weekQ) : cur
  const data = scoreData(ctx)
  const users = rows(ctx, 'users').filter(isTimesheetUser)
  let scope = scopePeople(ctx)
  // Without delivery or HR-wide access the scorecard covers their own reporting line only.
  if (!canDeliveryInsights(ctx) && !has(ctx, 'people.view_all')) {
    const s = teamOf(ctx, ctx.user.id)
    s.add(ctx.user.id)
    scope = users.filter((u) => s.has(u.id))
  }
  const forecast = breachSets(ctx).forecast
  const trendWeeks = Array.from({ length: 8 }, (_, i) => addDays(wk, -7 * (7 - i)))
  const people: ScoreRow[] = scope
    .filter((u) => u.joined_on <= addDays(wk, 6))
    .map((u) => {
      const s = scoreFor(ctx, u, wk, data)
      const trend = trendWeeks.map((w) => (u.joined_on > addDays(w, 6) ? null : scoreFor(ctx, u, w, data).score))
      const prev = trend[trend.length - 2]
      const redTwice = s.score !== null && s.score < SCORE_THRESHOLDS.amber && prev !== null && prev !== undefined && prev < SCORE_THRESHOLDS.amber
      const flags: string[] = []
      if (redTwice) flags.push('Red two weeks running: 1:1 due')
      const fb = forecast.filter((x) => x.owner_id === u.id).length
      if (fb) flags.push(`${fb} task${fb === 1 ? '' : 's'} forecast to breach`)
      const overdue = data.tasks.filter((x) => x.owner_id === u.id && x.status !== 'done' && x.due_on < t).length
      if (overdue) flags.push(`${overdue} task${overdue === 1 ? '' : 's'} overdue`)
      return { id: u.id, name: u.name, title: u.title, role: u.role, role_name: roleDef(u.tenant_id, u.role_key)?.name ?? u.title, hue: u.avatar_hue, kind: s.kind, cells: s.cells, score: s.score, trend, flags, red_twice: redTwice, forecast_breach: fb }
    })
    .sort((a, b) => (a.score ?? 999) - (b.score ?? 999) || a.name.localeCompare(b.name))
  const scored = people.filter((p) => p.score !== null)
  const teamTrend = trendWeeks.map((_, i) => {
    const v = people.map((p) => p.trend[i]).filter((x): x is number => x !== null)
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null
  })
  const label = (w: string) => `${fmtDay(w)} – ${fmtDay(addDays(w, 6))}`
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(cur, -7 * i)).map((w) => ({ week: w, label: label(w) }))
  return {
    week: wk,
    label: label(wk),
    weeks,
    is_current: wk === cur,
    is_future: wk > cur,
    team: {
      score: scored.length ? Math.round(scored.reduce((s, p) => s + p.score!, 0) / scored.length) : null,
      green: scored.filter((p) => p.score! >= SCORE_THRESHOLDS.green).length,
      amber: scored.filter((p) => p.score! >= SCORE_THRESHOLDS.amber && p.score! < SCORE_THRESHOLDS.green).length,
      red: scored.filter((p) => p.score! < SCORE_THRESHOLDS.amber).length,
      none: people.length - scored.length,
      trend: teamTrend,
    },
    people,
    thresholds: SCORE_THRESHOLDS,
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                                */
/* ------------------------------------------------------------------ */
export function register(r: Router) {
  r.get('/dashboards/ceo', ({ ctx, query }) => {
    const kind = (['month', 'quarter', 'fy'].includes(String(query.period)) ? query.period : 'month') as PeriodKind
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(query.anchor ?? '')) ? String(query.anchor) : ctx.today
    return ceo(ctx, kind, anchor > ctx.today ? ctx.today : anchor, weekOf(ctx, query.week))
  })
  r.get('/dashboards/pm', ({ ctx, query }) => pmDash(ctx, weekOf(ctx, query.week)))
  r.get('/dashboards/sales', ({ ctx }) => salesDash(ctx))
  r.get('/dashboards/ops', ({ ctx }) => opsDash(ctx))
  r.get('/dashboards/employee', ({ ctx, query }) => employeeDash(ctx, query.user, weekOf(ctx, query.week)))
  // "Tagged you": comments that mention a person (self, or someone in the viewer's employee-view scope)
  r.get('/dashboards/mentions', ({ ctx, query }) => {
    const uid = typeof query.user === 'string' && query.user ? query.user : ctx.user.id
    if (uid !== ctx.user.id && !viewablePeople(ctx).some((u) => u.id === uid)) err(403, 'FORBIDDEN', 'You can only see mentions of people in your team.')
    return mentionsOf(ctx, uid, 20)
  })
  // Rules page: how the weekly score is built, with the live thresholds
  r.get('/rules/score', () => ({ weights: SCORE_WEIGHTS, thresholds: SCORE_THRESHOLDS }))
  r.get('/insights', ({ ctx }) => {
    if (!has(ctx, 'insights.view')) err(403, 'FORBIDDEN', 'Insights are for managers, sales and operations.')
    return insightTabs(ctx)
  })
  r.get('/insights/:view', ({ ctx, params }) => {
    if (!has(ctx, 'insights.view')) err(403, 'FORBIDDEN', 'Insights are for managers, sales and operations.')
    if (!(params.view in LABELS)) err(404, 'NOT_FOUND', 'That insight doesn’t exist.')
    return insight(ctx, params.view as InsightViewId)
  })
  r.get('/scorecard', ({ ctx, query }) => scorecard(ctx, query.week ? String(query.week) : undefined))
}

void HEALTH
void WEEK_STATUS
void workingDaysBetween
