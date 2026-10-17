// Module B — projects & delivery. Mock of the FastAPI routers for projects, milestones, WBS tasks (write side of the
// shared task contract), allocations, schedule/critical path, money (margins, invoices, payments), change requests,
// openings, WBS import and the client view. Rules enforced here, never in components.
import type * as E from '@/types/entities'
import {
  calendarFor, canSeeMargins, err, has, hasAny, find, permissionsOf, getDb, insert, logActivity, nextNumber, notify, nowISO, remove, removeWhere, rows, uid, update, userName, warn,
  type Ctx, type Router,
} from '../server'
import { allocationOn, cal, costedEntries, currentRatePH, depsOf, milestoneState, openBlockers, projectMetrics, redactMetrics, taskActuals, type MilestoneDelivery } from '../analytics'
import { computeSchedule as computeScheduleCore, earnedHours, ensureSwept, scheduleOf, stageSince, sweepMilestones as sweepMilestonesCore, syncMilestoneDates } from '../analytics'
import { STAGE, TASK_TAG, progressOf, stageOf, statusForStage } from '@/domain/delivery'
// v5 workstream A: cost calculator, auto milestone setup, costing & margins
import { analyse, canPlanCost, insertPlanAllocations, insertProjectDocuments, projectRowInfo, publicAnalysis, registerCostingRoutes, spreadMilestones, validateCosting, validateCreateDocuments, type ValidCosting } from '../costing'
import { addDays, addWorkingDays, diffDays, fmtDate, fyStartYear, isRealISODate, isWorkingDay, maxISO, minISO, workingDaysBetween } from '@/domain/calendar'
import { PROJECT_STATUS, TASK_STATUS } from '@/domain/labels'
import { fmtMoney } from '@/domain/money'
import { marginPct, markupPct } from '@/domain/costing'
import { parseCSV } from '@/lib/utils'
import type { TaskDetail, TaskRef } from '@/api/tasks'
import { freezeWbs, wbsOf } from './tasks'
import { nextInvoiceNumber, raiseMilestoneInvoice, recordRevenuePayment } from './invoices'
import { applyStage, approveTask, canManageGeneral, canReviewTask, isTop, reviewerOf, selfReview } from './taskflow'
import { taskStats, taskTimeliness } from '../performance'
import type {
  ActivityItem, AllocationView, BillingRow, BillingSummary, ClientView, ImportPreview, ImportRow, InvoiceView, MilestoneView, OpeningView, PersonLoad, ProjectDetail, ProjectList,
  ProjectListItem, ProjectLoad, ProjectMoney, Schedule, ScheduleTask, TaskView,
} from '@/api/projects'

/* ================================================================== */
/* Access                                                              */
/* ================================================================== */
const STATUSES: E.ProjectStatus[] = ['initiated', 'active', 'on_hold', 'npa', 'completed', 'closed']
const TYPES: E.ProjectType[] = ['product', 'service', 'saas', 'ams']
const MODELS: E.BillingModel[] = ['fixed', 'tm', 'subscription', 'ams_retainer']
const STREAMS: E.RevenueStream[] = ['sap_consulting', 'products', 'services', 'saas', 'ams']
const TASK_STATUSES: E.TaskStatus[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done']
const CX: E.Complexity[] = ['low', 'medium', 'high', 'very_high']
const TAGS = Object.keys(TASK_TAG) as E.TaskTag[]
const ISO = { test: (s: string) => isRealISODate(s) }

function myDealProjectIds(ctx: Ctx) {
  const mine = rows(ctx, 'deals').filter((d) => d.owner_id === ctx.user.id)
  const ids = new Set(mine.map((d) => d.project_id).filter(Boolean) as string[])
  const dealIds = new Set(mine.map((d) => d.id))
  for (const p of rows(ctx, 'projects')) if (p.deal_id && dealIds.has(p.deal_id)) ids.add(p.id)
  return ids
}
function myTaskProjectIds(ctx: Ctx) {
  return new Set(rows(ctx, 'tasks').filter((t) => t.owner_id === ctx.user.id || t.backup_id === ctx.user.id).map((t) => t.project_id))
}
/** Projects a user is on without `projects.view_all`: they PM it, own/back up a task, are allocated, or own its deal. */
export function myProjectIds(ctx: Ctx): Set<string> {
  const me = ctx.user.id
  const ids = myTaskProjectIds(ctx)
  for (const p of rows(ctx, 'projects')) if (p.pm_id === me) ids.add(p.id)
  for (const a of rows(ctx, 'allocations')) if (a.user_id === me) ids.add(a.project_id)
  for (const id of myDealProjectIds(ctx)) ids.add(id)
  return ids
}
export function canView(ctx: Ctx, p: E.Project) {
  if (has(ctx, 'projects.view_all')) return true
  return myProjectIds(ctx).has(p.id)
}
/** Edit rights: `projects.manage_all` on any project; `projects.edit` on projects they manage. */
export function canEdit(ctx: Ctx, p: E.Project) {
  return has(ctx, 'projects.manage_all') || (has(ctx, 'projects.edit') && p.pm_id === ctx.user.id)
}
function getProject(ctx: Ctx, id: string) {
  const p = find(ctx, 'projects', id, 'Project')
  if (!canView(ctx, p)) err(403, 'FORBIDDEN', 'You don’t have access to this project.')
  return p
}
function editableProject(ctx: Ctx, id: string) {
  const p = getProject(ctx, id)
  if (!canEdit(ctx, p)) err(403, 'FORBIDDEN', has(ctx, 'projects.edit') ? 'Only the project manager of this project (or an admin) can change it.' : 'You can’t change this project.')
  return p
}
const isAdmin = (ctx: Ctx) => has(ctx, 'projects.manage_all')

function need(v: unknown, field: string, label: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) err(422, 'VALIDATION', `${label} is required.`, field)
  return s
}
function needDate(v: unknown, field: string, label: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!ISO.test(s)) err(422, 'VALIDATION', `${label} needs a valid date.`, field)
  return s
}
function money(v: unknown, field: string, label: string, allowZero = true): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n <= 0) || !Number.isInteger(n)) err(422, 'MONEY_INVALID', `${label} must be ${allowZero ? 'zero or more' : 'more than zero'}.`, field)
  return n
}
function activeUser(ctx: Ctx, id: string | null | undefined, field: string, mustManageProjects = false) {
  if (!id) return null
  const u = rows(ctx, 'users').find((x) => x.id === id)
  if (!u || u.status !== 'active') err(422, 'VALIDATION', 'Choose an active person from your team.', field)
  if (mustManageProjects && !permissionsOf(u).includes('projects.edit')) err(422, 'VALIDATION', `${u.name} can’t manage projects. Choose a project manager or an admin.`, field)
  return u
}

/* ================================================================== */
/* Numbering (BR-19: never reused)                                     */
/* ================================================================== */
function peekNumber(ctx: Ctx, scope: string, start: number) {
  const s = getDb().number_sequences.find((x) => x.tenant_id === ctx.tenant.id && x.scope === scope)
  return Math.max(s?.next_value ?? start, start)
}
function takeNumber(ctx: Ctx, scope: string, start: number) {
  const d = getDb()
  const s = d.number_sequences.find((x) => x.tenant_id === ctx.tenant.id && x.scope === scope)
  if (s && s.next_value < start) s.next_value = start
  return nextNumber(ctx, scope, start)
}
function allMilestones(ctx: Ctx, pid: string) {
  return rows(ctx, 'milestones').filter((m) => m.project_id === pid)
}
function liveMilestones(ctx: Ctx, pid: string) {
  return allMilestones(ctx, pid).filter((m) => !m.deleted_at).sort((a, b) => a.no - b.no)
}
function msScope(pid: string) {
  return `milestone:${pid}`
}
function taskScope(pid: string, msId: string | null) {
  return msId ? `task:${msId}` : `task:none:${pid}`
}
function nextMsNo(ctx: Ctx, pid: string, take: boolean) {
  const start = Math.max(0, ...allMilestones(ctx, pid).map((m) => m.no)) + 1
  return take ? takeNumber(ctx, msScope(pid), start) : peekNumber(ctx, msScope(pid), start)
}
/** Next task number in a milestone (2.1, 2.2 …). Counts every task that ever carried that milestone's prefix — including
 *  ones since moved elsewhere, which keep their number — so numbers are never reused. */
export function nextTaskNo(ctx: Ctx, pid: string, msId: string | null, take: boolean) {
  const all = new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
  const prefix = `${msId ? all.get(msId)?.no ?? 0 : 0}.`
  const used = rows(ctx, 'tasks').filter((t) => t.project_id === pid).map((t) => wbsOf(t, all)).filter((c) => c.startsWith(prefix)).map((c) => Number(c.slice(prefix.length)) || 0)
  const start = Math.max(0, ...used) + 1
  return take ? takeNumber(ctx, taskScope(pid, msId), start) : peekNumber(ctx, taskScope(pid, msId), start)
}
/** Permanent WBS code for a new task: its milestone's number + the next task number there. */
function newTaskCode(ctx: Ctx, pid: string, m: E.Milestone | null) {
  const no = nextTaskNo(ctx, pid, m?.id ?? null, true)
  return { no, wbs_code: `${m ? m.no : 0}.${no}` }
}

/* ================================================================== */
/* WBS helpers                                                         */
/* ================================================================== */
function msMap(ctx: Ctx) {
  return new Map(rows(ctx, 'milestones').filter((m) => !m.deleted_at).map((m) => [m.id, m]))
}
function taskRef(t: E.Task, ms: Map<string, E.Milestone>): TaskRef {
  return { id: t.id, wbs: wbsOf(t, ms), title: t.title, status: t.status, owner_id: t.owner_id, due_on: t.due_on, project_id: t.project_id }
}
function sortWbs(a: string, b: string) {
  const [a1, a2] = a.split('.').map(Number)
  const [b1, b2] = b.split('.').map(Number)
  return (a1 || 1e6) - (b1 || 1e6) || a2 - b2
}

/** Local builder for the shared TaskDetail contract (module C owns GET /tasks/:id). */
function buildTaskDetail(ctx: Ctx, t: E.Task): TaskDetail {
  const p = find(ctx, 'projects', t.project_id, 'Project')
  const ms = msMap(ctx)
  const all = rows(ctx, 'tasks')
  const byId = new Map(all.map((x) => [x.id, x]))
  const deps = depsOf(ctx, t.id)
  const dependents = rows(ctx, 'task_dependencies').filter((d) => d.depends_on_task_id === t.id).map((d) => byId.get(d.task_id)).filter(Boolean) as E.Task[]
  const a = taskActuals(ctx).get(t.id)
  const editor = canEdit(ctx, p)
  const m = t.milestone_id ? ms.get(t.milestone_id) ?? null : null
  return {
    task: t,
    wbs: wbsOf(t, ms),
    project: { id: p.id, name: p.name, code: p.code, status: p.status, pm_id: p.pm_id },
    milestone: m ? { id: m.id, no: m.no, name: m.name } : null,
    dependencies: deps.map((d) => taskRef(d, ms)),
    dependents: dependents.map((d) => taskRef(d, ms)),
    blockers: deps.filter((d) => d.status !== 'done').map((d) => taskRef(d, ms)),
    actual_hours: a?.hours ?? 0,
    approved_hours: a?.approved ?? 0,
    can_edit: editor,
    can_change_status: editor || t.owner_id === ctx.user.id || t.backup_id === ctx.user.id,
    can_comment: editor || canView(ctx, p),
  }
}

/** BR-20 sweep (the JOB-12 worker in the real build) — lives in analytics.ts so list/dashboards share it. */
function sweepMilestones(ctx: Ctx, p: E.Project) {
  sweepMilestonesCore(ctx, p)
}
function autoDeleteOn(ctx: Ctx, m: E.Milestone) {
  if (!m.empty_since || m.billing_status !== 'none') return null
  return addDays(m.empty_since, ctx.tenant.settings['projects.empty_milestone_days'])
}

export function syncAchieved(ctx: Ctx, msId: string | null) {
  if (!msId) return
  const m = getDb().milestones.find((x) => x.id === msId)
  if (!m || m.tenant_id !== ctx.tenant.id) return
  const mine = rows(ctx, 'tasks').filter((t) => t.milestone_id === msId)
  const allDone = mine.length > 0 && mine.every((t) => t.status === 'done')
  if (allDone && !m.achieved_on) m.achieved_on = mine.reduce((mx, t) => maxISO(mx, t.done_on ?? ctx.today), '0000-01-01')
  else if (!allDone && m.achieved_on && mine.length) m.achieved_on = null
}

function detectCycle(ctx: Ctx, edges: Map<string, string[]>, start: string): boolean {
  // Would following deps from `start` come back to `start`?
  const seen = new Set<string>()
  const stack = [...(edges.get(start) ?? [])]
  while (stack.length) {
    const x = stack.pop()!
    if (x === start) return true
    if (seen.has(x)) continue
    seen.add(x)
    stack.push(...(edges.get(x) ?? []))
  }
  void ctx
  return false
}
function depEdges(ctx: Ctx) {
  const m = new Map<string, string[]>()
  for (const d of rows(ctx, 'task_dependencies')) {
    if (!m.has(d.task_id)) m.set(d.task_id, [])
    m.get(d.task_id)!.push(d.depends_on_task_id)
  }
  return m
}

/* ================================================================== */
/* Views                                                               */
/* ================================================================== */
function listItem(ctx: Ctx, p: E.Project): ProjectListItem {
  const m = redactMetrics(ctx, projectMetrics(ctx, p), canSeeMargins(ctx))
  return { ...stripProject(ctx, p), metrics: m, can_edit: canEdit(ctx, p), team_ids: m.team, row: projectRowInfo(ctx, p) }
}
function stripProject(ctx: Ctx, p: E.Project): E.Project {
  if (hasAny(ctx, 'finance.view', 'margins.view', 'projects.edit')) return p
  // the saved cost calculator carries the price and the markup (= the margin): same rule as the contract value
  return { ...p, contract_value_paise: 0, ...(p.costing !== undefined ? { costing: null } : {}) }
}

function taskView(ctx: Ctx, t: E.Task, ms: Map<string, E.Milestone>): TaskView {
  const a = taskActuals(ctx).get(t.id)
  const deps = depsOf(ctx, t.id)
  const blockers = deps.filter((d) => d.status !== 'done').map((d) => ({ id: d.id, wbs: wbsOf(d, ms), title: d.title, owner_id: d.owner_id }))
  let risk: TaskView['risk'] = null
  if (t.status !== 'done' && t.status !== 'in_review') {
    if (t.due_on < ctx.today) risk = 'overdue'
    else if (t.status === 'blocked') risk = 'blocked'
    else if (t.status === 'todo' && diffDays(t.due_on, ctx.today) <= 3) risk = 'due_soon'
  }
  const tl = taskTimeliness(ctx, t)
  const st = scheduleOf(ctx, t.project_id).schedule?.tasks.find((x) => x.id === t.id)
  const revs = t.target_revisions ?? []
  return {
    ...t, stage: stageOf(t), progress: progressOf(t), timeliness: tl?.timeliness ?? null, variance_days: tl?.variance ?? null, wbs: wbsOf(t, ms), actual_hours: a?.hours ?? 0, approved_hours: a?.approved ?? 0, dep_ids: deps.map((d) => d.id), blockers, risk,
    dep_wbs: deps.map((d) => wbsOf(d, ms)).sort(sortWbs), forecast_start: st?.forecast_start ?? null, forecast_end: st?.forecast_end ?? null, float_days: st ? st.float_days : null, project_float_days: st ? st.project_float_days ?? null : null, critical: !!st?.critical,
    revised_on: revs.length ? revs[revs.length - 1].at.slice(0, 10) : null,
  }
}

function milestoneViews(ctx: Ctx, p: E.Project, tasks: E.Task[]): MilestoneView[] {
  const act = taskActuals(ctx)
  const invoices = rows(ctx, 'invoices')
  const sched = scheduleOf(ctx, p.id)
  const fin = has(ctx, 'finance.view')
  return liveMilestones(ctx, p.id).map((m) => {
    const fc = sched.msForecast.get(m.id) ?? null
    const s = milestoneState(ctx, m, tasks, m.achieved_on ? null : fc)
    const mine = tasks.filter((t) => t.milestone_id === m.id)
    const inv = invoices.find((i) => i.milestone_id === m.id) ?? null
    const achieved = s.state === 'achieved_on_time' || s.state === 'achieved_late'
    const endOn = m.achieved_on ?? (achieved ? mine.reduce((mx, t) => maxISO(mx, t.done_on ?? t.due_on), '0000-01-01') : fc)
    return {
      ...m,
      state: s.state,
      slip: s.slip,
      progress: s.progress,
      task_count: s.taskCount,
      open_count: s.openCount,
      est_hours: s.est,
      earned_hours: Math.round(s.earned * 10) / 10,
      logged_hours: mine.reduce((x, t) => x + (act.get(t.id)?.hours ?? 0), 0),
      invoice_id: inv?.id ?? null,
      invoice: fin && inv ? { id: inv.id, number: inv.number, amount_paise: inv.amount_paise, outstanding_paise: inv.amount_paise - inv.paid_amount_paise } : null,
      auto_delete_on: autoDeleteOn(ctx, m),
      forecast_end: fc,
      end_kind: mine.length ? (achieved ? 'achieved' : 'forecast') : null,
      end_on: mine.length ? endOn : null,
    }
  })
}

/** Milestone billing totals for the line under the milestone table (G4.05). */
function billingSummary(ctx: Ctx, p: E.Project, tasks: E.Task[]): BillingSummary | null {
  if (!hasAny(ctx, 'finance.view', 'projects.edit', 'margins.view')) return null
  const out: BillingSummary = { total: 0, paid: 0, invoiced_unpaid: 0, achieved_not_invoiced: 0, not_due: 0 }
  for (const m of liveMilestones(ctx, p.id)) {
    out.total += m.billing_amount_paise
    if (m.billing_status === 'paid') out.paid += m.billing_amount_paise
    else if (m.billing_status === 'invoiced') out.invoiced_unpaid += m.billing_amount_paise
    else {
      const st = milestoneState(ctx, m, tasks).state
      if (st === 'achieved_on_time' || st === 'achieved_late') out.achieved_not_invoiced += m.billing_amount_paise
      else out.not_due += m.billing_amount_paise
    }
  }
  return out
}

function allocView(ctx: Ctx, a: E.Allocation, ms: Map<string, E.Milestone>): AllocationView {
  const m = a.milestone_id ? ms.get(a.milestone_id) : undefined
  return { ...a, ms_code: a.milestone_id ? (m ? `M${m.no}` : '—') : 'All', ms_name: a.milestone_id ? m?.name ?? 'Removed milestone' : 'All milestones' }
}

/* ================================================================== */
/* Schedule: forecast + critical path (prototype §6.4, §7, §8)         */
/* ================================================================== */
function computeSchedule(ctx: Ctx, p: E.Project): Schedule {
  ensureSwept(ctx)
  return { ...scheduleOf(ctx, p.id).schedule ?? computeScheduleCore(ctx, p), can_edit: canEdit(ctx, p) }
}

/* ================================================================== */
/* Allocations (BR-22, SVC-12)                                         */
/* ================================================================== */
function validateAllocation(ctx: Ctx, p: E.Project, b: Record<string, unknown>, selfId: string | null) {
  const user_id = typeof b.user_id === 'string' ? b.user_id : ''
  const milestone_id = typeof b.milestone_id === 'string' ? b.milestone_id : ''
  const pct = Number(b.pct)
  const from_on = typeof b.from_on === 'string' ? b.from_on : ''
  const to_on = typeof b.to_on === 'string' ? b.to_on : ''
  if (!user_id) err(422, 'ALLOC_INVALID', 'Choose the person to allocate.', 'user_id')
  const u = activeUser(ctx, user_id, 'user_id')!
  // Feature Guide §6 (G6.01): person, milestone, % and both dates are all required, so cost always lands on a milestone and a period
  if (!milestone_id) err(422, 'ALLOC_INVALID', `${u.name}: choose the milestone (M1, M2…). Every allocation lands on a milestone.`, 'milestone_id')
  if (milestone_id) {
    const m = rows(ctx, 'milestones').find((x) => x.id === milestone_id && !x.deleted_at)
    if (!m || m.project_id !== p.id) err(422, 'ALLOC_INVALID', 'The milestone must belong to this project.', 'milestone_id')
  }
  if (!Number.isFinite(pct) || pct < 1 || pct > 100 || b.pct === null || b.pct === '') err(422, 'ALLOC_INVALID', `${u.name}: set an allocation between 1% and 100%.`, 'pct')
  if (!ISO.test(from_on)) err(422, 'ALLOC_INVALID', `${u.name}: the start date is required.`, 'from_on')
  if (!ISO.test(to_on)) err(422, 'ALLOC_INVALID', `${u.name}: the end date is required.`, 'to_on')
  if (from_on > to_on) err(422, 'ALLOC_INVALID', `${u.name}: the start date is after the end date.`, 'to_on')
  if (from_on < p.start_on || to_on > p.end_on) err(422, 'ALLOC_INVALID', `Allocation dates must sit inside the project (${fmtDate(p.start_on)} – ${fmtDate(p.end_on)}).`, from_on < p.start_on ? 'from_on' : 'to_on')
  // over-allocation across all projects on each working day
  const max = ctx.tenant.settings['allocation.max_pct_per_person']
  const self = selfId ? rows(ctx, 'allocations').find((a) => a.id === selfId) : null
  const c = calendarFor(ctx, user_id)
  const over: string[] = []
  for (let d = from_on; d <= to_on; d = addDays(d, 1)) {
    if (!isWorkingDay(d, c)) continue
    let total = allocationOn(ctx, user_id, d) + pct
    if (self && self.user_id === user_id && self.from_on <= d && self.to_on >= d) total -= self.pct
    if (total > max) over.push(d)
  }
  if (over.length) {
    const msg = `${u.name} would be over ${max}% on ${over.length} working day${over.length === 1 ? '' : 's'} (${fmtDate(over[0])}${over.length > 1 ? ` – ${fmtDate(over[over.length - 1])}` : ''}).`
    if (ctx.tenant.settings['allocation.block_over']) err(409, 'ALLOC_OVER', msg + ' Lower the percentage or shorten the dates.', 'pct')
    warn(ctx, 'ALLOC_OVER', msg)
  }
  return { user_id, milestone_id: milestone_id || null, pct: Math.round(pct), from_on, to_on, project_id: p.id }
}

function projectLoad(ctx: Ctx, p: E.Project): ProjectLoad {
  const max = ctx.tenant.settings['allocation.max_pct_per_person']
  const allocs = rows(ctx, 'allocations').filter((a) => a.project_id === p.id)
  const people = [...new Set([...allocs.map((a) => a.user_id), ...projectMetrics(ctx, p).team])]
  const c = { ...cal(ctx), leaveDates: undefined }
  const next: string[] = []
  for (let d = ctx.today; next.length < 10; d = addDays(d, 1)) if (isWorkingDay(d, c)) next.push(d)
  const out: PersonLoad[] = people.map((uid2) => {
    const days = next.map((d) => ({
      date: d,
      total_pct: allocationOn(ctx, uid2, d),
      project_pct: allocs.filter((a) => a.user_id === uid2 && a.from_on <= d && a.to_on >= d).reduce((s, a) => s + a.pct, 0),
    }))
    const mine = allocs.filter((a) => a.user_id === uid2)
    const over: { date: string; pct: number }[] = []
    const pc = calendarFor(ctx, uid2)
    const seen = new Set<string>()
    for (const a of mine)
      for (let d = maxISO(a.from_on, ctx.today); d <= a.to_on; d = addDays(d, 1)) {
        if (seen.has(d) || !isWorkingDay(d, pc)) continue
        seen.add(d)
        const tot = allocationOn(ctx, uid2, d)
        if (tot > max) over.push({ date: d, pct: tot })
      }
    over.sort((a, b) => a.date.localeCompare(b.date))
    return { user_id: uid2, days, over_days: over, avg_pct: days.reduce((s, d) => s + d.total_pct, 0) / days.length }
  })
  out.sort((a, b) => userName(ctx, a.user_id).localeCompare(userName(ctx, b.user_id)))
  return { max_pct: max, block_over: ctx.tenant.settings['allocation.block_over'], people: out }
}

/* ================================================================== */
/* Money (BR-23..27)                                                   */
/* ================================================================== */
/** v7: invoice numbers come from the GST invoice series (routes/invoices.ts): <prefix>/<yy-yy>/<0001>. */
function suggestInvoiceNumber(ctx: Ctx) {
  return { number: nextInvoiceNumber(ctx, ctx.today) }
}
function invoiceView(ctx: Ctx, i: E.Invoice): InvoiceView {
  const f = i.file_id ? rows(ctx, 'files').find((x) => x.id === i.file_id) : null
  return {
    ...i,
    payments: rows(ctx, 'payments').filter((p) => p.invoice_id === i.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on)),
    file: f ? { id: f.id, name: f.name, data_url: f.data_url } : null,
    outstanding: i.amount_paise - i.paid_amount_paise,
  }
}

function projectMoney(ctx: Ctx, p: E.Project): ProjectMoney {
  const m = projectMetrics(ctx, p)
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  const taskIds = new Set(tasks.map((t) => t.id))
  const ms = liveMilestones(ctx, p.id)
  const entries = costedEntries(ctx).filter((e) => e.kind === 'task' && e.task_id && taskIds.has(e.task_id))
  const people = new Map<string, ProjectMoney['by_person'][number]>()
  const touch = (id: string) => {
    if (!people.has(id)) people.set(id, { user_id: id, est_hours: 0, hours: 0, approved_hours: 0, rate_ph: Math.round(currentRatePH(ctx, id)), planned_cost: 0, cost: 0 })
    return people.get(id)!
  }
  for (const t of tasks)
    if (t.owner_id) {
      const r = touch(t.owner_id)
      r.est_hours += t.est_hours
      r.planned_cost += Math.round(t.est_hours * currentRatePH(ctx, t.owner_id))
    }
  for (const e of entries) {
    const r = touch(e.user_id)
    r.hours += e.hours
    if (e.approved) r.approved_hours += e.hours
    r.cost += Math.round(e.cost)
  }
  const byTask = new Map<string, { h: number; c: number }>()
  for (const e of entries) {
    const x = byTask.get(e.task_id!) ?? { h: 0, c: 0 }
    x.h += e.hours
    x.c += e.cost
    byTask.set(e.task_id!, x)
  }
  const groups = [...ms.map((x) => ({ id: x.id as string | null, code: `M${x.no}`, name: x.name })), { id: null as string | null, code: '—', name: 'No milestone' }]
  const by_milestone = groups
    .map((g) => {
      const ts = tasks.filter((t) => t.milestone_id === g.id || (g.id === null && t.milestone_id && !ms.some((x) => x.id === t.milestone_id)))
      const est = ts.reduce((s, t) => s + t.est_hours, 0)
      const logged = ts.reduce((s, t) => s + (byTask.get(t.id)?.h ?? 0), 0)
      return { ...g, est_hours: est, logged_hours: logged, variance_hours: logged - est, planned_cost: Math.round(ts.reduce((s, t) => s + t.est_hours * currentRatePH(ctx, t.owner_id), 0)), logged_cost: Math.round(ts.reduce((s, t) => s + (byTask.get(t.id)?.c ?? 0), 0)) }
    })
    .filter((g) => g.id !== null || g.est_hours > 0 || g.logged_hours > 0)
  const invoices = rows(ctx, 'invoices').filter((i) => i.project_id === p.id)
  const admin = has(ctx, 'finance.view')
  const billing: BillingRow[] | null = admin
    ? ms
        .filter((x) => x.billing_amount_paise > 0 || x.billing_status !== 'none')
        .map((x) => {
          const inv = invoices.find((i) => i.milestone_id === x.id)
          return { milestone_id: x.id, no: x.no, name: x.name, amount: x.billing_amount_paise, billing_status: x.billing_status, state: milestoneState(ctx, x, tasks).state, planned_end: x.planned_end, invoice: inv ? invoiceView(ctx, inv) : null }
        })
    : null
  const trip = (rev: number, cost: number) => ({ revenue: rev, cost, margin: marginPct(rev, cost), markup: markupPct(rev, cost) })
  return {
    floor_pct: ctx.tenant.settings['projects.margin_floor_pct'],
    contract: p.contract_value_paise,
    planned: trip(p.contract_value_paise, m.planned_cost),
    projected: trip(p.contract_value_paise, m.projected_cost),
    actual: trip(m.invoiced, m.actual_cost),
    invoiced: admin ? m.invoiced : null,
    collected: admin ? m.collected : null,
    by_person: [...people.values()].sort((a, b) => b.cost + b.planned_cost - (a.cost + a.planned_cost)),
    by_milestone,
    billing,
    can_invoice: admin && has(ctx, 'finance.edit'),
  }
}

/* ================================================================== */
/* Import (UI-11)                                                      */
/* ================================================================== */
/** WBS import previews live in `pending_tokens` (kind wbs_import, id = the token, ref_id = project), not in process
 * memory, so the commit may land on any API instance. A preview is valid for 15 minutes. */
type ImportPayload = { rows: ImportRow[]; signature: string }
function importSignature(ctx: Ctx, pid: string) {
  const ts = rows(ctx, 'tasks').filter((t) => t.project_id === pid)
  const ms = allMilestones(ctx, pid)
  return `${ts.length}:${ms.length}:${ms.filter((m) => !m.deleted_at).length}:${ts.reduce((s, t) => s + t.version, 0)}`
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function parseDate(s: string): string | null {
  const v = s.trim()
  if (!v) return null
  let y: number, mo: number, d: number
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]]
  else if ((m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, mo, y] = [+m[1], +m[2], +m[3]]
  else if ((m = v.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})$/))) [d, mo, y] = [+m[1], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[3]]
  else return null
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dt = new Date(y, mo - 1, d)
  return dt.getMonth() === mo - 1 ? iso : null
}

function importPreview(ctx: Ctx, p: E.Project, text: string): ImportPreview {
  const maxRows = 1000
  const table = parseCSV(String(text ?? '').replace(/^﻿/, ''))
  if (table.length < 2) err(422, 'WBS_INVALID', 'Paste a header row and at least one task row. Use the template.')
  const head = table[0].map((h) => h.trim().toLowerCase())
  const col = (prefix: string) => head.findIndex((h) => h.startsWith(prefix))
  const ix = { ms: head.findIndex((h) => h.startsWith('milestone') && !h.includes('billing')), task: col('task'), owner: col('owner'), est: col('estimated'), start: col('start'), end: col('end'), cx: col('complexity'), dep: col('depends'), bill: head.findIndex((h) => h.includes('billing')) }
  const missing = [['Milestone', ix.ms], ['Task', ix.task], ['Owner', ix.owner], ['Estimated hours', ix.est], ['Start', ix.start], ['End', ix.end]].filter(([, i]) => (i as number) < 0).map(([n]) => n)
  if (missing.length) err(422, 'WBS_INVALID', `The header is missing ${missing.join(', ')}. Download the template and keep its first row.`)
  const body = table.slice(1)
  if (body.length > maxRows) err(422, 'WBS_INVALID', `The file has ${body.length} rows. Import at most ${maxRows} rows at a time.`)

  const users = rows(ctx, 'users').filter((u) => u.status === 'active')
  const ms = liveMilestones(ctx, p.id)
  const msByName = new Map(ms.map((m) => [m.name.trim().toLowerCase(), m]))
  const newMs = new Map<string, { code: string; name: string; no: number; billing_paise: number }>()
  let nextMs = nextMsNo(ctx, p.id, false)
  const counters = new Map<string, number>()
  const known = new Set<string>()
  const msMapAll = msMap(ctx)
  for (const t of rows(ctx, 'tasks').filter((x) => x.project_id === p.id)) known.add(wbsOf(t, msMapAll))
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')

  const out: ImportRow[] = body.map((r, k) => {
    const errors: string[] = []
    const msName = cell(r, ix.ms)
    let msCode = ''
    let isNew = false
    let wbs = ''
    let msKey = ''
    let billing_paise: number | null = null
    if (!msName) errors.push('Milestone is empty.')
    else {
      const ex = msByName.get(msName.toLowerCase())
      if (ex) {
        msCode = `M${ex.no}`
        msKey = ex.id
        const n = counters.get(msKey) ?? nextTaskNo(ctx, p.id, ex.id, false)
        counters.set(msKey, n + 1)
        wbs = `${ex.no}.${n}`
      } else {
        const key = msName.toLowerCase()
        if (!newMs.has(key)) newMs.set(key, { code: `M${nextMs}`, name: msName, no: nextMs++, billing_paise: 0 })
        const nm = newMs.get(key)!
        isNew = true
        msCode = nm.code
        msKey = 'new:' + key
        const n = counters.get(msKey) ?? 1
        counters.set(msKey, n + 1)
        wbs = `${nm.no}.${n}`
        const bill = cell(r, ix.bill).replace(/[₹,\s]/g, '')
        if (bill) {
          const v = Number(bill)
          if (!Number.isFinite(v) || v < 0) errors.push(`Milestone billing “${cell(r, ix.bill)}” is not a number.`)
          else {
            billing_paise = Math.round(v * 100)
            if (!nm.billing_paise) nm.billing_paise = billing_paise
          }
        }
      }
    }
    const title = cell(r, ix.task)
    if (!title) errors.push('Task is empty.')
    else if (title.length > 200) errors.push('Task title is longer than 200 characters.')
    const ownerLabel = cell(r, ix.owner)
    let owner_id: string | null = null
    if (!ownerLabel) errors.push('Owner is empty.')
    else {
      const o = users.find((u) => u.email.toLowerCase() === ownerLabel.toLowerCase() || u.name.toLowerCase() === ownerLabel.toLowerCase())
      if (!o) errors.push(`Unknown owner “${ownerLabel}”. Use a team member’s full name or email.`)
      else owner_id = o.id
    }
    const estRaw = cell(r, ix.est)
    const est = Number(estRaw)
    if (!estRaw || !Number.isFinite(est) || est <= 0 || est > 999) errors.push(`Estimated hours “${estRaw}” must be a number between 0.5 and 999.`)
    const s = parseDate(cell(r, ix.start))
    const e = parseDate(cell(r, ix.end))
    if (!s) errors.push(`Start “${cell(r, ix.start)}” is not a date. Use YYYY-MM-DD.`)
    if (!e) errors.push(`End “${cell(r, ix.end)}” is not a date. Use YYYY-MM-DD.`)
    if (s && e && s > e) errors.push('End is before Start.')
    const cxRaw = cell(r, ix.cx).toLowerCase().trim().replace(/[\s-]+/g, '_')
    const cx = (cxRaw ? (CX.find((c) => c === cxRaw || (c === 'medium' && cxRaw === 'med')) ?? null) : 'medium') as E.Complexity | null
    if (!cx) errors.push(`Complexity “${cell(r, ix.cx)}” must be Low, Medium, High or Very high.`)
    const depRaw = cell(r, ix.dep)
    const depends_on = depRaw ? depRaw.split(/[;,|\s]+/).map((x) => x.trim()).filter(Boolean) : []
    if (wbs) known.add(wbs)
    return {
      line: k + 2, milestone: msName, milestone_code: msCode, milestone_new: isNew, wbs, title, owner_id, owner_label: ownerLabel, est_hours: Number.isFinite(est) && est > 0 ? est : null,
      start_on: s, due_on: e, complexity: cx, depends_on, billing_paise, errors,
    }
  })
  for (const r of out)
    for (const d of r.depends_on) {
      if (!/^\d+\.\d+$/.test(d)) r.errors.push(`Depends on “${d}” should be a WBS code like 1.2.`)
      else if (!known.has(d)) r.errors.push(`Depends on ${d}, which doesn’t exist in the project or this file.`)
      else if (d === r.wbs) r.errors.push('A task can’t depend on itself.')
    }
  // cycles within the file
  const fileEdges = new Map(out.map((r) => [r.wbs, r.depends_on]))
  for (const r of out) {
    const seen = new Set<string>()
    const stack = [...r.depends_on]
    while (stack.length) {
      const x = stack.pop()!
      if (x === r.wbs) {
        r.errors.push('Circular dependency. Remove one of the links.')
        break
      }
      if (seen.has(x)) continue
      seen.add(x)
      stack.push(...(fileEdges.get(x) ?? []))
    }
  }
  const token = uid('wbs_')
  const now = nowISO()
  removeWhere(ctx, 'pending_tokens', (t) => t.kind === 'wbs_import' && t.expires_at <= now)
  insert(ctx, 'pending_tokens', { id: token, kind: 'wbs_import', user_id: ctx.user.id, ref_id: p.id, payload: { rows: out, signature: importSignature(ctx, p.id) } satisfies ImportPayload, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() })
  return {
    token,
    rows: out,
    error_count: out.filter((r) => r.errors.length).length,
    task_count: out.length,
    new_milestones: [...newMs.values()].map((m) => ({ code: m.code, name: m.name, billing_paise: m.billing_paise })),
    max_rows: maxRows,
  }
}

function importCommit(ctx: Ctx, p: E.Project, token: string) {
  const pending = rows(ctx, 'pending_tokens').find((x) => x.id === token && x.kind === 'wbs_import')
  if (!pending || pending.ref_id !== p.id || pending.user_id !== ctx.user.id || pending.expires_at <= nowISO()) err(409, 'WBS_INVALID', 'This preview has expired. Preview the file again, then import.')
  const t = pending.payload as ImportPayload
  if (t.rows.some((r) => r.errors.length)) err(422, 'WBS_INVALID', 'Fix the rows with errors first. Nothing was imported.')
  if (importSignature(ctx, p.id) !== t.signature) err(409, 'STALE', 'The project’s WBS changed since you previewed. Preview again before importing.')
  // all-or-nothing: everything validated above, now apply
  const msByName = new Map(liveMilestones(ctx, p.id).map((m) => [m.name.trim().toLowerCase(), m]))
  const created: E.Milestone[] = []
  const wbsToId = new Map<string, string>()
  const msAll = msMap(ctx)
  for (const x of rows(ctx, 'tasks').filter((x) => x.project_id === p.id)) wbsToId.set(wbsOf(x, msAll), x.id)
  const newTasks: { row: ImportRow; task: E.Task }[] = []
  const sortedByMs = new Map<string, ImportRow[]>()
  for (const r of t.rows) (sortedByMs.get(r.milestone.toLowerCase()) ?? sortedByMs.set(r.milestone.toLowerCase(), []).get(r.milestone.toLowerCase())!).push(r)
  for (const [key, list] of sortedByMs) {
    let m = msByName.get(key)
    const wasEmpty = !m || !rows(ctx, 'tasks').some((x) => x.milestone_id === m!.id)
    if (!m) {
      const starts = list.map((r) => r.start_on!).sort()
      const ends = list.map((r) => r.due_on!).sort()
      const billing = list.map((r) => r.billing_paise).find(Boolean) ?? 0
      const no = nextMsNo(ctx, p.id, true)
      m = insert(ctx, 'milestones', {
        project_id: p.id, no, name: list[0].milestone, planned_start: starts[0], planned_end: ends[ends.length - 1], baseline_end: ends[ends.length - 1],
        billing_amount_paise: billing, billing_status: 'none', achieved_on: null, empty_since: null, deleted_at: null,
      })
      msByName.set(key, m)
      created.push(m)
    }
    for (const r of list) {
      const { no, wbs_code } = newTaskCode(ctx, p.id, m)
      const task = insert(ctx, 'tasks', {
        project_id: p.id, milestone_id: m.id, no, wbs_code, title: r.title, owner_id: r.owner_id, backup_id: null, est_hours: r.est_hours!, start_on: r.start_on!, due_on: r.due_on!, done_on: null,
        complexity: r.complexity ?? 'medium', status: 'todo', description: '', blocked_reason: null,
        kind: 'project', assigned_by: ctx.user.id, review_round: 0, priority: 'normal',
        stage: 'new', progress: 0, tag: null, actual_start_on: null, baseline_due_on: r.due_on!, target_revisions: [], slip_flagged_on: null, slip_note: null,
      } as never) as E.Task
      wbsToId.set(wbs_code, task.id)
      wbsToId.set(r.wbs, task.id) // preview code maps to the same row
      newTasks.push({ row: r, task })
    }
    m.empty_since = null
    syncMilestoneDates(ctx, m.id, wasEmpty)
  }
  let depCount = 0
  for (const { row, task } of newTasks)
    for (const d of row.depends_on) {
      const target = wbsToId.get(d)
      if (target && target !== task.id) {
        insert(ctx, 'task_dependencies', { task_id: task.id, depends_on_task_id: target })
        depCount++
      }
    }
  removeWhere(ctx, 'pending_tokens', (x) => x.id === token)
  const byOwner = new Map<string, number>()
  for (const { task } of newTasks) if (task.owner_id && task.owner_id !== ctx.user.id) byOwner.set(task.owner_id, (byOwner.get(task.owner_id) ?? 0) + 1)
  for (const [o, n] of byOwner) notify(ctx, o, 'NTF-14', `${n} task${n === 1 ? '' : 's'} assigned to you`, `${ctx.user.name} imported the WBS for ${p.name}.`, `/projects/${p.id}/wbs`)
  logActivity(ctx, 'project', p.id, 'wbs.imported', `Imported ${newTasks.length} tasks${created.length ? ` and ${created.length} new milestone${created.length === 1 ? '' : 's'}` : ''}`)
  return { tasks: newTasks.length, milestones: created.length, dependencies: depCount }
}

/* ================================================================== */
/* Client view (prototype §16)                                         */
/* ================================================================== */
function clientView(ctx: Ctx, p: E.Project): ClientView {
  const sch = computeSchedule(ctx, p)
  const ms = msMap(ctx)
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  const m = projectMetrics(ctx, p)
  const c = { ...cal(ctx), leaveDates: undefined }
  const twoWeeksAgo = (() => {
    let d = ctx.today
    let n = 10
    while (n > 0) {
      d = addDays(d, -1)
      if (isWorkingDay(d, c)) n--
    }
    return d
  })()
  const ahead = addWorkingDays(ctx.today, 10, c)
  const late = sch.forecast_finish && sch.forecast_finish > p.end_on ? workingDaysBetween(addDays(p.end_on, 1), sch.forecast_finish, c) : 0
  const milestones = sch.milestones.map((x) => {
    const st = x.state
    const map: Record<MilestoneDelivery, { s: string; tone: ClientView['milestones'][number]['tone'] }> = {
      achieved_on_time: { s: 'Achieved', tone: 'success' },
      achieved_late: { s: 'Achieved', tone: 'success' },
      overdue: { s: 'Delayed', tone: 'danger' },
      at_risk: { s: 'At risk', tone: 'warning' },
      on_track: { s: 'On track', tone: 'info' },
      not_started: { s: 'Planned', tone: 'neutral' },
    }
    const done = st === 'achieved_on_time' || st === 'achieved_late'
    const note = (st === 'overdue' || st === 'at_risk') && x.forecast_end && x.forecast_end > x.planned_end ? `Now expected ${fmtDate(x.forecast_end, 'long')}` : null
    const s = milestoneState(ctx, find(ctx, 'milestones', x.id), tasks)
    return { no: x.no, name: x.name, target: done ? x.achieved_on ?? x.forecast_end ?? x.planned_end : x.planned_end, status: map[st].s, tone: map[st].tone, note, progress: s.progress }
  })
  const completed = tasks
    .filter((t) => t.status === 'done' && t.done_on && t.done_on >= twoWeeksAgo)
    .sort((a, b) => (b.done_on ?? '').localeCompare(a.done_on ?? ''))
    .map((t) => ({ wbs: wbsOf(t, ms), title: t.title, done_on: t.done_on! }))
  const upcoming = sch.tasks
    .filter((t) => t.status !== 'done' && t.forecast_end <= ahead)
    .sort((a, b) => a.forecast_end.localeCompare(b.forecast_end))
    .map((t) => ({ wbs: t.wbs, title: t.title, due_on: t.forecast_end }))
  const inputs: string[] = []
  for (const t of tasks) if (t.status === 'in_review') inputs.push(`${wbsOf(t, ms)} ${t.title}: ready for your review`)
  for (const cr of rows(ctx, 'change_requests').filter((x) => x.project_id === p.id && (x.status === 'raised' || x.status === 'estimated')))
    inputs.push(`Change request “${cr.title}”${cr.hours ? ` (${cr.hours}h of work)` : ''}: awaiting your approval`)
  return {
    company: ctx.tenant.name,
    generated_on: ctx.today,
    project: { code: p.code, name: p.name, client: p.client, start_on: p.start_on, end_on: p.end_on, status: p.status, description: p.description },
    progress: m.progress,
    forecast_end: sch.forecast_finish,
    late_days: late,
    milestones,
    completed,
    upcoming,
    inputs,
  }
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
export function register(r: Router) {
  // v5 costing routes first: static paths (/projects/costing/preview, /projects/calendar-summary) before /projects/:id
  registerCostingRoutes(r, { canView, canEdit })
  /* ---------- projects ---------- */
  r.get('/projects', ({ ctx, query }) => {
    const visible = rows(ctx, 'projects').filter((p) => canView(ctx, p))
    const q = String(query.q ?? '').trim().toLowerCase()
    const type = String(query.type ?? '')
    const base = visible.filter((p) => (!q || `${p.name} ${p.client} ${p.code}`.toLowerCase().includes(q)) && (!type || p.type === type))
    const counts = { all: base.length } as ProjectList['counts']
    for (const s of STATUSES) counts[s] = base.filter((p) => p.status === s).length
    const status = String(query.status ?? 'all')
    const items = base.filter((p) => status === 'all' || p.status === status).map((p) => listItem(ctx, p))
    const sort = String(query.sort ?? 'priority')
    const open = (x: ProjectListItem) => (['completed', 'closed'].includes(x.status) ? 1 : 0)
    const healthRank = { off_track: 0, at_risk: 1, on_track: 2 }
    items.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'end') return a.end_on.localeCompare(b.end_on)
      if (sort === 'health') return healthRank[a.metrics.health] - healthRank[b.metrics.health] || a.priority - b.priority
      if (sort === 'progress') return b.metrics.progress - a.metrics.progress
      return open(a) - open(b) || a.priority - b.priority || a.end_on.localeCompare(b.end_on)
    })
    return { items, counts, total: items.length } satisfies ProjectList
  })

  r.post('/projects', ({ ctx, body }) => {
    if (!has(ctx, 'projects.create')) err(403, 'FORBIDDEN', 'Only admins and project managers can create projects.')
    const name = need(body.name, 'name', 'Project name')
    const client = need(body.client, 'client', 'Client')
    if (!TYPES.includes(body.type)) err(422, 'VALIDATION', 'Choose a project type: Product, Service, SaaS or AMS.', 'type')
    if (!MODELS.includes(body.billing_model)) err(422, 'VALIDATION', 'Choose a commercial model.', 'billing_model')
    if (!STREAMS.includes(body.stream)) err(422, 'VALIDATION', 'Choose a revenue stream.', 'stream')
    const start_on = needDate(body.start_on, 'start_on', 'Start date')
    const end_on = needDate(body.end_on, 'end_on', 'Planned end')
    if (end_on < start_on) err(422, 'DATE_RANGE', 'The planned end is before the start date.', 'end_on')
    const contract = money(body.contract_value_paise, 'contract_value_paise', 'Contract value')
    const pmId: string | null = body.pm_id || (has(ctx, 'projects.edit') ? ctx.user.id : null)
    if (!pmId) err(422, 'VALIDATION', 'Choose the project manager.', 'pm_id')
    activeUser(ctx, pmId, 'pm_id', true)
    if (!has(ctx, 'projects.manage_all') && pmId !== ctx.user.id) err(403, 'FORBIDDEN', 'Project managers create projects they manage. Ask an admin to assign someone else.')
    const priority = [1, 2, 3, 4, 5].includes(Number(body.priority)) ? Number(body.priority) : 3
    // AUTO MILESTONE SETUP (G3.08): names + optional billing in delivery order. Without end dates the server spreads
    // provisional deadlines over the project's working days (by billing share, else evenly); once tasks exist a
    // milestone's deadline becomes the target end of its last task.
    const msIn: { name: string; planned_end?: string | null; billing_amount_paise: number }[] = Array.isArray(body.milestones) ? body.milestones.filter((m: { name?: string }) => String(m?.name ?? '').trim()) : []
    const seenMs = new Map<string, number>()
    msIn.forEach((m, i) => {
      const k = String(m.name).trim().toLowerCase()
      if (seenMs.has(k)) err(422, 'VALIDATION', `Milestone ${i + 1}: “${String(m.name).trim()}” is already M${seenMs.get(k)! + 1}. Give each milestone its own name.`, `milestones.${i}.name`)
      seenMs.set(k, i)
      money(m.billing_amount_paise, `milestones.${i}.billing_amount_paise`, `Milestone ${i + 1} billing`)
    })
    const explicit = msIn.length > 0 && msIn.every((m) => ISO.test(m.planned_end ?? ''))
    let planned = spreadMilestones(ctx, start_on, end_on, msIn.map((m) => ({ name: String(m.name).trim(), billing_amount_paise: Number(m.billing_amount_paise) || 0 })))
    if (explicit) {
      let prev = start_on
      planned = msIn.map((m, i) => {
        const end = m.planned_end as string
        if (end < prev || end > end_on) err(422, 'DATE_RANGE', `Milestone ${i + 1}: the end date must fall between ${fmtDate(prev)} and the project end ${fmtDate(end_on)}, in delivery order.`, `milestones.${i}.planned_end`)
        const start = i === 0 ? start_on : minISO(addDays(prev, 1), end)
        prev = end
        return { index: i, id: null, code: `M${i + 1}`, name: String(m.name).trim(), billing_amount_paise: Number(m.billing_amount_paise) || 0, planned_start: start, planned_end: end }
      })
    }
    const msBill = msIn.reduce((s, m) => s + (Number(m.billing_amount_paise) || 0), 0)
    if (contract > 0 && msBill > contract) warn(ctx, 'MS_BILLING_OVER', `Milestone billing (${fmtMoney(msBill)}) is more than the contract value (${fmtMoney(contract)}).`)
    if (contract > 0 && msBill > 0 && msBill < contract) warn(ctx, 'MS_BILLING_UNDER', `Milestone billing (${fmtMoney(msBill)}) covers less than the contract value (${fmtMoney(contract)}).`)
    // PROJECT COST CALCULATOR (G3.10): validated before anything is saved
    const cb = body.costing && typeof body.costing === 'object' ? (body.costing as Record<string, unknown>) : null
    const hasCosting = !!cb && ((Array.isArray(cb.resources) && cb.resources.length > 0) || (Array.isArray(cb.additional_costs) && cb.additional_costs.length > 0) || Number(cb.maintenance_paise) > 0)
    if (hasCosting && !canPlanCost(ctx)) err(403, 'FORBIDDEN', 'Costing needs the margins or salaries permission. Create the project without it.')
    if (hasCosting && !has(ctx, 'allocation.edit')) err(403, 'FORBIDDEN', 'You can’t allocate people, so the resource plan can’t be saved.')
    const vc: ValidCosting | null = hasCosting ? validateCosting(ctx, null, { start: start_on, end: end_on }, planned, cb!) : null
    const docs = validateCreateDocuments(body.documents)
    const prefix = ctx.tenant.settings['projects.code_prefix'] || 'PRJ'
    const taken = new Set(rows(ctx, 'projects').map((p) => p.code))
    let code = ''
    do code = `${prefix}-${String(nextNumber(ctx, 'project')).padStart(3, '0')}`
    while (taken.has(code))
    const hue = [152, 210, 32, 260, 140, 350, 20, 190, 300, 90][rows(ctx, 'projects').length % 10]
    const p = insert(ctx, 'projects', {
      code, name, client, type: body.type, status: 'initiated', pm_id: pmId, start_on, end_on, contract_value_paise: contract, billing_model: body.billing_model, stream: body.stream,
      description: String(body.description ?? '').trim(), priority, deal_id: typeof body.deal_id === 'string' ? body.deal_id : null, baseline_end_on: end_on, color_hue: hue,
      costing: vc ? { ...vc.costing, saved_at: nowISO(), saved_by: ctx.user.id } : null,
    })
    insert(ctx, 'project_status_history', { project_id: p.id, from_status: null, to_status: 'initiated', reason: null, changed_by: ctx.user.id, changed_at: nowISO() })
    const msIds = planned.map((m) => {
      const no = nextMsNo(ctx, p.id, true)
      return insert(ctx, 'milestones', { project_id: p.id, no, name: m.name, planned_start: m.planned_start, planned_end: m.planned_end, baseline_end: m.planned_end, billing_amount_paise: m.billing_amount_paise, billing_status: 'none', achieved_on: null, empty_since: ctx.today, deleted_at: null }).id
    })
    if (vc) insertPlanAllocations(ctx, p.id, vc, msIds)
    insertProjectDocuments(ctx, p.id, docs)
    if (p.deal_id) {
      const d = rows(ctx, 'deals').find((x) => x.id === p.deal_id)
      if (d && !d.project_id) d.project_id = p.id
    }
    const bits = [planned.length ? `${planned.length} milestone${planned.length === 1 ? '' : 's'}` : '', vc ? `a costing plan (${vc.resolved.length} resource row${vc.resolved.length === 1 ? '' : 's'})` : '', docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : ''].filter(Boolean)
    logActivity(ctx, 'project', p.id, 'project.created', `Created ${code} ${name}${bits.length ? ` with ${bits.join(', ')}` : ''}`)
    if (pmId !== ctx.user.id) notify(ctx, pmId, 'NTF-14', `You manage ${code}`, `${ctx.user.name} created ${name} and made you the project manager.`, `/projects/${p.id}`)
    return p
  })

  r.get('/projects/:id', ({ ctx, params }) => {
    const p = getProject(ctx, params.id)
    sweepMilestones(ctx, p)
    ensureSwept(ctx)
    const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
    const ms = msMap(ctx)
    const metrics = redactMetrics(ctx, projectMetrics(ctx, p), canSeeMargins(ctx))
    const team = new Set([...metrics.team, ...rows(ctx, 'allocations').filter((a) => a.project_id === p.id).map((a) => a.user_id)])
    const since = addDays(ctx.today, -10)
    const detail: ProjectDetail = {
      project: stripProject(ctx, p),
      metrics,
      can_edit: canEdit(ctx, p),
      can_see_money: canSeeMargins(ctx),
      is_admin: isAdmin(ctx),
      milestones: milestoneViews(ctx, p, tasks),
      billing_summary: billingSummary(ctx, p, tasks),
      can_bill: has(ctx, 'finance.edit') && hasAny(ctx, 'finance.view'),
      tasks: tasks.map((t) => taskView(ctx, t, ms)).sort((a, b) => sortWbs(a.wbs, b.wbs)),
      allocations: rows(ctx, 'allocations').filter((a) => a.project_id === p.id).map((a) => allocView(ctx, a, ms)).sort((a, b) => a.ms_code.localeCompare(b.ms_code) || a.from_on.localeCompare(b.from_on)),
      change_requests: hasAny(ctx, 'change_requests.manage', 'projects.view_all') ? rows(ctx, 'change_requests').filter((c) => c.project_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [],
      status_history: rows(ctx, 'project_status_history').filter((h) => h.project_id === p.id).sort((a, b) => b.changed_at.localeCompare(a.changed_at)),
      recent_updates: rows(ctx, 'daily_updates').filter((u) => team.has(u.user_id) && u.date >= since).sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)).slice(0, 8),
      team_ids: [...team],
      delivery: (() => {
        const st = taskStats(ctx, { projectId: p.id })
        const awaiting = tasks
          .filter((t) => t.status === 'in_review')
          .map((t) => ({ id: t.id, wbs: wbsOf(t, ms), title: t.title, owner_id: t.owner_id, reviewer_id: reviewerOf(ctx, t), submitted_on: t.submitted_on ?? null, due_on: t.due_on, round: t.review_round ?? 1, late: (t.submitted_on ?? ctx.today) > t.due_on, can_review: canReviewTask(ctx, t) }))
          .sort((a, b) => (a.submitted_on ?? '').localeCompare(b.submitted_on ?? ''))
        return { completed: st.completed, early: st.early, on_time: st.on_time, late: st.late, on_time_pct: st.on_time_pct, avg_variance_days: st.avg_variance_days, first_pass_pct: st.first_pass_pct, avg_quality: st.avg_quality, sent_back: st.sent_back, awaiting_review: awaiting }
      })(),
    }
    return detail
  })

  r.patch('/projects/:id', ({ ctx, params, body, ifMatch }) => {
    const p = editableProject(ctx, params.id)
    if ('status' in body) err(422, 'VALIDATION', 'Change the status with the status control; it records the reason and history.', 'status')
    const patch: Partial<E.Project> = {}
    if ('name' in body) patch.name = need(body.name, 'name', 'Project name')
    if ('client' in body) patch.client = need(body.client, 'client', 'Client')
    if ('type' in body) {
      if (!TYPES.includes(body.type)) err(422, 'VALIDATION', 'Choose a project type.', 'type')
      patch.type = body.type
    }
    if ('billing_model' in body) {
      if (!MODELS.includes(body.billing_model)) err(422, 'VALIDATION', 'Choose a billing model.', 'billing_model')
      patch.billing_model = body.billing_model
    }
    if ('stream' in body) {
      if (!STREAMS.includes(body.stream)) err(422, 'VALIDATION', 'Choose a revenue stream.', 'stream')
      patch.stream = body.stream
    }
    if ('start_on' in body) patch.start_on = needDate(body.start_on, 'start_on', 'Start date')
    if ('end_on' in body) patch.end_on = needDate(body.end_on, 'end_on', 'End date')
    if ((patch.end_on ?? p.end_on) < (patch.start_on ?? p.start_on)) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'end_on')
    if ('contract_value_paise' in body) patch.contract_value_paise = money(body.contract_value_paise, 'contract_value_paise', 'Contract value')
    if ('priority' in body) patch.priority = [1, 2, 3, 4, 5].includes(Number(body.priority)) ? Number(body.priority) : 3
    if ('description' in body) patch.description = String(body.description ?? '').trim()
    if ('pm_id' in body && body.pm_id !== p.pm_id) {
      if (!isAdmin(ctx)) err(403, 'FORBIDDEN', 'Only an admin can hand a project to another project manager.', 'pm_id')
      activeUser(ctx, body.pm_id, 'pm_id', true)
      patch.pm_id = body.pm_id
    }
    const out = update(ctx, 'projects', p.id, patch, ifMatch)
    const changed = Object.keys(patch)
    logActivity(ctx, 'project', p.id, 'project.updated', `Updated ${changed.map((k) => k.replace(/_paise|_on|_id/g, '').replace('_', ' ')).join(', ')}`)
    if (patch.pm_id && patch.pm_id !== ctx.user.id) notify(ctx, patch.pm_id, 'NTF-14', `You now manage ${p.code}`, `${ctx.user.name} made you the project manager of ${p.name}.`, `/projects/${p.id}`)
    if (patch.contract_value_paise !== undefined && canSeeMargins(ctx)) {
      const m = projectMetrics({ ...ctx, warnings: ctx.warnings } as Ctx, out)
      const floor = ctx.tenant.settings['projects.margin_floor_pct'] / 100
      const pm = marginPct(out.contract_value_paise, m.projected_cost)
      if (pm !== null && pm < floor) warn(ctx, 'MARGIN_BELOW_FLOOR', `Projected margin is ${(pm * 100).toFixed(1)}%, below the ${ctx.tenant.settings['projects.margin_floor_pct']}% floor.`)
    }
    return out
  })

  r.post('/projects/:id/status', ({ ctx, params, body }) => {
    const p = editableProject(ctx, params.id)
    const to = body.status as E.ProjectStatus
    if (!STATUSES.includes(to)) err(422, 'VALIDATION', 'Choose a valid status.', 'status')
    if (to === p.status) err(409, 'SAME_STATUS', `${p.name} is already ${PROJECT_STATUS[to].label}.`, 'status')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (PROJECT_STATUS[to].needsReason && reason.length < 5) err(422, 'BR_17_REASON_REQUIRED', `Moving a project to ${PROJECT_STATUS[to].label} needs a reason (at least 5 characters).`, 'reason')
    insert(ctx, 'project_status_history', { project_id: p.id, from_status: p.status, to_status: to, reason: reason || null, changed_by: ctx.user.id, changed_at: nowISO() })
    const out = update(ctx, 'projects', p.id, { status: to })
    logActivity(ctx, 'project', p.id, 'project.status', `${PROJECT_STATUS[p.status].label} → ${PROJECT_STATUS[to].label}${reason ? `: ${reason}` : ''}`)
    if (p.pm_id && p.pm_id !== ctx.user.id) notify(ctx, p.pm_id, 'NTF-14', `${p.code} is now ${PROJECT_STATUS[to].label}`, reason || `${ctx.user.name} changed the status.`, `/projects/${p.id}`)
    return out
  })

  /* ---------- milestones ---------- */
  r.post('/projects/:id/milestones', ({ ctx, params, body }) => {
    const p = editableProject(ctx, params.id)
    const name = need(body.name, 'name', 'Milestone name')
    if (name.length > 120) err(422, 'VALIDATION', 'Keep the milestone name under 120 characters.', 'name')
    // Dates are optional (G4.08): a new milestone gets provisional dates after the last one; once it has tasks,
    // its deadline follows the target end of its last task.
    const provisional = !body.planned_start && !body.planned_end
    const last = liveMilestones(ctx, p.id).reduce<E.Milestone | null>((mx, m) => (!mx || m.planned_end > mx.planned_end ? m : mx), null)
    const pStart = last ? addDays(last.planned_end, 1) : p.start_on
    const planned_start = provisional ? pStart : needDate(body.planned_start, 'planned_start', 'Start date')
    const planned_end = provisional ? addWorkingDays(planned_start, 10, cal(ctx)) : needDate(body.planned_end, 'planned_end', 'End date')
    if (planned_end < planned_start) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'planned_end')
    if (!provisional && (planned_start < p.start_on || planned_end > p.end_on)) warn(ctx, 'MS_OUTSIDE_PROJECT', `The milestone runs outside the project dates (${fmtDate(p.start_on)} – ${fmtDate(p.end_on)}). Extend the project if that’s intended.`)
    const bill = money(body.billing_amount_paise, 'billing_amount_paise', 'Billing amount')
    const no = nextMsNo(ctx, p.id, true)
    const m = insert(ctx, 'milestones', { project_id: p.id, no, name, planned_start, planned_end, baseline_end: planned_end, billing_amount_paise: bill, billing_status: 'none', achieved_on: null, empty_since: ctx.today, deleted_at: null })
    const total = liveMilestones(ctx, p.id).reduce((s, x) => s + x.billing_amount_paise, 0)
    if (p.contract_value_paise > 0 && total > p.contract_value_paise) warn(ctx, 'MS_BILLING_OVER', `Milestone billing now totals ${fmtMoney(total)}, more than the contract value ${fmtMoney(p.contract_value_paise)}.`)
    logActivity(ctx, 'project', p.id, 'milestone.created', `Added M${no} ${name}`)
    return m
  })

  r.patch('/milestones/:id', ({ ctx, params, body, ifMatch }) => {
    const m = find(ctx, 'milestones', params.id, 'Milestone')
    if (m.deleted_at) err(404, 'NOT_FOUND', 'Milestone not found.')
    const p = editableProject(ctx, m.project_id)
    const patch: Partial<E.Milestone> = {}
    if ('name' in body) patch.name = need(body.name, 'name', 'Milestone name')
    if ('planned_start' in body) patch.planned_start = needDate(body.planned_start, 'planned_start', 'Start date')
    if ('planned_end' in body) patch.planned_end = needDate(body.planned_end, 'planned_end', 'End date')
    // G4.02: with tasks, the deadline is always the target end of the last task — dates follow the tasks.
    const hasTasks = rows(ctx, 'tasks').some((t) => t.milestone_id === m.id)
    if (hasTasks) {
      if (patch.planned_end && patch.planned_end !== m.planned_end) err(409, 'MS_DEADLINE_AUTO', `M${m.no}’s deadline is the target end of its last task (${fmtDate(m.planned_end)}). Move that task’s target end instead.`, 'planned_end')
      if (patch.planned_start && patch.planned_start !== m.planned_start) err(409, 'MS_DEADLINE_AUTO', `M${m.no} starts when its first task starts (${fmtDate(m.planned_start)}). Move that task instead.`, 'planned_start')
      delete patch.planned_start
      delete patch.planned_end
    }
    if ((patch.planned_end ?? m.planned_end) < (patch.planned_start ?? m.planned_start)) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'planned_end')
    if ('billing_amount_paise' in body) {
      const v = money(body.billing_amount_paise, 'billing_amount_paise', 'Billing amount')
      if (v !== m.billing_amount_paise && m.billing_status !== 'none') err(409, 'MS_INVOICED', 'This milestone has been invoiced, so its billing amount is fixed.', 'billing_amount_paise')
      patch.billing_amount_paise = v
    }
    const out = update(ctx, 'milestones', m.id, patch, ifMatch)
    if (patch.planned_end && patch.planned_end > m.baseline_end) warn(ctx, 'MS_SLIP', `M${m.no} now ends ${diffDays(patch.planned_end, m.baseline_end)} days after its baseline.`)
    logActivity(ctx, 'project', p.id, 'milestone.updated', `Updated M${m.no} ${out.name}`)
    return out
  })

  r.del('/milestones/:id', ({ ctx, params }) => {
    const m = find(ctx, 'milestones', params.id, 'Milestone')
    if (m.deleted_at) err(404, 'NOT_FOUND', 'Milestone not found.')
    const p = editableProject(ctx, m.project_id)
    if (m.billing_status !== 'none') err(409, 'MS_INVOICED', 'This milestone has been invoiced, so it can’t be deleted. Edit it instead.')
    const moved = rows(ctx, 'tasks').filter((t) => t.milestone_id === m.id).sort((a, b) => a.no - b.no)
    const msAll = new Map(rows(ctx, 'milestones').map((x) => [x.id, x]))
    // Tasks keep their number (e.g. 4.1 stays 4.1 under No milestone): numbers never change and are never reused.
    for (const t of moved) {
      freezeWbs(t, msAll)
      Object.assign(t, { milestone_id: null, updated_at: nowISO(), version: t.version + 1 })
    }
    const allocs = rows(ctx, 'allocations').filter((a) => a.milestone_id === m.id).length
    removeWhere(ctx, 'allocations', (a) => a.milestone_id === m.id)
    update(ctx, 'milestones', m.id, { deleted_at: nowISO() })
    logActivity(ctx, 'project', p.id, 'milestone.deleted', `Deleted M${m.no} ${m.name}${moved.length ? `; ${moved.length} task${moved.length === 1 ? '' : 's'} moved to No milestone` : ''}`)
    const told = new Set<string>()
    for (const uidx of [p.pm_id, ...moved.map((t) => t.owner_id)]) if (uidx && uidx !== ctx.user.id && !told.has(uidx)) {
      told.add(uidx)
      notify(ctx, uidx, 'NTF-15', `Milestone M${m.no} deleted`, `${ctx.user.name} deleted “${m.name}” on ${p.name}.${moved.length ? ' Its tasks are now under No milestone.' : ''}`, `/projects/${p.id}/wbs`)
    }
    return { moved_tasks: moved.length, removed_allocations: allocs }
  })

  /* ---------- tasks (write side of the shared contract) ---------- */
  r.post('/projects/:id/tasks', ({ ctx, params, body }) => {
    const p = editableProject(ctx, params.id)
    const title = need(body.title, 'title', 'Task title')
    if (title.length > 200) err(422, 'VALIDATION', 'Keep the title under 200 characters.', 'title')
    let msId: string | null = body.milestone_id || null
    let m: E.Milestone | null = null
    if (msId) {
      m = rows(ctx, 'milestones').find((x) => x.id === msId && !x.deleted_at && x.project_id === p.id) ?? null
      if (!m) err(422, 'VALIDATION', 'Choose a milestone of this project.', 'milestone_id')
    } else msId = null
    const c = cal(ctx)
    const owner = activeUser(ctx, body.owner_id, 'owner_id')
    let start_on: string = body.start_on || maxISO(ctx.today, m?.planned_start ?? p.start_on)
    if (!ISO.test(start_on)) err(422, 'VALIDATION', 'Start needs a valid date.', 'start_on')
    let due_on: string = body.due_on || addWorkingDays(start_on, 2, c)
    if (!body.due_on && m && due_on > m.planned_end && m.planned_end >= start_on) due_on = m.planned_end
    if (!body.start_on && m && start_on > m.planned_end) start_on = due_on = m.planned_end
    if (!ISO.test(due_on)) err(422, 'VALIDATION', 'Due needs a valid date.', 'due_on')
    if (due_on < start_on) err(422, 'DATE_RANGE', 'The due date is before the start date.', 'due_on')
    const est = body.est_hours === undefined ? 8 : Number(body.est_hours)
    if (!Number.isFinite(est) || est < 0 || est > 999) err(422, 'VALIDATION', 'Estimated hours must be between 0 and 999.', 'est_hours')
    if (body.complexity !== undefined && body.complexity !== null && body.complexity !== '' && !CX.includes(body.complexity)) err(422, 'VALIDATION', 'Complexity must be low, medium, high or very high.', 'complexity')
    const complexity: E.Complexity = CX.includes(body.complexity) ? body.complexity : 'medium'
    if (body.tag && !TAGS.includes(body.tag)) err(422, 'VALIDATION', 'Choose a tag: Feature, Bug, Improvement, Documentation, Support or Meeting.', 'tag')
    const backup = activeUser(ctx, body.backup_id, 'backup_id')
    if (backup && owner && backup.id === owner.id) err(422, 'VALIDATION', 'The backup must be a different person from the owner.', 'backup_id')
    const wasEmpty = !!m && !rows(ctx, 'tasks').some((x) => x.milestone_id === m!.id)
    const { no, wbs_code } = newTaskCode(ctx, p.id, m)
    const t = insert(ctx, 'tasks', {
      project_id: p.id, milestone_id: msId, no, wbs_code, title, owner_id: owner?.id ?? null, backup_id: backup?.id ?? null, est_hours: est, start_on, due_on, done_on: null, complexity, status: 'todo', description: String(body.description ?? '').trim(), blocked_reason: null,
      kind: p.id === `p_general_${ctx.tenant.slug}` ? 'general' : 'project', assigned_by: ctx.user.id, review_round: 0, priority: 'normal',
      stage: 'new', progress: 0, tag: body.tag ?? null, actual_start_on: null, baseline_due_on: due_on, target_revisions: [], slip_flagged_on: null, slip_note: null,
    } as never) as E.Task
    if (m) {
      m.empty_since = null
      if (m.achieved_on) m.achieved_on = null
      syncMilestoneDates(ctx, m.id, wasEmpty)
    }
    const code = wbs_code
    logActivity(ctx, 'task', t.id, 'task.created', `Added ${code} ${title}`)
    logActivity(ctx, 'project', p.id, 'task.created', `Added task ${code} ${title}`)
    if (owner && owner.id !== ctx.user.id) notify(ctx, owner.id, 'NTF-14', 'Task assigned to you', `${code} ${title} · ${p.name}`, `/my-tasks?task=${t.id}`)
    return t
  })

  r.patch('/tasks/:id', ({ ctx, params, body, ifMatch }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    const p = canManageGeneral(ctx, t) ? find(ctx, 'projects', t.project_id, 'Project') : editableProject(ctx, t.project_id)
    const patch: Partial<E.Task> = {}
    if ('priority' in body) {
      if (!['low', 'normal', 'high', 'urgent'].includes(body.priority)) err(422, 'VALIDATION', 'Priority must be low, normal, high or urgent.', 'priority')
      patch.priority = body.priority
    }
    if ('reviewer_id' in body) {
      const rv = activeUser(ctx, body.reviewer_id, 'reviewer_id')
      if (rv && rv.id === (('owner_id' in body ? body.owner_id : t.owner_id) ?? null) && !isTop(ctx, rv.id)) err(422, 'TASK_SELF_REVIEW', 'The reviewer must be someone other than the owner.', 'reviewer_id')
      patch.reviewer_id = rv?.id ?? null
    }
    if ('status' in body) err(422, 'VALIDATION', 'Change status with the status control so dependencies are checked.', 'status')
    // v7 professional fields
    if ('concerned_manager_id' in body) {
      const cm = activeUser(ctx, body.concerned_manager_id, 'concerned_manager_id')
      if (cm && cm.id === (('owner_id' in body ? body.owner_id : t.owner_id) ?? null) && !isTop(ctx, cm.id)) err(422, 'VALIDATION', 'The concerned manager must be someone other than the owner.', 'concerned_manager_id')
      patch.concerned_manager_id = cm?.id ?? null
    }
    if ('watcher_ids' in body) {
      if (!Array.isArray(body.watcher_ids) || body.watcher_ids.length > 20) err(422, 'VALIDATION', 'Choose up to 20 watchers.', 'watcher_ids')
      patch.watcher_ids = [...new Set((body.watcher_ids as string[]).map((id) => activeUser(ctx, id, 'watcher_ids')!.id))]
    }
    if ('acceptance_criteria' in body) {
      if (!Array.isArray(body.acceptance_criteria) || body.acceptance_criteria.length > 30) err(422, 'VALIDATION', 'Keep the definition of done to 30 items or fewer.', 'acceptance_criteria')
      patch.acceptance_criteria = (body.acceptance_criteria as { text?: unknown; done?: unknown }[])
        .map((c) => ({ text: String(typeof c === 'string' ? c : c?.text ?? '').trim(), done: typeof c === 'object' && c?.done === true }))
        .filter((c) => c.text)
      if (patch.acceptance_criteria.some((c) => c.text.length > 300)) err(422, 'VALIDATION', 'Each criterion must be under 300 characters.', 'acceptance_criteria')
    }
    if ('labels' in body) {
      if (!Array.isArray(body.labels)) err(422, 'VALIDATION', 'Labels must be a list.', 'labels')
      const ls = [...new Set((body.labels as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean))]
      if (ls.length > 10 || ls.some((x) => x.length > 30)) err(422, 'VALIDATION', 'Use up to 10 labels of 30 characters or fewer.', 'labels')
      patch.labels = ls
    }
    if ('billable' in body) {
      if (typeof body.billable !== 'boolean') err(422, 'VALIDATION', 'Billable must be yes or no.', 'billable')
      patch.billable = body.billable
    }
    if ('recurrence' in body) {
      if (!['none', 'weekly', 'monthly'].includes(body.recurrence)) err(422, 'VALIDATION', 'Repeat must be none, weekly or monthly.', 'recurrence')
      patch.recurrence = body.recurrence
    }
    if ('title' in body) {
      patch.title = need(body.title, 'title', 'Task title')
      if (patch.title.length > 200) err(422, 'VALIDATION', 'Keep the title under 200 characters.', 'title')
    }
    if ('description' in body) patch.description = String(body.description ?? '')
    if ('owner_id' in body) patch.owner_id = activeUser(ctx, body.owner_id, 'owner_id')?.id ?? null
    if ('backup_id' in body) patch.backup_id = activeUser(ctx, body.backup_id, 'backup_id')?.id ?? null
    const owner = patch.owner_id !== undefined ? patch.owner_id : t.owner_id
    const backup = patch.backup_id !== undefined ? patch.backup_id : t.backup_id
    if (owner && backup && owner === backup) err(422, 'VALIDATION', 'The backup must be a different person from the owner.', 'backup_id')
    if ('est_hours' in body) {
      const v = Number(body.est_hours)
      if (!Number.isFinite(v) || v < 0 || v > 999) err(422, 'VALIDATION', 'Estimated hours must be between 0 and 999.', 'est_hours')
      patch.est_hours = Math.round(v * 4) / 4
    }
    if ('start_on' in body) patch.start_on = needDate(body.start_on, 'start_on', 'Start')
    if ('due_on' in body) patch.due_on = needDate(body.due_on, 'due_on', 'Due')
    const dueReason = typeof body.due_change_reason === 'string' ? body.due_change_reason.trim() : ''
    if (patch.due_on && patch.due_on !== t.due_on) {
      if (t.status === 'done') err(409, 'INVALID_STATE', 'This task is approved. Reopen it before changing the due date.', 'due_on')
      if (t.owner_id && dueReason.length < 10) err(422, 'DUE_REASON_REQUIRED', 'Say why the due date is moving (at least 10 characters). Reschedules are kept in the task history.', 'due_change_reason')
    } else if (patch.due_on === t.due_on) delete patch.due_on
    if ((patch.due_on ?? t.due_on) < (patch.start_on ?? t.start_on)) err(422, 'DATE_RANGE', 'The due date is before the start date.', 'due_on')
    if ('complexity' in body) {
      if (!CX.includes(body.complexity)) err(422, 'VALIDATION', 'Complexity must be low, medium, high or very high.', 'complexity')
      patch.complexity = body.complexity
    }
    if ('tag' in body) {
      if (body.tag && !TAGS.includes(body.tag)) err(422, 'VALIDATION', 'Choose a tag: Feature, Bug, Improvement, Documentation, Support or Meeting.', 'tag')
      patch.tag = body.tag || null
    }
    if (patch.due_on && patch.due_on !== t.due_on) {
      // Every move of the target end after the baseline is kept (WBS shows “rev <date>”).
      patch.baseline_due_on = t.baseline_due_on ?? t.due_on
      patch.target_revisions = [...(t.target_revisions ?? []), { from: t.due_on, to: patch.due_on, at: nowISO(), by: ctx.user.id, reason: dueReason || 'Rescheduled' }]
    }
    const oldMs = t.milestone_id
    if ('milestone_id' in body && (body.milestone_id || null) !== t.milestone_id) {
      const nm = body.milestone_id ? rows(ctx, 'milestones').find((x) => x.id === body.milestone_id && !x.deleted_at && x.project_id === p.id) : null
      if (body.milestone_id && !nm) err(422, 'VALIDATION', 'Choose a milestone of this project.', 'milestone_id')
      patch.milestone_id = nm?.id ?? null
      // Moving a task never changes its number: freeze the current code before the milestone changes.
      freezeWbs(t, new Map(rows(ctx, 'milestones').map((x) => [x.id, x])))
      if (nm) nm.empty_since = null
    }
    const newMsWasEmpty = patch.milestone_id ? !rows(ctx, 'tasks').some((x) => x.milestone_id === patch.milestone_id) : false
    const out = update(ctx, 'tasks', t.id, patch, ifMatch)
    if (patch.milestone_id !== undefined) {
      syncAchieved(ctx, oldMs)
      syncAchieved(ctx, patch.milestone_id)
      if (oldMs && !rows(ctx, 'tasks').some((x) => x.milestone_id === oldMs)) {
        const om = rows(ctx, 'milestones').find((x) => x.id === oldMs)
        if (om && om.billing_status === 'none') om.empty_since = ctx.today
      }
      syncMilestoneDates(ctx, oldMs)
      syncMilestoneDates(ctx, patch.milestone_id, newMsWasEmpty)
    } else if (patch.due_on || patch.start_on) syncMilestoneDates(ctx, out.milestone_id)
    const ms = msMap(ctx)
    const code = wbsOf(out, ms)
    const changed = Object.keys(patch).filter((k) => k !== 'no')
    if (changed.length) logActivity(ctx, 'task', t.id, 'task.updated', `Updated ${changed.map((k) => k.replace(/_on|_id|_hours/g, '')).join(', ')}`)
    if (patch.owner_id && patch.owner_id !== t.owner_id && patch.owner_id !== ctx.user.id)
      notify(ctx, patch.owner_id, 'NTF-14', 'Task assigned to you', `${code} ${out.title} · ${p.name}`, `/my-tasks?task=${t.id}`)
    // v7: newly added watchers, a new reviewer and a new concerned manager hear about it
    for (const w of patch.watcher_ids ?? []) if (w !== ctx.user.id && !(t.watcher_ids ?? []).includes(w)) notify(ctx, w, 'NTF-14', 'You were added as a watcher', `${ctx.user.name} added you to ${code} ${out.title}`, `/tasks/${t.id}`)
    if (patch.reviewer_id && patch.reviewer_id !== t.reviewer_id && patch.reviewer_id !== ctx.user.id) notify(ctx, patch.reviewer_id, 'NTF-14', 'You review a task', `${code} ${out.title} · you approve it when it’s submitted`, `/tasks/${t.id}`)
    if (patch.concerned_manager_id && patch.concerned_manager_id !== t.concerned_manager_id && patch.concerned_manager_id !== ctx.user.id) notify(ctx, patch.concerned_manager_id, 'NTF-14', 'You’re the concerned manager on a task', `${code} ${out.title}`, `/tasks/${t.id}`)
    if (patch.owner_id !== undefined && patch.owner_id !== t.owner_id) logActivity(ctx, 'project', p.id, 'task.assigned', `${code} ${out.title} → ${userName(ctx, patch.owner_id)}`)
    if (patch.due_on && patch.due_on !== t.due_on) {
      const n = rows(ctx, 'activity_log').filter((a) => a.entity === 'task' && a.entity_id === t.id && a.action === 'task.rescheduled').length + 1
      logActivity(ctx, 'task', t.id, 'task.rescheduled', `Due moved ${fmtDate(t.due_on)} → ${fmtDate(patch.due_on)}${n > 1 ? ` (reschedule #${n})` : ''}: ${dueReason || 'no reason given'}`)
      if (out.owner_id && out.owner_id !== ctx.user.id) notify(ctx, out.owner_id, 'NTF-14', 'Due date changed', `${code} ${out.title} is now due ${fmtDate(patch.due_on)}: ${dueReason}`, `/tasks/${t.id}`)
      const m = out.milestone_id ? rows(ctx, 'milestones').find((x) => x.id === out.milestone_id) : null
      if (m && m.planned_end === patch.due_on && patch.due_on > t.due_on && m.planned_end > m.baseline_end) warn(ctx, 'MS_SLIP', `M${m.no}’s deadline moved to ${fmtDate(m.planned_end)} with this task (baseline ${fmtDate(m.baseline_end)}).`)
    }
    return out
  })

  r.post('/tasks/:id/status', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    const p = find(ctx, 'projects', t.project_id, 'Project')
    const editor = canEdit(ctx, p) || canManageGeneral(ctx, t)
    if (!editor && t.owner_id !== ctx.user.id && t.backup_id !== ctx.user.id && !canReviewTask(ctx, t)) err(403, 'FORBIDDEN', 'Only the task owner, their backup or the project manager can change its status.')
    const to = body.status as E.TaskStatus
    if (!TASK_STATUSES.includes(to)) err(422, 'VALIDATION', 'Choose a valid status.', 'status')
    if (to === t.status) return t
    // v3 review flow: completion goes through submit → approve; review states are owned by the reviewer.
    if (to === 'in_review') err(409, 'USE_REVIEW_FLOW', 'Use “Submit for review” so your note (and delay reason, if late) reaches the reviewer.', 'status')
    if (t.status === 'in_review') err(409, 'USE_REVIEW_FLOW', `This task is waiting for ${userName(ctx, reviewerOf(ctx, t))}'s review. The reviewer approves it or sends it back.`, 'status')
    if (to === 'done') {
      if (selfReview(ctx, t) || !canReviewTask(ctx, t))
        err(409, 'USE_REVIEW_FLOW', `Tasks are completed through review. Submit it for review — ${userName(ctx, reviewerOf(ctx, t))} approves it.`, 'status')
      const open = openBlockers(ctx, t.id)
      if (open.length) err(409, 'TASK_BLOCKED', `This task waits on ${open.map((d) => `${wbsOf(d, msMap(ctx))} ${d.title}`).join(', ')}. Finish ${open.length === 1 ? 'it' : 'them'} first.`, 'status')
      if (body.quality_rating === undefined || body.quality_rating === null) err(422, 'VALIDATION', 'Rate the quality of the work (1–5) to mark it done.', 'quality_rating')
      return approveTask(ctx, t, body.quality_rating, typeof body.note === 'string' ? body.note.trim() || null : null, true)
    }
    // v5: the summary status maps onto a detailed stage; applyStage enforces dependencies, reopen rights and progress.
    const cur = stageOf(t)
    const stage: E.TaskStage = to === 'todo' ? (STAGE[cur].group === 'not_started' ? cur : 'new') : to === 'in_progress' ? (STAGE[cur].group === 'active' || STAGE[cur].group === 'testing' ? cur : 'in_development') : 'blocked'
    void editor
    return applyStage(ctx, t, stage, { note: typeof body.blocked_reason === 'string' ? body.blocked_reason : null })
  })

  r.put('/tasks/:id/dependencies', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    editableProject(ctx, t.project_id)
    const ids: string[] = Array.isArray(body.depends_on) ? [...new Set(body.depends_on as string[])] : []
    const all = rows(ctx, 'tasks')
    for (const id of ids) {
      if (id === t.id) err(422, 'VALIDATION', 'A task can’t depend on itself.', 'depends_on')
      const d = all.find((x) => x.id === id)
      if (!d || d.project_id !== t.project_id) err(422, 'VALIDATION', 'Dependencies must be tasks of the same project.', 'depends_on')
    }
    const edges = depEdges(ctx)
    edges.set(t.id, ids)
    if (detectCycle(ctx, edges, t.id)) err(409, 'DEP_CYCLE', 'That would create a circular dependency. Remove one of the links.', 'depends_on')
    removeWhere(ctx, 'task_dependencies', (d) => d.task_id === t.id)
    for (const id of ids) insert(ctx, 'task_dependencies', { task_id: t.id, depends_on_task_id: id })
    const ms = msMap(ctx)
    logActivity(ctx, 'task', t.id, 'task.dependencies', ids.length ? `Depends on ${ids.map((id) => wbsOf(all.find((x) => x.id === id)!, ms)).join(', ')}` : 'Removed all dependencies')
    if (ids.length && (t.status === 'in_progress' || t.status === 'in_review') && openBlockers(ctx, t.id).length) warn(ctx, 'TASK_BLOCKED', 'This task is in progress but now waits on an open task.')
    return buildTaskDetail(ctx, find(ctx, 'tasks', t.id))
  })

  r.del('/tasks/:id', ({ ctx, params, ifMatch }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    const p = editableProject(ctx, t.project_id)
    const hours = rows(ctx, 'timesheet_entries').filter((e) => e.task_id === t.id).reduce((s, e) => s + e.hours, 0)
    if (hours > 0) err(409, 'TASK_HAS_HOURS', `${hours}h are logged against this task, so it can’t be deleted (the hours stay on the project cost). Cancel it instead.`)
    const ms = msMap(ctx)
    const code = wbsOf(t, ms)
    remove(ctx, 'tasks', t.id, ifMatch)
    removeWhere(ctx, 'task_dependencies', (d) => d.task_id === t.id || d.depends_on_task_id === t.id)
    removeWhere(ctx, 'comments', (c) => c.task_id === t.id)
    if (t.milestone_id && !rows(ctx, 'tasks').some((x) => x.milestone_id === t.milestone_id)) {
      const m = rows(ctx, 'milestones').find((x) => x.id === t.milestone_id)
      if (m && m.billing_status === 'none') m.empty_since = ctx.today
    } else {
      syncAchieved(ctx, t.milestone_id)
      syncMilestoneDates(ctx, t.milestone_id)
    }
    logActivity(ctx, 'project', p.id, 'task.deleted', `Deleted ${code} ${t.title}`)
    return null
  })

  /* ---------- schedule ---------- */
  r.get('/projects/:id/schedule', ({ ctx, params }) => computeSchedule(ctx, getProject(ctx, params.id)))

  /* ---------- allocations ---------- */
  r.get('/projects/:id/load', ({ ctx, params }) => projectLoad(ctx, getProject(ctx, params.id)))
  r.post('/projects/:id/allocations', ({ ctx, params, body }) => {
    const p = editableProject(ctx, params.id)
    if (!has(ctx, 'allocation.edit')) err(403, 'FORBIDDEN', 'You can’t change allocations.')
    const v = validateAllocation(ctx, p, body, null)
    const a = insert(ctx, 'allocations', v)
    const m = v.milestone_id ? find(ctx, 'milestones', v.milestone_id) : null
    logActivity(ctx, 'project', p.id, 'allocation.created', `Allocated ${userName(ctx, v.user_id)} ${v.pct}% to ${m ? `M${m.no}` : 'all milestones'} (${fmtDate(v.from_on)} – ${fmtDate(v.to_on)})`)
    return a
  })
  r.patch('/allocations/:id', ({ ctx, params, body, ifMatch }) => {
    const a = find(ctx, 'allocations', params.id, 'Allocation')
    const p = editableProject(ctx, a.project_id)
    const v = validateAllocation(ctx, p, { ...a, ...body }, a.id)
    const out = update(ctx, 'allocations', a.id, v, ifMatch)
    logActivity(ctx, 'project', p.id, 'allocation.updated', `Allocation for ${userName(ctx, v.user_id)} set to ${v.pct}% (${fmtDate(v.from_on)} – ${fmtDate(v.to_on)})`)
    return out
  })
  r.del('/allocations/:id', ({ ctx, params }) => {
    const a = find(ctx, 'allocations', params.id, 'Allocation')
    const p = editableProject(ctx, a.project_id)
    remove(ctx, 'allocations', a.id)
    logActivity(ctx, 'project', p.id, 'allocation.deleted', `Removed ${userName(ctx, a.user_id)}’s ${a.pct}% allocation`)
    return null
  })

  /* ---------- money ---------- */
  r.get('/projects/:id/money', ({ ctx, params }) => {
    const p = getProject(ctx, params.id)
    if (!canSeeMargins(ctx)) return null
    const money = projectMoney(ctx, p)
    // v5: planned / projected / actual come from the costing engine (saved plan + allocations), same as the list
    const an = publicAnalysis(ctx, analyse(ctx, p))
    const trip = (c: { revenue: number; cost: number; margin: number | null; markup: number | null }) => ({ revenue: c.revenue, cost: c.cost, margin: c.margin, markup: c.markup })
    return { ...money, planned: trip(an.planned), projected: trip(an.projected), actual: trip(an.actual), analysis: an } satisfies ProjectMoney
  })
  r.get('/invoices/next-number', ({ ctx }) => {
    if (!has(ctx, 'finance.edit')) err(403, 'FORBIDDEN', 'Only admins raise invoices.')
    return { number: suggestInvoiceNumber(ctx).number }
  })
  r.post('/milestones/:id/invoice', ({ ctx, params, body }) => {
    if (!has(ctx, 'finance.edit')) err(403, 'FORBIDDEN', 'Only admins raise invoices.')
    const m = find(ctx, 'milestones', params.id, 'Milestone')
    if (m.deleted_at) err(404, 'NOT_FOUND', 'Milestone not found.')
    getProject(ctx, m.project_id)
    if (m.billing_status !== 'none') err(409, 'MS_INVOICED', `M${m.no} is already invoiced.`)
    const number = need(body.number, 'number', 'Invoice number')
    if (rows(ctx, 'invoices').some((i) => i.number.toLowerCase() === number.toLowerCase())) err(409, 'INV_NUMBER_TAKEN', `Invoice ${number} already exists. Use ${suggestInvoiceNumber(ctx).number}.`, 'number')
    const invoiced_on = needDate(body.invoiced_on, 'invoiced_on', 'Invoice date')
    if (invoiced_on > ctx.today) err(422, 'VALIDATION', 'An invoice can’t be dated in the future. Use today or an earlier date.', 'invoiced_on')
    const due_on = body.due_on ? needDate(body.due_on, 'due_on', 'Due date') : addDays(invoiced_on, 30)
    if (due_on < invoiced_on) err(422, 'DATE_RANGE', 'The due date is before the invoice date.', 'due_on')
    const amount = money(body.amount_paise, 'amount_paise', 'Amount', false)
    let file_id: string | null = null
    if (body.file) {
      const f = body.file as { name: string; mime: string; size_bytes: number; data_url: string }
      if (!f.name || !f.data_url) err(422, 'FILE_REJECTED', 'The file could not be read. Try again.', 'file')
      if (f.size_bytes > 10 * 1024 * 1024) err(422, 'FILE_REJECTED', 'The file is larger than 10 MB.', 'file')
      file_id = insert(ctx, 'files', { name: f.name, mime: f.mime || 'application/octet-stream', size_bytes: f.size_bytes, entity: 'invoice', entity_id: '', data_url: f.data_url }).id
    }
    // v7: the quick dialog raises a complete GST tax invoice (amount = taxable value; GST added on top)
    const inv = raiseMilestoneInvoice(ctx, m, { number, invoiced_on, due_on, amount_paise: amount, file_id })
    if (file_id) {
      const f = rows(ctx, 'files').find((x) => x.id === file_id)
      if (f) f.entity_id = inv.id
    }
    return inv
  })
  r.post('/invoices/:id/payments', ({ ctx, params, body }) => {
    if (!has(ctx, 'finance.edit')) err(403, 'FORBIDDEN', 'Only admins record payments.')
    const inv = find(ctx, 'invoices', params.id, 'Invoice')
    const amount = money(body.amount_paise, 'amount_paise', 'Amount', false)
    const paid_on = needDate(body.paid_on, 'paid_on', 'Payment date')
    if (paid_on < inv.invoiced_on) err(422, 'DATE_RANGE', 'The payment date is before the invoice date.', 'paid_on')
    // v7: amount is on the ex-GST (revenue) basis here; the GST invoice records the matching cash
    return recordRevenuePayment(ctx, inv, amount, paid_on, String(body.reference ?? '').trim())
  })

  /* ---------- change requests (G5.04) ---------- */
  const crProject = (ctx: Ctx, id: string) => {
    if (!has(ctx, 'change_requests.manage')) err(403, 'FORBIDDEN', 'Only admins and the project manager handle change requests.')
    return editableProject(ctx, id)
  }
  const crNumber = (ctx: Ctx, pid: string, take: boolean) => {
    const start = Math.max(0, ...rows(ctx, 'change_requests').filter((c) => c.project_id === pid).map((c) => c.number ?? 0)) + 1
    return take ? takeNumber(ctx, `cr:${pid}`, start) : peekNumber(ctx, `cr:${pid}`, start)
  }
  const proposedTasks = (ctx: Ctx, v: unknown) => {
    if (v === undefined) return undefined
    if (!Array.isArray(v)) err(422, 'VALIDATION', 'Proposed tasks must be a list.', 'proposed_tasks')
    const list = (v as { title?: string; est_hours?: unknown; owner_id?: string | null }[]).filter((x) => (x.title ?? '').trim())
    if (list.length > 30) err(422, 'VALIDATION', 'Propose at most 30 tasks per change request.', 'proposed_tasks')
    return list.map((x, i) => {
      const h = Number(x.est_hours ?? 0)
      if (!Number.isFinite(h) || h < 0 || h > 999) err(422, 'VALIDATION', `Proposed task ${i + 1}: hours must be between 0 and 999.`, `proposed_tasks.${i}.est_hours`)
      const title = String(x.title).trim()
      if (title.length > 200) err(422, 'VALIDATION', `Proposed task ${i + 1}: keep the title under 200 characters.`, `proposed_tasks.${i}.title`)
      return { title, est_hours: Math.round(h * 4) / 4, owner_id: activeUser(ctx, x.owner_id ?? null, `proposed_tasks.${i}.owner_id`)?.id ?? null }
    })
  }
  const crFields = (ctx: Ctx, body: Record<string, unknown>, partial: boolean) => {
    const patch: Partial<E.ChangeRequest> = {}
    if (!partial || 'title' in body) {
      patch.title = need(body.title, 'title', 'Title')
      if (patch.title.length > 200) err(422, 'VALIDATION', 'Keep the title under 200 characters.', 'title')
    }
    if (!partial || 'description' in body) patch.description = String(body.description ?? '').trim()
    if (!partial || 'note' in body) patch.note = String(body.note ?? '').trim()
    if (!partial || 'requested_by_client' in body) {
      patch.requested_by_client = String(body.requested_by_client ?? '').trim()
      if (!partial && !patch.requested_by_client) err(422, 'VALIDATION', 'Say who at the client asked for it.', 'requested_by_client')
    }
    if (!partial || 'requested_on' in body) {
      const d = String(body.requested_on ?? '').trim() || (partial ? '' : ctx.today)
      if (d && !ISO.test(d)) err(422, 'VALIDATION', 'Requested on needs a valid date.', 'requested_on')
      if (d && d > ctx.today) err(422, 'DATE_RANGE', 'Requested on can’t be in the future.', 'requested_on')
      patch.requested_on = d || null
    }
    if (!partial || 'hours' in body) {
      const h = Number(body.hours ?? 0)
      if (!Number.isFinite(h) || h < 0 || h > 9999) err(422, 'VALIDATION', 'Effort hours must be zero or more.', 'hours')
      patch.hours = h
    }
    if (!partial || 'impact_days' in body) {
      const n = Number(body.impact_days ?? 0)
      if (!Number.isInteger(n) || n < 0 || n > 365) err(422, 'VALIDATION', 'Working days impact must be a whole number of days (0 or more).', 'impact_days')
      patch.impact_days = n
    }
    if (!partial || 'value_paise' in body) patch.value_paise = money(body.value_paise, 'value_paise', 'Billable value')
    const pt = proposedTasks(ctx, body.proposed_tasks)
    if (pt) patch.proposed_tasks = pt
    // proposed task hours roll up into the effort when no effort was given
    if (pt && pt.length && !(patch.hours ?? 0) && !('hours' in body && Number(body.hours) > 0)) patch.hours = pt.reduce((s2, x) => s2 + x.est_hours, 0)
    return patch
  }
  const crList = (ctx: Ctx, p: E.Project) => {
    const list = rows(ctx, 'change_requests').filter((c) => c.project_id === p.id).sort((a, b) => (b.number ?? 0) - (a.number ?? 0) || b.created_at.localeCompare(a.created_at))
    const crTask = new Set(rows(ctx, 'tasks').filter((t) => t.project_id === p.id && (t as E.Task & { cr_id?: string }).cr_id).map((t) => t.id))
    const baseline = rows(ctx, 'tasks').filter((t) => t.project_id === p.id && !crTask.has(t.id)).reduce((s2, t) => s2 + t.est_hours, 0)
    const approved = list.filter((c) => c.status === 'approved' || c.status === 'done')
    const approvedHours = approved.reduce((s2, c) => s2 + c.hours, 0)
    return {
      items: list,
      raised: list.length,
      awaiting: list.filter((c) => c.status === 'raised' || c.status === 'estimated').length,
      approved_hours: approvedHours,
      approved_value: approved.reduce((s2, c) => s2 + c.value_paise, 0),
      baseline_hours: baseline,
      scope_growth: baseline > 0 ? approvedHours / baseline : null,
      next_number: crNumber(ctx, p.id, false),
      can_manage: canEdit(ctx, p) && has(ctx, 'change_requests.manage'),
    }
  }
  r.get('/projects/:id/change-requests', ({ ctx, params }) => {
    const p = getProject(ctx, params.id)
    if (!hasAny(ctx, 'change_requests.manage', 'projects.view_all') && !canEdit(ctx, p)) err(403, 'FORBIDDEN', 'Only the project manager and admins see change requests.')
    return crList(ctx, p)
  })
  r.post('/projects/:id/change-requests', ({ ctx, params, body }) => {
    const p = crProject(ctx, params.id)
    const f = crFields(ctx, body, false)
    const number = crNumber(ctx, p.id, true)
    const cr = insert(ctx, 'change_requests', {
      project_id: p.id, title: f.title!, description: f.description ?? '', hours: f.hours ?? 0, value_paise: f.value_paise ?? 0, status: (f.hours ?? 0) > 0 ? 'estimated' : 'raised', raised_by: ctx.user.id, milestone_id: null,
      decided_by: null, decided_at: null, number, requested_by_client: f.requested_by_client ?? '', requested_on: f.requested_on ?? ctx.today, impact_days: f.impact_days ?? 0, note: f.note ?? '', proposed_tasks: f.proposed_tasks ?? [], tasks_added_on: null,
    })
    logActivity(ctx, 'project', p.id, 'cr.raised', `CR-${number} raised: ${cr.title}${cr.hours ? ` (${cr.hours}h, ${fmtMoney(cr.value_paise)})` : ''}`)
    return cr
  })
  r.patch('/change-requests/:id', ({ ctx, params, body, ifMatch }) => {
    const cr = find(ctx, 'change_requests', params.id, 'Change request')
    const p = crProject(ctx, cr.project_id)
    const editing = ['title', 'description', 'hours', 'value_paise', 'requested_by_client', 'requested_on', 'impact_days', 'note', 'proposed_tasks'].some((k) => k in body)
    if (editing && !['raised', 'estimated'].includes(cr.status)) err(409, 'CR_DECIDED', 'This change request has been decided. Raise a new one for more changes.')
    const patch = crFields(ctx, body, true)
    if (body.status === 'estimated') {
      if (cr.status !== 'raised') err(409, 'CR_STATUS', 'Only a raised change request can be estimated.')
      if ((patch.hours ?? cr.hours) <= 0) err(422, 'VALIDATION', 'Add the estimated hours first.', 'hours')
      patch.status = 'estimated'
    } else if (body.status === 'done') {
      if (cr.status !== 'approved') err(409, 'CR_STATUS', 'Only an approved change request can be marked done.')
      patch.status = 'done'
    } else if (cr.status === 'raised' && (patch.hours ?? 0) > 0) patch.status = 'estimated'
    const out = update(ctx, 'change_requests', cr.id, patch, ifMatch)
    logActivity(ctx, 'project', p.id, 'cr.updated', `CR-${cr.number ?? '?'} “${out.title}”${patch.status ? ` → ${patch.status}` : ' updated'}`)
    return out
  })
  r.post('/change-requests/:id/decision', ({ ctx, params, body }) => {
    const cr = find(ctx, 'change_requests', params.id, 'Change request')
    const p = crProject(ctx, cr.project_id)
    if (!['raised', 'estimated'].includes(cr.status)) err(409, 'CR_DECIDED', 'This change request has already been decided.')
    const decision = body.decision
    if (decision !== 'approve' && decision !== 'reject') err(422, 'VALIDATION', 'Choose approve or reject.', 'decision')
    const tag = `CR-${cr.number ?? '?'}`
    if (decision === 'reject') {
      const reason = String(body.reason ?? '').trim()
      if (reason.length < 5) err(422, 'VALIDATION', 'Say why it is rejected (at least 5 characters). The client sees this in the change log.', 'reason')
      const out = update(ctx, 'change_requests', cr.id, { status: 'rejected', decided_by: ctx.user.id, decided_at: nowISO(), note: [cr.note, `Rejected: ${reason}`].filter(Boolean).join(' · ') })
      logActivity(ctx, 'project', p.id, 'cr.rejected', `${tag} rejected: ${cr.title} (${reason})`)
      if (cr.raised_by !== ctx.user.id) notify(ctx, cr.raised_by, 'NTF-06', `${tag} rejected`, `${cr.title} on ${p.name}: ${reason}`, `/projects/${p.id}/changes`)
      return out
    }
    if (cr.hours <= 0) err(422, 'VALIDATION', 'Estimate the effort (hours) before approving, so the plan and margin stay honest.', 'hours')
    let msId: string | null = null
    if (body.milestone) {
      const name = need(body.milestone.name, 'milestone.name', 'Milestone name')
      const end = needDate(body.milestone.planned_end, 'milestone.planned_end', 'Milestone end')
      const start = maxISO(ctx.today, p.start_on) > end ? end : maxISO(ctx.today, p.start_on)
      const no = nextMsNo(ctx, p.id, true)
      const m = insert(ctx, 'milestones', { project_id: p.id, no, name, planned_start: start, planned_end: end, baseline_end: end, billing_amount_paise: cr.value_paise, billing_status: 'none', achieved_on: null, empty_since: ctx.today, deleted_at: null })
      msId = m.id
      if (end > p.end_on) update(ctx, 'projects', p.id, { end_on: end })
      logActivity(ctx, 'project', p.id, 'milestone.created', `Added M${no} ${name} from ${tag}`)
    }
    const addValue = body.add_to_contract !== false
    if (addValue && cr.value_paise > 0) {
      const cur = find(ctx, 'projects', p.id)
      update(ctx, 'projects', p.id, { contract_value_paise: cur.contract_value_paise + cr.value_paise })
    }
    const out = update(ctx, 'change_requests', cr.id, { status: 'approved', decided_by: ctx.user.id, decided_at: nowISO(), milestone_id: msId ?? cr.milestone_id })
    logActivity(ctx, 'project', p.id, 'cr.approved', `${tag} approved: ${cr.title}${addValue && cr.value_paise ? `; contract +${fmtMoney(cr.value_paise)}` : ''}`)
    if (cr.raised_by !== ctx.user.id) notify(ctx, cr.raised_by, 'NTF-05', `${tag} approved`, `${cr.title} on ${p.name}`, `/projects/${p.id}/changes`)
    return out
  })
  /** "Add its tasks to the WBS" — only for an approved CR, once. Nothing enters the plan without an approved CR. */
  r.post('/change-requests/:id/add-tasks', ({ ctx, params, body }) => {
    const cr = find(ctx, 'change_requests', params.id, 'Change request')
    const p = crProject(ctx, cr.project_id)
    const tag = `CR-${cr.number ?? '?'}`
    if (cr.status !== 'approved' && cr.status !== 'done') err(409, 'CR_NOT_APPROVED', `${tag} isn’t approved yet. Nothing enters the plan without an approved change request.`)
    if (cr.tasks_added_on) err(409, 'CR_TASKS_ADDED', `${tag}’s tasks were already added to the WBS on ${fmtDate(cr.tasks_added_on.slice(0, 10))}.`)
    const tasksIn = proposedTasks(ctx, body.tasks) ?? cr.proposed_tasks ?? []
    if (!tasksIn.length) err(422, 'VALIDATION', 'Add at least one task (title and hours).', 'tasks')
    const c = cal(ctx)
    // CR work starts today (or the start the client asked for, if later) and runs back to back. It is never parked after
    // the project's planned end; the milestone's deadline then follows its last task as usual.
    let start = ctx.today
    if (body.start_on !== undefined && body.start_on !== null && body.start_on !== '') {
      const asked = needDate(body.start_on, 'start_on', 'Start')
      if (asked < ctx.today) err(422, 'VALIDATION', 'Start the change request’s work today or later.', 'start_on')
      start = asked
    }
    start = maxISO(start, p.start_on)
    for (let i = 0; i < 14 && !isWorkingDay(start, c); i++) start = addDays(start, 1)
    let m: E.Milestone | null = null
    if (body.milestone_id === 'new' || (!body.milestone_id && !cr.milestone_id)) {
      const no = nextMsNo(ctx, p.id, true)
      m = insert(ctx, 'milestones', { project_id: p.id, no, name: `${tag} ${cr.title}`.slice(0, 120), planned_start: start, planned_end: start, baseline_end: start, billing_amount_paise: cr.milestone_id ? 0 : cr.value_paise, billing_status: 'none', achieved_on: null, empty_since: null, deleted_at: null })
      logActivity(ctx, 'project', p.id, 'milestone.created', `Added M${no} ${m.name} for ${tag}`)
    } else {
      const id = body.milestone_id || cr.milestone_id
      m = rows(ctx, 'milestones').find((x) => x.id === id && x.project_id === p.id && !x.deleted_at) ?? null
      if (!m) err(422, 'VALIDATION', 'Choose a milestone of this project, or a new one for the change request.', 'milestone_id')
    }
    const wasEmpty = !rows(ctx, 'tasks').some((x) => x.milestone_id === m!.id)
    const created: E.Task[] = []
    for (const x of tasksIn) {
      const days = Math.max(1, Math.ceil(x.est_hours / Math.max(1, ctx.tenant.settings['calendar.min_hours_per_day'] * 0.75)))
      const due = addWorkingDays(start, Math.max(0, days - 1), c)
      const { no, wbs_code } = newTaskCode(ctx, p.id, m)
      const t = insert(ctx, 'tasks', {
        project_id: p.id, milestone_id: m.id, no, wbs_code, title: x.title, owner_id: x.owner_id, backup_id: null, est_hours: x.est_hours || 8, start_on: start, due_on: due, done_on: null, complexity: 'medium', status: 'todo',
        description: `From ${tag}: ${cr.title}`, blocked_reason: null, kind: 'project', assigned_by: ctx.user.id, review_round: 0, priority: 'normal',
        stage: 'new', progress: 0, tag: 'feature', actual_start_on: null, baseline_due_on: due, target_revisions: [], slip_flagged_on: null, slip_note: null, cr_id: cr.id,
      } as never) as E.Task
      created.push(t)
      if (x.owner_id && x.owner_id !== ctx.user.id) notify(ctx, x.owner_id, 'NTF-14', 'Task assigned to you', `${wbs_code} ${x.title} · ${p.name} (${tag})`, `/tasks/${t.id}`)
      start = addWorkingDays(due, 1, c)
    }
    m.empty_since = null
    if (m.achieved_on) m.achieved_on = null
    syncMilestoneDates(ctx, m.id, wasEmpty)
    const lastDue = created.reduce((mx, t) => maxISO(mx, t.due_on), '0000-01-01')
    if (lastDue > p.end_on) warn(ctx, 'CR_PAST_END', `${tag}’s tasks run to ${fmtDate(lastDue)}, ${workingDaysBetween(addDays(p.end_on, 1), lastDue, c)} working days after the planned end (${fmtDate(p.end_on)}). Agree the new end date with the client.`)
    const out = update(ctx, 'change_requests', cr.id, { tasks_added_on: nowISO(), milestone_id: m.id })
    logActivity(ctx, 'project', p.id, 'cr.tasks_added', `${tag}: ${created.length} task${created.length === 1 ? '' : 's'} added to M${m.no} ${m.name}`)
    return { change_request: out, milestone_id: m.id, tasks: created.length }
  })

  /* ---------- activity & client view ---------- */
  r.get('/projects/:id/activity', ({ ctx, params }) => {
    const p = getProject(ctx, params.id)
    const taskIds = new Set(rows(ctx, 'tasks').filter((t) => t.project_id === p.id).map((t) => t.id))
    const hist: ActivityItem[] = rows(ctx, 'project_status_history')
      .filter((h) => h.project_id === p.id)
      .map((h) => ({ id: h.id, kind: 'status', at: h.changed_at, actor_id: h.changed_by, title: h.from_status ? `${PROJECT_STATUS[h.from_status].label} → ${PROJECT_STATUS[h.to_status].label}` : `Created as ${PROJECT_STATUS[h.to_status].label}`, detail: h.reason, action: 'project.status' }))
    const logs: ActivityItem[] = rows(ctx, 'activity_log')
      .filter((l) => (l.entity === 'project' && l.entity_id === p.id && l.action !== 'project.status') || (l.entity === 'task' && taskIds.has(l.entity_id) && l.action === 'comment.created'))
      .map((l) => ({ id: l.id, kind: 'log', at: l.at, actor_id: l.actor_id, title: l.summary, detail: null, action: l.action }))
    return [...hist, ...logs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300)
  })
  r.get('/projects/:id/client-view', ({ ctx, params }) => clientView(ctx, getProject(ctx, params.id)))

  /* ---------- WBS import ---------- */
  r.post('/projects/:id/import', ({ ctx, params, body, query }) => {
    const p = editableProject(ctx, params.id)
    if (query.mode === 'commit') return importCommit(ctx, p, String(body.token ?? ''))
    return importPreview(ctx, p, String(body.text ?? ''))
  })

  /* ---------- openings (UI-35) ---------- */
  const OPEN_STATUS: E.Opening['status'][] = ['open', 'interviewing', 'offered', 'filled', 'on_hold']
  const openingGuard = (ctx: Ctx, o?: E.Opening) => {
    if (!has(ctx, 'openings.manage')) err(403, 'FORBIDDEN', 'Only admins, project managers and operations manage openings.')
    if (o && !hasAny(ctx, 'projects.manage_all', 'people.view_all')) {
      const pr = o.project_id ? rows(ctx, 'projects').find((x) => x.id === o.project_id) : null
      if (o.owner_id !== ctx.user.id && pr?.pm_id !== ctx.user.id && o.created_by !== ctx.user.id) err(403, 'FORBIDDEN', 'You can change openings you own or that are on your projects.')
    }
  }
  const validateOpening = (ctx: Ctx, b: Record<string, unknown>, partial: boolean) => {
    const out: Partial<E.Opening> = {}
    if (!partial || 'role' in b) out.role = need(b.role, 'role', 'Role')
    if (!partial || 'count' in b) {
      const n = Number(b.count)
      if (!Number.isInteger(n) || n < 1 || n > 50) err(422, 'VALIDATION', 'Count must be between 1 and 50.', 'count')
      out.count = n
    }
    if (!partial || 'status' in b) {
      const s = (b.status ?? 'open') as E.Opening['status']
      if (!OPEN_STATUS.includes(s)) err(422, 'VALIDATION', 'Choose a valid status.', 'status')
      out.status = s
    }
    if (!partial || 'owner_id' in b) {
      if (!b.owner_id) err(422, 'VALIDATION', 'Choose who owns this opening.', 'owner_id')
      out.owner_id = activeUser(ctx, b.owner_id as string, 'owner_id')!.id
    }
    if (!partial || 'project_id' in b) {
      const pid = (b.project_id as string) || null
      if (pid) find(ctx, 'projects', pid, 'Project')
      out.project_id = pid
    }
    if (!partial || 'needed_by' in b) {
      const d = (b.needed_by as string) || null
      if (d && !ISO.test(d)) err(422, 'VALIDATION', 'Needed by must be a date.', 'needed_by')
      out.needed_by = d
    }
    if (!partial || 'notes' in b) out.notes = String(b.notes ?? '').trim()
    return out
  }
  const openingView = (ctx: Ctx, o: E.Opening): OpeningView => {
    const pr = o.project_id ? rows(ctx, 'projects').find((x) => x.id === o.project_id) : null
    return { ...o, project_code: pr?.code ?? null, project_name: pr?.name ?? null }
  }
  r.get('/openings', ({ ctx }) => {
    openingGuard(ctx)
    const rank: Record<E.Opening['status'], number> = { open: 0, interviewing: 1, offered: 2, on_hold: 3, filled: 4 }
    return rows(ctx, 'openings')
      .map((o) => openingView(ctx, o))
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.needed_by ?? '9999').localeCompare(b.needed_by ?? '9999'))
  })
  r.post('/openings', ({ ctx, body }) => {
    openingGuard(ctx)
    const v = validateOpening(ctx, body, false) as Omit<E.Opening, keyof E.Base>
    const o = insert(ctx, 'openings', v)
    logActivity(ctx, 'opening', o.id, 'opening.created', `Opening: ${o.count} × ${o.role}`)
    if (o.owner_id !== ctx.user.id) notify(ctx, o.owner_id, 'NTF-14', 'Opening assigned to you', `${o.count} × ${o.role}`, '/openings')
    return o
  })
  r.patch('/openings/:id', ({ ctx, params, body, ifMatch }) => {
    const o = find(ctx, 'openings', params.id, 'Opening')
    openingGuard(ctx, o)
    const out = update(ctx, 'openings', o.id, validateOpening(ctx, body, true), ifMatch)
    logActivity(ctx, 'opening', o.id, 'opening.updated', `Opening ${out.role}: ${out.status.replace('_', ' ')}`)
    return out
  })
  r.del('/openings/:id', ({ ctx, params }) => {
    const o = find(ctx, 'openings', params.id, 'Opening')
    openingGuard(ctx, o)
    remove(ctx, 'openings', o.id)
    logActivity(ctx, 'opening', o.id, 'opening.deleted', `Removed opening ${o.role}`)
    return null
  })
}
