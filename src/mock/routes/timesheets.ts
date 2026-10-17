import { coveringFor } from './tasks'
// Module C — timesheets (UI-15), approvals (UI-16), team grid (UI-37), daily updates (UI-40), leave.
// Enforces BR-01..BR-11, VAL-F04..F10, F28 and VAL-C01..C09 on the "server".
import type * as E from '@/types/entities'
import type { ApprovalItem, ApprovalsView, DailyView, LeaveRow, LeaveView, RowInput, TeamGrid, WeekDay, WeekRow, WeekView, WorkItem } from '@/api/work'
import { err, find, getDb, insert, logActivity, notify, nowISO, persist, remove, rows, update, userName, usersWith, warn, type Ctx, type Router, has, hasAny } from '../server'
import { cal, slaDue, taskActuals } from '../analytics'
import { addDays, dayKind, diffDays, fmtDate, fyLabel, fyRange, fyStartYear, isWorkingDay, parseISO, weekDays, weekLabel, weekStart } from '@/domain/calendar'
import { INTERNAL_CODES, LEAVE_TYPE } from '@/domain/labels'
import { milestoneMap, wbsOf } from './tasks'
import { advanceApproval, ensureWf, startApproval, stepLabel, wfClear, wfPatch, type WfState } from '../workflows'
import { approvalKpi, approvalKpis } from '../approvalKpi'

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */
const S = (ctx: Ctx) => ctx.tenant.settings
const r2 = (n: number) => Math.round(n * 100) / 100
const LEAVE_TYPES: E.LeaveType[] = ['casual', 'sick', 'earned', 'compensatory', 'lwp', 'optional_holiday']
/** Internal activity that counts toward the daily minimum only when the company says breaks count. */
const BREAKS = 'breaks'
const countsToMin = (ctx: Ctx, e: { kind: E.EntryKind; internal_code: string | null }) => !(e.kind === 'internal' && e.internal_code === BREAKS && !S(ctx)['calendar.breaks_count'])
export const leaveLabel = (t: E.LeaveType) => (t === 'lwp' || t === 'optional_holiday' ? LEAVE_TYPE[t] : `${LEAVE_TYPE[t]} leave`)
/** Optional holidays (the tenant's list) — an optional-holiday leave day must be one of them. */
export function optionalHolidayOn(ctx: Ctx, date: string) {
  return rows(ctx, 'holidays').find((h) => h.optional && h.date === date) ?? null
}

function assertMonday(week: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(parseISO(week).getTime()) || weekStart(week) !== week)
    err(422, 'TS_BAD_WEEK', 'A timesheet week starts on a Monday. Pick the Monday of the week you want.', 'week')
}

function activeUser(ctx: Ctx, id: string | null | undefined): E.User | null {
  if (!id) return null
  const u = rows(ctx, 'users').find((x) => x.id === id)
  return u && u.status === 'active' ? u : null
}

/** BR-07: approver = reports_to (active, not self). Deactivated manager → first admin. Top person → null (auto-approved). */
export function resolveApprover(ctx: Ctx, user: E.User): string | null {
  const rt = activeUser(ctx, user.reports_to_id)
  if (rt && rt.id !== user.id) return rt.id
  if (user.reports_to_id === null) return null
  const admin = topApprovers(ctx).find((u) => u.id !== user.id)
  return admin?.id ?? null
}
/** Timesheet override: may decide any submitted week (projects.manage_all — CEO / Administrator / CTO by default). */
export const timesheetOverride = (ctx: Ctx) => has(ctx, 'projects.manage_all')
/** People who hold the timesheet override, top of the reporting line first (fallback approvers). */
function topApprovers(ctx: Ctx) {
  return usersWith(ctx, 'projects.manage_all').sort((a, b) => Number(!!a.reports_to_id) - Number(!!b.reports_to_id))
}

/** People who have delegated their approvals to me today. */
function delegatorsOf(ctx: Ctx, me: string, on = ctx.today): Set<string> {
  return new Set(rows(ctx, 'delegations').filter((d) => d.to_user_id === me && d.from_on <= on && d.to_on >= on && !d.project_id).map((d) => d.from_user_id))
}
/** Delegates covering an approver today. Only all-project delegations hand over timesheet approvals;
 *  a one-project delegation covers that project's tasks and reviews only. */
function activeDelegates(ctx: Ctx, approverId: string, on = ctx.today): string[] {
  return rows(ctx, 'delegations').filter((d) => d.from_user_id === approverId && d.from_on <= on && d.to_on >= on && !d.project_id).map((d) => d.to_user_id)
}

function approverFor(ctx: Ctx, w: E.TimesheetWeek): string | null {
  if (w.approver_id) return w.approver_id
  const u = rows(ctx, 'users').find((x) => x.id === w.user_id)
  return u ? resolveApprover(ctx, u) : null
}

/** Can the viewer approve / reject / unlock this week? (F08: never your own) */
export function canDecide(ctx: Ctx, w: E.TimesheetWeek): { ok: boolean; viaDelegation: boolean } {
  if (w.user_id === ctx.user.id) return { ok: false, viaDelegation: false }
  if (timesheetOverride(ctx)) return { ok: true, viaDelegation: false }
  const ap = approverFor(ctx, w)
  if (ap === ctx.user.id) return { ok: true, viaDelegation: false }
  if (ap && delegatorsOf(ctx, ctx.user.id).has(ap)) return { ok: true, viaDelegation: true }
  return { ok: false, viaDelegation: false }
}

/** BR-06 lazy lock: an open week whose Sunday has passed locks (unless an unlock window is live). */
export function applyLock(ctx: Ctx, w: E.TimesheetWeek): E.TimesheetWeek {
  if (w.status !== 'open' || !S(ctx)['timesheet.weekly_lock']) return w
  const sunday = addDays(w.week_start, 6)
  if (sunday >= ctx.today) return w
  if (w.unlock_until && w.unlock_until >= ctx.today) return w
  w.status = 'locked'
  w.version += 1
  w.updated_at = nowISO()
  persist()
  return w
}
export function sweepLocks(ctx: Ctx) {
  for (const w of rows(ctx, 'timesheet_weeks')) if (w.status === 'open') applyLock(ctx, w)
}

export function findWeek(ctx: Ctx, userId: string, monday: string): E.TimesheetWeek | null {
  const w = rows(ctx, 'timesheet_weeks').find((x) => x.user_id === userId && x.week_start === monday)
  return w ? applyLock(ctx, w) : null
}
function ensureWeek(ctx: Ctx, userId: string, monday: string): E.TimesheetWeek {
  const w = findWeek(ctx, userId, monday)
  if (w) return w
  const row = insert(ctx, 'timesheet_weeks', {
    id: `wk_${userId.replace(/^u_/, '')}_${monday}`,
    user_id: userId, week_start: monday, status: 'open', submitted_at: null, approver_id: null, decided_by: null, decided_at: null,
    late: false, reject_reason: null, unlock_requested_at: null, unlock_reason: null, unlock_until: null,
  } as never) as E.TimesheetWeek
  return applyLock(ctx, row)
}

function isEditable(w: E.TimesheetWeek) {
  return w.status === 'open' || w.status === 'rejected'
}
function assertEditable(w: E.TimesheetWeek) {
  if (w.status === 'locked')
    err(409, 'TS_LOCKED', 'This week ended without being submitted, so it is locked. Ask your manager to unlock it.')
  if (!isEditable(w))
    err(409, 'TS_NOT_EDITABLE', w.status === 'approved' ? 'This week is approved and can no longer change.' : 'This week is submitted and waiting for approval. It can’t be edited now.')
}

function entriesOf(ctx: Ctx, w: E.TimesheetWeek) {
  return rows(ctx, 'timesheet_entries').filter((e) => e.week_id === w.id)
}
function leaveOf(ctx: Ctx, userId: string) {
  return rows(ctx, 'leave').filter((l) => l.user_id === userId)
}

function userCal(ctx: Ctx, userId: string) {
  const base = cal(ctx)
  const full = new Set(leaveOf(ctx, userId).filter((l) => l.portion === 'full').map((l) => l.date))
  return { ...base, leaveDates: full }
}

function dayTotals(ctx: Ctx, w: E.TimesheetWeek, entries = entriesOf(ctx, w)) {
  const min = S(ctx)['calendar.min_hours_per_day']
  const c = userCal(ctx, w.user_id)
  return weekDays(w.week_start).map((date) => {
    const kind = dayKind(date, c)
    const day = entries.filter((e) => e.work_date === date)
    const total = r2(day.reduce((s, e) => s + e.hours, 0))
    const counted = r2(day.filter((e) => countsToMin(ctx, e)).reduce((s, e) => s + e.hours, 0))
    // a half-day leave keeps the day a working day: the leave hours count toward the minimum
    const minReq = kind === 'working' ? min : 0
    const decided = !isEditable(w)
    const below = minReq > 0 && counted < minReq && (date < ctx.today || (decided && date <= ctx.today))
    return { date, kind, total, counted, min_required: minReq, below_min: below }
  })
}

/** Task access for time entry (VAL-F09): owner, backup, or allocated to the task's milestone during the week. */
function taskAllowed(ctx: Ctx, t: E.Task, userId: string, monday: string) {
  if (t.owner_id === userId || t.backup_id === userId) return true
  const sun = addDays(monday, 6)
  if (coveringFor(ctx, userId, monday, sun).has(t.id)) return true // covering via delegation
  return rows(ctx, 'allocations').some((a) => a.user_id === userId && a.project_id === t.project_id && (!t.milestone_id || !a.milestone_id || a.milestone_id === t.milestone_id) && a.from_on <= sun && a.to_on >= monday)
}
/** VAL-F10: completed / closed projects accept no hours after their status date. */
function projectClosedOn(ctx: Ctx, p: E.Project): string | null {
  if (p.status !== 'completed' && p.status !== 'closed') return null
  const h = rows(ctx, 'project_status_history').filter((x) => x.project_id === p.id && x.to_status === p.status).sort((a, b) => b.changed_at.localeCompare(a.changed_at))[0]
  return h ? h.changed_at.slice(0, 10) : p.updated_at.slice(0, 10)
}

function rowKey(e: { kind: E.EntryKind; task_id: string | null; internal_code: string | null; leave_type: E.LeaveType | null; note: string; project_id?: string | null }) {
  if (e.kind === 'task') return `task:${e.task_id}`
  if (e.kind === 'leave') return `leave:${e.leave_type}`
  return `internal:${e.internal_code}:${e.project_id ?? ''}:${(e.note ?? '').trim().toLowerCase()}`
}

/** Projects a person can book activity time to (No project is always allowed). */
function activityProjects(ctx: Ctx, userId: string) {
  const mine = new Set<string>()
  for (const a of rows(ctx, 'allocations')) if (a.user_id === userId) mine.add(a.project_id)
  for (const t of rows(ctx, 'tasks')) if (t.owner_id === userId || t.backup_id === userId) mine.add(t.project_id)
  for (const p of rows(ctx, 'projects')) if (p.pm_id === userId) mine.add(p.id)
  return rows(ctx, 'projects')
    .filter((p) => p.status !== 'completed' && p.status !== 'closed' && (mine.has(p.id) || p.code === 'GEN'))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({ id: p.id, code: p.code, name: p.name }))
}

/** Day the week's Friday demo is recorded on: Friday, or the nearest working day before it (else the last working day). */
export function demoDateOf(ctx: Ctx, monday: string, userId?: string) {
  const c = userId ? userCal(ctx, userId) : cal(ctx)
  const fri = addDays(monday, 4)
  for (let d = fri; d >= monday; d = addDays(d, -1)) if (isWorkingDay(d, { ...c, leaveDates: undefined })) return d
  for (let d = addDays(monday, 6); d > fri; d = addDays(d, -1)) if (isWorkingDay(d, { ...c, leaveDates: undefined })) return d
  return fri
}

/* ------------------------------------------------------------------ */
/* Week view                                                           */
/* ------------------------------------------------------------------ */
function buildWeekView(ctx: Ctx, w: E.TimesheetWeek): WeekView {
  const st = S(ctx)
  const user = find(ctx, 'users', w.user_id, 'Person')
  const entries = entriesOf(ctx, w)
  const totals = dayTotals(ctx, w, entries)
  const holidays = new Map(rows(ctx, 'holidays').filter((h) => !h.optional).map((h) => [h.date, h.name]))
  const leaves = new Map(leaveOf(ctx, w.user_id).map((l) => [l.date, l]))
  const editable = isEditable(w)
  const dowOf = (d: string) => parseISO(d).getDay()
  const days: WeekDay[] = totals.map((d) => {
    const l = leaves.get(d.date)
    const future = d.date > ctx.today
    const hol = holidays.get(d.date) ?? null
    const off = d.kind === 'weekly_off' || (d.kind === 'leave' && dayKind(d.date, { ...cal(ctx), leaveDates: undefined }) === 'weekly_off')
    return {
      date: d.date,
      kind: d.kind,
      holiday: hol,
      // Mon–Sat always; Sunday only when the company calendar makes it a working day (or hours were logged on it)
      hidden: dowOf(d.date) === 0 && off && d.total === 0,
      label: hol ? 'Holiday' : off ? 'Weekly off' : l ? (l.portion === 'half' ? 'Half day' : 'Leave') : null,
      counted: d.counted,
      leave: l ? { id: l.id, type: l.type, portion: l.portion, source: l.source } : null,
      total: d.total,
      min_required: d.min_required,
      below_min: d.below_min,
      future,
      entry_allowed: !future || st['timesheet.allow_future_entries'],
    }
  })
  const ms = milestoneMap(ctx)
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const act = taskActuals(ctx)
  const hrDates = new Set([...leaves.values()].filter((l) => l.source === 'hr').map((l) => l.date))
  const grouped = new Map<string, WeekRow>()
  for (const e of entries.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const key = rowKey(e)
    let row = grouped.get(key)
    if (!row) {
      const t = e.task_id ? tasks.get(e.task_id) : null
      const p = t ? projects.get(t.project_id) : null
      const m = t?.milestone_id ? ms.get(t.milestone_id) : null
      row = {
        key,
        kind: e.kind,
        task_id: e.task_id,
        internal_code: e.internal_code,
        leave_type: e.leave_type,
        note: e.note ?? '',
        label: e.kind === 'task' ? t?.title ?? 'Removed task' : e.kind === 'leave' ? leaveLabel(e.leave_type ?? 'casual') : INTERNAL_CODES[e.internal_code ?? ''] ?? e.internal_code ?? 'Internal',
        sublabel: e.kind === 'task' ? [p?.code, p?.name, m ? `M${m.no} ${m.name}` : null].filter(Boolean).join(' · ') : e.kind === 'leave' ? 'Leave' : e.project_id ? `Activity · ${projects.get(e.project_id)?.code ?? ''} ${projects.get(e.project_id)?.name ?? ''}`.trim() : 'Activity · no project',
        project_id: e.kind === 'internal' ? e.project_id ?? null : t?.project_id ?? null,
        wbs: t ? wbsOf(t, ms) : null,
        project_code: p?.code ?? null,
        project_hue: p?.color_hue ?? null,
        task_status: t?.status ?? null,
        est_hours: t?.est_hours ?? null,
        logged_hours: t ? r2(act.get(t.id)?.hours ?? 0) : null,
        hours: {},
        total: 0,
        locked_reason: null,
      }
      grouped.set(key, row)
    }
    if (e.hours > 0) row.hours[e.work_date] = r2((row.hours[e.work_date] ?? 0) + e.hours)
    row.total = r2(row.total + e.hours)
    if (e.kind === 'leave' && hrDates.has(e.work_date)) row.locked_reason = 'Leave entered by HR. Ask HR to change it.'
  }
  const order = { task: 0, internal: 1, leave: 2 }
  const outRows = [...grouped.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.wbs ?? '').localeCompare(b.wbs ?? '', undefined, { numeric: true }))
  const approverId = w.approver_id ?? resolveApprover(ctx, user)
  const total = r2(totals.reduce((s, d) => s + d.total, 0))
  const isSelf = w.user_id === ctx.user.id
  const optional = rows(ctx, 'holidays').filter((h) => h.optional && h.date >= w.week_start && h.date <= addDays(w.week_start, 6)).map((h) => ({ date: h.date, name: h.name }))
  return {
    id: w.id,
    version: w.version,
    user: { id: user.id, name: user.name, title: user.title },
    is_self: isSelf,
    week_start: w.week_start,
    week_end: addDays(w.week_start, 6),
    status: w.status,
    editable: editable && isSelf && !ctx.viewAs,
    unlocked_until: w.unlock_until && w.unlock_until >= ctx.today && w.status === 'open' ? w.unlock_until : null,
    submitted_at: w.submitted_at,
    decided_at: w.decided_at,
    decided_by: w.decided_by ? { id: w.decided_by, name: userName(ctx, w.decided_by) } : null,
    approver: approverId ? { id: approverId, name: userName(ctx, approverId) } : null,
    auto_approved: w.status === 'approved' && w.decided_by === w.user_id,
    reject_reason: w.reject_reason,
    unlock_requested_at: w.unlock_requested_at,
    unlock_reason: w.unlock_reason,
    sla_due: w.status === 'submitted' && w.submitted_at ? slaDue(ctx, w.submitted_at) : null,
    late: w.late,
    days,
    rows: outRows,
    total,
    target: totals.reduce((s, d) => s + d.min_required, 0),
    target_to_date: totals.filter((d) => d.date <= ctx.today).reduce((s, d) => s + d.min_required, 0),
    counted: r2(totals.reduce((s, d) => s + d.counted, 0)),
    submit_by: addDays(w.week_start, 6),
    below_min_days: totals.filter((d) => d.below_min).length,
    activity_projects: isSelf ? activityProjects(ctx, w.user_id) : [],
    optional_holidays: optional,
    rules: {
      min_hours: st['calendar.min_hours_per_day'],
      max_hours: st['calendar.max_hours_per_day'],
      step: st['timesheet.hours_step'],
      allow_future: st['timesheet.allow_future_entries'],
      note_required: st['timesheet.internal_note_required'],
      unlock_max_days: st['timesheet.unlock_max_days'],
      bulk_approve: st['approval.bulk_approve'],
      breaks_count: st['calendar.breaks_count'],
    },
    can_submit: editable && isSelf && w.week_start <= ctx.today,
    can_request_unlock: isSelf && w.status === 'locked' && !w.unlock_requested_at,
  }
}

function canView(ctx: Ctx, userId: string) {
  if (userId === ctx.user.id) return true
  if (hasAny(ctx, 'people.view_all', 'projects.view_all')) return true
  const u = rows(ctx, 'users').find((x) => x.id === userId)
  if (!u) return false
  const ap = resolveApprover(ctx, u)
  return ap === ctx.user.id || (!!ap && delegatorsOf(ctx, ctx.user.id).has(ap))
}

/* ------------------------------------------------------------------ */
/* Save (replace entry set) with all validations                       */
/* ------------------------------------------------------------------ */
/** Replace the week's entries. Rows with no hours are dropped (the grid keeps one empty row client-side);
 *  `keepEmpty` keeps them, e.g. rows just copied from last week, until the next save. */
function saveRows(ctx: Ctx, w: E.TimesheetWeek, input: RowInput[], keepEmpty = false) {
  const st = S(ctx)
  if (!Array.isArray(input)) err(422, 'VALIDATION', 'Send the rows of the week.', 'rows')
  const days = new Set(weekDays(w.week_start))
  const c = userCal(ctx, w.user_id)
  const step = st['timesheet.hours_step']
  const maxH = st['calendar.max_hours_per_day']
  const minH = st['calendar.min_hours_per_day']
  const existing = entriesOf(ctx, w)
  const hadTask = new Set(existing.filter((e) => e.kind === 'task').map((e) => e.task_id))
  const leaves = leaveOf(ctx, w.user_id)
  const hrLeaveDates = new Set(leaves.filter((l) => l.source === 'hr').map((l) => l.date))
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  type NewE = { work_date: string; kind: E.EntryKind; task_id: string | null; internal_code: string | null; leave_type: E.LeaveType | null; hours: number; note: string; project_id: string | null }
  const allowedProjects = new Set(activityProjects(ctx, w.user_id).map((p) => p.id))
  const out: NewE[] = []
  const seen = new Set<string>()
  input.forEach((row, i) => {
    const kind = row.kind
    if (!['task', 'leave', 'internal'].includes(kind)) err(422, 'VALIDATION', `Row ${i + 1}: choose a task, leave type or internal activity.`, `rows.${i}`)
    const note = String(row.note ?? '').trim().slice(0, 500)
    const hours = row.hours && typeof row.hours === 'object' ? row.hours : {}
    const any = Object.values(hours).some((h) => Number(h) > 0)
    let label = ''
    if (kind === 'task') {
      const t = row.task_id ? tasks.get(row.task_id) : undefined
      if (!t) err(422, 'VALIDATION', `Row ${i + 1}: that task no longer exists. Remove the row.`, `rows.${i}`)
      label = t.title
      if (any && !hadTask.has(t.id) && !taskAllowed(ctx, t, w.user_id, w.week_start))
        err(403, 'TS_TASK_NOT_ALLOWED', `You can log time only on tasks you own, back up or are allocated to. “${t.title}” isn’t one of them.`, `rows.${i}`)
      const p = projects.get(t.project_id)
      const closedOn = p ? projectClosedOn(ctx, p) : null
      if (closedOn && any && Object.entries(hours).some(([d, h]) => Number(h) > 0 && d > closedOn))
        err(409, 'TS_PROJECT_CLOSED', `${p!.name} was ${p!.status} on ${fmtDate(closedOn)}. Hours after that date can’t be booked to it.`, `rows.${i}`)
    } else if (kind === 'internal') {
      if (!row.internal_code || !INTERNAL_CODES[row.internal_code]) err(422, 'VALIDATION', `Row ${i + 1}: choose an activity.`, `rows.${i}`)
      label = INTERNAL_CODES[row.internal_code]
      if (row.project_id && !allowedProjects.has(row.project_id) && !projects.has(row.project_id)) err(422, 'VALIDATION', `Row ${i + 1}: that project no longer exists. Pick another or “No project”.`, `rows.${i}.project_id`)
      if (any && st['timesheet.internal_note_required'] && row.internal_code !== BREAKS && note.length < 3)
        err(422, 'TS_NOTE_REQUIRED', `Add a short note to “${label}” saying what the time was for.`, `rows.${i}.note`)
    } else {
      if (!row.leave_type || !LEAVE_TYPES.includes(row.leave_type)) err(422, 'VALIDATION', `Row ${i + 1}: choose a leave type.`, `rows.${i}`)
      label = leaveLabel(row.leave_type)
    }
    const projectId = kind === 'internal' ? row.project_id || null : null
    // Feature Guide §8: "Rows with no hours disappear" — on every save, whatever the note says.
    // keepEmpty only for rows just copied from last week (they disappear on the next save if still empty).
    if (!any && !keepEmpty) return
    const key = rowKey({ kind, task_id: row.task_id ?? null, internal_code: row.internal_code ?? null, leave_type: row.leave_type ?? null, note, project_id: projectId })
    if (seen.has(key)) err(422, 'VALIDATION', `“${label}” appears twice. Merge the rows into one.`, `rows.${i}`)
    seen.add(key)
    let wrote = false
    for (const [date, raw] of Object.entries(hours)) {
      const h = Number(raw)
      if (!h) continue
      if (!days.has(date)) err(422, 'TS_BAD_HOURS', `${fmtDate(date)} is outside this week.`, `rows.${i}`)
      if (!Number.isFinite(h) || h < 0 || h > 24) err(422, 'TS_BAD_HOURS', `Hours must be between 0 and 24 (${label}, ${fmtDate(date, 'day')}).`, `rows.${i}`)
      if (Math.abs(h / step - Math.round(h / step)) > 1e-9) err(422, 'TS_BAD_STEP', `Enter hours in steps of ${step}h. ${h}h on ${fmtDate(date, 'day')} for “${label}” isn’t one.`, `rows.${i}`)
      if (kind !== 'leave' && date > ctx.today && !st['timesheet.allow_future_entries'])
        err(422, 'TS_FUTURE', `${fmtDate(date, 'day')} hasn’t happened yet. Log hours on or after the day you worked them.`, `rows.${i}`)
      if (kind === 'leave') {
        if (hrLeaveDates.has(date)) continue // HR-entered leave is kept as is
        const k = dayKind(date, { ...c, leaveDates: undefined })
        if (k !== 'working') err(422, 'LEAVE_INVALID', `${fmtDate(date, 'day')} is ${k === 'holiday' ? 'a holiday' : 'a weekly off'}, so it can’t be a leave day.`, `rows.${i}`)
        if (row.leave_type === 'optional_holiday' && !optionalHolidayOn(ctx, date))
          err(422, 'LEAVE_INVALID', `${fmtDate(date, 'day')} isn’t on the optional holiday list. Pick one of the optional holidays in the holiday calendar, or another leave type.`, `rows.${i}`)
      }
      out.push({ work_date: date, kind, task_id: kind === 'task' ? row.task_id : null, internal_code: kind === 'internal' ? row.internal_code : null, leave_type: kind === 'leave' ? row.leave_type : null, hours: h, note, project_id: projectId })
      wrote = true
    }
    // keep empty rows pinned (e.g. copied from last week) with a zero-hour marker
    if (!wrote) out.push({ work_date: w.week_start, kind, task_id: kind === 'task' ? row.task_id : null, internal_code: kind === 'internal' ? row.internal_code : null, leave_type: kind === 'leave' ? row.leave_type : null, hours: 0, note, project_id: projectId })
  })
  // HR leave entries survive the replace
  const keepHr = existing.filter((e) => e.kind === 'leave' && hrLeaveDates.has(e.work_date))
  // VAL-C02: per-day maximum
  for (const d of days) {
    const tot = out.filter((e) => e.work_date === d).reduce((s, e) => s + e.hours, 0) + keepHr.filter((e) => e.work_date === d).reduce((s, e) => s + e.hours, 0)
    if (tot > maxH) err(422, 'TS_OVER_MAX', `${fmtDate(d, 'day')} adds up to ${r2(tot)}h. The most you can log in a day is ${maxH}h.`)
  }
  // Replace the entry set
  const db = getDb()
  db.timesheet_entries = db.timesheet_entries.filter((e) => !(e.tenant_id === ctx.tenant.id && e.week_id === w.id && !keepHr.includes(e)))
  for (const e of out) insert(ctx, 'timesheet_entries', { week_id: w.id, user_id: w.user_id, ...e } as never)
  // BR-09: leave rows ⇄ leave records (timesheet-sourced only)
  for (const d of days) {
    if (hrLeaveDates.has(d)) continue
    const lv = out.filter((e) => e.kind === 'leave' && e.work_date === d && e.hours > 0)
    const cur = leaves.find((l) => l.date === d && l.source === 'timesheet')
    if (!lv.length) {
      if (cur) remove(ctx, 'leave', cur.id)
      continue
    }
    const hrs = lv.reduce((s, e) => s + e.hours, 0)
    const type = [...lv].sort((a, b) => b.hours - a.hours)[0].leave_type!
    const portion: 'full' | 'half' = hrs >= minH ? 'full' : 'half'
    if (cur) {
      if (cur.type !== type || cur.portion !== portion) update(ctx, 'leave', cur.id, { type, portion })
    } else insert(ctx, 'leave', { user_id: w.user_id, date: d, type, portion, source: 'timesheet', approved_by: null } as never)
  }
  w.version += 1
  w.updated_at = nowISO()
  persist()
}

function submitWeek(ctx: Ctx, w: E.TimesheetWeek) {
  assertEditable(w)
  if (w.week_start > ctx.today) err(422, 'TS_FUTURE', 'This week hasn’t started yet. Submit it once you’ve worked it.')
  const totals = dayTotals(ctx, w)
  const total = totals.reduce((s, d) => s + d.total, 0)
  if (total <= 0) err(422, 'TS_BAD_HOURS', 'Log your hours before submitting the week.')
  const st = S(ctx)
  const user = find(ctx, 'users', w.user_id, 'Person')
  // Timesheet workflow (default: reporting manager); the v3 rule applies when it names nobody.
  const wf = startApproval(ctx, 'timesheet', { requester_id: user.id }, resolveApprover(ctx, user))
  const approver = wf.approver_id
  const below = totals.filter((d) => d.min_required > 0 && d.counted < d.min_required && d.date <= ctx.today)
  if (below.length)
    warn(ctx, 'TS_BELOW_MIN', `${below.map((d) => `${fmtDate(d.date, 'day')}: ${d.total}h`).join(', ')} ${below.length === 1 ? 'is' : 'are'} below ${st['calendar.min_hours_per_day']}h. Short days may not be paid in full.`)
  const wasRejected = w.status === 'rejected'
  // rows still at 0h (e.g. copied from last week and never filled) don't travel with the submitted week
  const db0 = getDb()
  db0.timesheet_entries = db0.timesheet_entries.filter((e) => !(e.tenant_id === ctx.tenant.id && e.week_id === w.id && !(e.hours > 0)))
  if (!approver) {
    // Top person: auto-approved (BR-07)
    update(ctx, 'timesheet_weeks', w.id, { status: 'approved', submitted_at: nowISO(), approver_id: null, decided_by: user.id, decided_at: nowISO(), late: false, reject_reason: null, unlock_until: null, unlock_requested_at: null, unlock_reason: null })
    logActivity(ctx, 'timesheet_week', w.id, 'auto_approved', `Submitted ${weekLabel(w.week_start)} (auto-approved)`)
    return { approverName: null as string | null }
  }
  update(ctx, 'timesheet_weeks', w.id, { status: 'submitted', submitted_at: nowISO(), approver_id: approver, decided_by: null, decided_at: null, late: false, reject_reason: null, unlock_until: null, unlock_requested_at: null, unlock_reason: null, ...wfPatch(wf) } as never)
  const body = `${user.name} ${wasRejected ? 'resubmitted' : 'submitted'} ${weekLabel(w.week_start)} (${r2(total)}h${below.length ? `, ${below.length} short day${below.length > 1 ? 's' : ''}` : ''}).`
  for (const to of [approver, ...activeDelegates(ctx, approver)]) notify(ctx, to, 'NTF-04', 'Timesheet submitted', body, '/approvals')
  logActivity(ctx, 'timesheet_week', w.id, 'submitted', `Submitted ${weekLabel(w.week_start)} to ${userName(ctx, approver)}`)
  return { approverName: userName(ctx, approver) }
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */
function approvalItem(ctx: Ctx, w: E.TimesheetWeek, viaDelegation: boolean): ApprovalItem {
  const u = find(ctx, 'users', w.user_id, 'Person')
  const totals = dayTotals(ctx, w)
  const due = w.submitted_at ? slaDue(ctx, w.submitted_at) : null
  return {
    week_id: w.id,
    version: w.version,
    user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue },
    week_start: w.week_start,
    status: w.status,
    total: r2(totals.reduce((s, d) => s + d.total, 0)),
    day_totals: totals.map((d) => ({ date: d.date, total: d.total, below_min: d.min_required > 0 && d.counted < d.min_required, kind: d.kind, hidden: parseISO(d.date).getDay() === 0 && d.kind !== 'working' && d.total === 0 })),
    days_below_min: totals.filter((d) => d.min_required > 0 && d.counted < d.min_required).length,
    submitted_at: w.submitted_at,
    days_waiting: w.submitted_at ? Math.max(0, diffDays(ctx.today, w.submitted_at.slice(0, 10))) : w.unlock_requested_at ? Math.max(0, diffDays(ctx.today, w.unlock_requested_at.slice(0, 10))) : 0,
    sla_due: due,
    overdue: w.status === 'submitted' && !!due && ctx.today > due,
    via_delegation: viaDelegation,
    unlock_requested_at: w.unlock_requested_at,
    unlock_reason: w.unlock_reason,
    // v4 workflow extra (multi-step timesheet chains); not in the shared ApprovalItem type
    ...({ step_label: w.status === 'submitted' ? stepLabel(w as Partial<WfState>) : null } as object),
  }
}

function decidable(ctx: Ctx, weekId: string) {
  const w = find(ctx, 'timesheet_weeks', weekId, 'Timesheet week')
  applyLock(ctx, w)
  if (w.user_id === ctx.user.id) err(403, 'TS_SELF_APPROVAL', 'You can’t approve or unlock your own timesheet. Your manager does that.')
  if (!canDecide(ctx, w).ok) err(403, 'FORBIDDEN', 'Only this person’s approver (or their delegate) can do this.')
  return w
}

function doApprove(ctx: Ctx, w: E.TimesheetWeek, ifMatch?: number) {
  if (w.status !== 'submitted') err(409, 'TS_NOT_EDITABLE', 'Only submitted weeks can be approved. Refresh to see its current state.')
  const late = !!w.submitted_at && ctx.today > slaDue(ctx, w.submitted_at)
  const owner = rows(ctx, 'users').find((u) => u.id === w.user_id)
  const st = ensureWf(ctx, w as E.TimesheetWeek & Partial<WfState>, 'timesheet', { requester_id: w.user_id }, owner ? resolveApprover(ctx, owner) : null)
  const adv = advanceApproval(ctx, st, ctx.user.id)
  if (adv.next) {
    // Multi-step timesheet workflow: the week stays submitted and moves to the next approver.
    const nx = adv.next
    update(ctx, 'timesheet_weeks', w.id, { approver_id: nx.approver_id, ...wfPatch(adv.state) } as never, ifMatch)
    for (const to of [nx.approver_id, ...activeDelegates(ctx, nx.approver_id)]) notify(ctx, to, 'NTF-04', 'Timesheet to approve', `${userName(ctx, w.user_id)}’s ${weekLabel(w.week_start)} was approved by ${ctx.user.name} and needs your approval (${nx.name}).`, '/approvals')
    logActivity(ctx, 'timesheet_week', w.id, 'approved_step', `Step ${st.wf_step + 1} of ${st.wf_chain.length} (${adv.done?.name ?? 'approval'}) of ${userName(ctx, w.user_id)}’s ${weekLabel(w.week_start)} approved by ${ctx.user.name}; sent to ${userName(ctx, nx.approver_id)}`)
    warn(ctx, 'NEXT_APPROVAL', `Step ${st.wf_step + 1} of ${st.wf_chain.length} approved — sent to ${userName(ctx, nx.approver_id)}.`)
    return false
  }
  update(ctx, 'timesheet_weeks', w.id, { status: 'approved', decided_by: ctx.user.id, decided_at: nowISO(), late, reject_reason: null, ...wfPatch(adv.state) } as never, ifMatch)
  notify(ctx, w.user_id, 'NTF-05', 'Timesheet approved', `${ctx.user.name} approved ${weekLabel(w.week_start)}. It counts for salary.`, `/timesheet/${w.week_start}`)
  logActivity(ctx, 'timesheet_week', w.id, 'approved', `Approved ${userName(ctx, w.user_id)}’s ${weekLabel(w.week_start)}${late ? ' (late)' : ''}`)
  return late
}

/* ------------------------------------------------------------------ */
/* Work item picker                                                    */
/* ------------------------------------------------------------------ */
function workItems(ctx: Ctx, userId: string, monday: string): WorkItem[] {
  const ms = milestoneMap(ctx)
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const out: WorkItem[] = []
  const tasks = rows(ctx, 'tasks').filter((t) => {
    const p = projects.get(t.project_id)
    if (!p || p.status === 'completed' || p.status === 'closed') return false
    if (t.status === 'done' && (!t.done_on || t.done_on < monday)) return false
    return taskAllowed(ctx, t, userId, monday)
  })
  const kindOf = (t: E.Task) => (t.owner_id === userId ? 'mine' : t.backup_id === userId ? 'backup' : 'allocated')
  tasks.sort((a, b) => (projects.get(a.project_id)!.code + wbsOf(a, ms)).localeCompare(projects.get(b.project_id)!.code + wbsOf(b, ms), undefined, { numeric: true }))
  for (const t of tasks) {
    const p = projects.get(t.project_id)!
    const m = t.milestone_id ? ms.get(t.milestone_id) : null
    const k = kindOf(t)
    out.push({
      key: `task:${t.id}`, kind: 'task', task_id: t.id, internal_code: null, leave_type: null,
      label: `${wbsOf(t, ms)} ${t.title}`,
      hint: [p.code, m ? `M${m.no} ${m.name}` : null, k === 'backup' ? `covering ${userName(ctx, t.owner_id)}` : k === 'allocated' ? `owner ${userName(ctx, t.owner_id)}` : null].filter(Boolean).join(' · '),
      group: k === 'mine' ? `My tasks · ${p.name}` : k === 'backup' ? 'Tasks I’m covering' : `Allocated · ${p.name}`,
      wbs: wbsOf(t, ms), project_code: p.code,
    })
  }
  for (const [code, label] of Object.entries(INTERNAL_CODES))
    out.push({ key: `internal:${code}`, kind: 'internal', task_id: null, internal_code: code, leave_type: null, label, hint: code === BREAKS ? (S(ctx)['calendar.breaks_count'] ? 'Counts toward the minimum' : 'Doesn’t count toward the minimum') : S(ctx)['timesheet.internal_note_required'] ? 'Needs a note' : 'Activity', group: 'Activities', wbs: null, project_code: null })
  for (const lt of LEAVE_TYPES)
    out.push({ key: `leave:${lt}`, kind: 'leave', task_id: null, internal_code: null, leave_type: lt, label: leaveLabel(lt), hint: lt === 'lwp' ? 'Unpaid — deducted in payroll' : lt === 'optional_holiday' ? 'Only on a listed optional holiday' : 'Full day = minimum hours; less = half day', group: 'Leave', wbs: null, project_code: null })
  return out
}

/* ------------------------------------------------------------------ */
/* Leave helpers                                                       */
/* ------------------------------------------------------------------ */
function leaveEntryFor(ctx: Ctx, l: E.Leave) {
  const w = ensureWeek(ctx, l.user_id, weekStart(l.date))
  const minH = S(ctx)['calendar.min_hours_per_day']
  const hours = l.portion === 'full' ? minH : minH / 2
  const db = getDb()
  db.timesheet_entries = db.timesheet_entries.filter((e) => !(e.tenant_id === ctx.tenant.id && e.week_id === w.id && e.kind === 'leave' && e.work_date === l.date))
  insert(ctx, 'timesheet_entries', { week_id: w.id, user_id: l.user_id, work_date: l.date, kind: 'leave', task_id: null, internal_code: null, leave_type: l.type, hours, note: l.source === 'hr' ? 'Entered by HR' : '' } as never)
  w.version += 1
  persist()
}
function removeLeaveEntry(ctx: Ctx, l: E.Leave) {
  const w = findWeek(ctx, l.user_id, weekStart(l.date))
  if (!w) return
  const db = getDb()
  db.timesheet_entries = db.timesheet_entries.filter((e) => !(e.tenant_id === ctx.tenant.id && e.week_id === w.id && e.kind === 'leave' && e.work_date === l.date))
  w.version += 1
  persist()
}
function directReports(ctx: Ctx, me: string) {
  const del = delegatorsOf(ctx, me)
  return rows(ctx, 'users').filter((u) => u.status === 'active' && u.id !== me && (u.reports_to_id === me || (u.reports_to_id && del.has(u.reports_to_id))))
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
export function register(r: Router) {
  /* ---------- timesheet week ---------- */
  r.get('/timesheets/:week', ({ ctx, params, query }) => {
    assertMonday(params.week)
    const userId = (query.user as string) || ctx.user.id
    if (!canView(ctx, userId)) err(403, 'FORBIDDEN', 'You can see only your own timesheet and those of people who report to you.')
    find(ctx, 'users', userId, 'Person')
    const w = userId === ctx.user.id ? ensureWeek(ctx, userId, params.week) : findWeek(ctx, userId, params.week) ?? ensureWeek(ctx, userId, params.week)
    return buildWeekView(ctx, w)
  })

  r.put('/timesheets/:week', ({ ctx, params, body, ifMatch }) => {
    assertMonday(params.week)
    const w = ensureWeek(ctx, ctx.user.id, params.week)
    assertEditable(w)
    if (ifMatch !== undefined && ifMatch !== w.version) err(409, 'STALE', 'This week changed in another tab or device. Reload to see the latest version.')
    saveRows(ctx, w, body.rows)
    logActivity(ctx, 'timesheet_week', w.id, 'saved', `Saved draft for ${weekLabel(w.week_start)}`)
    return buildWeekView(ctx, w)
  })

  r.post('/timesheets/:week/submit', ({ ctx, params, body, ifMatch }) => {
    assertMonday(params.week)
    const w = ensureWeek(ctx, ctx.user.id, params.week)
    assertEditable(w)
    if (ifMatch !== undefined && ifMatch !== w.version) err(409, 'STALE', 'This week changed in another tab or device. Reload to see the latest version.')
    if (Array.isArray(body.rows)) saveRows(ctx, w, body.rows)
    const res = submitWeek(ctx, w)
    return { ...buildWeekView(ctx, w), approver_name: res.approverName }
  })

  r.post('/timesheets/:week/unlock-request', ({ ctx, params, body }) => {
    assertMonday(params.week)
    const w = ensureWeek(ctx, ctx.user.id, params.week)
    if (w.status !== 'locked') err(409, 'TS_NOT_EDITABLE', 'Only a locked week needs unlocking.')
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 5) err(422, 'TS_REASON_REQUIRED', 'Say why you need the week unlocked (at least 5 characters).', 'reason')
    update(ctx, 'timesheet_weeks', w.id, { unlock_requested_at: nowISO(), unlock_reason: reason })
    const ap = resolveApprover(ctx, ctx.user)
    const to = ap ? [ap, ...activeDelegates(ctx, ap)] : topApprovers(ctx).filter((u) => u.id !== ctx.user.id).map((u) => u.id)
    const snippet = reason.length > 70 ? reason.slice(0, 68) + '…' : reason
    for (const id of to) notify(ctx, id, 'NTF-07', 'Unlock requested', `${ctx.user.name} asked to unlock ${weekLabel(w.week_start)}: “${snippet}”`, '/approvals')
    logActivity(ctx, 'timesheet_week', w.id, 'unlock_requested', `Requested unlock of ${weekLabel(w.week_start)}`)
    return { ...buildWeekView(ctx, w), approver_name: ap ? userName(ctx, ap) : 'an admin' }
  })

  r.post('/timesheets/:week/copy-previous', ({ ctx, params, body }) => {
    assertMonday(params.week)
    const w = ensureWeek(ctx, ctx.user.id, params.week)
    assertEditable(w)
    const prevMon = addDays(params.week, -7)
    const prev = findWeek(ctx, ctx.user.id, prevMon)
    const prevEntries = prev ? entriesOf(ctx, prev).filter((e) => e.kind !== 'leave') : []
    if (!prevEntries.length) err(422, 'VALIDATION', 'Last week has no task or internal rows to copy.')
    const cur = entriesOf(ctx, w)
    const current: RowInput[] = []
    const byKey = new Map<string, RowInput>()
    for (const e of cur) {
      const k = rowKey(e)
      let row = byKey.get(k)
      if (!row) {
        row = { kind: e.kind, task_id: e.task_id, internal_code: e.internal_code, leave_type: e.leave_type, note: e.note, hours: {}, project_id: e.project_id ?? null }
        byKey.set(k, row)
        current.push(row)
      }
      if (e.hours > 0) row.hours[e.work_date] = (row.hours[e.work_date] ?? 0) + e.hours
    }
    const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const c = userCal(ctx, ctx.user.id)
    const allowFuture = S(ctx)['timesheet.allow_future_entries']
    let added = 0
    let skipped = 0
    for (const e of prevEntries) {
      if (e.kind === 'task') {
        const t = e.task_id ? tasks.get(e.task_id) : null
        const p = t ? projects.get(t.project_id) : null
        if (!t || !p || t.status === 'done' || p.status === 'completed' || p.status === 'closed' || !taskAllowed(ctx, t, ctx.user.id, params.week)) {
          skipped++
          continue
        }
      }
      const k = rowKey(e)
      let row = byKey.get(k)
      if (!row) {
        row = { kind: e.kind, task_id: e.task_id, internal_code: e.internal_code, leave_type: null, note: e.note, hours: {}, project_id: e.project_id ?? null }
        byKey.set(k, row)
        current.push(row)
        added++
      }
      if (body.with_hours && e.hours > 0) {
        const d = addDays(e.work_date, 7)
        if ((allowFuture || d <= ctx.today) && isWorkingDay(d, c) && !row.hours[d]) row.hours[d] = e.hours
      }
    }
    if (!added && !body.with_hours) err(422, 'VALIDATION', 'All of last week’s rows are already on this week.')
    saveRows(ctx, w, current, true)
    if (skipped) warn(ctx, 'COPY_SKIPPED', `${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} skipped: the task is done, reassigned or its project is closed.`)
    return { ...buildWeekView(ctx, w), copied: added }
  })

  r.get('/timesheet/work-items', ({ ctx, query }) => {
    const wk = String(query.week ?? weekStart(ctx.today))
    assertMonday(wk)
    return workItems(ctx, ctx.user.id, wk)
  })

  /* ---------- approvals ---------- */
  r.get('/approvals', ({ ctx }) => {
    sweepLocks(ctx)
    const all = rows(ctx, 'timesheet_weeks')
    const pending: ApprovalItem[] = []
    const unlocks: ApprovalItem[] = []
    for (const w of all) {
      if (w.status !== 'submitted' && !(w.status === 'locked' && w.unlock_requested_at)) continue
      const d = canDecide(ctx, w)
      if (!d.ok) continue
      if (w.status === 'submitted') pending.push(approvalItem(ctx, w, d.viaDelegation))
      else unlocks.push(approvalItem(ctx, w, d.viaDelegation))
    }
    pending.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    unlocks.sort((a, b) => (a.unlock_requested_at ?? '').localeCompare(b.unlock_requested_at ?? ''))
    const since = addDays(ctx.today, -14)
    const recent = all
      .filter((w) => w.decided_by === ctx.user.id && w.user_id !== ctx.user.id && w.decided_at && w.decided_at.slice(0, 10) >= since)
      .sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''))
      .slice(0, 20)
      .map((w) => ({ ...approvalItem(ctx, w, false), decided_at: w.decided_at, late: w.late }))
    const out: ApprovalsView = {
      pending,
      unlock_requests: unlocks,
      recent,
      bulk_enabled: S(ctx)['approval.bulk_approve'],
      unlock_max_days: S(ctx)['timesheet.unlock_max_days'],
      sla_days: S(ctx)['approval.sla_working_days'],
      kpi: approvalKpi(ctx, ctx.user.id, 30),
      can_unlock_any: timesheetOverride(ctx) || directReports(ctx, ctx.user.id).length > 0,
    }
    return out
  })

  r.get('/approvals/summary', ({ ctx }) => {
    if (ctx.isSuper) return { pending: 0, overdue: 0 }
    let pending = 0
    let overdue = 0
    for (const w of rows(ctx, 'timesheet_weeks')) {
      if (w.status !== 'submitted' && !(w.status === 'locked' && w.unlock_requested_at)) continue
      if (!canDecide(ctx, w).ok) continue
      pending++
      if (w.status === 'submitted' && w.submitted_at && ctx.today > slaDue(ctx, w.submitted_at)) overdue++
    }
    return { pending, overdue }
  })

  r.post('/approvals/:weekId/approve', ({ ctx, params, ifMatch }) => {
    const w = decidable(ctx, params.weekId)
    const late = doApprove(ctx, w, ifMatch)
    if (late) warn(ctx, 'APPROVAL_LATE', `Approved after the ${S(ctx)['approval.sla_working_days']}-working-day deadline. It’s recorded as a late approval.`)
    return { id: w.id, late, user_name: userName(ctx, w.user_id) }
  })

  r.post('/approvals/:weekId/reject', ({ ctx, params, body, ifMatch }) => {
    const w = decidable(ctx, params.weekId)
    if (w.status !== 'submitted') err(409, 'TS_NOT_EDITABLE', 'Only submitted weeks can be sent back.')
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 5) err(422, 'TS_REASON_REQUIRED', 'Give a reason of at least 5 characters so they know what to fix.', 'reason')
    const late = !!w.submitted_at && ctx.today > slaDue(ctx, w.submitted_at)
    update(ctx, 'timesheet_weeks', w.id, { status: 'rejected', decided_by: ctx.user.id, decided_at: nowISO(), late, reject_reason: reason, ...wfClear() } as never, ifMatch)
    notify(ctx, w.user_id, 'NTF-06', 'Timesheet sent back', `${ctx.user.name} sent back ${weekLabel(w.week_start)}: “${reason}”`, `/timesheet/${w.week_start}`)
    logActivity(ctx, 'timesheet_week', w.id, 'rejected', `Sent back ${userName(ctx, w.user_id)}’s ${weekLabel(w.week_start)}`)
    return { id: w.id, late, user_name: userName(ctx, w.user_id) }
  })

  r.post('/approvals/bulk-approve', ({ ctx, body }) => {
    if (!S(ctx)['approval.bulk_approve']) err(403, 'TS_BULK_OFF', 'Bulk approval is switched off for this workspace. Approve weeks one at a time.')
    const ids: string[] = Array.isArray(body.ids) ? body.ids : []
    if (!ids.length) err(422, 'VALIDATION', 'Select at least one week.')
    const approved: string[] = []
    const skipped: { id: string; reason: string }[] = []
    let lateCount = 0
    for (const id of ids) {
      const w = rows(ctx, 'timesheet_weeks').find((x) => x.id === id)
      if (!w) {
        skipped.push({ id, reason: 'Not found' })
        continue
      }
      if (w.user_id === ctx.user.id || !canDecide(ctx, w).ok) {
        skipped.push({ id, reason: 'Not yours to approve' })
        continue
      }
      if (w.status !== 'submitted') {
        skipped.push({ id, reason: 'No longer waiting' })
        continue
      }
      const below = dayTotals(ctx, w).filter((d) => d.min_required > 0 && d.counted < d.min_required).length
      if (below) {
        skipped.push({ id, reason: `${userName(ctx, w.user_id)}: ${below} short day${below > 1 ? 's' : ''} — review it individually` })
        continue
      }
      if (doApprove(ctx, w)) lateCount++
      approved.push(id)
    }
    if (skipped.length) warn(ctx, 'BULK_SKIPPED', `${skipped.length} week${skipped.length > 1 ? 's were' : ' was'} skipped. ${skipped.map((s) => s.reason).join('; ')}.`)
    if (lateCount) warn(ctx, 'APPROVAL_LATE', `${lateCount} approval${lateCount > 1 ? 's were' : ' was'} past the deadline and recorded as late.`)
    return { approved, skipped }
  })

  /** Unlock a locked week for N days. Works on the person's request or on the manager's own initiative
   *  (then a reason is required — it goes to the person and the audit log). */
  const unlockWeek = (ctx: Ctx, w: E.TimesheetWeek, body: Record<string, unknown>) => {
    if (w.status !== 'locked') err(409, 'TS_NOT_EDITABLE', 'Only locked weeks can be unlocked.')
    const max = S(ctx)['timesheet.unlock_max_days']
    const days = Number(body.days)
    if (!Number.isInteger(days) || days < 1 || days > max) err(422, 'TS_UNLOCK_RANGE', `Unlock for 1 to ${max} days.`, 'days')
    const reason = String(body.reason ?? '').trim()
    if (!w.unlock_requested_at && reason.length < 5) err(422, 'TS_REASON_REQUIRED', 'Say why you are reopening this week (at least 5 characters). They’ll see it.', 'reason')
    const until = addDays(ctx.today, days - 1)
    const why = reason || w.unlock_reason || ''
    update(ctx, 'timesheet_weeks', w.id, { status: 'open', unlock_until: until, unlock_requested_at: null, unlock_reason: null })
    notify(ctx, w.user_id, 'NTF-08', 'Timesheet unlocked', `${ctx.user.name} unlocked ${weekLabel(w.week_start)} until ${fmtDate(until)}${reason ? `: “${reason.slice(0, 80)}”` : ''}. Fill it in and submit before then.`, `/timesheet/${w.week_start}`)
    logActivity(ctx, 'timesheet_week', w.id, 'unlocked', `Unlocked ${userName(ctx, w.user_id)}’s ${weekLabel(w.week_start)} until ${until}${why ? ` — ${why}` : ''}`)
    return { id: w.id, unlock_until: until, user_name: userName(ctx, w.user_id) }
  }
  r.post('/approvals/:weekId/unlock', ({ ctx, params, body }) => unlockWeek(ctx, decidable(ctx, params.weekId), body))
  // A week that ended without a timesheet at all: create it (it locks immediately) and unlock it.
  r.post('/approvals/unlock-week', ({ ctx, body }) => {
    const userId = String(body.user_id ?? '')
    const week = String(body.week_start ?? '')
    assertMonday(week)
    const person = find(ctx, 'users', userId, 'Person')
    if (person.id === ctx.user.id) err(403, 'TS_SELF_APPROVAL', 'You can’t approve or unlock your own timesheet. Your manager does that.')
    if (addDays(week, 6) >= ctx.today) err(409, 'TS_NOT_EDITABLE', 'This week hasn’t ended, so it isn’t locked.')
    const w = ensureWeek(ctx, person.id, week)
    return unlockWeek(ctx, decidable(ctx, w.id), body)
  })

  /* ---------- my team's timesheets (inside Approvals, Feature Guide §9) ---------- */
  r.get('/approvals/team', ({ ctx, query }) => {
    sweepLocks(ctx)
    const n = Math.min(8, Math.max(4, Number(query.weeks ?? 4)))
    const thisMon = weekStart(ctx.today)
    const weeks = Array.from({ length: n }, (_, i) => addDays(thisMon, -7 * (n - 1 - i)))
    const override = timesheetOverride(ctx)
    const del = delegatorsOf(ctx, ctx.user.id)
    const people = rows(ctx, 'users')
      .filter((u) => u.status === 'active' && u.id !== ctx.user.id && !u.is_super_admin)
      .map((u) => ({ u, ap: resolveApprover(ctx, u) }))
      .filter(({ u, ap }) => ap === ctx.user.id || (!!ap && del.has(ap)) || (override && (u.reports_to_id !== null || ap !== null)))
    const weekRows = rows(ctx, 'timesheet_weeks')
    const hours = new Map<string, number>()
    for (const e of rows(ctx, 'timesheet_entries')) hours.set(e.week_id, (hours.get(e.week_id) ?? 0) + e.hours)
    const lockOn = S(ctx)['timesheet.weekly_lock']
    const mine = (ap: string | null) => ap === ctx.user.id
    const out = people
      .sort((a, b) => Number(!mine(a.ap)) - Number(!mine(b.ap)) || a.u.name.localeCompare(b.u.name))
      .map(({ u, ap }) => ({
        user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue },
        approver_name: ap ? userName(ctx, ap) : null,
        via_delegation: !!ap && ap !== ctx.user.id && del.has(ap),
        cells: weeks.map((wk) => {
          const w = weekRows.find((x) => x.user_id === u.id && x.week_start === wk)
          const ended = addDays(wk, 6) < ctx.today
          const status: E.WeekStatus | 'upcoming' = w ? w.status : ended ? (lockOn ? 'locked' : 'open') : wk > ctx.today ? 'upcoming' : 'open'
          return {
            week_start: wk, status, week_id: w?.id ?? null, hours: r2(w ? hours.get(w.id) ?? 0 : 0),
            unlock_requested: !!w?.unlock_requested_at, unlock_reason: w?.unlock_reason ?? null,
            unlocked_until: w && w.status === 'open' && w.unlock_until && w.unlock_until >= ctx.today ? w.unlock_until : null,
            can_unlock: status === 'locked' && !ctx.viewAs,
          }
        }),
      }))
    return { weeks, people: out, unlock_max_days: S(ctx)['timesheet.unlock_max_days'] }
  })

  r.post('/approvals/:weekId/deny-unlock', ({ ctx, params, body }) => {
    const w = decidable(ctx, params.weekId)
    if (w.status !== 'locked' || !w.unlock_requested_at) err(409, 'TS_NOT_EDITABLE', 'There is no open unlock request on this week.')
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 5) err(422, 'TS_REASON_REQUIRED', 'Give a reason of at least 5 characters.', 'reason')
    update(ctx, 'timesheet_weeks', w.id, { unlock_requested_at: null, unlock_reason: null })
    notify(ctx, w.user_id, 'NTF-08', 'Unlock request declined', `${ctx.user.name} declined unlocking ${weekLabel(w.week_start)}: “${reason}”`, `/timesheet/${w.week_start}`)
    logActivity(ctx, 'timesheet_week', w.id, 'unlock_denied', `Declined unlock for ${userName(ctx, w.user_id)}’s ${weekLabel(w.week_start)}`)
    return { id: w.id, user_name: userName(ctx, w.user_id) }
  })

  /* ---------- team grid (UI-37) ---------- */
  r.get('/team/grid', ({ ctx, query }) => {
    if (!has(ctx, 'team.view')) err(403, 'FORBIDDEN', 'The team view is for admins and project managers.')
    sweepLocks(ctx)
    const n = Math.min(12, Math.max(4, Number(query.weeks ?? 8)))
    const thisMon = weekStart(ctx.today)
    const weeks = Array.from({ length: n }, (_, i) => addDays(thisMon, -7 * (n - 1 - i)))
    const users = rows(ctx, 'users').filter((u) => u.status === 'active')
    const scope = has(ctx, 'people.view_all') ? users : users.filter((u) => u.id === ctx.user.id || u.reports_to_id === ctx.user.id || rows(ctx, 'projects').some((p) => p.pm_id === ctx.user.id && rows(ctx, 'tasks').some((t) => t.project_id === p.id && t.owner_id === u.id)))
    const weekRows = rows(ctx, 'timesheet_weeks')
    const entries = rows(ctx, 'timesheet_entries')
    const hoursByWeek = new Map<string, number>()
    const taskHoursByWeek = new Map<string, number>()
    for (const e of entries) {
      hoursByWeek.set(e.week_id, (hoursByWeek.get(e.week_id) ?? 0) + e.hours)
      if (e.kind === 'task') taskHoursByWeek.set(e.week_id, (taskHoursByWeek.get(e.week_id) ?? 0) + e.hours)
    }
    const minH = S(ctx)['calendar.min_hours_per_day']
    const c = cal(ctx)
    const workedDays = weekDays(thisMon).filter((d) => d <= ctx.today && isWorkingDay(d, c)).length
    const people: TeamGrid['people'] = scope
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => {
        const cells = weeks.map((wk) => {
          const w = weekRows.find((x) => x.user_id === u.id && x.week_start === wk)
          const ended = addDays(wk, 6) < ctx.today
          const status: TeamGrid['people'][number]['cells'][number]['status'] = w ? w.status : ended ? 'missing' : 'upcoming'
          return { week_start: wk, status, hours: r2(w ? hoursByWeek.get(w.id) ?? 0 : 0), week_id: w?.id ?? null, late: !!w?.late }
        })
        const cur = weekRows.find((x) => x.user_id === u.id && x.week_start === thisMon)
        const leaveDaysThisWeek = leaveOf(ctx, u.id).filter((l) => l.date >= thisMon && l.date <= ctx.today && isWorkingDay(l.date, c)).reduce((s, l) => s + (l.portion === 'full' ? 1 : 0.5), 0)
        const capacity = Math.max(0, workedDays - leaveDaysThisWeek) * minH
        const taskH = cur ? taskHoursByWeek.get(cur.id) ?? 0 : 0
        return {
          user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue, role: u.role, reports_to_id: u.reports_to_id },
          cells,
          utilisation: capacity > 0 ? r2(taskH / capacity) : null,
          hours_this_week: r2(cur ? hoursByWeek.get(cur.id) ?? 0 : 0),
        }
      })
    // Approval KPI per approver (BR-11) over the grid's window; credited to whoever decided (delegates included).
    const managers: TeamGrid['managers'] = []
    for (const k of approvalKpis(ctx, diffDays(ctx.today, weeks[0])).values()) {
      if (!has(ctx, 'people.view_all') && k.user_id !== ctx.user.id && !scope.some((s) => s.id === k.user_id)) continue
      const ap = users.find((u) => u.id === k.user_id)
      if (!ap) continue
      managers.push({ user: { id: ap.id, name: ap.name, avatar_hue: ap.avatar_hue }, decided: k.decided, on_time: k.on_time, late: k.late, overdue: k.overdue_now, pending: k.overdue_now + k.waiting_within, score: -k.lapses })
    }
    const mgr = managers.sort((a, b) => b.score - a.score || b.decided - a.decided)
    return { weeks, people, managers: mgr } satisfies TeamGrid
  })

  /* ---------- daily updates (UI-40) ---------- */
  r.get('/daily', ({ ctx, query }) => {
    const date = String(query.date ?? ctx.today)
    const every = rows(ctx, 'daily_updates')
    // a demo-only row (no end-of-day text yet) isn't an update
    const all = every.filter((d) => d.done)
    const mine = all.find((d) => d.user_id === ctx.user.id && d.date === date) ?? null
    const recent = all.filter((d) => d.user_id === ctx.user.id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
    let team: DailyView['team'] = null
    const reports = directReports(ctx, ctx.user.id)
    const wide = has(ctx, 'people.view_all')
    if (wide || has(ctx, 'team.view') || reports.length) {
      const people = wide ? rows(ctx, 'users').filter((u) => u.status === 'active' && u.id !== ctx.user.id) : reports
      const leaveOn = new Set(rows(ctx, 'leave').filter((l) => l.date === date && l.portion === 'full').map((l) => l.user_id))
      team = people
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => ({ user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue }, update: all.find((d) => d.user_id === u.id && d.date === date) ?? null, on_leave: leaveOn.has(u.id) }))
    }
    const demoDate = demoDateOf(ctx, weekStart(date), ctx.user.id)
    const demoRow = every.find((d) => d.user_id === ctx.user.id && d.date === demoDate) ?? null
    const demo = { date: demoDate, week_start: weekStart(date), shown: !!demoRow?.demo_shown, note: demoRow?.demo_note ?? '', editable: !ctx.viewAs && weekStart(date) === weekStart(ctx.today) && demoDate <= ctx.today }
    return { date, mine, recent, proof_required: S(ctx)['daily.proof_required'], team, demo } satisfies DailyView
  })

  /* Friday demo (Feature Guide §8): one per week, stored on the week's demo day (Friday, or the working day before it). */
  r.post('/daily/demo', ({ ctx, body }) => {
    const anchor = String(body.date ?? ctx.today)
    if (weekStart(anchor) !== weekStart(ctx.today)) err(422, 'VALIDATION', 'The demo can be recorded for this week only.', 'date')
    const date = demoDateOf(ctx, weekStart(anchor), ctx.user.id)
    if (date > ctx.today) err(422, 'VALIDATION', `Record the demo on ${fmtDate(date, 'long')}, the week’s demo day.`, 'date')
    const shown = !!body.demo_shown
    const note = String(body.demo_note ?? '').trim().slice(0, 300)
    if (shown && note.length < 5) err(422, 'VALIDATION', 'Say what was demoed (at least a few words).', 'demo_note')
    const cur = rows(ctx, 'daily_updates').find((d) => d.user_id === ctx.user.id && d.date === date)
    const patch = { demo_shown: shown, demo_note: shown ? note : '' }
    const saved = cur ? update(ctx, 'daily_updates', cur.id, patch) : insert(ctx, 'daily_updates', { user_id: ctx.user.id, date, done: '', proof_url: '', blocker: '', ...patch } as never)
    logActivity(ctx, 'daily_update', saved.id, 'demo', shown ? `${ctx.user.name} showed working software: ${note}` : `${ctx.user.name} recorded no demo for the week of ${fmtDate(weekStart(date))}`)
    return saved
  })

  r.post('/daily', ({ ctx, body }) => {
    const date = String(body.date ?? ctx.today)
    if (date > ctx.today) err(422, 'VALIDATION', 'You can’t post an update for a future day.', 'date')
    if (date < weekStart(ctx.today)) err(422, 'VALIDATION', 'Updates can be posted or edited for this week only.', 'date')
    const done = String(body.done ?? '').trim()
    if (done.length < 5) err(422, 'VALIDATION', 'Write what you finished today (at least a sentence).', 'done')
    const proof = String(body.proof_url ?? '').trim()
    if (S(ctx)['daily.proof_required'] && !proof) err(422, 'DU_PROOF_REQUIRED', 'Add a proof link — a commit, screenshot or demo URL. No proof, no progress.', 'proof_url')
    if (proof && !/^https?:\/\/\S+\.\S+/.test(proof)) err(422, 'VALIDATION', 'Links must start with http:// or https://', 'proof_url')
    const cur = rows(ctx, 'daily_updates').find((d) => d.user_id === ctx.user.id && d.date === date)
    const patch = { done, proof_url: proof, blocker: String(body.blocker ?? '').trim(), demo_shown: body.demo_shown === undefined ? cur?.demo_shown ?? false : !!body.demo_shown }
    const saved = cur ? update(ctx, 'daily_updates', cur.id, patch) : insert(ctx, 'daily_updates', { user_id: ctx.user.id, date, ...patch } as never)
    if (patch.blocker && !cur?.blocker) {
      const ap = resolveApprover(ctx, ctx.user)
      if (ap) logActivity(ctx, 'daily_update', saved.id, 'blocker', `${ctx.user.name} flagged a blocker: ${patch.blocker}`)
    }
    return saved
  })

  /* ---------- leave ---------- */
  r.get('/leave', ({ ctx, query }) => {
    const hr = has(ctx, 'leave.hr_entry')
    const reports = directReports(ctx, ctx.user.id)
    let scope: LeaveView['scope'] = (query.scope as LeaveView['scope']) || 'mine'
    const seeAll = hr || has(ctx, 'people.view_all')
    if (scope === 'all' && !seeAll) scope = reports.length ? 'team' : 'mine'
    if (scope === 'team' && !reports.length && !hr) scope = 'mine'
    const from = String(query.from ?? addDays(ctx.today, -120))
    const to = String(query.to ?? addDays(ctx.today, 180))
    const ids = scope === 'mine' ? new Set([ctx.user.id]) : scope === 'team' ? new Set([ctx.user.id, ...reports.map((u) => u.id)]) : null
    const weeks = rows(ctx, 'timesheet_weeks')
    const items: LeaveRow[] = rows(ctx, 'leave')
      .filter((l) => (!ids || ids.has(l.user_id)) && l.date >= from && l.date <= to && (!query.user || l.user_id === query.user))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((l) => {
        const w = weeks.find((x) => x.user_id === l.user_id && x.week_start === weekStart(l.date))
        const st = w ? applyLock(ctx, w).status : null
        const own = l.user_id === ctx.user.id
        const canDel = st !== 'approved' && (hr || (own && (!st || st === 'open' || st === 'rejected')))
        return { id: l.id, user_id: l.user_id, user_name: userName(ctx, l.user_id), date: l.date, type: l.type, portion: l.portion, source: l.source, week_status: st, can_delete: canDel && !ctx.viewAs }
      })
    const holidays = rows(ctx, 'holidays').filter((h) => h.date >= from && h.date <= to).map((h) => ({ date: h.date, name: h.name, optional: h.optional }))
    return { items, holidays, can_hr_entry: hr, can_see_all: seeAll, scope } satisfies LeaveView
  })

  r.post('/leave', ({ ctx, body }) => {
    const hr = has(ctx, 'leave.hr_entry')
    const userId = String(body.user_id || ctx.user.id)
    const forOther = userId !== ctx.user.id
    if (forOther && !hr) err(403, 'FORBIDDEN', 'Only admins and operations can enter leave for someone else.')
    const person = find(ctx, 'users', userId, 'Person')
    if (person.status !== 'active') err(422, 'VALIDATION', `${person.name} is not an active user.`)
    const type = body.type as E.LeaveType
    if (!LEAVE_TYPES.includes(type)) err(422, 'VALIDATION', 'Choose a leave type.', 'type')
    const portion: 'full' | 'half' = body.portion === 'half' ? 'half' : 'full'
    const from = String(body.from ?? '')
    const to = String(body.to || from)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) err(422, 'VALIDATION', 'Pick the leave dates.', 'from')
    if (to < from) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'to')
    if (diffDays(to, from) > 60) err(422, 'DATE_RANGE', 'Enter at most 60 days at a time.', 'to')
    if (portion === 'half' && to !== from) err(422, 'LEAVE_INVALID', 'A half day covers one date. Pick a single day.', 'to')
    const c = cal(ctx)
    const existing = new Set(leaveOf(ctx, userId).map((l) => l.date))
    const dates: string[] = []
    let offs = 0
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!isWorkingDay(d, { ...c, leaveDates: undefined })) {
        offs++
        continue
      }
      if (existing.has(d)) err(422, 'LEAVE_INVALID', `${person.name} already has leave on ${fmtDate(d, 'long')}.`, 'from')
      if (type === 'optional_holiday' && !optionalHolidayOn(ctx, d)) err(422, 'LEAVE_INVALID', `${fmtDate(d, 'long')} isn’t an optional holiday. Pick a date from the optional holiday list, or another leave type.`, 'from')
      const w = findWeek(ctx, userId, weekStart(d))
      if (w && w.status === 'approved') err(409, 'TS_NOT_EDITABLE', `The week of ${fmtDate(weekStart(d))} is already approved. Ask the approver to send it back first.`, 'from')
      if (!forOther && w && !isEditable(w)) err(409, w.status === 'locked' ? 'TS_LOCKED' : 'TS_NOT_EDITABLE', `The week of ${fmtDate(weekStart(d))} is ${w.status}. ${w.status === 'locked' ? 'Ask your manager to unlock it first.' : 'Leave can’t be added to it now.'}`, 'from')
      dates.push(d)
    }
    if (!dates.length) err(422, 'LEAVE_INVALID', from === to ? `${fmtDate(from, 'long')} is not a working day, so it can’t be a leave day.` : 'Every day in that range is a weekly off or holiday.', 'from')
    for (const d of dates) {
      const l = insert(ctx, 'leave', { user_id: userId, date: d, type, portion, source: forOther ? 'hr' : 'timesheet', approved_by: forOther ? ctx.user.id : null } as never) as E.Leave
      leaveEntryFor(ctx, l)
    }
    if (offs) warn(ctx, 'LEAVE_SKIPPED_OFFS', `${offs} weekly off or holiday day${offs > 1 ? 's were' : ' was'} skipped.`)
    if (type === 'optional_holiday') {
      const pol = rows(ctx, 'leave_policies').find((p) => p.type === 'optional_holiday')
      if (pol) {
        const fm = S(ctx)['company.fy_start_month']
        const fy = fyRange(fyStartYear(dates[0], fm), fm)
        const used = leaveOf(ctx, userId).filter((l) => l.type === 'optional_holiday' && l.date >= fy.from && l.date <= fy.to).length
        if (used + dates.length > pol.annual_days) err(422, 'LEAVE_BALANCE', `${person.name} can take ${pol.annual_days} optional holiday${pol.annual_days === 1 ? '' : 's'} a year and has used ${used}.`, 'type')
      }
    }
    logActivity(ctx, 'leave', userId, 'created', `${forOther ? 'HR entered' : 'Entered'} ${dates.length} day${dates.length > 1 ? 's' : ''} of ${leaveLabel(type)} for ${person.name}`)
    return { created: dates.length }
  })

  /* Leave taken this financial year by person × type (Feature Guide §16). Days from timesheet = leave hours ÷ minimum hours. */
  r.get('/leave/summary', ({ ctx, query }) => {
    const hr = has(ctx, 'leave.hr_entry')
    const reports = directReports(ctx, ctx.user.id)
    const seeAll = hr || has(ctx, 'people.view_all')
    if (!seeAll && !reports.length) err(403, 'FORBIDDEN', 'The leave summary is for HR and managers.')
    const fm = S(ctx)['company.fy_start_month']
    const fyStart = query.fy ? Number(query.fy) : fyStartYear(ctx.today, fm)
    const { from, to } = fyRange(fyStart, fm)
    const minH = S(ctx)['calendar.min_hours_per_day']
    const people = (seeAll ? rows(ctx, 'users').filter((u) => u.status !== 'invited' && !u.is_super_admin) : [ctx.user, ...reports]).sort((a, b) => a.name.localeCompare(b.name))
    const leave = rows(ctx, 'leave').filter((l) => l.date >= from && l.date <= to)
    const entries = rows(ctx, 'timesheet_entries').filter((e) => e.kind === 'leave' && e.work_date >= from && e.work_date <= to)
    const types: E.LeaveType[] = ['casual', 'sick', 'earned', 'compensatory', 'lwp', 'optional_holiday']
    const out = people
      .map((u) => {
        const mine = leave.filter((l) => l.user_id === u.id)
        const by_type = Object.fromEntries(types.map((t) => [t, mine.filter((l) => l.type === t && l.portion === 'full').length])) as Record<E.LeaveType, number>
        const half_days = mine.filter((l) => l.portion === 'half').length * 0.5
        const timesheet_days = r2(entries.filter((e) => e.user_id === u.id).reduce((s2, e) => s2 + e.hours, 0) / minH)
        const total = r2(mine.reduce((s2, l) => s2 + (l.portion === 'half' ? 0.5 : 1), 0))
        return { user: { id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue }, by_type, half_days, timesheet_days, total }
      })
      .filter((r) => r.total > 0 || r.timesheet_days > 0)
    return { fy_label: fyLabel(fyStart), from, to, min_hours: minH, types, rows: out }
  })

  r.del('/leave/:id', ({ ctx, params }) => {
    const l = find(ctx, 'leave', params.id, 'Leave')
    const hr = has(ctx, 'leave.hr_entry')
    const own = l.user_id === ctx.user.id
    if (!own && !hr) err(403, 'FORBIDDEN', 'Only admins and operations can remove someone else’s leave.')
    const w = findWeek(ctx, l.user_id, weekStart(l.date))
    if (w?.status === 'approved') err(409, 'TS_NOT_EDITABLE', 'That week is approved, so its leave can’t change.')
    if (!hr && w && !isEditable(w)) err(409, w.status === 'locked' ? 'TS_LOCKED' : 'TS_NOT_EDITABLE', `That week is ${w.status}; its leave can’t change now.`)
    if (!hr && l.source === 'hr') err(403, 'FORBIDDEN', 'This leave was entered by HR. Ask them to change it.')
    removeLeaveEntry(ctx, l)
    remove(ctx, 'leave', l.id)
    logActivity(ctx, 'leave', l.user_id, 'deleted', `Removed leave on ${l.date} for ${userName(ctx, l.user_id)}`)
    return { ok: true }
  })

  r.get('/holidays-lite', ({ ctx, query }) => {
    const from = String(query.from ?? `${ctx.today.slice(0, 4)}-01-01`)
    const to = String(query.to ?? `${ctx.today.slice(0, 4)}-12-31`)
    return rows(ctx, 'holidays')
      .filter((h) => h.date >= from && h.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((h) => ({ date: h.date, name: h.name, optional: h.optional }))
  })
}
