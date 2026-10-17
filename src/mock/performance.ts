// Shared performance calculations (v3). Used by task governance, appraisals, people dashboards,
// the approvals inbox and the report engine, so every screen shows the same numbers.
import type * as E from '@/types/entities'
import { rows, type Ctx } from './server'
import { cal } from './analytics'
import { addDays, isWorkingDay } from '@/domain/calendar'

/** A task closed as cancelled (it had logged hours, so it couldn't be deleted). Excluded from delivery stats. */
export const isCancelled = (t: E.Task) => !!(t as E.Task & { cancelled_on?: string | null }).cancelled_on

/** Signed working-day difference: positive = late, negative = early, 0 = on the due date. */
export function workingDayVariance(ctx: Ctx, due: string, done: string): number {
  if (done === due) return 0
  const c = cal(ctx)
  let n = 0
  if (done > due) {
    for (let d = addDays(due, 1); d <= done; d = addDays(d, 1)) if (isWorkingDay(d, c)) n++
    return n
  }
  for (let d = addDays(done, 1); d <= due; d = addDays(d, 1)) if (isWorkingDay(d, c)) n--
  return n
}

/** Early = finished ≥1 working day before due; on time = on the due date; late = after due. */
export function timelinessOf(variance: number): 'early' | 'on_time' | 'late' {
  return variance < 0 ? 'early' : variance === 0 ? 'on_time' : 'late'
}

/** Timeliness for a completed task: stored value if the reviewer approved it, else derived from dates. */
export function taskTimeliness(ctx: Ctx, t: E.Task): { timeliness: 'early' | 'on_time' | 'late'; variance: number } | null {
  if (t.status !== 'done' || !t.done_on || isCancelled(t)) return null
  if (t.timeliness && t.variance_days !== undefined && t.variance_days !== null) return { timeliness: t.timeliness, variance: t.variance_days }
  const v = workingDayVariance(ctx, t.due_on, t.done_on)
  return { timeliness: timelinessOf(v), variance: v }
}

export interface TaskStats {
  assigned: number
  open: number
  overdue_open: number
  completed: number
  early: number
  on_time: number
  late: number
  on_time_pct: number | null // (early + on time) / completed
  avg_variance_days: number | null
  in_review: number
  sent_back: number // review rounds that ended in "sent back"
  first_pass_pct: number | null // approved on the first submission
  avg_quality: number | null // 1–5
  delay_reasons: Record<string, number>
}

/** Task stats for a person (owner) or set of people, for tasks due or completed inside [from, to]. */
export function taskStats(ctx: Ctx, opts: { userIds?: string[]; projectId?: string; from?: string; to?: string }): TaskStats {
  const ids = opts.userIds ? new Set(opts.userIds) : null
  const inWindow = (t: E.Task) => {
    const d = t.done_on ?? t.due_on
    return (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to)
  }
  const tasks = rows(ctx, 'tasks').filter((t) => !isCancelled(t) && (!ids || (t.owner_id && ids.has(t.owner_id))) && (!opts.projectId || t.project_id === opts.projectId) && inWindow(t))
  const reviews = rows(ctx, 'task_reviews')
  const byTask = new Map<string, typeof reviews>()
  for (const r of reviews) (byTask.get(r.task_id) ?? byTask.set(r.task_id, []).get(r.task_id)!).push(r)
  const s: TaskStats = { assigned: tasks.length, open: 0, overdue_open: 0, completed: 0, early: 0, on_time: 0, late: 0, on_time_pct: null, avg_variance_days: null, in_review: 0, sent_back: 0, first_pass_pct: null, avg_quality: null, delay_reasons: {} }
  let varSum = 0
  let qSum = 0
  let qN = 0
  let firstPass = 0
  let reviewedDone = 0
  for (const t of tasks) {
    if (t.status === 'in_review') s.in_review++
    if (t.status !== 'done') {
      s.open++
      if (t.due_on < ctx.today) s.overdue_open++
    } else {
      s.completed++
      const tl = taskTimeliness(ctx, t)
      if (tl) {
        s[tl.timeliness]++
        varSum += tl.variance
      }
      if (t.quality_rating) {
        qSum += t.quality_rating
        qN++
      }
    }
    if (t.delay_reason_code) s.delay_reasons[t.delay_reason_code] = (s.delay_reasons[t.delay_reason_code] ?? 0) + 1
    const rs = byTask.get(t.id) ?? []
    s.sent_back += rs.filter((r) => r.decision === 'sent_back').length
    if (t.status === 'done' && rs.length) {
      reviewedDone++
      if (!rs.some((r) => r.decision === 'sent_back')) firstPass++
    }
  }
  if (s.completed) {
    s.on_time_pct = (s.early + s.on_time) / s.completed
    s.avg_variance_days = varSum / s.completed
  }
  if (qN) s.avg_quality = qSum / qN
  if (reviewedDone) s.first_pass_pct = firstPass / reviewedDone
  return s
}

/** Direct reports of a manager (reports_to), active only. */
export function reportsOf(ctx: Ctx, managerId: string): E.User[] {
  return rows(ctx, 'users').filter((u) => u.reports_to_id === managerId && u.status === 'active')
}
/** Everyone below a manager in the reporting tree. */
export function teamOf(ctx: Ctx, managerId: string): E.User[] {
  const all = rows(ctx, 'users').filter((u) => u.status === 'active')
  const out: E.User[] = []
  const walk = (id: string, depth: number) => {
    if (depth > 8) return
    for (const u of all) if (u.reports_to_id === id) {
      out.push(u)
      walk(u.id, depth + 1)
    }
  }
  walk(managerId, 0)
  return out
}

export const DELAY_REASON_LABEL: Record<string, string> = {
  scope_change: 'Scope changed',
  dependency: 'Waiting on another task',
  client_delay: 'Client delay / input pending',
  underestimated: 'Effort underestimated',
  leave_absence: 'Leave or absence',
  priority_change: 'Re-prioritised by manager',
  technical_issue: 'Technical issue',
  resource_shortage: 'Resource shortage',
  other: 'Other',
}
