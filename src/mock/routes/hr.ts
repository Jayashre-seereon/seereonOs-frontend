// People & HR (v3): leave requests with approval + balances, appraisal cycles and reviews (metrics from real
// work data), goals/KRAs, feedback, performance profiles, recruitment pipeline, onboarding/exit checklists,
// asset register and the HR dashboard. Every rule is enforced here; the UI only reflects it.
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import type {
  AppraisalDetail, AppraisalRow, AppraisalsView, AssetView, AssetsView, CandidateDetail, CandidateRow, ChecklistItemView, ChecklistView, CycleView, FeedbackView, GoalView,
  HrDashboard, LeaveBalance, LeaveRequestView, LeaveRequestsView, LifecycleView, Metrics, PeopleOption, PerfKpis, PerformanceProfile, RecruitmentView,
} from '@/api/hr'
import { err, find, getDb, insert, logActivity, notify, nowISO, persist, permissionsOf, remove, requireAction, requireAny, rows, uid, update, userName, usersWith, warn, type Ctx, type Router, has } from '../server'
import { avgAllocation, cal, slaDue } from '../analytics'
import { DELAY_REASON_LABEL, taskStats, taskTimeliness, teamOf } from '../performance'
import { findWeek, resolveApprover } from './timesheets'
import { advanceApproval, approvalRoute, ensureWf, startApproval, stepLabel, wfPatch, type WfState } from '../workflows'
import { addDays, addMonths, diffDays, fmtDate, fyLabel, fyRange, fyStartYear, isRealISODate, isWorkingDay, maxISO, minISO, monthOf, monthRange, parseISO, quarterOf, weekStart } from '@/domain/calendar'
import { LEAVE_TYPE } from '@/domain/labels'
import { appraisalTemplate, assertNotWorkflowManaged, checkRoutable, setAppraisalSyncHook, startWorkflow, wfLinkedAppraisals } from './workflowsV7'

const S = (ctx: Ctx) => ctx.tenant.settings
const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100
const half = (n: number) => Math.round(n * 2) / 2
const DATE_RE = { test: (s: string) => isRealISODate(s) }
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(parseISO(s).getTime())
const str = (v: unknown) => String(v ?? '').trim()
const LEAVE_TYPES: E.LeaveType[] = ['casual', 'sick', 'earned', 'compensatory', 'lwp', 'optional_holiday']

function user(ctx: Ctx, id: string | null | undefined): E.User | undefined {
  return id ? rows(ctx, 'users').find((u) => u.id === id) : undefined
}
const isHR = (ctx: Ctx) => has(ctx, 'people.manage')
const isAppraisalAdmin = (ctx: Ctx) => has(ctx, 'appraisals.manage')
/** people.view_all: HR records (leave, feedback, profiles) of everyone. */
const seesAllPeople = (ctx: Ctx) => has(ctx, 'people.view_all')
/** HR-level leave authority: may decide any pending leave request (people.manage + leave.approve). */
const leaveOverride = (ctx: Ctx) => has(ctx, 'people.manage') && has(ctx, 'leave.approve')

/** Is `viewer` anywhere above `target` in the reporting chain? */
function isAbove(ctx: Ctx, viewer: string, target: string): boolean {
  let u = user(ctx, target)
  for (let i = 0; u && i < 10; i++) {
    if (!u.reports_to_id) return false
    if (u.reports_to_id === viewer) return true
    u = user(ctx, u.reports_to_id)
  }
  return false
}
function canViewPerson(ctx: Ctx, target: string) {
  return target === ctx.user.id || seesAllPeople(ctx) || isAbove(ctx, ctx.user.id, target)
}
function hrPeople(ctx: Ctx) {
  return usersWith(ctx, 'people.manage')
}
/** All-project delegations hand over approvals; a one-project delegation covers that project's tasks only. */
function delegatorsOf(ctx: Ctx, me: string, on = ctx.today) {
  return new Set(rows(ctx, 'delegations').filter((d) => d.to_user_id === me && d.from_on <= on && d.to_on >= on && !d.project_id).map((d) => d.from_user_id))
}

/* ================================================================== */
/* Leave                                                               */
/* ================================================================== */
function policyOf(ctx: Ctx, type: E.LeaveType) {
  return rows(ctx, 'leave_policies').find((p) => p.type === type) ?? null
}
function leaveDaysOf(ls: E.Leave[]) {
  return ls.reduce((s, l) => s + (l.portion === 'half' ? 0.5 : 1), 0)
}
/** Balance of one leave type for a person in the FY that contains `asOf`. */
function balanceFor(ctx: Ctx, u: E.User, type: E.LeaveType, asOf = ctx.today, excludeRequest?: string): LeaveBalance | null {
  const p = policyOf(ctx, type)
  if (!p) return null
  const fm = S(ctx)['company.fy_start_month']
  const fy = fyStartYear(asOf, fm)
  const { from, to } = fyRange(fy, fm)
  const startMonth = u.joined_on > from ? monthOf(u.joined_on) : monthOf(from)
  const monthsIdx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7))
  const monthsInFy = Math.max(0, monthsIdx(monthOf(to)) - monthsIdx(startMonth) + 1)
  const monthsSoFar = Math.max(0, Math.min(monthsInFy, monthsIdx(monthOf(asOf)) - monthsIdx(startMonth) + 1))
  let accrued = p.accrual === 'upfront' ? half((p.annual_days * monthsInFy) / 12) : half((p.annual_days * monthsSoFar) / 12)
  // carry forward from last FY (unused, capped)
  if (p.carry_forward_max > 0 && u.joined_on < from) {
    const prev = fyRange(fy - 1, fm)
    const usedPrev = leaveDaysOf(rows(ctx, 'leave').filter((l) => l.user_id === u.id && l.type === type && l.date >= prev.from && l.date <= prev.to))
    accrued += Math.min(p.carry_forward_max, Math.max(0, p.annual_days - usedPrev))
  }
  const used = leaveDaysOf(rows(ctx, 'leave').filter((l) => l.user_id === u.id && l.type === type && l.date >= from && l.date <= to))
  const pending = rows(ctx, 'leave_requests').filter((r) => r.user_id === u.id && r.type === type && r.status === 'pending' && r.id !== excludeRequest && r.from_on >= from && r.from_on <= to).reduce((s, r) => s + r.days, 0)
  return { type, annual: p.annual_days, accrued, used, pending, remaining: r2(accrued - used - pending), accrual: p.accrual }
}

function workingDatesIn(ctx: Ctx, from: string, to: string) {
  const c = cal(ctx)
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(d, { ...c, leaveDates: undefined })) out.push(d)
  return out
}

function canDecideLeave(ctx: Ctx, r: B.LeaveRequest): { ok: boolean; via: boolean } {
  if (r.user_id === ctx.user.id || r.status !== 'pending') return { ok: false, via: false }
  if (leaveOverride(ctx)) return { ok: true, via: false }
  if (r.approver_id === ctx.user.id) return { ok: true, via: false }
  if (r.approver_id && delegatorsOf(ctx, ctx.user.id).has(r.approver_id)) return { ok: true, via: true }
  return { ok: false, via: false }
}

function leaveView(ctx: Ctx, r: B.LeaveRequest): LeaveRequestView {
  const u = user(ctx, r.user_id)
  const d = canDecideLeave(ctx, r)
  const canCancel = r.user_id === ctx.user.id && !ctx.viewAs && (r.status === 'pending' || (r.status === 'approved' && r.from_on > ctx.today))
  const pend = r.status === 'pending'
  // step_label / route are v4 workflow extras (multi-step leave chains); not in the shared type.
  return { ...r, user_name: u?.name ?? '—', user_hue: u?.avatar_hue ?? 150, approver_name: r.approver_id ? userName(ctx, r.approver_id) : null, can_approve: d.ok && !ctx.viewAs, can_cancel: canCancel, via_delegation: d.via, step_label: pend ? stepLabel(r as Partial<WfState>) : null, route: approvalRoute(ctx, r as Partial<WfState>, pend) } as LeaveRequestView
}
/** Leave routing: the tenant's leave workflow; the v3 rule (reports-to, else first admin, top person auto-approved) when it names nobody. */
function leaveLegacy(ctx: Ctx, userId: string) {
  const u = user(ctx, userId)
  return u ? resolveApprover(ctx, u) : null
}

/** Timesheet leave line for an approved leave day (mirrors the timesheet module's own behaviour). */
function writeLeaveEntry(ctx: Ctx, l: E.Leave): boolean {
  const monday = weekStart(l.date)
  let w = findWeek(ctx, l.user_id, monday)
  if (w && (w.status === 'approved' || w.status === 'submitted')) return false
  if (!w) {
    w = insert(ctx, 'timesheet_weeks', {
      id: `wk_${l.user_id.replace(/^u_/, '')}_${monday}`, user_id: l.user_id, week_start: monday, status: 'open', submitted_at: null, approver_id: null, decided_by: null, decided_at: null,
      late: false, reject_reason: null, unlock_requested_at: null, unlock_reason: null, unlock_until: null,
    } as never) as E.TimesheetWeek
  }
  const minH = S(ctx)['calendar.min_hours_per_day']
  const db = getDb()
  db.timesheet_entries = db.timesheet_entries.filter((e) => !(e.tenant_id === ctx.tenant.id && e.week_id === w!.id && e.kind === 'leave' && e.work_date === l.date))
  insert(ctx, 'timesheet_entries', { week_id: w.id, user_id: l.user_id, work_date: l.date, kind: 'leave', task_id: null, internal_code: null, leave_type: l.type, hours: l.portion === 'full' ? minH : minH / 2, note: 'Approved leave request' } as never)
  w.version += 1
  persist()
  return true
}
function removeLeaveEntry(ctx: Ctx, l: E.Leave) {
  const w = findWeek(ctx, l.user_id, weekStart(l.date))
  if (!w || w.status === 'approved') return
  const db = getDb()
  db.timesheet_entries = db.timesheet_entries.filter((e) => !(e.tenant_id === ctx.tenant.id && e.week_id === w.id && e.kind === 'leave' && e.work_date === l.date))
  w.version += 1
  persist()
}

function createLeaveRows(ctx: Ctx, r: B.LeaveRequest, approvedBy: string) {
  const existing = new Set(rows(ctx, 'leave').filter((l) => l.user_id === r.user_id).map((l) => l.date))
  let skippedWeeks = 0
  let n = 0
  for (const d of workingDatesIn(ctx, r.from_on, r.to_on)) {
    if (existing.has(d)) continue
    const l = insert(ctx, 'leave', { user_id: r.user_id, date: d, type: r.type, portion: r.portion, source: 'hr', approved_by: approvedBy } as never) as E.Leave
    if (!writeLeaveEntry(ctx, l)) skippedWeeks++
    n++
  }
  if (skippedWeeks) warn(ctx, 'LEAVE_WEEK_SUBMITTED', `${skippedWeeks} day${skippedWeeks > 1 ? 's fall' : ' falls'} in a submitted or approved timesheet week, so the timesheet line was not added there.`)
  return n
}

/* ================================================================== */
/* Performance metrics                                                 */
/* ================================================================== */
function timesheetCompliance(ctx: Ctx, u: E.User, from: string, to: string) {
  // count from when the company started using timesheets (or the person joined), whichever is later
  const adopted = rows(ctx, 'timesheet_weeks').reduce((m, w) => (w.week_start < m ? w.week_start : m), ctx.today)
  const start = weekStart(maxISO(maxISO(from, u.joined_on), adopted))
  const lastDone = addDays(weekStart(ctx.today), -1) // last completed Sunday
  const end = minISO(to, lastDone)
  const weeks = rows(ctx, 'timesheet_weeks').filter((w) => w.user_id === u.id)
  const by = new Map(weeks.map((w) => [w.week_start, w]))
  let expected = 0
  let approved = 0
  let late = 0
  for (let m = start; addDays(m, 6) <= end; m = addDays(m, 7)) {
    expected++
    const w = by.get(m)
    if (w?.status === 'approved') approved++
    if (w?.late) late++
  }
  return { expected, approved, late, pct: expected ? approved / expected : null }
}
function approvalSla(ctx: Ctx, managerId: string, from: string, to: string) {
  const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  const decided = rows(ctx, 'timesheet_weeks').filter((w) => {
    if (!w.submitted_at || !w.decided_at || w.decided_by !== managerId) return false
    const d = w.decided_at.slice(0, 10)
    if (d < from || d > to) return false
    const owner = users.get(w.user_id)
    return owner && owner.id !== managerId
  })
  if (!decided.length) return null
  return decided.filter((w) => w.decided_at!.slice(0, 10) <= slaDue(ctx, w.submitted_at!)).length / decided.length
}
function goalsOf(ctx: Ctx, userId: string, from?: string, to?: string, cycleId?: string) {
  const cycles = new Map(rows(ctx, 'appraisal_cycles').map((c) => [c.id, c]))
  return rows(ctx, 'goals').filter((g) => {
    if (g.user_id !== userId) return false
    if (cycleId) return g.cycle_id === cycleId
    if (!from || !to) return true
    const c = g.cycle_id ? cycles.get(g.cycle_id) : null
    if (c) return c.period_from <= to && c.period_to >= from
    return g.due_on >= from && g.due_on <= to
  })
}
function goalsScore(gs: B.Goal[]) {
  const counted = gs.filter((g) => g.manager_approved && g.weight > 0)
  const w = counted.reduce((s, g) => s + g.weight, 0)
  if (!w) return null
  return counted.reduce((s, g) => s + g.weight * Math.min(1, g.target ? g.current / g.target : 0), 0) / w
}
function computeMetrics(ctx: Ctx, a: B.Appraisal, c: B.AppraisalCycle): Metrics {
  const u = user(ctx, a.user_id)!
  const ts = taskStats(ctx, { userIds: [a.user_id], from: c.period_from, to: c.period_to })
  const tc = timesheetCompliance(ctx, u, c.period_from, c.period_to)
  const gs = goalsScore(goalsOf(ctx, a.user_id, undefined, undefined, c.id))
  const isMgr = rows(ctx, 'users').some((x) => x.reports_to_id === a.user_id)
  const sla = isMgr ? approvalSla(ctx, a.user_id, c.period_from, c.period_to) : null
  const scale = (x: number) => r1(Math.max(1, Math.min(5, 1 + 4 * x)))
  let scoreTasks: number | null = null
  if (ts.completed > 0 && ts.on_time_pct !== null) {
    const parts: [number, number][] = [[ts.on_time_pct, 0.6]]
    if (ts.first_pass_pct !== null) parts.push([ts.first_pass_pct, 0.2])
    if (ts.avg_quality !== null) parts.push([(ts.avg_quality - 1) / 4, 0.2])
    if (sla !== null) parts.push([sla, 0.15])
    const wsum = parts.reduce((s, p) => s + p[1], 0)
    scoreTasks = scale(parts.reduce((s, p) => s + p[0] * p[1], 0) / wsum)
  }
  const scoreTs = tc.pct === null ? null : r1(Math.max(1, scale(tc.pct) - Math.min(0.5, 0.1 * tc.late)))
  const scoreGoals = gs === null ? null : scale(gs)
  const scoreBeh = a.manager_rating
  const comps: [number | null, number][] = [[scoreGoals, c.weights.goals], [scoreTasks, c.weights.tasks], [scoreTs, c.weights.timesheets], [scoreBeh, c.weights.behaviour]]
  const avail = comps.filter((x) => x[0] !== null && x[1] > 0)
  const wsum = avail.reduce((s, x) => s + x[1], 0)
  const suggested = wsum ? r1(avail.reduce((s, x) => s + (x[0] as number) * x[1], 0) / wsum) : null
  return {
    on_time_pct: ts.on_time_pct, avg_variance_days: ts.avg_variance_days === null ? null : r2(ts.avg_variance_days), first_pass_pct: ts.first_pass_pct,
    avg_quality: ts.avg_quality === null ? null : r2(ts.avg_quality), tasks_completed: ts.completed, timesheet_compliance: tc.pct, late_submissions: tc.late,
    goals_score: gs, approval_sla_pct: sla, score_tasks: scoreTasks, score_timesheets: scoreTs, score_goals: scoreGoals, score_behaviour: scoreBeh, suggested,
  }
}

function goalView(ctx: Ctx, g: B.Goal): GoalView {
  const own = g.user_id === ctx.user.id
  const mgr = isAbove(ctx, ctx.user.id, g.user_id) || isHR(ctx)
  return {
    ...g, user_name: userName(ctx, g.user_id), progress: g.target ? g.current / g.target : 0,
    can_edit: !ctx.viewAs && (own || mgr), can_approve: !ctx.viewAs && !own && mgr && !g.manager_approved,
    // only a manager (or HR) closes a goal as achieved or missed — the same rule PATCH /goals/:id enforces
    can_close: !ctx.viewAs && mgr,
  }
}
function feedbackVisible(ctx: Ctx, f: B.Feedback) {
  if (f.from_user_id === ctx.user.id) return true
  if (f.visibility === 'public') return canViewPerson(ctx, f.to_user_id)
  if (f.visibility === 'private') return f.to_user_id === ctx.user.id
  // manager-only notes: the recipient's managers and HR, not the recipient
  return f.to_user_id !== ctx.user.id && (isAbove(ctx, ctx.user.id, f.to_user_id) || seesAllPeople(ctx))
}
function feedbackView(ctx: Ctx, f: B.Feedback): FeedbackView {
  const from = user(ctx, f.from_user_id)
  return { ...f, from_name: from?.name ?? '—', from_hue: from?.avatar_hue ?? 150, to_name: userName(ctx, f.to_user_id) }
}

/* ================================================================== */
/* Appraisals                                                          */
/* ================================================================== */
function cycleView(ctx: Ctx, c: B.AppraisalCycle): CycleView {
  const counts = { not_started: 0, self_pending: 0, manager_pending: 0, hr_pending: 0, completed: 0 } as Record<B.AppraisalStatus, number>
  const as = rows(ctx, 'appraisals').filter((a) => a.cycle_id === c.id)
  for (const a of as) counts[a.status]++
  return { ...c, counts, total: as.length }
}
/** A running cycle's phase follows its due dates: self review until self_due, manager review until manager_due, then HR. */
function syncCycle(ctx: Ctx, cycleId: string) {
  const c = find(ctx, 'appraisal_cycles', cycleId)
  if (c.status === 'draft' || c.status === 'closed' || c.status === 'goal_setting') return c
  const st: B.AppraisalCycleStatus = ctx.today <= c.self_due ? 'self_review' : ctx.today <= c.manager_due ? 'manager_review' : 'hr_review'
  return st !== c.status ? update(ctx, 'appraisal_cycles', c.id, { status: st }) : c
}
function sweepCycles(ctx: Ctx) {
  for (const c of rows(ctx, 'appraisal_cycles')) if (c.status !== 'draft' && c.status !== 'closed') syncCycle(ctx, c.id)
}
function dueOf(a: B.Appraisal, c: B.AppraisalCycle) {
  return a.status === 'self_pending' ? c.self_due : a.status === 'manager_pending' ? c.manager_due : a.status === 'hr_pending' ? c.hr_due : null
}
function canSeeAppraisal(ctx: Ctx, a: B.Appraisal) {
  return a.user_id === ctx.user.id || isAppraisalAdmin(ctx) || a.manager_id === ctx.user.id || isAbove(ctx, ctx.user.id, a.user_id)
}
function appraisalRow(ctx: Ctx, a: B.Appraisal, c: B.AppraisalCycle): AppraisalRow {
  const u = user(ctx, a.user_id)
  const done = a.status === 'completed'
  const m = done ? (a.metrics as unknown as Metrics) : computeMetrics(ctx, a, c)
  const own = a.user_id === ctx.user.id && !isAppraisalAdmin(ctx)
  const due = dueOf(a, c)
  return {
    id: a.id, cycle_id: a.cycle_id, user_id: a.user_id, user_name: u?.name ?? '—', user_title: u?.title ?? '', user_hue: u?.avatar_hue ?? 150, manager_id: a.manager_id, manager_name: a.manager_id ? userName(ctx, a.manager_id) : null,
    status: a.status, self_rating: a.self_rating, manager_rating: own && !done ? null : a.manager_rating, final_rating: a.final_rating, suggested: own && !done ? null : m.suggested ?? null,
    on_time_pct: m.on_time_pct ?? null, increment_pct: own && !done ? null : a.increment_pct, overdue: !!due && due < ctx.today && c.status !== 'closed', due_on: due,
  }
}
function getAppraisal(ctx: Ctx, id: string) {
  const a = find(ctx, 'appraisals', id, 'Appraisal')
  if (!canSeeAppraisal(ctx, a)) err(403, 'FORBIDDEN', 'You can only open your own appraisal or those of people who report to you.')
  return a
}

/* ================================================================== */
/* Lifecycle                                                           */
/* ================================================================== */
type Tpl = [string, string, B.ChecklistItem['owner_role'], number]
const ONBOARDING: Tpl[] = [
  ['offer_signed', 'Offer letter signed', 'ops', -7],
  ['documents', 'Documents collected (ID, PAN, bank)', 'ops', -3],
  ['laptop', 'Laptop issued (asset)', 'it', 0],
  ['accounts', 'Email & accounts created', 'it', 0],
  ['buddy', 'Buddy assigned', 'manager', 0],
  ['policies', 'Policy acknowledgements', 'employee', 3],
  ['checkin_30', '30-day check-in', 'manager', 30],
  ['checkin_60', '60-day check-in', 'manager', 60],
  ['checkin_90', '90-day check-in', 'manager', 90],
]
function offboardingItems(start: string, lastDay: string): B.ChecklistItem[] {
  const ld = diffDays(lastDay, start)
  const t: Tpl[] = [
    ['resignation', 'Resignation received', 'ops', 0],
    ['notice', 'Notice period agreed', 'manager', 2],
    ['kt', 'Knowledge transfer', 'manager', Math.max(2, ld - 5)],
    ['exit_interview', 'Exit interview', 'ops', Math.max(2, ld - 2)],
    ['asset_return', 'Asset return', 'it', ld],
    ['access', 'Access revoked', 'it', ld],
    ['fnf', 'Full & final settlement', 'finance', ld + 30],
    ['experience_letter', 'Experience letter issued', 'ops', ld + 7],
  ]
  return t.map(([id, label, owner_role, due_offset_days]) => ({ id, label, owner_role, due_offset_days, done_on: null, done_by: null }))
}
function onboardingItems(): B.ChecklistItem[] {
  return ONBOARDING.map(([id, label, owner_role, due_offset_days]) => ({ id, label, owner_role, due_offset_days, done_on: null, done_by: null }))
}
/** A checklist's person is a user, or a pending invite (hired candidates before they accept). Relinks on acceptance. */
function personOf(ctx: Ctx, cl: B.LifecycleChecklist): { name: string; title: string; hue: number; status: 'active' | 'deactivated' | 'invited'; user: E.User | null; manager: string | null } {
  const u = user(ctx, cl.user_id)
  if (u) return { name: u.name, title: u.title, hue: u.avatar_hue, status: u.status === 'invited' ? 'invited' : u.status, user: u, manager: u.reports_to_id }
  const inv = rows(ctx, 'invites').find((i) => i.id === cl.user_id)
  if (inv) {
    const accepted = rows(ctx, 'users').find((x) => x.email.toLowerCase() === inv.email.toLowerCase())
    if (accepted) {
      cl.user_id = accepted.id
      persist()
      return personOf(ctx, cl)
    }
    return { name: inv.name, title: 'Joining · invite pending', hue: 200, status: 'invited', user: null, manager: inv.reports_to_id }
  }
  return { name: '—', title: '', hue: 150, status: 'deactivated', user: null, manager: null }
}
function deactivateUser(ctx: Ctx, u: E.User, why: string) {
  if (u.status === 'deactivated') return
  update(ctx, 'users', u.id, { status: 'deactivated' })
  const d = getDb()
  d.sessions = d.sessions.filter((s) => s.user_id !== u.id)
  persist()
  logActivity(ctx, 'user', u.id, 'deactivate', `Deactivated ${u.name} — ${why}`)
}
/** Exits take effect when the offboarding checklist is complete and the last day has passed. */
function sweepExits(ctx: Ctx) {
  for (const cl of rows(ctx, 'lifecycle_checklists')) {
    if (cl.kind !== 'offboarding' || cl.status !== 'completed' || !cl.last_day || cl.last_day > ctx.today) continue
    const u = user(ctx, cl.user_id)
    if (u && u.status === 'active') deactivateUser(ctx, u, `exit completed, last day ${fmtDate(cl.last_day, 'long')}`)
  }
}
function canToggleItem(ctx: Ctx, cl: B.LifecycleChecklist, item: B.ChecklistItem, p: ReturnType<typeof personOf>) {
  if (ctx.viewAs) return false
  if (isHR(ctx)) return true
  if (item.owner_role === 'manager') return p.manager === ctx.user.id
  if (item.owner_role === 'employee') return cl.user_id === ctx.user.id
  return false
}
function checklistView(ctx: Ctx, cl: B.LifecycleChecklist): ChecklistView {
  const p = personOf(ctx, cl)
  const items: ChecklistItemView[] = cl.items.map((i) => {
    const due = addDays(cl.start_on, i.due_offset_days)
    return { ...i, due_on: due, overdue: !i.done_on && due < ctx.today, done_by_name: i.done_by ? userName(ctx, i.done_by) : null, can_toggle: canToggleItem(ctx, cl, i, p) }
  })
  const assetsOut = p.user ? rows(ctx, 'assets').filter((a) => a.assigned_to === p.user!.id && a.status === 'assigned').length : 0
  return {
    ...cl, items, person_name: p.name, person_title: p.title, person_hue: p.hue, person_status: p.status,
    done: items.filter((i) => i.done_on).length, total: items.length, overdue: items.filter((i) => i.overdue).length, assets_out: assetsOut,
  }
}

/* ================================================================== */
/* Recruitment                                                         */
/* ================================================================== */
const STAGES: B.CandidateStage[] = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']
function hiredOn(ctx: Ctx, c: B.Candidate) {
  const l = rows(ctx, 'activity_log').find((x) => x.entity === 'candidate' && x.entity_id === c.id && x.action === 'hired')
  return (l?.at ?? c.updated_at).slice(0, 10)
}
function candidateRow(ctx: Ctx, c: B.Candidate): CandidateRow {
  const ivs = rows(ctx, 'interviews').filter((i) => i.candidate_id === c.id)
  const o = rows(ctx, 'openings').find((x) => x.id === c.opening_id)
  const next = ivs.filter((i) => i.result === 'pending' && i.scheduled_at.slice(0, 10) >= ctx.today).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0]
  const f = c.resume_file_id ? rows(ctx, 'files').find((x) => x.id === c.resume_file_id) : null
  const end = c.stage === 'hired' ? hiredOn(ctx, c) : ctx.today
  return {
    ...c, offer_ctc_paise: c.offer_ctc_paise, opening_role: o?.role ?? '—', interviews_total: ivs.length, interviews_passed: ivs.filter((i) => i.result === 'pass').length,
    next_interview: next?.scheduled_at ?? null, resume_name: f?.name ?? null, days_in_pipeline: Math.max(0, diffDays(end, c.created_at.slice(0, 10))),
  }
}
function emailTaken(ctx: Ctx, email: string) {
  const e = email.toLowerCase()
  if (rows(ctx, 'users').some((u) => u.email.toLowerCase() === e)) return 'Someone with this email already has an account.'
  if (rows(ctx, 'invites').some((i) => !i.accepted_at && i.email.toLowerCase() === e)) return 'An invite is already pending for this email.'
  return null
}

/* ================================================================== */
/* Assets                                                              */
/* ================================================================== */
function assetView(ctx: Ctx, a: B.Asset): AssetView {
  const u = user(ctx, a.assigned_to)
  const offboarding = u ? rows(ctx, 'lifecycle_checklists').some((c) => c.kind === 'offboarding' && c.user_id === u.id && c.status === 'open') : false
  return {
    ...a, assignee_name: u?.name ?? null, assignee_status: u ? (u.status === 'invited' ? 'invited' : u.status) : null,
    pending_return: a.status === 'assigned' && !!u && (u.status === 'deactivated' || offboarding), warranty_expired: !!a.warranty_until && a.warranty_until < ctx.today,
  }
}
const ASSET_CATS: B.Asset['category'][] = ['laptop', 'monitor', 'phone', 'licence', 'furniture', 'other']

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
export function register(r: Router) {
  // v7: appraisal workflows mirror their progress onto the appraisal and keep the cycle status in step
  setAppraisalSyncHook((ctx, cycleId) => void syncCycle(ctx, cycleId))
  /* Leave taken this financial year by person × type (Feature Guide §16). "Taken" counts only days up to today;
     later dates are "planned" and returned separately. Half days stay their own portion column (img-033). */
  r.get('/leave/taken', ({ ctx, query }) => {
    const hr = has(ctx, 'leave.hr_entry')
    const reports = rows(ctx, 'users').filter((u) => u.reports_to_id === ctx.user.id && u.status !== 'invited')
    const seeAll = hr || has(ctx, 'people.view_all')
    if (!seeAll && !reports.length) err(403, 'FORBIDDEN', 'The leave summary is for HR and managers.')
    const fm = S(ctx)['company.fy_start_month']
    const fyStart = query.fy ? Number(query.fy) : fyStartYear(ctx.today, fm)
    const { from, to } = fyRange(fyStart, fm)
    const minH = S(ctx)['calendar.min_hours_per_day']
    const people = (seeAll ? rows(ctx, 'users').filter((u) => u.status !== 'invited' && !u.is_super_admin) : [ctx.user, ...reports]).sort((a, b) => a.name.localeCompare(b.name))
    const leave = rows(ctx, 'leave').filter((l) => l.date >= from && l.date <= to)
    const entries = rows(ctx, 'timesheet_entries').filter((e) => e.kind === 'leave' && e.work_date >= from && e.work_date <= to && e.work_date <= ctx.today)
    const count = (ls: E.Leave[]) => ({
      by_type: Object.fromEntries(LEAVE_TYPES.map((t) => [t, ls.filter((l) => l.type === t && l.portion === 'full').length])) as Record<E.LeaveType, number>,
      half_days: ls.filter((l) => l.portion === 'half').length * 0.5,
      total: r2(ls.reduce((s2, l) => s2 + (l.portion === 'half' ? 0.5 : 1), 0)),
    })
    const out = people
      .map((u) => {
        const mine = leave.filter((l) => l.user_id === u.id)
        const taken = count(mine.filter((l) => l.date <= ctx.today))
        const later = mine.filter((l) => l.date > ctx.today).sort((a, b) => a.date.localeCompare(b.date))
        const planned = { ...count(later), dates: later.map((l) => ({ date: l.date, type: l.type, portion: l.portion })) }
        const timesheet_days = r2(entries.filter((e) => e.user_id === u.id).reduce((s2, e) => s2 + e.hours, 0) / minH)
        return { user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue }, ...taken, timesheet_days, planned }
      })
      .filter((x) => x.total > 0 || x.timesheet_days > 0 || x.planned.total > 0)
    return { fy_label: fyLabel(fyStart), from, to, as_of: ctx.today, min_hours: minH, types: LEAVE_TYPES, rows: out }
  })

  /* ---------------- leave requests ---------------- */
  r.get('/leave-requests', ({ ctx }) => {
    const me = ctx.user
    const hr = isHR(ctx)
    const all = rows(ctx, 'leave_requests').sort((a, b) => b.from_on.localeCompare(a.from_on))
    const mine = all.filter((x) => x.user_id === me.id).map((x) => leaveView(ctx, x))
    const del = delegatorsOf(ctx, me.id)
    const mineToApprove = (x: B.LeaveRequest) => x.user_id !== me.id && (x.approver_id === me.id || (!!x.approver_id && del.has(x.approver_id)))
    const to_approve = all.filter((x) => canDecideLeave(ctx, x).ok && (mineToApprove(x) || leaveOverride(ctx))).map((x) => leaveView(ctx, x))
    const team = all.filter((x) => x.user_id !== me.id && (hr || seesAllPeople(ctx) || mineToApprove(x) || isAbove(ctx, me.id, x.user_id))).slice(0, 200).map((x) => leaveView(ctx, x))
    const balances = LEAVE_TYPES.map((t) => balanceFor(ctx, me, t)).filter(Boolean) as LeaveBalance[]
    const fm = S(ctx)['company.fy_start_month']
    return {
      mine, to_approve, team, balances, policies: rows(ctx, 'leave_policies').sort((a, b) => LEAVE_TYPES.indexOf(a.type) - LEAVE_TYPES.indexOf(b.type)),
      can_manage_policy: hr && !ctx.viewAs, is_approver: rows(ctx, 'users').some((u) => u.reports_to_id === me.id && u.status === 'active') || del.size > 0 || leaveOverride(ctx),
      fy_label: fyLabel(fyStartYear(ctx.today, fm)),
    } satisfies LeaveRequestsView
  })

  r.post('/leave-requests', ({ ctx, body }) => {
    const me = find(ctx, 'users', ctx.user.id)
    const type = body.type as E.LeaveType
    if (!LEAVE_TYPES.includes(type)) err(422, 'VALIDATION', 'Choose a leave type.', 'type')
    const portion: 'full' | 'half' = body.portion === 'half' ? 'half' : 'full'
    const from = str(body.from_on)
    const to = portion === 'half' ? from : str(body.to_on || from)
    if (!isDate(from)) err(422, 'VALIDATION', 'Pick the first day of leave.', 'from_on')
    if (!isDate(to)) err(422, 'VALIDATION', 'Pick the last day of leave.', 'to_on')
    if (to < from) err(422, 'DATE_RANGE', 'The last day is before the first day.', 'to_on')
    if (diffDays(to, from) > 60) err(422, 'DATE_RANGE', 'Apply for at most 60 days at a time.', 'to_on')
    if (from < addDays(ctx.today, -30)) err(422, 'DATE_RANGE', 'Leave more than 30 days in the past has to be entered by HR.', 'from_on')
    const reason = str(body.reason)
    if (reason.length < 5) err(422, 'VALIDATION', 'Give a reason of at least 5 characters.', 'reason')
    const dates = workingDatesIn(ctx, from, to)
    if (!dates.length) err(422, 'LEAVE_INVALID', from === to ? `${fmtDate(from, 'long')} is a weekly off or holiday, so no leave is needed.` : 'Every day in that range is a weekly off or holiday.', 'from_on')
    if (type === 'optional_holiday') {
      const opt = new Set(rows(ctx, 'holidays').filter((h) => h.optional).map((h) => h.date))
      const bad = dates.find((d) => !opt.has(d))
      if (bad) err(422, 'LEAVE_INVALID', `${fmtDate(bad, 'long')} isn’t an optional holiday. Apply for an optional holiday on a date from the holiday calendar.`, 'from_on')
    }
    const days = portion === 'half' ? 0.5 : dates.length
    // overlap with other requests or recorded leave
    const clash = rows(ctx, 'leave_requests').find((x) => x.user_id === me.id && (x.status === 'pending' || x.status === 'approved') && x.from_on <= to && x.to_on >= from)
    if (clash) err(409, 'LEAVE_OVERLAP', `You already have a ${clash.status} request for ${fmtDate(clash.from_on)}${clash.to_on !== clash.from_on ? ` – ${fmtDate(clash.to_on)}` : ''}. Cancel it or pick other dates.`, 'from_on')
    const recorded = rows(ctx, 'leave').find((l) => l.user_id === me.id && dates.includes(l.date))
    if (recorded) err(409, 'LEAVE_OVERLAP', `Leave is already recorded on ${fmtDate(recorded.date, 'long')}.`, 'from_on')
    if (type !== 'lwp') {
      const b = balanceFor(ctx, me, type, maxISO(from, ctx.today))
      if (b && days > b.remaining) err(422, 'LEAVE_BALANCE', `Not enough ${LEAVE_TYPE[type].toLowerCase()} leave: ${b.remaining} day${b.remaining === 1 ? '' : 's'} left, this request needs ${days}. Pick fewer days or apply as leave without pay.`, 'type')
    }
    const wf = startApproval(ctx, 'leave', { requester_id: me.id }, resolveApprover(ctx, me))
    const approver = wf.approver_id
    const req = insert(ctx, 'leave_requests', {
      user_id: me.id, from_on: from, to_on: to, type, portion, days, reason, status: approver ? 'pending' : 'approved', approver_id: approver,
      decided_by: approver ? null : me.id, decided_at: approver ? null : nowISO(), decision_reason: approver ? null : 'Auto-approved (no manager above)',
      ...(approver ? wfPatch(wf) : {}),
    } as never) as B.LeaveRequest
    logActivity(ctx, 'leave_request', req.id, 'created', `${me.name} applied for ${days} day${days === 1 ? '' : 's'} of ${LEAVE_TYPE[type]} leave (${fmtDate(from)}${to !== from ? ` – ${fmtDate(to)}` : ''})`)
    if (approver) {
      notify(ctx, approver, 'NTF-04', 'Leave request', `${me.name} asked for ${days} day${days === 1 ? '' : 's'} of ${LEAVE_TYPE[type].toLowerCase()} leave from ${fmtDate(from)}: “${reason.slice(0, 80)}”`, '/leave')
      for (const dl of rows(ctx, 'delegations').filter((d) => d.from_user_id === approver && d.from_on <= ctx.today && d.to_on >= ctx.today && !d.project_id))
        notify(ctx, dl.to_user_id, 'NTF-04', 'Leave request (delegated)', `${me.name} asked for leave from ${fmtDate(from)}. You are covering approvals for ${userName(ctx, approver)}.`, '/leave')
    } else createLeaveRows(ctx, req, me.id)
    return req
  })

  r.post('/leave-requests/:id/approve', ({ ctx, params }) => {
    const req = find(ctx, 'leave_requests', params.id, 'Leave request')
    if (req.status !== 'pending') err(409, 'NOT_PENDING', `This request is already ${req.status}.`)
    requireAction(ctx, 'approvals.act')
    const d = canDecideLeave(ctx, req)
    if (!d.ok) err(403, 'FORBIDDEN', req.user_id === ctx.user.id ? 'You can’t approve your own leave.' : 'Only the person’s manager (or their delegate) can decide this request.')
    // re-check balance at decision time (policy may have changed)
    const person = find(ctx, 'users', req.user_id)
    if (req.type !== 'lwp') {
      const b = balanceFor(ctx, person, req.type, maxISO(req.from_on, ctx.today), req.id)
      if (b && req.days > b.remaining) err(422, 'LEAVE_BALANCE', `${person.name} has only ${b.remaining} day${b.remaining === 1 ? '' : 's'} of ${LEAVE_TYPE[req.type].toLowerCase()} leave left. Reject it, or ask them to re-apply as leave without pay.`)
    }
    // Multi-step leave workflows: hand over to the next step before anything is recorded.
    const st = ensureWf(ctx, req as B.LeaveRequest & Partial<WfState>, 'leave', { requester_id: req.user_id }, leaveLegacy(ctx, req.user_id))
    const adv = advanceApproval(ctx, st, ctx.user.id)
    if (adv.next) {
      const nx = adv.next
      const mid = update(ctx, 'leave_requests', req.id, { approver_id: nx.approver_id, ...wfPatch(adv.state) } as never)
      logActivity(ctx, 'leave_request', req.id, 'approved_step', `Step ${st.wf_step + 1} of ${st.wf_chain.length} (${adv.done?.name ?? 'approval'}) approved by ${ctx.user.name}${d.via ? ' as delegate' : ''}; sent to ${userName(ctx, nx.approver_id)} for ${nx.name}`)
      notify(ctx, nx.approver_id, 'NTF-04', 'Leave request', `${person.name}’s ${LEAVE_TYPE[req.type].toLowerCase()} leave from ${fmtDate(req.from_on)} was approved by ${ctx.user.name} and needs your approval (${nx.name}).`, '/leave')
      for (const dl of rows(ctx, 'delegations').filter((x) => x.from_user_id === nx.approver_id && x.from_on <= ctx.today && x.to_on >= ctx.today && !x.project_id))
        notify(ctx, dl.to_user_id, 'NTF-04', 'Leave request (delegated)', `${person.name}’s leave from ${fmtDate(req.from_on)} needs approval. You are covering approvals for ${userName(ctx, nx.approver_id)}.`, '/leave')
      notify(ctx, req.user_id, 'NTF-05', 'Leave approved — one more step', `${ctx.user.name} approved your leave from ${fmtDate(req.from_on)}. It now needs ${userName(ctx, nx.approver_id)}’s approval.`, '/leave')
      warn(ctx, 'NEXT_APPROVAL', `Step ${st.wf_step + 1} of ${st.wf_chain.length} approved — sent to ${userName(ctx, nx.approver_id)} for ${nx.name.toLowerCase()}.`)
      return mid
    }
    const out = update(ctx, 'leave_requests', req.id, { status: 'approved', decided_by: ctx.user.id, decided_at: nowISO(), ...wfPatch(adv.state) } as never)
    const n = createLeaveRows(ctx, out, ctx.user.id)
    logActivity(ctx, 'leave_request', req.id, 'approved', `${ctx.user.name} approved ${person.name}’s ${LEAVE_TYPE[req.type]} leave (${n} day${n === 1 ? '' : 's'} recorded)${d.via ? ' as delegate' : ''}`)
    notify(ctx, req.user_id, 'NTF-05', 'Leave approved', `${ctx.user.name} approved your ${LEAVE_TYPE[req.type].toLowerCase()} leave from ${fmtDate(req.from_on)}${req.to_on !== req.from_on ? ` to ${fmtDate(req.to_on)}` : ''}.`, '/leave')
    return out
  })

  r.post('/leave-requests/:id/reject', ({ ctx, params, body }) => {
    const req = find(ctx, 'leave_requests', params.id, 'Leave request')
    if (req.status !== 'pending') err(409, 'NOT_PENDING', `This request is already ${req.status}.`)
    const d = canDecideLeave(ctx, req)
    if (!d.ok) err(403, 'FORBIDDEN', req.user_id === ctx.user.id ? 'You can’t decide your own leave.' : 'Only the person’s manager (or their delegate) can decide this request.')
    const reason = str(body.reason)
    if (reason.length < 5) err(422, 'VALIDATION', 'Tell them why in at least 5 characters.', 'reason')
    const out = update(ctx, 'leave_requests', req.id, { status: 'rejected', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: reason })
    logActivity(ctx, 'leave_request', req.id, 'rejected', `${ctx.user.name} rejected ${userName(ctx, req.user_id)}’s leave: ${reason}`)
    notify(ctx, req.user_id, 'NTF-06', 'Leave not approved', `${ctx.user.name} rejected your leave from ${fmtDate(req.from_on)}: “${reason}”`, '/leave')
    return out
  })

  r.post('/leave-requests/:id/cancel', ({ ctx, params }) => {
    const req = find(ctx, 'leave_requests', params.id, 'Leave request')
    if (req.user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the person who applied can cancel a request.')
    if (req.status === 'approved') {
      if (req.from_on <= ctx.today) err(409, 'LEAVE_STARTED', 'This leave has already started. Ask HR to change the recorded days.')
      const dates = new Set(workingDatesIn(ctx, req.from_on, req.to_on))
      for (const l of rows(ctx, 'leave').filter((x) => x.user_id === req.user_id && dates.has(x.date) && x.type === req.type && x.source === 'hr')) {
        removeLeaveEntry(ctx, l)
        remove(ctx, 'leave', l.id)
      }
    } else if (req.status !== 'pending') err(409, 'NOT_PENDING', `This request is already ${req.status}.`)
    const was = req.status
    const out = update(ctx, 'leave_requests', req.id, { status: 'cancelled' })
    logActivity(ctx, 'leave_request', req.id, 'cancelled', `${ctx.user.name} cancelled ${was} ${LEAVE_TYPE[req.type]} leave from ${fmtDate(req.from_on)}`)
    if (req.approver_id && req.approver_id !== ctx.user.id) notify(ctx, req.approver_id, 'NTF-04', 'Leave cancelled', `${ctx.user.name} cancelled ${was === 'approved' ? 'approved' : 'their pending'} leave from ${fmtDate(req.from_on)}.`, '/leave')
    return out
  })

  r.put('/leave-policies/:type', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins can change leave policy.')
    const type = params.type as E.LeaveType
    if (!LEAVE_TYPES.includes(type) || type === 'lwp') err(422, 'VALIDATION', 'Pick a paid leave type.')
    const annual = Number(body.annual_days)
    const carry = Number(body.carry_forward_max)
    if (!Number.isFinite(annual) || annual < 0 || annual > 60 || annual * 2 !== Math.round(annual * 2)) err(422, 'VALIDATION', 'Annual days must be between 0 and 60 (half days allowed).', 'annual_days')
    if (!Number.isFinite(carry) || carry < 0 || carry > 60) err(422, 'VALIDATION', 'Carry-forward must be between 0 and 60 days.', 'carry_forward_max')
    const accrual = body.accrual === 'monthly' ? 'monthly' : 'upfront'
    const cur = rows(ctx, 'leave_policies').find((p) => p.type === type)
    const out = cur ? update(ctx, 'leave_policies', cur.id, { annual_days: annual, carry_forward_max: carry, accrual }, ifMatch) : insert(ctx, 'leave_policies', { type, annual_days: annual, carry_forward_max: carry, accrual } as never)
    logActivity(ctx, 'leave_policy', out.id, 'updated', `${LEAVE_TYPE[type]} leave policy: ${annual} days/year, ${accrual}, carry forward up to ${carry}`)
    return out
  })

  /* ---------------- performance ---------------- */
  r.get('/performance-people', ({ ctx }) => {
    const all = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin)
    const list = all.filter((u) => canViewPerson(ctx, u.id))
    const from = addDays(ctx.today, -90)
    return list
      .map<PeopleOption>((u) => ({ id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue, on_time_pct: taskStats(ctx, { userIds: [u.id], from, to: ctx.today }).on_time_pct }))
      .sort((a, b) => (a.id === ctx.user.id ? -1 : b.id === ctx.user.id ? 1 : a.name.localeCompare(b.name)))
  })

  r.get('/performance/:userId', ({ ctx, params, query }) => {
    const id = params.userId === 'me' ? ctx.user.id : params.userId
    const u = find(ctx, 'users', id, 'Person')
    if (!canViewPerson(ctx, u.id)) err(403, 'FORBIDDEN', 'You can see your own performance and that of people who report to you.')
    const to = isDate(query.to) ? query.to : ctx.today
    const from = isDate(query.from) ? query.from : addDays(to, -90)
    const ts = taskStats(ctx, { userIds: [u.id], from, to })
    const tc = timesheetCompliance(ctx, u, from, to)
    const gs = goalsOf(ctx, u.id, from, to)
    const isMgr = rows(ctx, 'users').some((x) => x.reports_to_id === u.id)
    const kpis: PerfKpis = {
      on_time_pct: ts.on_time_pct, avg_variance_days: ts.avg_variance_days === null ? null : r2(ts.avg_variance_days), first_pass_pct: ts.first_pass_pct, avg_quality: ts.avg_quality,
      completed: ts.completed, late: ts.late, overdue_open: ts.overdue_open, open: ts.open, timesheet_compliance: tc.pct, expected_weeks: tc.expected, approved_weeks: tc.approved, late_submissions: tc.late,
      utilisation: avgAllocation(ctx, u.id, from, minISO(to, ctx.today)) / 100, goals_total: gs.length, goals_achieved: gs.filter((g) => g.status === 'achieved' || (g.target > 0 && g.current >= g.target)).length,
      goals_score: goalsScore(gs), approval_sla_pct: isMgr ? approvalSla(ctx, u.id, from, to) : null,
    }
    const trend: PerformanceProfile['trend'] = []
    for (let i = 5; i >= 0; i--) {
      const ym = monthOf(addMonths(`${monthOf(minISO(to, ctx.today))}-01`, -i))
      const m = monthRange(ym)
      const s = taskStats(ctx, { userIds: [u.id], from: m.from, to: m.to })
      trend.push({ month: ym, label: parseISO(m.from).toLocaleDateString('en-IN', { month: 'short' }), on_time_pct: s.on_time_pct, completed: s.completed })
    }
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const ms = new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
    const tasks = rows(ctx, 'tasks')
      .filter((t) => t.owner_id === u.id && (() => { const d = t.done_on ?? t.due_on; return d >= from && d <= to })())
      .sort((a, b) => (b.done_on ?? b.due_on).localeCompare(a.done_on ?? a.due_on))
      .slice(0, 40)
      .map((t) => {
        const tl = taskTimeliness(ctx, t)
        const p = projects.get(t.project_id)
        const m = t.milestone_id ? ms.get(t.milestone_id) : undefined
        return {
          id: t.id, code: `${p?.code ?? ''}${m ? ` ${m.no}.${t.no}` : ` #${t.no}`}`, title: t.title, project: p?.name ?? '—', status: t.status, due_on: t.due_on, done_on: t.done_on,
          timeliness: tl?.timeliness ?? null, variance_days: tl?.variance ?? null,
          delay_reason: t.delay_reason_code ? `${DELAY_REASON_LABEL[t.delay_reason_code] ?? t.delay_reason_code}${t.delay_reason ? `: ${t.delay_reason}` : ''}` : t.delay_reason ?? null,
          quality_rating: t.quality_rating ?? null, overdue_days: t.status !== 'done' && t.due_on < ctx.today ? diffDays(ctx.today, t.due_on) : 0,
        }
      })
    const cycles = new Map(rows(ctx, 'appraisal_cycles').map((c) => [c.id, c]))
    const self = u.id === ctx.user.id
    const appraisals = rows(ctx, 'appraisals')
      .filter((a) => a.user_id === u.id)
      .map((a) => {
        const c = cycles.get(a.cycle_id)!
        const hide = self && a.status !== 'completed' && !isAppraisalAdmin(ctx)
        return { id: a.id, cycle_name: c.name, period_from: c.period_from, period_to: c.period_to, status: a.status, final_rating: a.final_rating, increment_pct: hide ? null : a.increment_pct, promotion_to: hide ? null : a.promotion_to }
      })
      .sort((a, b) => b.period_from.localeCompare(a.period_from))
    const mgr = user(ctx, u.reports_to_id)
    return {
      user: { id: u.id, name: u.name, title: u.title, role: u.role, avatar_hue: u.avatar_hue, joined_on: u.joined_on, manager_name: mgr?.name ?? null, department: u.department },
      from, to, kpis, trend, tasks,
      delay_reasons: Object.entries(ts.delay_reasons).map(([code, count]) => ({ code, label: DELAY_REASON_LABEL[code] ?? code, count })).sort((a, b) => b.count - a.count),
      goals: goalsOf(ctx, u.id).filter((g) => { const c = g.cycle_id ? cycles.get(g.cycle_id) : null; return !c || c.status !== 'closed' || (c.period_to >= from && c.period_from <= to) }).map((g) => goalView(ctx, g)).sort((a, b) => b.weight - a.weight),
      feedback: rows(ctx, 'feedback').filter((f) => f.to_user_id === u.id && feedbackVisible(ctx, f)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((f) => feedbackView(ctx, f)),
      appraisals,
      cycles: [...cycles.values()].filter((c) => c.status !== 'closed').map((c) => ({ id: c.id, name: c.name, status: c.status })),
      can_add_goal: !ctx.viewAs && (self || isAbove(ctx, ctx.user.id, u.id) || isHR(ctx)),
      can_give_feedback: !ctx.viewAs && !self,
      is_self: self,
      is_manager: isAbove(ctx, ctx.user.id, u.id),
    } satisfies PerformanceProfile
  })

  /* ---------------- goals ---------------- */
  const assertGoalWeights = (ctx: Ctx, userId: string, cycleId: string | null, extra: number, exclude?: string, exact = false) => {
    const total = rows(ctx, 'goals').filter((g) => g.user_id === userId && g.cycle_id === cycleId && g.id !== exclude && g.status !== 'missed').reduce((s, g) => s + g.weight, 0) + extra
    if (total > 100) err(422, 'GOAL_WEIGHTS', `Goal weights for this cycle would total ${total}%. They must add up to exactly 100% — lower another goal first.`, 'weight')
    if (exact && total !== 100) err(422, 'GOAL_WEIGHTS', `Goal weights for this cycle total ${total}%. Adjust them to exactly 100% before approving.`, 'weight')
  }
  const goalInput = (body: Record<string, unknown>, partial = false) => {
    const out: Partial<B.Goal> = {}
    if (!partial || body.title !== undefined) { const t = str(body.title); if (t.length < 4) err(422, 'VALIDATION', 'Give the goal a title of at least 4 characters.', 'title'); out.title = t }
    if (!partial || body.kra !== undefined) out.kra = str(body.kra) || 'General'
    if (!partial || body.weight !== undefined) { const w = Number(body.weight); if (!Number.isInteger(w) || w < 5 || w > 100) err(422, 'VALIDATION', 'Weight is a whole percentage between 5 and 100.', 'weight'); out.weight = w }
    if (!partial || body.measure !== undefined) out.measure = str(body.measure)
    if (!partial || body.target !== undefined) { const t = Number(body.target); if (!Number.isFinite(t) || t <= 0) err(422, 'VALIDATION', 'Set a target greater than zero.', 'target'); out.target = t }
    if (!partial || body.unit !== undefined) out.unit = str(body.unit)
    if (!partial || body.due_on !== undefined) { if (!isDate(body.due_on)) err(422, 'VALIDATION', 'Pick a due date.', 'due_on'); out.due_on = body.due_on as string }
    return out
  }
  r.post('/goals', ({ ctx, body }) => {
    const userId = str(body.user_id) || ctx.user.id
    const u = find(ctx, 'users', userId, 'Person')
    const self = u.id === ctx.user.id
    if (!self && !isAbove(ctx, ctx.user.id, u.id) && !isHR(ctx)) err(403, 'FORBIDDEN', 'You can set goals for yourself and for people who report to you.')
    const cycleId = str(body.cycle_id) || null
    if (cycleId) {
      const c = find(ctx, 'appraisal_cycles', cycleId, 'Cycle')
      if (c.status === 'closed') err(409, 'CYCLE_CLOSED', `${c.name} is closed. Add goals to an open cycle.`, 'cycle_id')
    }
    const g = goalInput(body)
    assertGoalWeights(ctx, u.id, cycleId, g.weight!)
    const row = insert(ctx, 'goals', { ...g, user_id: u.id, cycle_id: cycleId, current: 0, status: self ? 'draft' : 'agreed', manager_approved: !self } as never) as B.Goal
    logActivity(ctx, 'goal', row.id, 'created', `${ctx.user.name} added goal “${row.title}” (${row.weight}%) for ${u.name}`)
    if (self && u.reports_to_id) notify(ctx, u.reports_to_id, 'NTF-04', 'Goal to approve', `${u.name} drafted a goal: “${row.title}” (${row.weight}%).`, `/performance/${u.id}`)
    if (!self) notify(ctx, u.id, 'NTF-14', 'New goal', `${ctx.user.name} set a goal for you: “${row.title}”.`, '/performance')
    return row
  })
  r.patch('/goals/:id', ({ ctx, params, body, ifMatch }) => {
    const g = find(ctx, 'goals', params.id, 'Goal')
    const own = g.user_id === ctx.user.id
    const mgr = isAbove(ctx, ctx.user.id, g.user_id) || isHR(ctx)
    if (!own && !mgr) err(403, 'FORBIDDEN', 'Only the person and their managers can change this goal.')
    const patch: Partial<B.Goal> = {}
    const defining = ['title', 'kra', 'weight', 'measure', 'target', 'unit', 'due_on'].some((k) => body[k] !== undefined)
    if (defining) {
      if (g.manager_approved && !mgr) err(409, 'GOAL_LOCKED', 'This goal is agreed with your manager. Ask them to change its definition.')
      Object.assign(patch, goalInput(body, true))
      if (patch.weight !== undefined) assertGoalWeights(ctx, g.user_id, g.cycle_id, patch.weight, g.id)
    }
    if (body.current !== undefined) {
      const c = Number(body.current)
      if (!Number.isFinite(c) || c < 0) err(422, 'VALIDATION', 'Progress must be zero or more.', 'current')
      if (!g.manager_approved) err(409, 'GOAL_NOT_AGREED', 'Progress can be logged once your manager approves the goal.')
      patch.current = c
    }
    if (body.status !== undefined) {
      const st = body.status as B.Goal['status']
      if (!['on_track', 'at_risk', 'achieved', 'missed'].includes(st)) err(422, 'VALIDATION', 'Pick a valid status.', 'status')
      if ((st === 'achieved' || st === 'missed') && !mgr) err(403, 'FORBIDDEN', 'Your manager marks goals achieved or missed.')
      patch.status = st
    } else if (patch.current !== undefined && g.status !== 'achieved' && g.status !== 'missed') {
      patch.status = patch.current >= g.target ? 'on_track' : g.status === 'agreed' ? 'on_track' : g.status
    }
    const out = update(ctx, 'goals', g.id, patch, ifMatch)
    logActivity(ctx, 'goal', g.id, 'updated', `${ctx.user.name} updated goal “${out.title}”${patch.current !== undefined ? ` — progress ${out.current}/${out.target} ${out.unit}` : ''}${patch.status ? ` — ${patch.status.replace('_', ' ')}` : ''}`)
    return out
  })
  r.post('/goals/:id/approve', ({ ctx, params }) => {
    const g = find(ctx, 'goals', params.id, 'Goal')
    if (g.user_id === ctx.user.id) err(403, 'FORBIDDEN', 'Your manager approves your goals.')
    if (!isAbove(ctx, ctx.user.id, g.user_id) && !isHR(ctx)) err(403, 'FORBIDDEN', 'Only the person’s manager can approve their goals.')
    if (g.manager_approved) return g
    // approving the last draft must bring the cycle to exactly 100%
    const drafts = rows(ctx, 'goals').filter((x) => x.user_id === g.user_id && x.cycle_id === g.cycle_id && !x.manager_approved && x.id !== g.id)
    if (g.cycle_id && !drafts.length) assertGoalWeights(ctx, g.user_id, g.cycle_id, 0, undefined, true)
    const out = update(ctx, 'goals', g.id, { manager_approved: true, status: 'agreed' })
    logActivity(ctx, 'goal', g.id, 'approved', `${ctx.user.name} approved goal “${g.title}” for ${userName(ctx, g.user_id)}`)
    notify(ctx, g.user_id, 'NTF-05', 'Goal approved', `${ctx.user.name} approved your goal “${g.title}”.`, '/performance')
    return out
  })
  r.del('/goals/:id', ({ ctx, params }) => {
    const g = find(ctx, 'goals', params.id, 'Goal')
    const own = g.user_id === ctx.user.id
    const mgr = isAbove(ctx, ctx.user.id, g.user_id) || isHR(ctx)
    if (!own && !mgr) err(403, 'FORBIDDEN', 'Only the person and their managers can remove this goal.')
    if (g.manager_approved && !mgr) err(409, 'GOAL_LOCKED', 'This goal is agreed. Ask your manager to remove it.')
    remove(ctx, 'goals', g.id)
    logActivity(ctx, 'goal', g.id, 'deleted', `${ctx.user.name} removed goal “${g.title}”`)
    return null
  })

  /* ---------------- feedback ---------------- */
  r.post('/feedback', ({ ctx, body }) => {
    const to = find(ctx, 'users', str(body.to_user_id), 'Person')
    if (to.id === ctx.user.id) err(422, 'VALIDATION', 'Feedback goes to someone else.', 'to_user_id')
    const kind = body.kind as B.Feedback['kind']
    if (!['praise', 'improvement', 'one_on_one'].includes(kind)) err(422, 'VALIDATION', 'Pick the kind of feedback.', 'kind')
    const vis = body.visibility as B.Feedback['visibility']
    if (!['private', 'manager', 'public'].includes(vis)) err(422, 'VALIDATION', 'Pick who can see it.', 'visibility')
    if (kind === 'one_on_one' && !isAbove(ctx, ctx.user.id, to.id) && !isHR(ctx)) err(403, 'FORBIDDEN', '1:1 notes are written by the person’s manager.')
    const text = str(body.body)
    if (text.length < 10) err(422, 'VALIDATION', 'Write at least 10 characters so it is useful.', 'body')
    const row = insert(ctx, 'feedback', { to_user_id: to.id, from_user_id: ctx.user.id, kind, body: text, visibility: vis, at: nowISO() } as never)
    logActivity(ctx, 'feedback', row.id, 'created', `${ctx.user.name} gave ${kind.replace(/_/g, ' ')} feedback to ${to.name}`)
    if (vis !== 'manager') notify(ctx, to.id, 'NTF-03', kind === 'praise' ? 'You got praise' : 'New feedback', `${ctx.user.name}: “${text.slice(0, 90)}”`, '/performance')
    return row
  })

  /* ---------------- appraisals ---------------- */
  r.get('/appraisal-cycles', ({ ctx }) => (sweepCycles(ctx), rows(ctx, 'appraisal_cycles').sort((a, b) => b.period_from.localeCompare(a.period_from)).map((c) => cycleView(ctx, c))))

  r.post('/appraisal-cycles', ({ ctx, body }) => {
    requireAction(ctx, 'appraisals.manage', 'Only HR and admins run appraisal cycles.')
    const name = str(body.name)
    if (name.length < 3) err(422, 'VALIDATION', 'Name the cycle, e.g. “H2 FY26-27”.', 'name')
    if (rows(ctx, 'appraisal_cycles').some((c) => c.name.toLowerCase() === name.toLowerCase())) err(409, 'DUPLICATE', 'A cycle with this name already exists.', 'name')
    for (const k of ['period_from', 'period_to', 'self_due', 'manager_due', 'hr_due']) if (!isDate(body[k])) err(422, 'VALIDATION', 'Fill in every date.', k)
    if (body.period_to <= body.period_from) err(422, 'DATE_RANGE', 'The period must end after it starts.', 'period_to')
    if (!(body.self_due <= body.manager_due && body.manager_due <= body.hr_due)) err(422, 'DATE_RANGE', 'Due dates run in order: self review, then manager review, then HR review.', 'manager_due')
    if (body.self_due < body.period_from) err(422, 'DATE_RANGE', 'Self reviews can’t be due before the period starts.', 'self_due')
    const w = body.weights ?? {}
    const weights = { goals: Number(w.goals), tasks: Number(w.tasks), timesheets: Number(w.timesheets), behaviour: Number(w.behaviour) }
    if (Object.values(weights).some((x) => !Number.isInteger(x) || x < 0 || x > 100)) err(422, 'APPRAISAL_WEIGHTS', 'Each weight is a whole percentage between 0 and 100.', 'weights')
    const sum = weights.goals + weights.tasks + weights.timesheets + weights.behaviour
    if (sum !== 100) err(422, 'APPRAISAL_WEIGHTS', `Weights add up to ${sum}%. Make goals, tasks, timesheets and behaviour total exactly 100%.`, 'weights')
    const c = insert(ctx, 'appraisal_cycles', { name, period_from: body.period_from, period_to: body.period_to, status: 'draft', self_due: body.self_due, manager_due: body.manager_due, hr_due: body.hr_due, weights } as never)
    logActivity(ctx, 'appraisal_cycle', c.id, 'created', `${ctx.user.name} created appraisal cycle ${name}`)
    return c
  })

  r.post('/appraisal-cycles/:id/launch', ({ ctx, params, body }) => {
    requireAction(ctx, 'appraisals.manage', 'Only HR and admins launch appraisal cycles.')
    const c = find(ctx, 'appraisal_cycles', params.id, 'Cycle')
    if (c.status !== 'draft') err(409, 'CYCLE_LAUNCHED', `${c.name} has already been launched.`)
    const open = rows(ctx, 'appraisal_cycles').find((x) => x.id !== c.id && x.status !== 'draft' && x.status !== 'closed')
    if (open) err(409, 'CYCLE_OPEN', `${open.name} is still running. Close it before launching another cycle.`)
    const people = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && u.reports_to_id)
    if (!people.length) err(409, 'NO_PEOPLE', 'There is nobody with a manager to appraise. Set reporting lines first.')
    // v7: optionally run every appraisal through a workflow (e.g. self → manager → unit head → HR → finance)
    const wfId = str(body?.workflow_template_id)
    if (wfId) requireAction(ctx, 'workflows.start', 'Starting appraisal workflows needs “Start workflows for others”.')
    const tpl = wfId ? appraisalTemplate(ctx, wfId) : null
    if (tpl) checkRoutable(ctx, tpl, people.map((u) => u.id))
    for (const u of people) {
      const a = insert(ctx, 'appraisals', {
        cycle_id: c.id, user_id: u.id, manager_id: u.reports_to_id, status: 'self_pending', self_rating: null, self_comments: '', manager_rating: null, manager_comments: '', hr_rating: null, hr_comments: '',
        final_rating: null, increment_pct: null, promotion_to: null, metrics: {}, submitted_self_at: null, submitted_manager_at: null, closed_at: null,
      } as never)
      if (tpl) startWorkflow(ctx, tpl, u.id, { cycle_id: c.id, cycle_name: c.name, appraisal_id: a.id, note: `Started with ${c.name}` }, `${tpl.name} ${c.name} — ${u.name}`)
      else notify(ctx, u.id, 'NTF-14', 'Appraisal open', `${c.name}: write your self review by ${fmtDate(c.self_due, 'long')}.`, `/appraisals/${a.id}`)
    }
    update(ctx, 'appraisal_cycles', c.id, { status: 'self_review' })
    syncCycle(ctx, c.id)
    logActivity(ctx, 'appraisal_cycle', c.id, 'launched', `${ctx.user.name} launched ${c.name} for ${people.length} people${tpl ? ` through the “${tpl.name}” workflow` : ''}`)
    return { created: people.length, workflows: tpl ? people.length : 0 }
  })

  r.post('/appraisal-cycles/:id/close', ({ ctx, params }) => {
    requireAction(ctx, 'appraisals.manage', 'Only HR and admins close appraisal cycles.')
    const c = find(ctx, 'appraisal_cycles', params.id, 'Cycle')
    if (c.status === 'closed') return c
    if (c.status === 'draft') err(409, 'CYCLE_DRAFT', 'This cycle was never launched.')
    const open = rows(ctx, 'appraisals').filter((a) => a.cycle_id === c.id && a.status !== 'completed').length
    if (open) err(409, 'APPRAISALS_OPEN', `${open} appraisal${open === 1 ? ' is' : 's are'} not completed yet. Finish the HR reviews first.`)
    const out = update(ctx, 'appraisal_cycles', c.id, { status: 'closed' })
    logActivity(ctx, 'appraisal_cycle', c.id, 'closed', `${ctx.user.name} closed ${c.name}`)
    return out
  })

  r.get('/appraisals', ({ ctx, query }) => {
    sweepCycles(ctx)
    const cycles = rows(ctx, 'appraisal_cycles').sort((a, b) => b.period_from.localeCompare(a.period_from))
    const hr = isAppraisalAdmin(ctx)
    const visible = rows(ctx, 'appraisals').filter((a) => canSeeAppraisal(ctx, a))
    const mode: AppraisalsView['mode'] = hr ? 'hr' : visible.some((a) => a.user_id !== ctx.user.id) ? 'manager' : 'self'
    const active = cycles.find((c) => c.status !== 'closed' && c.status !== 'draft') ?? cycles[0]
    const cycle = (query.cycle_id ? cycles.find((c) => c.id === query.cycle_id) : null) ?? active ?? null
    const cmap = new Map(cycles.map((c) => [c.id, c]))
    const scoped = (mode === 'self' ? visible : visible.filter((a) => a.cycle_id === cycle?.id)).filter((a) => cmap.has(a.cycle_id))
    const rowsOut = scoped.map((a) => appraisalRow(ctx, a, cmap.get(a.cycle_id)!)).sort((a, b) => a.user_name.localeCompare(b.user_name))
    const dist = [1, 2, 3, 4, 5].map((n) => ({ rating: String(n), count: 0 }))
    for (const x of rowsOut) {
      const v = x.final_rating ?? x.manager_rating
      if (v !== null && v !== undefined) dist[Math.min(4, Math.max(0, Math.round(v) - 1))].count++
    }
    return {
      mode, cycles: (hr ? cycles : cycles.filter((c) => c.status !== 'draft')).map((c) => cycleView(ctx, c)), cycle: cycle ? cycleView(ctx, cycle) : null, rows: rowsOut, distribution: dist,
      overdue: rowsOut.filter((x) => x.overdue), can_manage: hr && !ctx.viewAs,
    } satisfies AppraisalsView
  })

  r.get('/appraisals/:id', ({ ctx, params }) => {
    const a = getAppraisal(ctx, params.id)
    const c = find(ctx, 'appraisal_cycles', a.cycle_id)
    const u = find(ctx, 'users', a.user_id)
    const isSelf = a.user_id === ctx.user.id
    const isMgr = !isSelf && (a.manager_id === ctx.user.id || isAbove(ctx, ctx.user.id, a.user_id))
    const isHr = !isSelf && isAppraisalAdmin(ctx)
    const done = a.status === 'completed'
    const live = done && a.metrics && 'suggested' in a.metrics ? (a.metrics as unknown as Metrics) : computeMetrics(ctx, a, c)
    const stage: AppraisalDetail['stage_for_viewer'] = ctx.viewAs ? 'view'
      : a.status === 'self_pending' && isSelf ? 'self'
      : a.status === 'manager_pending' && !isSelf && (a.manager_id === ctx.user.id || isAppraisalAdmin(ctx)) ? 'manager'
      : a.status === 'hr_pending' && isHr ? 'hr' : 'view'
    const wfManaged = wfLinkedAppraisals(ctx).has(a.id)
    const show = (!isSelf || done || isAppraisalAdmin(ctx)) && !(wfManaged && isSelf && !isAppraisalAdmin(ctx) && !done)
    const back = rows(ctx, 'activity_log').filter((l) => l.entity === 'appraisal' && l.entity_id === a.id && l.action === 'sent_back').sort((x, y) => y.at.localeCompare(x.at))[0]
    const out: AppraisalDetail = {
      ...a,
      manager_rating: show ? a.manager_rating : null, manager_comments: show ? a.manager_comments : '', hr_rating: show ? a.hr_rating : null, hr_comments: show ? a.hr_comments : '',
      increment_pct: show ? a.increment_pct : null, promotion_to: show ? a.promotion_to : null,
      cycle: c, user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue, joined_on: u.joined_on }, manager_name: a.manager_id ? userName(ctx, a.manager_id) : null,
      live: show ? live : { ...live, suggested: null, score_behaviour: null },
      goals: goalsOf(ctx, a.user_id, undefined, undefined, c.id).map((g) => goalView(ctx, g)),
      // v7: a workflow-managed appraisal is acted on from /workflows/run/:id; the employee sees only their own review + the outcome
      ...(wfManaged && isSelf ? { manager_rating: null, manager_comments: '', hr_comments: '' } : {}),
      stage_for_viewer: wfManaged ? 'view' : stage, viewer: { is_self: isSelf, is_manager: isMgr, is_hr: isHr }, show_ratings: show,
      sent_back_reason: back && a.status !== 'completed' ? back.summary.replace(/^.*?: /, '') : null,
    }
    return out
  })

  const ratingOf = (v: unknown, step = 1) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 1 || n > 5 || Math.round(n / step) * step !== n) err(422, 'VALIDATION', step === 1 ? 'Pick a rating from 1 to 5.' : 'Pick a rating from 1 to 5 (half points allowed).', 'rating')
    return n
  }
  r.post('/appraisals/:id/self', ({ ctx, params, body, ifMatch }) => {
    const a = getAppraisal(ctx, params.id)
    assertNotWorkflowManaged(ctx, a.id)
    if (a.user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the person writes their self review.')
    if (a.status !== 'self_pending') err(409, 'APPRAISAL_STAGE', 'Your self review is already submitted.')
    const c = find(ctx, 'appraisal_cycles', a.cycle_id)
    if (c.status === 'closed') err(409, 'CYCLE_CLOSED', 'This cycle is closed.')
    const rating = ratingOf(body.rating)
    const comments = str(body.comments)
    if (comments.length < 30) err(422, 'VALIDATION', 'Write at least 30 characters about what you delivered and where you want to grow.', 'comments')
    const next: B.AppraisalStatus = a.manager_id ? 'manager_pending' : 'hr_pending'
    const out = update(ctx, 'appraisals', a.id, { self_rating: rating, self_comments: comments, status: next, submitted_self_at: nowISO() }, ifMatch)
    logActivity(ctx, 'appraisal', a.id, 'self_submitted', `${ctx.user.name} submitted the self review for ${c.name} (${rating}/5)`)
    if (a.manager_id) notify(ctx, a.manager_id, 'NTF-04', 'Appraisal to review', `${ctx.user.name} submitted their self review for ${c.name}. Your review is due ${fmtDate(c.manager_due, 'long')}.`, `/appraisals/${a.id}`)
    else for (const h of hrPeople(ctx)) notify(ctx, h.id, 'NTF-04', 'Appraisal to review', `${ctx.user.name}’s appraisal is ready for HR review.`, `/appraisals/${a.id}`)
    syncCycle(ctx, a.cycle_id)
    return out
  })

  r.post('/appraisals/:id/manager', ({ ctx, params, body, ifMatch }) => {
    const a = getAppraisal(ctx, params.id)
    assertNotWorkflowManaged(ctx, a.id)
    if (a.user_id === ctx.user.id) err(403, 'FORBIDDEN', 'You can’t review your own appraisal.')
    if (a.manager_id !== ctx.user.id && !isAppraisalAdmin(ctx)) err(403, 'FORBIDDEN', 'Only the person’s manager writes the manager review.')
    if (a.status !== 'manager_pending') err(409, 'APPRAISAL_STAGE', a.status === 'self_pending' ? 'Wait for the self review first.' : 'The manager review is already submitted.')
    const c = find(ctx, 'appraisal_cycles', a.cycle_id)
    const rating = ratingOf(body.rating)
    const comments = str(body.comments)
    if (comments.length < 30) err(422, 'VALIDATION', 'Write at least 30 characters: what went well, what to improve, with examples.', 'comments')
    const snap = computeMetrics(ctx, { ...a, manager_rating: rating }, c)
    const out = update(ctx, 'appraisals', a.id, { manager_rating: rating, manager_comments: comments, status: 'hr_pending', submitted_manager_at: nowISO(), metrics: snap as unknown as Record<string, number | null> }, ifMatch)
    logActivity(ctx, 'appraisal', a.id, 'manager_submitted', `${ctx.user.name} submitted the manager review for ${userName(ctx, a.user_id)} (${rating}/5, system suggests ${snap.suggested ?? '—'})`)
    for (const h of hrPeople(ctx)) if (h.id !== a.user_id && h.id !== ctx.user.id) notify(ctx, h.id, 'NTF-04', 'Appraisal ready for HR', `${userName(ctx, a.user_id)}: manager review done (${rating}/5). Calibrate by ${fmtDate(c.hr_due, 'long')}.`, `/appraisals/${a.id}`)
    syncCycle(ctx, a.cycle_id)
    return out
  })

  r.post('/appraisals/:id/hr', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'appraisals.manage', 'Only HR and admins calibrate appraisals.')
    const a = getAppraisal(ctx, params.id)
    assertNotWorkflowManaged(ctx, a.id)
    if (a.user_id === ctx.user.id) err(403, 'FORBIDDEN', 'Someone else in HR or an admin must calibrate your own appraisal.')
    if (a.status !== 'hr_pending') err(409, 'APPRAISAL_STAGE', a.status === 'completed' ? 'This appraisal is completed and locked.' : 'The manager review has to be submitted first.')
    const c = find(ctx, 'appraisal_cycles', a.cycle_id)
    const rating = ratingOf(body.rating, 0.5)
    const comments = str(body.comments)
    const inc = Number(body.increment_pct)
    if (!Number.isFinite(inc) || inc < 0 || inc > 50) err(422, 'VALIDATION', 'Increment is a percentage between 0 and 50.', 'increment_pct')
    const promo = str(body.promotion_to) || null
    const snap = computeMetrics(ctx, a, c)
    if (snap.suggested !== null && Math.abs(rating - snap.suggested) > 1 && comments.length < 15)
      err(422, 'RATING_DEVIATION', `The final rating differs from the system suggestion (${snap.suggested}) by more than 1. Explain why in at least 15 characters.`, 'comments')
    if (comments.length && comments.length < 5) err(422, 'VALIDATION', 'Write a little more in the HR comments.', 'comments')
    const out = update(ctx, 'appraisals', a.id, { hr_rating: rating, hr_comments: comments, final_rating: rating, increment_pct: r1(inc), promotion_to: promo, status: 'completed', closed_at: nowISO(), metrics: snap as unknown as Record<string, number | null> }, ifMatch)
    // Increment flows into costing and payroll: a new cost-rate row effective the day after the cycle ends.
    if (inc > 0) {
      const rates = rows(ctx, 'cost_rates').filter((x) => x.user_id === a.user_id).sort((x, y) => y.effective_from.localeCompare(x.effective_from))
      const cur = rates[0]
      const eff = addDays(c.period_to, 1)
      if (cur && !rates.some((x) => x.effective_from === eff)) {
        insert(ctx, 'cost_rates', { user_id: a.user_id, monthly_ctc_paise: Math.round(cur.monthly_ctc_paise * (1 + inc / 100)), variable_pct: cur.variable_pct, sales_target_paise: cur.sales_target_paise ? Math.round(cur.sales_target_paise * (1 + inc / 100)) : null, effective_from: eff } as never)
        logActivity(ctx, 'cost_rate', a.user_id, 'increment', `Cost rate for ${userName(ctx, a.user_id)} raised ${r1(inc)}% from ${fmtDate(eff)} (appraisal ${c.name})`)
      }
    }
    logActivity(ctx, 'appraisal', a.id, 'completed', `${ctx.user.name} completed ${userName(ctx, a.user_id)}’s appraisal: final ${rating}/5, increment ${r1(inc)}%${promo ? `, promoted to ${promo}` : ''}`)
    notify(ctx, a.user_id, 'NTF-05', 'Appraisal completed', `Your ${c.name} appraisal is complete. Open it to see the final rating.`, `/appraisals/${a.id}`)
    if (a.manager_id && a.manager_id !== ctx.user.id) notify(ctx, a.manager_id, 'NTF-05', 'Appraisal completed', `${userName(ctx, a.user_id)}: final rating ${rating}/5.`, `/appraisals/${a.id}`)
    syncCycle(ctx, a.cycle_id)
    return out
  })

  r.post('/appraisals/:id/send-back', ({ ctx, params, body }) => {
    const a = getAppraisal(ctx, params.id)
    assertNotWorkflowManaged(ctx, a.id)
    const reason = str(body.reason)
    if (reason.length < 10) err(422, 'VALIDATION', 'Explain what to change in at least 10 characters.', 'reason')
    let to: B.AppraisalStatus
    let notifyId: string | null
    if (a.status === 'hr_pending') {
      requireAction(ctx, 'appraisals.manage', 'Only HR sends a review back to the manager.')
      if (a.user_id === ctx.user.id) err(403, 'FORBIDDEN', 'You can’t act on your own appraisal.')
      to = a.manager_id ? 'manager_pending' : 'self_pending'
      notifyId = a.manager_id ?? a.user_id
    } else if (a.status === 'manager_pending') {
      if (a.manager_id !== ctx.user.id && !isAppraisalAdmin(ctx)) err(403, 'FORBIDDEN', 'Only the manager can send the self review back.')
      to = 'self_pending'
      notifyId = a.user_id
    } else err(409, 'APPRAISAL_STAGE', 'Only reviews waiting on a manager or HR can be sent back.')
    const out = update(ctx, 'appraisals', a.id, { status: to })
    logActivity(ctx, 'appraisal', a.id, 'sent_back', `${ctx.user.name} sent the review back: ${reason}`)
    if (notifyId) notify(ctx, notifyId, 'NTF-06', 'Appraisal sent back', `${ctx.user.name}: “${reason}”`, `/appraisals/${a.id}`)
    syncCycle(ctx, a.cycle_id)
    return out
  })

  /* ---------------- recruitment ---------------- */
  r.get('/recruitment', ({ ctx }) => {
    requireAction(ctx, 'recruitment.manage')
    const cands = rows(ctx, 'candidates')
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const openings = rows(ctx, 'openings')
      .filter((o) => o.status !== 'filled' || cands.some((c) => c.opening_id === o.id && !['hired', 'rejected', 'withdrawn'].includes(c.stage)))
      .map((o) => ({
        id: o.id, role: o.role, project: o.project_id ? projects.get(o.project_id)?.name ?? null : null, status: o.status, count: o.count, owner_id: o.owner_id, owner_name: userName(ctx, o.owner_id), needed_by: o.needed_by,
        candidates: cands.filter((c) => c.opening_id === o.id).length, hired: cands.filter((c) => c.opening_id === o.id && c.stage === 'hired').length,
      }))
    const hired = cands.filter((c) => c.stage === 'hired')
    const tth = hired.map((c) => diffDays(hiredOn(ctx, c), c.created_at.slice(0, 10)))
    const sources = new Map<string, { count: number; hired: number }>()
    for (const c of cands) {
      const s = sources.get(c.source) ?? { count: 0, hired: 0 }
      s.count++
      if (c.stage === 'hired') s.hired++
      sources.set(c.source, s)
    }
    return {
      openings,
      candidates: cands.map((c) => candidateRow(ctx, c)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      metrics: {
        open_positions: rows(ctx, 'openings').filter((o) => o.status !== 'filled' && o.status !== 'on_hold').reduce((s, o) => s + Math.max(0, o.count - cands.filter((c) => c.opening_id === o.id && c.stage === 'hired').length), 0),
        active: cands.filter((c) => !['hired', 'rejected', 'withdrawn'].includes(c.stage)).length,
        avg_time_to_hire: tth.length ? Math.round(tth.reduce((s, x) => s + x, 0) / tth.length) : null,
        hired_90: hired.filter((c) => hiredOn(ctx, c) >= addDays(ctx.today, -90)).length,
        offers_out: cands.filter((c) => c.stage === 'offer').length,
        by_source: [...sources.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.count - a.count),
      },
    } satisfies RecruitmentView
  })

  r.get('/candidates/:id', ({ ctx, params }) => {
    requireAction(ctx, 'recruitment.manage')
    const c = find(ctx, 'candidates', params.id, 'Candidate')
    const f = c.resume_file_id ? rows(ctx, 'files').find((x) => x.id === c.resume_file_id) : null
    const inv = c.user_id ? rows(ctx, 'invites').find((i) => i.id === c.user_id) : null
    return {
      ...candidateRow(ctx, c),
      interviews: rows(ctx, 'interviews').filter((i) => i.candidate_id === c.id).sort((a, b) => a.round - b.round).map((i) => ({ ...i, interviewer_name: userName(ctx, i.interviewer_id) })),
      resume: f ? { id: f.id, name: f.name, size_bytes: f.size_bytes, data_url: f.data_url } : null,
      history: rows(ctx, 'activity_log').filter((l) => l.entity === 'candidate' && l.entity_id === c.id).sort((a, b) => b.at.localeCompare(a.at)).map((l) => ({ at: l.at, summary: l.summary, actor: userName(ctx, l.actor_id) })),
      invite: inv ? { id: inv.id, email: inv.email, accepted: !!inv.accepted_at } : null,
    } satisfies CandidateDetail
  })

  const candInput = (ctx: Ctx, body: Record<string, unknown>, partial: boolean) => {
    const out: Partial<B.Candidate> = {}
    if (!partial || body.name !== undefined) { const n = str(body.name); if (n.length < 2) err(422, 'VALIDATION', 'Enter the candidate’s name.', 'name'); out.name = n }
    if (!partial || body.email !== undefined) { const e = str(body.email).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) err(422, 'VALIDATION', 'Enter a valid email address.', 'email'); out.email = e }
    if (body.phone !== undefined) out.phone = str(body.phone)
    if (!partial || body.source !== undefined) { const s = body.source as B.Candidate['source']; if (!['referral', 'job_portal', 'linkedin', 'campus', 'agency', 'website', 'other'].includes(s)) err(422, 'VALIDATION', 'Pick where the candidate came from.', 'source'); out.source = s }
    if (body.experience_years !== undefined) { const n = Number(body.experience_years); if (!Number.isFinite(n) || n < 0 || n > 50) err(422, 'VALIDATION', 'Experience is between 0 and 50 years.', 'experience_years'); out.experience_years = n }
    for (const k of ['current_ctc_paise', 'expected_ctc_paise', 'offer_ctc_paise'] as const)
      if (body[k] !== undefined) { const v = body[k] === null || body[k] === '' ? null : Number(body[k]); if (v !== null && (!Number.isInteger(v) || v < 0)) err(422, 'VALIDATION', 'Enter a valid amount.', k); out[k] = v }
    if (body.notice_days !== undefined) { const v = body.notice_days === null || body.notice_days === '' ? null : Number(body.notice_days); if (v !== null && (!Number.isInteger(v) || v < 0 || v > 180)) err(422, 'VALIDATION', 'Notice is 0–180 days.', 'notice_days'); out.notice_days = v }
    if (body.rating !== undefined) { const v = body.rating === null ? null : Number(body.rating); if (v !== null && (!Number.isInteger(v) || v < 1 || v > 5)) err(422, 'VALIDATION', 'Rating is 1 to 5.', 'rating'); out.rating = v }
    if (body.notes !== undefined) out.notes = str(body.notes)
    if (body.joining_on !== undefined) { if (body.joining_on !== null && !isDate(body.joining_on)) err(422, 'VALIDATION', 'Pick a joining date.', 'joining_on'); out.joining_on = (body.joining_on as string) || null }
    void ctx
    return out
  }
  r.post('/candidates', ({ ctx, body }) => {
    requireAction(ctx, 'recruitment.manage', 'Only HR, PMs and admins manage candidates.')
    const o = find(ctx, 'openings', str(body.opening_id), 'Opening')
    if (o.status === 'filled') err(409, 'OPENING_FILLED', `${o.role} is already filled.`, 'opening_id')
    const data = candInput(ctx, body, false)
    if (rows(ctx, 'candidates').some((c) => c.opening_id === o.id && c.email === data.email)) err(409, 'DUPLICATE', 'This candidate is already in the pipeline for this opening.', 'email')
    const c = insert(ctx, 'candidates', {
      opening_id: o.id, name: data.name, email: data.email, phone: data.phone ?? '', source: data.source, stage: 'applied', experience_years: data.experience_years ?? 0,
      current_ctc_paise: data.current_ctc_paise ?? null, expected_ctc_paise: data.expected_ctc_paise ?? null, offer_ctc_paise: null, notice_days: data.notice_days ?? null,
      resume_file_id: null, rating: null, notes: data.notes ?? '', rejected_reason: null, joining_on: null, user_id: null,
    } as never)
    logActivity(ctx, 'candidate', c.id, 'created', `${ctx.user.name} added ${c.name} to ${o.role}`)
    if (o.owner_id !== ctx.user.id) notify(ctx, o.owner_id, 'NTF-14', 'New candidate', `${c.name} was added to ${o.role}.`, '/recruitment')
    return c
  })
  r.patch('/candidates/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'recruitment.manage', 'Only HR, PMs and admins manage candidates.')
    const c = find(ctx, 'candidates', params.id, 'Candidate')
    if (c.stage === 'hired') err(409, 'CANDIDATE_HIRED', 'This candidate is hired. Change their details in People.')
    const patch = candInput(ctx, body, true)
    const out = update(ctx, 'candidates', c.id, patch, ifMatch)
    logActivity(ctx, 'candidate', c.id, 'updated', `${ctx.user.name} updated ${c.name}’s details`)
    return out
  })
  r.post('/candidates/:id/resume', ({ ctx, params, body }) => {
    requireAction(ctx, 'recruitment.manage')
    const c = find(ctx, 'candidates', params.id, 'Candidate')
    const name = str(body.name)
    const size = Number(body.size_bytes)
    if (!name || !String(body.data_url ?? '').startsWith('data:')) err(422, 'VALIDATION', 'Choose a resume file.', 'file')
    if (size > 5 * 1024 * 1024) err(422, 'FILE_TOO_LARGE', 'Resumes can be up to 5 MB.', 'file')
    const f = insert(ctx, 'files', { name, mime: str(body.mime) || 'application/octet-stream', size_bytes: size, entity: 'candidate', entity_id: c.id, data_url: String(body.data_url) } as never)
    const out = update(ctx, 'candidates', c.id, { resume_file_id: f.id })
    logActivity(ctx, 'candidate', c.id, 'resume', `${ctx.user.name} uploaded a resume (${name})`)
    return out
  })
  r.post('/candidates/:id/interviews', ({ ctx, params, body }) => {
    requireAction(ctx, 'recruitment.manage')
    const c = find(ctx, 'candidates', params.id, 'Candidate')
    if (['hired', 'rejected', 'withdrawn'].includes(c.stage)) err(409, 'CANDIDATE_CLOSED', `${c.name} is ${c.stage}; no more interviews.`)
    const kind = body.kind as B.Interview['kind']
    if (!['technical', 'hr', 'manager', 'assignment', 'final'].includes(kind)) err(422, 'VALIDATION', 'Pick the interview type.', 'kind')
    const at = str(body.scheduled_at)
    if (!at || Number.isNaN(new Date(at).getTime())) err(422, 'VALIDATION', 'Pick a date and time.', 'scheduled_at')
    const iv = find(ctx, 'users', str(body.interviewer_id), 'Interviewer')
    if (iv.status !== 'active') err(422, 'VALIDATION', 'Pick an active interviewer.', 'interviewer_id')
    const round = rows(ctx, 'interviews').filter((i) => i.candidate_id === c.id).length + 1
    const row = insert(ctx, 'interviews', { candidate_id: c.id, round, kind, scheduled_at: new Date(at).toISOString(), interviewer_id: iv.id, result: 'pending', rating: null, feedback: '' } as never)
    if (c.stage === 'applied' || c.stage === 'screening') update(ctx, 'candidates', c.id, { stage: 'interview' })
    logActivity(ctx, 'candidate', c.id, 'interview', `${ctx.user.name} scheduled round ${round} (${kind}) with ${iv.name}`)
    if (iv.id !== ctx.user.id) notify(ctx, iv.id, 'NTF-14', 'Interview scheduled', `${c.name} — round ${round} (${kind}) on ${fmtDate(at.slice(0, 10), 'long')}.`, '/recruitment')
    return row
  })
  r.patch('/interviews/:id', ({ ctx, params, body }) => {
    const iv = find(ctx, 'interviews', params.id, 'Interview')
    if (iv.interviewer_id !== ctx.user.id && !has(ctx, 'recruitment.manage')) err(403, 'FORBIDDEN', 'Only the interviewer or the hiring team records the result.')
    const result = body.result as B.Interview['result']
    if (!['pending', 'pass', 'fail', 'no_show'].includes(result)) err(422, 'VALIDATION', 'Pick a result.', 'result')
    const rating = body.rating === null || body.rating === undefined || body.rating === '' ? null : Number(body.rating)
    const feedback = str(body.feedback)
    if (result === 'pass' || result === 'fail') {
      if (rating === null || !Number.isInteger(rating) || rating < 1 || rating > 5) err(422, 'VALIDATION', 'Rate the candidate 1 to 5.', 'rating')
      if (feedback.length < 10) err(422, 'VALIDATION', 'Write at least 10 characters of feedback.', 'feedback')
    }
    const out = update(ctx, 'interviews', iv.id, { result, rating, feedback })
    const c = find(ctx, 'candidates', iv.candidate_id)
    logActivity(ctx, 'candidate', c.id, 'interview_result', `${ctx.user.name} recorded round ${iv.round}: ${result.replace('_', ' ')}${rating ? ` (${rating}/5)` : ''}`)
    return out
  })
  r.post('/candidates/:id/move', ({ ctx, params, body }) => {
    requireAction(ctx, 'recruitment.manage', 'Only HR, PMs and admins move candidates.')
    const c = find(ctx, 'candidates', params.id, 'Candidate')
    const stage = body.stage as B.CandidateStage
    if (!STAGES.includes(stage)) err(422, 'VALIDATION', 'Pick a stage.', 'stage')
    if (stage === c.stage) return c
    if (c.stage === 'hired') err(409, 'CANDIDATE_HIRED', `${c.name} is already hired.`)
    const o = find(ctx, 'openings', c.opening_id, 'Opening')
    const patch: Partial<B.Candidate> = { stage }
    let summary = `${ctx.user.name} moved ${c.name} to ${stage}`
    if (stage === 'offer') {
      const passed = rows(ctx, 'interviews').some((i) => i.candidate_id === c.id && i.result === 'pass')
      if (!passed) err(409, 'NEEDS_PASSED_INTERVIEW', `${c.name} has no passed interview yet. Record at least one passed round before making an offer.`)
      if (body.offer_ctc_paise !== undefined && body.offer_ctc_paise !== null) {
        const v = Number(body.offer_ctc_paise)
        if (!Number.isInteger(v) || v <= 0) err(422, 'VALIDATION', 'Enter the offered CTC.', 'offer_ctc_paise')
        patch.offer_ctc_paise = v
      }
      if (o.status === 'open' || o.status === 'interviewing') update(ctx, 'openings', o.id, { status: 'offered' })
    }
    if (stage === 'interview' && (o.status === 'open')) update(ctx, 'openings', o.id, { status: 'interviewing' })
    if (stage === 'rejected' || stage === 'withdrawn') {
      const reason = str(body.reason)
      if (reason.length < 5) err(422, 'VALIDATION', 'Give a reason of at least 5 characters.', 'reason')
      patch.rejected_reason = reason
      summary += `: ${reason}`
    }
    let invite: E.Invite | null = null
    let checklist: B.LifecycleChecklist | null = null
    if (stage === 'hired') {
      if (c.stage !== 'offer') err(409, 'NOT_OFFERED', `Make ${c.name} an offer before marking them hired.`)
      const joining = body.joining_on ?? c.joining_on
      if (!isDate(joining)) err(422, 'VALIDATION', 'Set the joining date to mark the candidate hired.', 'joining_on')
      const taken = emailTaken(ctx, c.email)
      if (taken) err(409, 'USER_EMAIL_TAKEN', `${taken} Use another email for ${c.name} first.`)
      patch.joining_on = joining
      const owner = user(ctx, o.owner_id)
      const project = o.project_id ? rows(ctx, 'projects').find((p) => p.id === o.project_id) : null
      const reportsTo = owner && permissionsOf(owner).some((k) => k === 'projects.edit' || k === 'team.view') ? owner.id : project?.pm_id ?? o.owner_id
      invite = insert(ctx, 'invites', { email: c.email, name: c.name, role: 'employee', reports_to_id: reportsTo, token: 'inv_' + uid(), expires_at: addDays(ctx.today, 14) + 'T00:00:00Z', accepted_at: null } as never) as E.Invite
      patch.user_id = invite.id
      checklist = insert(ctx, 'lifecycle_checklists', { user_id: invite.id, kind: 'onboarding', status: 'open', start_on: joining, last_day: null, exit_reason: null, exit_type: null, rehire_eligible: null, items: onboardingItems() } as never) as B.LifecycleChecklist
      const hiredCount = rows(ctx, 'candidates').filter((x) => x.opening_id === o.id && x.stage === 'hired').length + 1
      if (hiredCount >= o.count) update(ctx, 'openings', o.id, { status: 'filled' })
      summary = `${ctx.user.name} hired ${c.name} for ${o.role}, joining ${fmtDate(joining, 'long')}`
      logActivity(ctx, 'invite', invite.id, 'create', `Invited ${c.name} (${c.email}) after hiring`)
      logActivity(ctx, 'lifecycle', checklist.id, 'created', `Onboarding checklist started for ${c.name}`)
      for (const h of hrPeople(ctx)) if (h.id !== ctx.user.id) notify(ctx, h.id, 'NTF-14', 'New joiner', `${c.name} joins as ${o.role} on ${fmtDate(joining, 'long')}. Onboarding checklist created.`, '/lifecycle')
      if (reportsTo && reportsTo !== ctx.user.id) notify(ctx, reportsTo, 'NTF-14', 'New team member', `${c.name} joins your team on ${fmtDate(joining, 'long')}.`, '/lifecycle')
    }
    const out = update(ctx, 'candidates', c.id, patch)
    logActivity(ctx, 'candidate', c.id, stage === 'hired' ? 'hired' : 'moved', summary)
    return { ...out, invite_id: invite?.id, checklist_id: checklist?.id }
  })

  /* ---------------- lifecycle ---------------- */
  r.get('/lifecycle', ({ ctx }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins manage onboarding and exits.')
    sweepExits(ctx)
    const items = rows(ctx, 'lifecycle_checklists').map((c) => checklistView(ctx, c)).sort((a, b) => (a.status === b.status ? b.start_on.localeCompare(a.start_on) : a.status === 'open' ? -1 : 1))
    const taken = new Set(rows(ctx, 'lifecycle_checklists').filter((c) => c.status === 'open').map((c) => c.user_id))
    const people = [
      ...rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin).map((u) => ({ id: u.id, name: u.name, kind: 'user' as const })),
      ...rows(ctx, 'invites').filter((i) => !i.accepted_at).map((i) => ({ id: i.id, name: `${i.name} (invited)`, kind: 'invite' as const })),
    ].filter((p) => !taken.has(p.id))
    return { items, people } satisfies LifecycleView
  })
  r.post('/lifecycle', ({ ctx, body }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins start onboarding or exits.')
    const kind = body.kind === 'offboarding' ? 'offboarding' : 'onboarding'
    const pid = str(body.person_id)
    const u = rows(ctx, 'users').find((x) => x.id === pid)
    const inv = u ? null : rows(ctx, 'invites').find((i) => i.id === pid && !i.accepted_at)
    if (!u && !inv) err(422, 'VALIDATION', 'Pick a person.', 'person_id')
    if (kind === 'offboarding' && !u) err(422, 'VALIDATION', 'Exits are for people who have joined.', 'person_id')
    if (u && u.id === ctx.user.id && kind === 'offboarding') err(403, 'FORBIDDEN', 'Someone else records your own exit.')
    if (rows(ctx, 'lifecycle_checklists').some((c) => c.user_id === pid && c.status === 'open' && c.kind === kind)) err(409, 'DUPLICATE', `An open ${kind} checklist already exists for this person.`, 'person_id')
    const start = str(body.start_on)
    if (!isDate(start)) err(422, 'VALIDATION', kind === 'onboarding' ? 'Pick the joining date.' : 'Pick the resignation date.', 'start_on')
    let row: B.LifecycleChecklist
    const name = u?.name ?? inv!.name
    if (kind === 'offboarding') {
      const last = str(body.last_day)
      if (!isDate(last)) err(422, 'VALIDATION', 'Pick the last working day.', 'last_day')
      if (last < start) err(422, 'DATE_RANGE', 'The last day can’t be before the resignation date.', 'last_day')
      const et = body.exit_type as B.LifecycleChecklist['exit_type']
      if (!['resignation', 'termination', 'contract_end', 'retirement'].includes(et as string)) err(422, 'VALIDATION', 'Pick the exit type.', 'exit_type')
      const reason = str(body.exit_reason)
      if (reason.length < 5) err(422, 'VALIDATION', 'Record the reason in at least 5 characters.', 'exit_reason')
      row = insert(ctx, 'lifecycle_checklists', { user_id: u!.id, kind, status: 'open', start_on: start, last_day: last, exit_reason: reason, exit_type: et, rehire_eligible: body.rehire_eligible === null || body.rehire_eligible === undefined ? null : !!body.rehire_eligible, items: offboardingItems(start, last) } as never) as B.LifecycleChecklist
      if (u!.reports_to_id) notify(ctx, u!.reports_to_id, 'NTF-14', 'Exit started', `${name}’s last day is ${fmtDate(last, 'long')}. Plan knowledge transfer.`, '/lifecycle')
    } else {
      row = insert(ctx, 'lifecycle_checklists', { user_id: pid, kind, status: 'open', start_on: start, last_day: null, exit_reason: null, exit_type: null, rehire_eligible: null, items: onboardingItems() } as never) as B.LifecycleChecklist
    }
    logActivity(ctx, 'lifecycle', row.id, 'created', `${ctx.user.name} started ${kind} for ${name}`)
    return row
  })
  r.patch('/lifecycle/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'people.manage')
    const cl = find(ctx, 'lifecycle_checklists', params.id, 'Checklist')
    const patch: Partial<B.LifecycleChecklist> = {}
    if (body.last_day !== undefined) {
      if (cl.kind !== 'offboarding') err(422, 'VALIDATION', 'Only exits have a last day.')
      if (!isDate(body.last_day) || body.last_day < cl.start_on) err(422, 'DATE_RANGE', 'Pick a last day on or after the resignation date.', 'last_day')
      patch.last_day = body.last_day
      const fresh = offboardingItems(cl.start_on, body.last_day)
      patch.items = cl.items.map((i) => ({ ...i, due_offset_days: fresh.find((f) => f.id === i.id)?.due_offset_days ?? i.due_offset_days }))
    }
    if (body.exit_reason !== undefined) patch.exit_reason = str(body.exit_reason)
    if (body.exit_type !== undefined) patch.exit_type = body.exit_type
    if (body.rehire_eligible !== undefined) patch.rehire_eligible = body.rehire_eligible === null ? null : !!body.rehire_eligible
    const out = update(ctx, 'lifecycle_checklists', cl.id, patch, ifMatch)
    logActivity(ctx, 'lifecycle', cl.id, 'updated', `${ctx.user.name} updated the ${cl.kind} record for ${personOf(ctx, cl).name}`)
    sweepExits(ctx)
    return out
  })
  r.post('/lifecycle/:id/items/:itemId', ({ ctx, params, body }) => {
    const cl = find(ctx, 'lifecycle_checklists', params.id, 'Checklist')
    const item = cl.items.find((i) => i.id === params.itemId)
    if (!item) err(404, 'NOT_FOUND', 'Checklist item not found.')
    const p = personOf(ctx, cl)
    if (!canToggleItem(ctx, cl, item, p)) err(403, 'FORBIDDEN', `This item belongs to ${item.owner_role === 'manager' ? 'the person’s manager' : item.owner_role === 'employee' ? 'the person' : 'HR'}.`)
    const done = !!body.done
    if (done && item.id === 'asset_return' && p.user) {
      const out = rows(ctx, 'assets').filter((a) => a.assigned_to === p.user!.id && a.status === 'assigned')
      if (out.length) err(409, 'ASSETS_OUTSTANDING', `${out.length} asset${out.length > 1 ? 's are' : ' is'} still assigned (${out.map((a) => a.tag).join(', ')}). Record the return in Assets first.`)
    }
    if (done && item.id === 'laptop' && p.user && !rows(ctx, 'assets').some((a) => a.assigned_to === p.user!.id && a.category === 'laptop' && a.status === 'assigned'))
      warn(ctx, 'NO_LAPTOP_ASSIGNED', `No laptop is assigned to ${p.name} in Assets yet.`)
    const items = cl.items.map((i) => (i.id === item.id ? { ...i, done_on: done ? ctx.today : null, done_by: done ? ctx.user.id : null } : i))
    const complete = items.every((i) => i.done_on)
    const out = update(ctx, 'lifecycle_checklists', cl.id, { items, status: complete ? 'completed' : 'open' })
    logActivity(ctx, 'lifecycle', cl.id, done ? 'item_done' : 'item_reopened', `${ctx.user.name} ${done ? 'completed' : 'reopened'} “${item.label}” for ${p.name}`)
    if (complete) {
      logActivity(ctx, 'lifecycle', cl.id, 'completed', `${cl.kind === 'onboarding' ? 'Onboarding' : 'Exit'} checklist completed for ${p.name}`)
      for (const h of hrPeople(ctx)) if (h.id !== ctx.user.id) notify(ctx, h.id, 'NTF-05', `${cl.kind === 'onboarding' ? 'Onboarding' : 'Exit'} complete`, `Every item for ${p.name} is done.`, '/lifecycle')
      if (cl.kind === 'offboarding' && cl.last_day && cl.last_day <= ctx.today && p.user && p.user.status === 'active') {
        deactivateUser(ctx, p.user, `exit completed, last day ${fmtDate(cl.last_day, 'long')}`)
        warn(ctx, 'USER_DEACTIVATED', `${p.name} has been deactivated (last day ${fmtDate(cl.last_day)}).`)
      } else if (cl.kind === 'offboarding' && cl.last_day) warn(ctx, 'EXIT_SCHEDULED', `${p.name} will be deactivated after the last day, ${fmtDate(cl.last_day)}.`)
    }
    return out
  })

  /* ---------------- assets ---------------- */
  r.get('/assets', ({ ctx }) => {
    const all = isHR(ctx)
    const list = rows(ctx, 'assets').filter((a) => all || a.assigned_to === ctx.user.id).map((a) => assetView(ctx, a)).sort((a, b) => a.tag.localeCompare(b.tag))
    return {
      mode: all ? 'all' : 'mine',
      items: list,
      summary: {
        total: list.length, assigned: list.filter((a) => a.status === 'assigned').length, in_stock: list.filter((a) => a.status === 'in_stock').length, repair: list.filter((a) => a.status === 'repair').length,
        pending_return: list.filter((a) => a.pending_return).length, value_paise: list.filter((a) => a.status !== 'retired' && a.status !== 'lost').reduce((s, a) => s + a.purchase_cost_paise, 0),
      },
    } satisfies AssetsView
  })
  r.get('/assets/:id/history', ({ ctx, params }) => {
    const a = find(ctx, 'assets', params.id, 'Asset')
    if (!isHR(ctx) && a.assigned_to !== ctx.user.id) err(403, 'FORBIDDEN', 'You can see the history of assets assigned to you.')
    return rows(ctx, 'activity_log').filter((l) => l.entity === 'asset' && l.entity_id === a.id).sort((x, y) => y.at.localeCompare(x.at)).map((l) => ({ at: l.at, summary: l.summary, actor: userName(ctx, l.actor_id) }))
  })
  const assetInput = (ctx: Ctx, body: Record<string, unknown>, partial: boolean, selfId?: string) => {
    const out: Partial<B.Asset> = {}
    if (!partial || body.tag !== undefined) {
      const t = str(body.tag).toUpperCase()
      if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(t)) err(422, 'VALIDATION', 'Use a tag like SEE-LAP-015 (letters, digits and dashes).', 'tag')
      if (rows(ctx, 'assets').some((a) => a.tag === t && a.id !== selfId)) err(409, 'ASSET_TAG_TAKEN', `Tag ${t} is already used.`, 'tag')
      out.tag = t
    }
    if (!partial || body.name !== undefined) { const n = str(body.name); if (n.length < 2) err(422, 'VALIDATION', 'Describe the asset, e.g. “Dell Latitude 5440”.', 'name'); out.name = n }
    if (!partial || body.category !== undefined) { if (!ASSET_CATS.includes(body.category as B.Asset['category'])) err(422, 'VALIDATION', 'Pick a category.', 'category'); out.category = body.category as B.Asset['category'] }
    if (body.serial !== undefined) out.serial = str(body.serial)
    if (!partial || body.purchase_on !== undefined) { if (!isDate(body.purchase_on)) err(422, 'VALIDATION', 'Pick the purchase date.', 'purchase_on'); if ((body.purchase_on as string) > ctx.today) err(422, 'DATE_RANGE', 'The purchase date can’t be in the future.', 'purchase_on'); out.purchase_on = body.purchase_on as string }
    if (!partial || body.purchase_cost_paise !== undefined) { const v = Number(body.purchase_cost_paise); if (!Number.isInteger(v) || v < 0) err(422, 'VALIDATION', 'Enter the purchase cost.', 'purchase_cost_paise'); out.purchase_cost_paise = v }
    if (body.warranty_until !== undefined) { if (body.warranty_until && !isDate(body.warranty_until)) err(422, 'VALIDATION', 'Pick the warranty end date.', 'warranty_until'); out.warranty_until = (body.warranty_until as string) || null }
    if (body.notes !== undefined) out.notes = str(body.notes)
    return out
  }
  r.post('/assets', ({ ctx, body }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins manage the asset register.')
    const data = assetInput(ctx, body, false)
    const a = insert(ctx, 'assets', { serial: '', warranty_until: null, notes: '', ...data, status: 'in_stock', assigned_to: null, assigned_on: null } as never)
    logActivity(ctx, 'asset', a.id, 'created', `${ctx.user.name} registered ${a.tag} (${a.name})`)
    return a
  })
  r.patch('/assets/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins manage the asset register.')
    const a = find(ctx, 'assets', params.id, 'Asset')
    const patch = assetInput(ctx, body, true, a.id)
    if (body.status !== undefined) {
      const st = body.status as B.Asset['status']
      if (!['in_stock', 'repair', 'retired', 'lost'].includes(st)) err(422, 'VALIDATION', 'Use Assign or Return to change who holds it.', 'status')
      if (a.status === 'assigned' && st !== 'lost') err(409, 'ASSET_ASSIGNED', `${a.tag} is with ${userName(ctx, a.assigned_to)}. Record the return first.`, 'status')
      patch.status = st
      if (st === 'lost') Object.assign(patch, { assigned_to: null, assigned_on: null })
    }
    const out = update(ctx, 'assets', a.id, patch, ifMatch)
    logActivity(ctx, 'asset', a.id, 'updated', `${ctx.user.name} updated ${out.tag}${patch.status ? ` — status ${patch.status.replace('_', ' ')}` : ''}`)
    return out
  })
  r.post('/assets/:id/assign', ({ ctx, params, body }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins assign assets.')
    const a = find(ctx, 'assets', params.id, 'Asset')
    if (a.status !== 'in_stock') err(409, 'ASSET_NOT_AVAILABLE', a.status === 'assigned' ? `${a.tag} is already with ${userName(ctx, a.assigned_to)}. Record the return first.` : `${a.tag} is ${a.status.replace('_', ' ')} and can’t be assigned.`)
    const u = find(ctx, 'users', str(body.user_id), 'Person')
    if (u.status !== 'active') err(422, 'VALIDATION', `${u.name} is not an active user.`, 'user_id')
    const out = update(ctx, 'assets', a.id, { status: 'assigned', assigned_to: u.id, assigned_on: ctx.today })
    logActivity(ctx, 'asset', a.id, 'assigned', `${ctx.user.name} assigned ${a.tag} to ${u.name}`)
    notify(ctx, u.id, 'NTF-14', 'Asset assigned', `${a.tag} (${a.name}) is now assigned to you.`, '/assets')
    return out
  })
  r.post('/assets/:id/return', ({ ctx, params, body }) => {
    requireAction(ctx, 'people.manage', 'Only HR and admins record returns.')
    const a = find(ctx, 'assets', params.id, 'Asset')
    if (a.status !== 'assigned') err(409, 'ASSET_NOT_ASSIGNED', `${a.tag} is not assigned to anyone.`)
    const st = body.status === 'repair' ? 'repair' : 'in_stock'
    const note = str(body.note)
    const who = userName(ctx, a.assigned_to)
    const out = update(ctx, 'assets', a.id, { status: st, assigned_to: null, assigned_on: null })
    logActivity(ctx, 'asset', a.id, 'returned', `${ctx.user.name} recorded the return of ${a.tag} from ${who}${st === 'repair' ? ' (sent for repair)' : ''}${note ? ` — ${note}` : ''}`)
    return out
  })

  /* ---------------- dashboard ---------------- */
  r.get('/hr/dashboard', ({ ctx }) => {
    requireAny(ctx, ['people.manage', 'people.view_all'], 'The HR dashboard is for HR and admins.')
    sweepExits(ctx)
    const fm = S(ctx)['company.fy_start_month']
    const q = quarterOf(ctx.today, fm)
    const users = rows(ctx, 'users').filter((u) => !u.is_super_admin)
    const active = users.filter((u) => u.status === 'active')
    const exitsIn = (from: string, to: string) => rows(ctx, 'lifecycle_checklists').filter((c) => c.kind === 'offboarding' && c.last_day && c.last_day >= from && c.last_day <= to)
    const exits12 = exitsIn(addDays(ctx.today, -365), ctx.today).length
    const cands = rows(ctx, 'candidates')
    const pend = rows(ctx, 'leave_requests').filter((x) => x.status === 'pending').sort((a, b) => a.from_on.localeCompare(b.from_on))
    const cyc = rows(ctx, 'appraisal_cycles').filter((c) => c.status !== 'draft').sort((a, b) => (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0) || b.period_from.localeCompare(a.period_from))[0]
    const cv = cyc ? cycleView(ctx, cyc) : null
    const due: HrDashboard['lifecycle_due'] = []
    for (const cl of rows(ctx, 'lifecycle_checklists').filter((c) => c.status === 'open')) {
      const p = personOf(ctx, cl)
      for (const i of cl.items) {
        if (i.done_on) continue
        const d = addDays(cl.start_on, i.due_offset_days)
        const days = diffDays(d, ctx.today)
        if (days <= 7) due.push({ checklist_id: cl.id, person: p.name, kind: cl.kind, label: i.label, due_on: d, days })
      }
    }
    const back = rows(ctx, 'assets').map((a) => assetView(ctx, a)).filter((a) => a.pending_return)
    /* v7 "Needs attention": who needs HR's action today (persona round). */
    const pendingExpenses = rows(ctx, 'expense_claims').filter((x) => x.status === 'submitted' || x.status === 'approved').length
    const wfWaiting = rows(ctx, 'wf_instances').filter((i) => i.status === 'in_progress' && i.current_assignee_id === ctx.user.id).length
    const docsToVerify = rows(ctx, 'employee_documents').filter((d) => d.status === 'pending').length
    // Probation ends 6 months after joining; due = ends within 30 days (or recently ended) with no confirmation letter issued yet.
    const confirmed = new Set(rows(ctx, 'issued_documents').filter((d) => d.category === 'confirmation_letter' && d.status !== 'revoked').map((d) => d.employee_id))
    const probationDue = active.filter((u) => {
      if (confirmed.has(u.id)) return false
      const end = addMonths(u.joined_on, 6)
      return end >= addDays(ctx.today, -90) && end <= addDays(ctx.today, 30)
    }).length
    // Outstanding acknowledgements on must-read company policies across active staff.
    const mustRead = rows(ctx, 'documents').filter((d) => !d.project_id && d.must_read && !d.archived && d.visibility === 'company')
    const acks = rows(ctx, 'document_acks')
    let unacked = 0
    for (const doc of mustRead) for (const u of active) if (!acks.some((a) => a.document_id === doc.id && a.user_id === u.id && a.version >= doc.current_version)) unacked++
    const attention: HrDashboard['attention'] = [
      { key: 'leave', label: 'Leave approvals pending', count: pend.length, to: '/leave', hint: 'Leave requests waiting for a decision across the company.' },
      { key: 'expenses', label: 'Expense claims open', count: pendingExpenses, to: '/expenses', hint: 'Submitted claims waiting for a decision anywhere in the company, plus approved claims waiting to be paid out.' },
      { key: 'workflows', label: 'Workflow steps on me', count: wfWaiting, to: '/workflows', hint: 'Workflow stages currently assigned to you.' },
      { key: 'docs', label: 'Documents to verify', count: docsToVerify, to: '/documents?tab=employees', hint: 'Employee uploads waiting for HR verification.' },
      { key: 'probation', label: 'Probation confirmations due', count: probationDue, to: '/workflows', hint: 'Probation (6 months) ends within 30 days, or ended recently, with no confirmation letter issued.' },
      { key: 'policies', label: 'Policy acks outstanding', count: unacked, to: '/documents?tab=policies', hint: 'Must-read policies not yet acknowledged, totalled across active staff.' },
    ]
    return {
      attention,
      headcount: active.length,
      joiners_q: users.filter((u) => u.joined_on >= q.from && u.joined_on <= q.to).length + rows(ctx, 'invites').filter((i) => !i.accepted_at && rows(ctx, 'lifecycle_checklists').some((c) => c.user_id === i.id && c.start_on >= q.from && c.start_on <= q.to)).length,
      exits_q: exitsIn(q.from, q.to).length,
      attrition_pct: active.length ? exits12 / ((active.length + active.length + exits12) / 2) : null,
      quarter_label: q.label,
      open_positions: rows(ctx, 'openings').filter((o) => o.status !== 'filled' && o.status !== 'on_hold').reduce((s, o) => s + Math.max(0, o.count - cands.filter((c) => c.opening_id === o.id && c.stage === 'hired').length), 0),
      candidates_by_stage: (['applied', 'screening', 'interview', 'offer', 'hired'] as B.CandidateStage[]).map((stage) => ({ stage, count: cands.filter((c) => c.stage === stage).length })),
      pending_leave: pend.length,
      pending_leave_items: pend.slice(0, 6).map((x) => { const u = user(ctx, x.user_id); return { id: x.id, name: u?.name ?? '—', hue: u?.avatar_hue ?? 150, type: x.type, from_on: x.from_on, to_on: x.to_on, days: x.days, approver: x.approver_id ? userName(ctx, x.approver_id) : null } }),
      on_time_pct: taskStats(ctx, { userIds: active.map((u) => u.id), from: addDays(ctx.today, -90), to: ctx.today }).on_time_pct,
      cycle: cv ? { id: cv.id, name: cv.name, status: cv.status, total: cv.total, completed: cv.counts.completed, counts: cv.counts } : null,
      lifecycle_due: due.sort((a, b) => a.days - b.days).slice(0, 8),
      assets_due_back: back.map((a) => ({ id: a.id, tag: a.tag, name: a.name, person: a.assignee_name ?? '—', last_day: rows(ctx, 'lifecycle_checklists').find((c) => c.kind === 'offboarding' && c.user_id === a.assigned_to)?.last_day ?? null })),
    } satisfies HrDashboard
  })
}
