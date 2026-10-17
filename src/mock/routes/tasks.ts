// Module C — task detail (drawer), comments with @mentions and "My tasks".
// Module B owns task writes (PATCH / status / dependencies / delete) in routes/projects.ts.
import type * as E from '@/types/entities'
import type { MyTask, TaskDetail, TaskRef } from '@/api/tasks'
import { err, find, getDb, has, insert, logActivity, notify, rows, update, type Ctx, type Router } from '../server'
import { canEdit, canView, myProjectIds } from './projects'
import { ensureSwept, estimateHint, openBlockers, scheduleOf, stageSince, taskActuals } from '../analytics'
import { addDays, addWorkingDays, fmtDate, isWorkingDay, weekStart } from '@/domain/calendar'
import { STAGE, TASK_STAGES, TASK_TAG, progressOf, stageOf } from '@/domain/delivery'
import { COMPLEXITY } from '@/domain/labels'
import type { AllTaskRow, AllTasksResponse, MentionRow, MyTaskV5, RiskRow, RiskTaskLink } from '@/api/work'
import { userName as userNameOf } from '../server'
import type { TaskReviewInfo } from '@/api/tasks'
import { canManageGeneral, canMoveTask, canReviewTask, canSubmit, createRights, createTaskCore, ensureGeneralProject, generalProjectId, isGeneral, lateBy, reschedulesOf, reviewerOf, reviewsOf, selfReview, validAttachment } from './taskflow'
import { nextTaskNo } from './projects'
import { teamOf } from '../performance'
import type { TaskCreateOptions } from '@/api/work'

/* ------------------------------------------------------------------ */
/* Shared helpers (also used by timesheets.ts)                         */
/* ------------------------------------------------------------------ */
export function milestoneMap(ctx: Ctx) {
  return new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
}
/** A task's WBS number is permanent (Feature Guide §4: "Numbers never change and are never reused"). It is stored on
 *  the task as `wbs_code` when the task is created (or, for older rows, frozen the first time its milestone changes) and
 *  is kept when the task moves or its milestone is deleted. Older rows without it fall back to milestone no + task no. */
export type WbsTask = E.Task & { wbs_code?: string | null }
export function wbsOf(t: E.Task, ms: Map<string, E.Milestone>): string {
  const frozen = (t as WbsTask).wbs_code
  if (frozen) return frozen
  const m = t.milestone_id ? ms.get(t.milestone_id) : null
  return `${m && !m.deleted_at ? m.no : 0}.${t.no}`
}
/** Store the task's current number permanently (call before its milestone changes). */
export function freezeWbs(t: E.Task, ms: Map<string, E.Milestone>): string {
  const w = t as WbsTask
  if (!w.wbs_code) w.wbs_code = wbsOf(t, ms)
  return w.wbs_code
}
export function toRef(t: E.Task, ms: Map<string, E.Milestone>): TaskRef {
  return { id: t.id, wbs: wbsOf(t, ms), title: t.title, status: t.status, owner_id: t.owner_id, due_on: t.due_on, project_id: t.project_id }
}

/** Is the person on leave on a date? Only a FULL-day leave counts (Feature Guide §8: a half day stays a working day). */
export function onLeave(ctx: Ctx, userId: string | null, date: string) {
  if (!userId) return false
  return rows(ctx, 'leave').some((l) => l.user_id === userId && l.date === date && l.portion !== 'half')
}

/**
 * Tasks a person covers in a date range (G7.02): they are the backup and the owner is on leave on any of those days,
 * or the owner delegated their task follow-ups to them (Delegation.include_tasks, scoped by project_id).
 * Returns task id → the covered days. Timesheets use the same rule to let the backup log time on those days.
 */
export function coveringFor(ctx: Ctx, userId: string, from: string, to: string): Map<string, { days: string[]; reason: 'leave' | 'delegation'; from_user_id: string }> {
  const out = new Map<string, { days: string[]; reason: 'leave' | 'delegation'; from_user_id: string }>()
  // only full-day leave hands a task to the backup; a half day stays a working day for the owner
  const leave = rows(ctx, 'leave').filter((l) => l.date >= from && l.date <= to && l.portion !== 'half')
  const dels = rows(ctx, 'delegations').filter((d) => d.to_user_id === userId && d.include_tasks !== false && d.from_on <= to && d.to_on >= from)
  for (const t of rows(ctx, 'tasks')) {
    if (t.status === 'done' || !t.owner_id || t.owner_id === userId) continue
    if (t.backup_id === userId) {
      const days = leave.filter((l) => l.user_id === t.owner_id).map((l) => l.date).sort()
      if (days.length) {
        out.set(t.id, { days: [...new Set(days)], reason: 'leave', from_user_id: t.owner_id })
        continue
      }
    }
    const d = dels.find((x) => x.from_user_id === t.owner_id && (!x.project_id || x.project_id === t.project_id))
    if (d) {
      const days: string[] = []
      for (let x = d.from_on < from ? from : d.from_on; x <= (d.to_on > to ? to : d.to_on); x = addDays(x, 1)) days.push(x)
      out.set(t.id, { days, reason: 'delegation', from_user_id: t.owner_id })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* v7 task visibility (CEO point 5)                                    */
/* ------------------------------------------------------------------ */
/** Why a person can see a task without `tasks.view_all`. The first matching reason is the label shown on the row. */
export type TaskRelation = 'owner' | 'covering' | 'backup' | 'reviewer' | 'concerned_manager' | 'project_manager' | 'assigned_by' | 'watcher' | 'tagged'
export const TASK_RELATION_LABEL: Record<TaskRelation, string> = {
  owner: 'Mine', covering: 'Covering', backup: 'Backup', reviewer: 'Reviewer', concerned_manager: 'Concerned manager',
  project_manager: 'Project manager', assigned_by: 'Assigned by me', watcher: 'Watching', tagged: 'Tagged me',
}
/** Effective concerned manager: the task's own setting, else the owner's reporting manager. */
export function concernedManagerOf(ctx: Ctx, t: E.Task): string | null {
  if (t.concerned_manager_id) return t.concerned_manager_id
  if (!t.owner_id) return null
  return rows(ctx, 'users').find((u) => u.id === t.owner_id)?.reports_to_id ?? null
}
/** Cached per request: covering map for this week and the tasks I'm @mentioned on. */
type RelCache = { cov: Map<string, unknown>; tagged: Set<string>; delegated: Set<string> }
const relCache = new WeakMap<Ctx, RelCache>()
function relCacheOf(ctx: Ctx): RelCache {
  let c = relCache.get(ctx)
  if (!c) {
    const wk = weekStart(ctx.today)
    const me = ctx.user.id
    const tagged = new Set<string>()
    for (const x of rows(ctx, 'comments')) if ((x.mentions ?? []).includes(me) && x.author_id !== me) tagged.add(x.task_id)
    // G16.05: a delegation with task follow-ups hands the owner's tasks to the delegate for its whole range (any week the
    // header shows, not only this one) — recent, current and upcoming delegations keep those tasks openable
    const delegated = new Set<string>(coveringFor(ctx, me, addDays(wk, -28), addDays(wk, 90)).keys())
    c = { cov: coveringFor(ctx, me, wk, addDays(wk, 6)), tagged, delegated }
    relCache.set(ctx, c)
  }
  return c
}
/** The viewer's relation to a task (null = unrelated). Owner, covering (backup on the owner's leave or a delegation),
 *  backup, reviewer, concerned manager, the project's PM, the person who assigned it, watcher, or @mentioned in its thread. */
export function relationOf(ctx: Ctx, t: E.Task): TaskRelation | null {
  const me = ctx.user.id
  if (t.owner_id === me) return 'owner'
  const c = relCacheOf(ctx)
  if (c.cov.has(t.id)) return 'covering'
  if (t.backup_id === me) return 'backup'
  if (reviewerOf(ctx, t) === me || t.reviewer_id === me) return 'reviewer'
  if (concernedManagerOf(ctx, t) === me) return 'concerned_manager'
  const p = rows(ctx, 'projects').find((x) => x.id === t.project_id)
  if (p && p.pm_id === me && !isGeneral(ctx, t)) return 'project_manager'
  if (t.assigned_by === me) return 'assigned_by'
  if ((t.watcher_ids ?? []).includes(me)) return 'watcher'
  if (c.tagged.has(t.id)) return 'tagged'
  if (c.delegated.has(t.id)) return 'covering'
  return null
}
/** v7 rule: `tasks.view_all` (managers, HR, admins, CXOs) sees every task; everyone else only tasks they are related to. */
export function canSeeTask(ctx: Ctx, t: E.Task): boolean {
  return has(ctx, 'tasks.view_all') || relationOf(ctx, t) !== null
}

export interface TaskAccess {
  visible: boolean
  can_edit: boolean
  can_change_status: boolean
  can_comment: boolean
}
export function taskAccess(ctx: Ctx, t: E.Task): TaskAccess {
  const p = rows(ctx, 'projects').find((x) => x.id === t.project_id)
  const me = ctx.user.id
  const can_edit = (!!p && canEdit(ctx, p)) || canManageGeneral(ctx, t)
  const mine = t.owner_id === me || t.backup_id === me
  const reviewer = reviewerOf(ctx, t) === me
  // v7: visibility is the task rule (tasks.view_all, else owner / covering / backup / reviewer / concerned manager …).
  const visible = can_edit || canSeeTask(ctx, t)
  const onProject = () => !!p && (myProjectIds(ctx).has(p.id) || canView(ctx, p))
  return {
    visible,
    can_edit,
    can_change_status: can_edit || mine || canReviewTask(ctx, t),
    // Commenting is for people involved: editors, owner/backup, reviewer, concerned manager, watchers, or anyone on the project.
    can_comment: visible && (can_edit || mine || reviewer || relationOf(ctx, t) !== null || onProject()),
  }
}

export function visibleTask(ctx: Ctx, id: string): E.Task {
  const t = find(ctx, 'tasks', id, 'Task')
  if (!taskAccess(ctx, t).visible) err(403, 'TASK_NOT_VISIBLE', 'This task isn’t yours. You can see tasks you own, back up or cover, review, manage or watch; the project plan still lists it.')
  return t
}

export function taskDetail(ctx: Ctx, t: E.Task) {
  const ms = milestoneMap(ctx)
  const p = find(ctx, 'projects', t.project_id, 'Project')
  const m = t.milestone_id ? ms.get(t.milestone_id) : null
  const all = rows(ctx, 'tasks')
  const byId = new Map(all.map((x) => [x.id, x]))
  const deps = rows(ctx, 'task_dependencies')
  const dependencies = deps.filter((d) => d.task_id === t.id).map((d) => byId.get(d.depends_on_task_id)).filter(Boolean) as E.Task[]
  const dependents = deps.filter((d) => d.depends_on_task_id === t.id).map((d) => byId.get(d.task_id)).filter(Boolean) as E.Task[]
  const act = taskActuals(ctx).get(t.id)
  const access = taskAccess(ctx, t)
  const detail: TaskDetail & { milestones: { id: string; no: number; name: string }[]; project_tasks: TaskRef[]; owner_on_leave: boolean } = {
    task: t,
    wbs: wbsOf(t, ms),
    project: { id: p.id, name: p.name, code: p.code, status: p.status, pm_id: p.pm_id },
    milestone: m && !m.deleted_at ? { id: m.id, no: m.no, name: m.name } : null,
    dependencies: dependencies.map((x) => toRef(x, ms)),
    dependents: dependents.map((x) => toRef(x, ms)),
    blockers: openBlockers(ctx, t.id).map((x) => toRef(x, ms)),
    actual_hours: act?.hours ?? 0,
    approved_hours: act?.approved ?? 0,
    can_edit: access.can_edit,
    can_change_status: access.can_change_status,
    can_comment: access.can_comment,
    milestones: rows(ctx, 'milestones')
      .filter((x) => x.project_id === p.id && !x.deleted_at)
      .sort((a, b) => a.no - b.no)
      .map((x) => ({ id: x.id, no: x.no, name: x.name })),
    project_tasks: all
      .filter((x) => x.project_id === p.id && x.id !== t.id)
      .map((x) => toRef(x, ms))
      .sort((a, b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true })),
    owner_on_leave: onLeave(ctx, t.owner_id, ctx.today),
  }
  // v5: stage, progress, waiting-on / blocks with owner, stage and dates, schedule forecast
  const st = schedIndex(ctx, t.project_id).get(t.id)
  const wk0 = weekStart(ctx.today)
  const covMe = coveringFor(ctx, ctx.user.id, wk0, addDays(wk0, 6)).get(t.id)
  const v5 = {
    stage: stageOf(t),
    progress: progressOf(t),
    stage_since: stageSince(ctx, t),
    forecast_start: st?.forecast_start ?? null,
    forecast_end: st?.forecast_end ?? null,
    float_days: st ? st.float_days : null,
    critical: !!st?.critical,
    waiting_on: dependencies.map((x) => linkOf(ctx, x, ms, st?.forecast_start ?? t.start_on, 'waits')),
    blocks: dependents.map((x) => linkOf(ctx, x, ms, st?.forecast_end ?? t.due_on, 'blocks')),
    cancelled: !!(t as E.Task & { cancelled_on?: string | null }).cancelled_on,
    // v6 (G7.02 / G7.05): what can't be picked as a dependency (would make a cycle), the owner's leave this week,
    // whether I'm covering it, and whether I can log time on it
    downstream_ids: downstreamOf(ctx, t.id),
    owner_leave_days: ownerLeaveDays(ctx, t),
    covering_me: covMe ? { days: covMe.days, reason: covMe.reason, from_user_id: covMe.from_user_id } : null,
    can_log_time: t.status !== 'done' && (t.owner_id === ctx.user.id || t.backup_id === ctx.user.id || !!covMe),
    comments_count: rows(ctx, 'comments').filter((c) => c.task_id === t.id).length,
  }
  const review: TaskReviewInfo = {
    reviewer_id: reviewerOf(ctx, t),
    can_submit: canSubmit(ctx, t),
    can_review: t.status === 'in_review' && canReviewTask(ctx, t),
    self_review: selfReview(ctx, t),
    late_now: t.status !== 'done' && ctx.today > t.due_on,
    late_by_days: t.status !== 'done' ? lateBy(ctx, t.due_on, ctx.today) : 0,
    reviews: reviewsOf(ctx, t.id),
    reschedules: reschedulesOf(ctx, t.id),
    assigned_by: t.assigned_by ?? null,
  }
  return { ...detail, review, ...v5, ...taskV7(ctx, t, all, ms, access) }
}

/** v7 professional fields on the task page / drawer. */
function taskV7(ctx: Ctx, t: E.Task, all: E.Task[], ms: Map<string, E.Milestone>, access: TaskAccess) {
  const me = ctx.user.id
  const parent = t.parent_task_id ? all.find((x) => x.id === t.parent_task_id) ?? null : null
  const children = all.filter((x) => x.parent_task_id === t.id)
  const nextOcc = all.find((x) => x.recurrence_of === t.id) ?? null
  const reviewer = reviewerOf(ctx, t)
  const involved = t.owner_id === me || t.backup_id === me || reviewer === me
  const rel = relationOf(ctx, t)
  return {
    relation: rel,
    relation_label: rel ? TASK_RELATION_LABEL[rel] : null,
    concerned_manager_id: concernedManagerOf(ctx, t),
    concerned_manager_default: !t.concerned_manager_id,
    watcher_ids: t.watcher_ids ?? [],
    watching: (t.watcher_ids ?? []).includes(me),
    acceptance_criteria: t.acceptance_criteria ?? [],
    criteria_done: (t.acceptance_criteria ?? []).filter((c) => c.done).length,
    labels: t.labels ?? [],
    billable: t.billable ?? !isGeneral(ctx, t),
    recurrence: t.recurrence ?? 'none',
    recurrence_of: t.recurrence_of ? (() => { const r = all.find((x) => x.id === t.recurrence_of); return r ? toRef(r, ms) : null })() : null,
    next_occurrence: nextOcc ? toRef(nextOcc, ms) : null,
    attachments: (t.attachments ?? []).map((a) => ({ ...a })),
    parent: parent && canSeeTask(ctx, parent) ? toRef(parent, ms) : parent ? { ...toRef(parent, ms), title: 'A task you can’t open' } : null,
    children: children.map((x) => toRef(x, ms)),
    priority: t.priority ?? 'normal',
    // owner / backup / reviewer / editors tick the definition of done; anyone who can comment can attach files
    can_tick_criteria: t.status !== 'done' && (access.can_edit || involved),
    can_attach: access.can_comment,
    can_create_followup: access.can_edit || t.owner_id === me || reviewer === me || has(ctx, 'tasks.assign_team'),
  }
}

/* ---------------- v6 helpers ---------------- */
/** Every task that (transitively) depends on this one: picking any of them as a dependency would close a cycle. */
function downstreamOf(ctx: Ctx, id: string): string[] {
  const deps = rows(ctx, 'task_dependencies')
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const d of deps) if (d.depends_on_task_id === cur && !out.has(d.task_id)) {
      out.add(d.task_id)
      stack.push(d.task_id)
    }
  }
  out.delete(id)
  return [...out]
}
/** The owner's leave days in the current week (Mon–Sun). */
function ownerLeaveDays(ctx: Ctx, t: E.Task): string[] {
  if (!t.owner_id || t.status === 'done') return []
  const wk = weekStart(ctx.today)
  const end = addDays(wk, 6)
  return [...new Set(rows(ctx, 'leave').filter((l) => l.user_id === t.owner_id && l.date >= wk && l.date <= end).map((l) => l.date))].sort()
}

/* ---------------- v5 helpers ---------------- */
function schedIndex(ctx: Ctx, projectId: string) {
  const sc = scheduleOf(ctx, projectId).schedule
  return new Map((sc?.tasks ?? []).map((x) => [x.id, x]))
}
/**
 * A dependency link with owner, stage and dates. For “waits” links `pivot` is this task's forecast start: an open
 * dependency that ends on/after it holds this task up. For “blocks” links `pivot` is this task's forecast end:
 * a dependent planned to start on/before it will be held up.
 */
function linkOf(ctx: Ctx, x: E.Task, ms: Map<string, E.Milestone>, pivot: string, kind: 'waits' | 'blocks'): RiskTaskLink {
  const st = schedIndex(ctx, x.project_id).get(x.id)
  const done = x.status === 'done'
  const fEnd = done ? x.done_on ?? x.due_on : st?.forecast_end ?? x.due_on
  return {
    id: x.id, wbs: wbsOf(x, ms), title: x.title, owner_id: x.owner_id, stage: stageOf(x), progress: progressOf(x), done, start_on: x.start_on, due_on: x.due_on, done_on: x.done_on,
    forecast_start: st?.forecast_start ?? x.start_on, forecast_end: fEnd,
    held_up: kind === 'waits' ? !done && fEnd >= pivot : !done && x.start_on <= pivot,
  }
}

function myTask(ctx: Ctx, t: E.Task, ms: Map<string, E.Milestone>, projects: Map<string, E.Project>, isBackup: boolean): MyTaskV5 {
  const p = projects.get(t.project_id)
  const m = t.milestone_id ? ms.get(t.milestone_id) : null
  return {
    stage: stageOf(t),
    progress: progressOf(t),
    tag: t.tag ?? null,
    backup_id: t.backup_id,
    can_submit: canSubmit(ctx, t),
    can_review: t.status === 'in_review' ? canReviewTask(ctx, t) : canReviewTask(ctx, t) && !selfReview(ctx, t),
    ...toRef(t, ms),
    project_name: p?.name ?? '—',
    project_code: p?.code ?? '',
    milestone_label: m && !m.deleted_at ? `M${m.no} ${m.name}` : null,
    est_hours: t.est_hours,
    actual_hours: taskActuals(ctx).get(t.id)?.hours ?? 0,
    complexity: t.complexity,
    is_backup: isBackup,
    blocked_by: openBlockers(ctx, t.id).map((x) => toRef(x, ms)),
    reviewer_id: reviewerOf(ctx, t),
    review_round: t.review_round ?? 0,
    submitted_on: t.submitted_on ?? null,
    general: isGeneral(ctx, t),
    sent_back: (() => {
      if (t.status === 'in_review') return null
      const last = reviewsOf(ctx, t.id).at(-1)
      return last?.decision === 'sent_back' ? { reason: last.decision_reason ?? '', by: last.decided_by, at: last.decided_at, round: last.round } : null
    })(),
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
export function register(r: Router) {
  /* ---------- v7: the shared Create task form (CEO point 7) ---------- */
  // What the form may offer this person: projects they can create tasks in (PM / admin → anyone; General & admin →
  // themselves and their reports), each with milestones (and the next WBS number), the tasks to depend on, labels in use.
  r.get('/tasks/create-options', ({ ctx }): TaskCreateOptions => {
    const me = ctx.user.id
    const gen = generalProjectId(ctx)
    ensureGeneralProject(ctx)
    const team = teamOf(ctx, me).map((u) => u.id)
    const msAll = rows(ctx, 'milestones')
    const msById = new Map(msAll.map((m) => [m.id, m]))
    const allTasks = rows(ctx, 'tasks')
    const admin = has(ctx, 'projects.manage_all')
    const projects = rows(ctx, 'projects')
      .filter((p) => p.id === gen || (['active', 'initiated'].includes(p.status) && createRights(ctx, p, null).ok))
      .sort((a, b) => (a.id === gen ? -1 : b.id === gen ? 1 : a.code.localeCompare(b.code)))
      .map((p) => {
        const general = p.id === gen
        const live = msAll.filter((m) => m.project_id === p.id && !m.deleted_at).sort((a, b) => a.no - b.no)
        const tasks = allTasks
          .filter((t) => t.project_id === p.id && !(t as E.Task & { cancelled_on?: string | null }).cancelled_on && (!general || canSeeTask(ctx, t)))
          .map((t) => ({ id: t.id, wbs: wbsOf(t, msById), title: t.title, status: t.status, owner_id: t.owner_id, milestone_id: t.milestone_id }))
          .sort((a, b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true }))
        const teamIds = general ? [] : [...new Set([...rows(ctx, 'allocations').filter((a) => a.project_id === p.id).map((a) => a.user_id), ...allTasks.filter((t) => t.project_id === p.id && t.owner_id).map((t) => t.owner_id!)])]
        return {
          id: p.id, code: p.code, name: p.name, general, status: p.status, start_on: p.start_on, end_on: p.end_on, pm_id: p.pm_id,
          anyone: admin || (!general && createRights(ctx, p, null).ok), team_only: general && !admin,
          milestones: live.map((m) => ({ id: m.id, no: m.no, name: m.name, planned_start: m.planned_start, planned_end: m.planned_end, next_wbs: `${m.no}.${nextTaskNo(ctx, p.id, m.id, false)}` })),
          milestone_required: !general && live.length > 0,
          next_wbs_none: `0.${nextTaskNo(ctx, p.id, null, false)}`,
          tasks, team_ids: teamIds,
        }
      })
    const labels = [...new Set(allTasks.filter((t) => canSeeTask(ctx, t)).flatMap((t) => t.labels ?? []))].sort()
    const settings = ctx.tenant.settings as unknown as Record<string, unknown>
    const productive: Record<string, number> = {}
    for (const u of rows(ctx, 'users')) if (u.status === 'active') productive[u.id] = Number((u as E.User & { productive_hours?: number }).productive_hours ?? settings['team.default_productive_hours'] ?? 6) || 6
    return {
      me, my_manager_id: ctx.user.reports_to_id ?? null, general_project_id: gen, view_all: has(ctx, 'tasks.view_all'), can_assign_team: has(ctx, 'tasks.assign_team'),
      team_ids: team, projects, labels, min_hours_per_day: Number(settings['calendar.min_hours_per_day'] ?? 9) || 9, productive_hours: productive,
    }
  })

  r.post('/tasks', ({ ctx, body }) => {
    const t = createTaskCore(ctx, body)
    return { ...t, wbs: wbsOf(t, milestoneMap(ctx)) }
  })

  /* ---------- v7: watch / unwatch, definition-of-done ticks, attachments ---------- */
  r.post('/tasks/:id/watch', ({ ctx, params, body }) => {
    const t = visibleTask(ctx, params.id)
    const me = ctx.user.id
    const on = body.watch !== false
    const cur = t.watcher_ids ?? []
    const next = on ? [...new Set([...cur, me])] : cur.filter((x) => x !== me)
    update(ctx, 'tasks', t.id, { watcher_ids: next } as never)
    logActivity(ctx, 'task', t.id, on ? 'task.watch' : 'task.unwatch', `${ctx.user.name} ${on ? 'started' : 'stopped'} watching`)
    return taskDetail(ctx, find(ctx, 'tasks', t.id))
  })

  r.post('/tasks/:id/criteria', ({ ctx, params, body }) => {
    const t = visibleTask(ctx, params.id)
    const d = taskDetail(ctx, t)
    if (!d.can_tick_criteria) err(403, 'FORBIDDEN', t.status === 'done' ? 'This task is approved. Reopen it to change its definition of done.' : 'Only the owner, backup, reviewer or project manager can tick the definition of done.')
    const list = [...(t.acceptance_criteria ?? [])]
    const i = Number(body.index)
    if (!Number.isInteger(i) || i < 0 || i >= list.length) err(422, 'VALIDATION', 'That checklist item no longer exists. Reload the task.', 'index')
    const done = body.done === true
    list[i] = { ...list[i], done }
    update(ctx, 'tasks', t.id, { acceptance_criteria: list } as never)
    const n = list.filter((x) => x.done).length
    logActivity(ctx, 'task', t.id, 'task.criteria', `${done ? 'Ticked' : 'Unticked'} “${list[i].text}” (${n}/${list.length} done)`)
    return taskDetail(ctx, find(ctx, 'tasks', t.id))
  })

  r.post('/tasks/:id/attachments', ({ ctx, params, body }) => {
    const t = visibleTask(ctx, params.id)
    if (!taskAccess(ctx, t).can_comment) err(403, 'FORBIDDEN', 'Only people involved in this task can attach files.')
    const list = t.attachments ?? []
    if (list.length >= 8) err(422, 'VALIDATION', 'A task holds up to 8 files. Remove one first.', 'attachments')
    const a = validAttachment(ctx, body)
    update(ctx, 'tasks', t.id, { attachments: [...list, a] } as never)
    logActivity(ctx, 'task', t.id, 'task.attachment', `Attached ${a.name}`)
    for (const uid of [t.owner_id, reviewerOf(ctx, t)]) if (uid && uid !== ctx.user.id) notify(ctx, uid, 'NTF-14', 'File attached to a task', `${ctx.user.name} attached ${a.name} to ${wbsOf(t, milestoneMap(ctx))} ${t.title}`, `/tasks/${t.id}`)
    return taskDetail(ctx, find(ctx, 'tasks', t.id))
  })

  r.del('/tasks/:id/attachments/:aid', ({ ctx, params }) => {
    const t = visibleTask(ctx, params.id)
    const a = (t.attachments ?? []).find((x) => x.id === params.aid)
    if (!a) err(404, 'NOT_FOUND', 'That file was already removed.')
    if (a.uploaded_by !== ctx.user.id && !taskAccess(ctx, t).can_edit) err(403, 'FORBIDDEN', 'Only the person who attached the file or the project manager can remove it.')
    update(ctx, 'tasks', t.id, { attachments: (t.attachments ?? []).filter((x) => x.id !== a.id) } as never)
    logActivity(ctx, 'task', t.id, 'task.attachment', `Removed ${a.name}`)
    return taskDetail(ctx, find(ctx, 'tasks', t.id))
  })

  /* ---------- v6: the Tasks tab (Feature Guide §7, G7.01) ---------- */
  // Everyone gets it. Scope is the server's: employees see their own tasks, tasks they cover and tasks on their projects;
  // managers / CEO see every project they're allowed to. Filters: person (owner), project, status (5 summary statuses)
  // with the detailed stage as a sub-filter, search, and quick chips Mine / Covering / Tagged me / Overdue / Blocked.
  r.get('/tasks', ({ ctx, query }) => {
    ensureSwept(ctx)
    const me = ctx.user.id
    const ms = milestoneMap(ctx)
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
    const act = taskActuals(ctx)
    const comments = new Map<string, number>()
    const tagged = new Set<string>()
    for (const c of rows(ctx, 'comments')) {
      comments.set(c.task_id, (comments.get(c.task_id) ?? 0) + 1)
      if ((c.mentions ?? []).includes(me) && c.author_id !== me) tagged.add(c.task_id)
    }
    const wkRaw = String(query.week ?? '')
    const wk = /^\d{4}-\d{2}-\d{2}$/.test(wkRaw) ? weekStart(wkRaw) : weekStart(ctx.today)
    const wkEnd = addDays(wk, 6)
    const cov = coveringFor(ctx, me, wk, wkEnd)
    const leaveBy = new Map<string, string[]>()
    for (const l of rows(ctx, 'leave')) if (l.date >= wk && l.date <= wkEnd) leaveBy.set(l.user_id, [...new Set([...(leaveBy.get(l.user_id) ?? []), l.date])].sort())
    // v7 visibility (CEO point 5): tasks.view_all sees every task; everyone else only tasks they own, cover, back up,
    // review, are the concerned manager / PM / assigner of, watch or were @mentioned on (each row says why).
    const viewAll = has(ctx, 'tasks.view_all')
    const visible = rows(ctx, 'tasks').filter((t) => projects.has(t.project_id) && (canSeeTask(ctx, t) || cov.has(t.id)))
    const manager = viewAll || has(ctx, 'tasks.assign_team') || rows(ctx, 'projects').some((p) => canEdit(ctx, p))
    // Person: 'all' = everyone I may see (default), 'me' or a user id = owner. Without tasks.view_all the person filter
    // only narrows within the tasks already visible.
    const personRaw = String(query.person ?? '')
    const person = personRaw === 'all' || !personRaw ? '' : personRaw === 'me' ? me : personRaw
    // Department of the owner (master department, else the user's function)
    const depts = new Map(rows(ctx, 'departments').map((d) => [d.id, d]))
    const deptKey = (uid: string | null) => {
      const u = uid ? users.get(uid) : undefined
      if (!u) return ''
      return u.department_id && depts.has(u.department_id) ? u.department_id : `kind:${u.department}`
    }
    const deptLabel = (key: string) => (key.startsWith('kind:') ? key.slice(5).replace(/^./, (c) => c.toUpperCase()) : depts.get(key)?.name ?? key)
    const department = String(query.department ?? '')
    const label = String(query.label ?? '')
    const group = String(query.group ?? '') === 'employee' ? 'employee' : ''
    const wkMon = weekStart(ctx.today)
    const project = String(query.project ?? '')
    const milestone = String(query.milestone ?? '')
    // status: 'open' (default) | 'all' | a summary status. Legacy ?stage=open|all|done|in_review maps onto it.
    const legacy = String(query.stage ?? '')
    const SUMMARY = ['todo', 'in_progress', 'blocked', 'in_review', 'done']
    let status = String(query.status ?? '')
    let stage = legacy
    if (!status && ['open', 'all', 'done', 'in_review'].includes(legacy)) {
      status = legacy
      stage = ''
    }
    if (!status) status = 'open'
    if (stage && !(stage in STAGE)) stage = ''
    const chip = String(query.chip ?? '')
    const tag = String(query.tag ?? '')
    const cx = String(query.complexity ?? '')
    const overdueOnly = String(query.overdue ?? '') === '1'
    const q = String(query.q ?? '').trim().toLowerCase()
    const sIdx = new Map<string, ReturnType<typeof schedIndex>>()
    const sOf = (pid: string) => sIdx.get(pid) ?? sIdx.set(pid, schedIndex(ctx, pid)).get(pid)!
    const byId = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
    const depRows = rows(ctx, 'task_dependencies')
    const counts = { all: 0, mine: 0, covering: 0, tagged: 0, overdue: 0, blocked: 0 }
    const stageCounts: Record<string, number> = {}
    const statusCounts: Record<string, number> = {}
    const items: AllTaskRow[] = []
    // group-by-employee counts (open, overdue, done this week) follow every filter except status / stage / chips
    const byEmp = new Map<string, { user_id: string | null; open: number; overdue: number; done_week: number; total: number; est_open: number }>()
    const deptFacet = new Map<string, number>()
    const labelFacet = new Map<string, number>()
    for (const t of visible) {
      const p = projects.get(t.project_id)
      if (!p) continue
      const sg = stageOf(t)
      const dk = deptKey(t.owner_id)
      if (dk) deptFacet.set(dk, (deptFacet.get(dk) ?? 0) + 1)
      for (const l of t.labels ?? []) labelFacet.set(l, (labelFacet.get(l) ?? 0) + 1)
      if (project && t.project_id !== project) continue
      if (department && dk !== department) continue
      if (label && !(t.labels ?? []).includes(label)) continue
      if (milestone && (milestone === 'none' ? !!t.milestone_id : t.milestone_id !== milestone)) continue
      if (tag && (t.tag ?? '') !== tag) continue
      if (cx && t.complexity !== cx) continue
      if (q && !`${wbsOf(t, ms)} ${t.title} ${p.code} ${p.name} ${users.get(t.owner_id ?? '')?.name ?? ''}`.toLowerCase().includes(q)) continue
      const isOverdue = t.status !== 'done' && t.status !== 'in_review' && t.due_on < ctx.today
      if (overdueOnly && !isOverdue) continue
      const deps = depRows.filter((d) => d.task_id === t.id).map((d) => byId.get(d.depends_on_task_id)).filter(Boolean) as E.Task[]
      const openDeps = t.status === 'done' ? [] : deps.filter((d) => d.status !== 'done')
      const isBlocked = t.status !== 'done' && (t.status === 'blocked' || openDeps.length > 0)
      const personOk = !person || t.owner_id === person
      if (personOk || group) {
        const key = t.owner_id ?? ''
        const g = byEmp.get(key) ?? { user_id: t.owner_id, open: 0, overdue: 0, done_week: 0, total: 0, est_open: 0 }
        g.total++
        if (t.status !== 'done') {
          g.open++
          g.est_open += t.est_hours
        }
        if (isOverdue) g.overdue++
        if (t.status === 'done' && (t.done_on ?? '') >= wkMon) g.done_week++
        byEmp.set(key, g)
      }
      // status counts follow person + chip-free filters so the select can show them
      const statusOk = status === 'all' ? true : status === 'open' ? t.status !== 'done' : SUMMARY.includes(status) ? t.status === status : true
      const stageOk = !stage || sg === stage
      if (personOk && stageOk) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1
      if (personOk && statusOk) stageCounts[sg] = (stageCounts[sg] ?? 0) + 1
      if (!statusOk || !stageOk) continue
      const isCov = cov.has(t.id)
      const isTagged = tagged.has(t.id)
      if (personOk) counts.all++
      if (t.owner_id === me) counts.mine++
      if (isCov) counts.covering++
      if (isTagged) counts.tagged++
      if (personOk && isOverdue) counts.overdue++
      if (personOk && isBlocked) counts.blocked++
      // chips: Mine / Covering / Tagged me replace the person filter; Overdue / Blocked narrow it
      if (chip === 'mine' ? t.owner_id !== me : chip === 'covering' ? !isCov : chip === 'tagged' ? !isTagged : !personOk) continue
      if (chip === 'overdue' && !isOverdue) continue
      if (chip === 'blocked' && !isBlocked) continue
      const m = t.milestone_id ? ms.get(t.milestone_id) : null
      const st = sOf(t.project_id).get(t.id)
      const acc = taskAccess(ctx, t)
      const dep = (d: E.Task) => ({ id: d.id, wbs: wbsOf(d, ms), title: d.title, owner_id: d.owner_id, stage: stageOf(d), done: d.status === 'done' })
      const c = cov.get(t.id)
      items.push({
        id: t.id, wbs: wbsOf(t, ms), title: t.title, project_id: p.id, project_code: p.code, project_name: p.name, project_hue: p.color_hue, general: isGeneral(ctx, t),
        milestone_id: m && !m.deleted_at ? m.id : null, milestone_label: m && !m.deleted_at ? `M${m.no} ${m.name}` : null,
        owner_id: t.owner_id, backup_id: t.backup_id, reviewer_id: reviewerOf(ctx, t), stage: sg, progress: progressOf(t), status: t.status, tag: t.tag ?? null, complexity: t.complexity,
        est_hours: t.est_hours, logged_hours: Math.round((act.get(t.id)?.hours ?? 0) * 10) / 10, start_on: t.start_on, due_on: t.due_on, done_on: t.done_on,
        overdue_days: isOverdue ? lateBy(ctx, t.due_on, ctx.today) : 0, forecast_end: st && t.status !== 'done' ? st.forecast_end : null, critical: !!st?.critical && t.status !== 'done',
        blocked_by: openDeps.length, comments: comments.get(t.id) ?? 0, version: t.version,
        can_move: canMoveTask(ctx, t), can_edit: acc.can_edit, can_submit: canSubmit(ctx, t), can_review: canReviewTask(ctx, t) && !selfReview(ctx, t),
        depends_on: deps.map(dep),
        blocking: openDeps.map(dep),
        owner_leave_days: t.owner_id && t.status !== 'done' ? leaveBy.get(t.owner_id) ?? [] : [],
        covering: c ? { days: c.days, reason: c.reason, from_user_id: c.from_user_id } : null,
        tagged: isTagged,
        can_log_time: t.status !== 'done' && (t.owner_id === me || t.backup_id === me || isCov),
        // v7 professional fields + why I can see it
        relation: isCov ? 'covering' : relationOf(ctx, t),
        priority: t.priority ?? 'normal',
        concerned_manager_id: concernedManagerOf(ctx, t),
        watcher_ids: t.watcher_ids ?? [],
        labels: t.labels ?? [],
        billable: t.billable ?? !isGeneral(ctx, t),
        recurrence: t.recurrence ?? 'none',
        criteria_total: (t.acceptance_criteria ?? []).length,
        criteria_done: (t.acceptance_criteria ?? []).filter((x) => x.done).length,
        attachments: (t.attachments ?? []).length,
        owner_department: dk ? deptLabel(dk) : null,
      })
    }
    const order = (x: AllTaskRow) => (x.status === 'done' ? 3 : x.overdue_days ? 0 : x.blocking?.length || x.status === 'blocked' ? 1 : 2)
    items.sort((a, b) => order(a) - order(b) || a.due_on.localeCompare(b.due_on) || a.project_code.localeCompare(b.project_code) || a.wbs.localeCompare(b.wbs, undefined, { numeric: true }))
    const projIds = [...new Set(visible.map((t) => t.project_id))]
    const facets: AllTasksResponse['facets'] = {
      projects: projIds.map((id) => projects.get(id)).filter(Boolean).map((p) => ({ id: p!.id, code: p!.code, name: p!.name })).sort((a, b) => a.code.localeCompare(b.code)),
      milestones: [...new Set(visible.map((t) => t.milestone_id).filter(Boolean) as string[])]
        .map((id) => ms.get(id))
        .filter((m) => m && !m.deleted_at)
        .map((m) => ({ id: m!.id, project_id: m!.project_id, label: `M${m!.no} ${m!.name}` })),
      people: [...new Set(visible.map((t) => t.owner_id).filter(Boolean) as string[])],
      departments: [...deptFacet.entries()].map(([id, n]) => ({ id, name: deptLabel(id), count: n })).sort((a, b) => a.name.localeCompare(b.name)),
      labels: [...labelFacet.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }
    const groups = [...byEmp.values()]
      .map((g) => ({ ...g, est_open: Math.round(g.est_open * 10) / 10, name: g.user_id ? users.get(g.user_id)?.name ?? 'Former user' : 'Unassigned', department: g.user_id ? deptLabel(deptKey(g.user_id)) : null }))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name))
    const resp: AllTasksResponse = {
      items, total: items.length, facets, wide: viewAll,
      person: person || 'all', status, stage, chip, week: wk, manager, counts,
      status_counts: statusCounts, stage_counts: stageCounts,
      view_all: viewAll, department, label, group, groups,
      scope_note: viewAll ? null : 'You see tasks you own, back up or cover, review, are the concerned manager of, assigned, watch or were tagged on.',
    }
    return resp
  })

  /* ---------- v5: “Tagged you” feed (G7.06) for the dashboards ---------- */
  r.get('/tasks/mentions', ({ ctx, query }) => {
    const user = String(query.user ?? '') || ctx.user.id
    if (user !== ctx.user.id && !has(ctx, 'people.view_all')) err(403, 'FORBIDDEN', 'You can only see your own mentions.')
    const limit = Math.max(1, Math.min(50, Number(query.limit ?? 10) || 10))
    const ms = milestoneMap(ctx)
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
    const out: MentionRow[] = []
    for (const c of rows(ctx, 'comments').filter((x) => (x.mentions ?? []).includes(user) && x.author_id !== user).sort((a, b) => b.created_at.localeCompare(a.created_at))) {
      const t = tasks.get(c.task_id)
      if (!t || !taskAccess(ctx, t).visible) continue
      const p = projects.get(t.project_id)
      out.push({ id: c.id, task_id: t.id, wbs: wbsOf(t, ms), title: t.title, tag: t.tag ?? null, stage: stageOf(t), project_id: t.project_id, project_code: p?.code ?? '', project_name: p?.name ?? '—', author_id: c.author_id, at: c.created_at, body: c.body })
      if (out.length >= limit) break
    }
    return out
  })

  /* ---------- v5: estimate check (G15.04) ---------- */
  r.get('/tasks/estimate-hint', ({ ctx, query }) => {
    const cx = String(query.complexity ?? 'medium') as E.Complexity
    if (!(cx in COMPLEXITY)) err(422, 'VALIDATION', 'Choose a complexity.', 'complexity')
    const est = Number(query.est ?? 0)
    return estimateHint(ctx, (query.owner_id as string) || null, cx, Number.isFinite(est) && est > 0 ? est : null)
  })

  /* ---------- v5: critical path and breach risks (G5.03) ---------- */
  r.get('/delivery/risks', ({ ctx, query }) => {
    ensureSwept(ctx)
    const me = ctx.user.id
    const pid = String(query.project_id ?? '')
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    let scope: E.Task[]
    if (pid) {
      const p = find(ctx, 'projects', pid, 'Project')
      if (!canView(ctx, p)) err(403, 'FORBIDDEN', 'You don’t have access to this project.')
      scope = rows(ctx, 'tasks').filter((t) => t.project_id === pid)
    } else {
      const live = (t: E.Task) => ['active', 'initiated'].includes(projects.get(t.project_id)?.status ?? '')
      scope = rows(ctx, 'tasks').filter((t) => {
        if (!live(t)) return false
        const p = projects.get(t.project_id)!
        return canEdit(ctx, p) || canManageGeneral(ctx, t) || t.owner_id === me || t.backup_id === me
      })
    }
    const ms = milestoneMap(ctx)
    const act = taskActuals(ctx)
    const comments = new Map<string, number>()
    for (const c of rows(ctx, 'comments')) comments.set(c.task_id, (comments.get(c.task_id) ?? 0) + 1)
    const allTasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
    const deps = rows(ctx, 'task_dependencies')
    const horizon = addWorkingDays(ctx.today, 10, { settings: ctx.tenant.settings, holidays: rows(ctx, 'holidays') })
    const out: RiskRow[] = []
    for (const t of scope) {
      // One definition everywhere (Rules › Breached): an open task (not done) already past its target end. A task waiting
      // in review is listed only when it is breached.
      if (t.status === 'done' || (t.status === 'in_review' && t.due_on >= ctx.today)) continue
      const st = schedIndex(ctx, t.project_id).get(t.id)
      if (!st) continue
      const sg = stageOf(t)
      const logged = act.get(t.id)?.hours ?? 0
      const prog = progressOf(t)
      const reasons: string[] = []
      const breached = t.due_on < ctx.today
      if (breached) reasons.push(`Overdue since ${fmtDate(t.due_on)}`)
      const forecastLate = st.forecast_end > t.due_on
      if (forecastLate && !breached) reasons.push(`Forecast end ${fmtDate(st.forecast_end)}, target ${fmtDate(t.due_on)}`)
      const waitingStage = STAGE[sg].group === 'waiting'
      const since = waitingStage ? stageSince(ctx, t) : null
      if (waitingStage) reasons.push(`${STAGE[sg].label} since ${fmtDate(since)}`)
      const over = logged > t.est_hours && t.est_hours > 0
      if (over) reasons.push(`Logged ${Math.round(logged * 10) / 10}h of ${t.est_hours}h estimate at ${prog}%`)
      const shouldStart = STAGE[sg].group === 'not_started' && t.start_on < ctx.today
      if (shouldStart) reasons.push(`Should have started ${fmtDate(t.start_on)}`)
      if (t.slip_flagged_on) reasons.push(`Slip flagged ${fmtDate(t.slip_flagged_on)}`)
      const highRisk = forecastLate || waitingStage || over || shouldStart || !!t.slip_flagged_on || (!!t.milestone_id && st.breach?.kind === 'milestone')
      const critical = st.critical
      const soon = st.forecast_start <= horizon
      if (!breached && !highRisk && !(critical && soon)) continue
      const waits = deps.filter((d) => d.task_id === t.id).map((d) => allTasks.get(d.depends_on_task_id)).filter(Boolean) as E.Task[]
      const blocks = deps.filter((d) => d.depends_on_task_id === t.id).map((d) => allTasks.get(d.task_id)).filter(Boolean) as E.Task[]
      const waitingOn = waits.map((x) => linkOf(ctx, x, ms, st.forecast_start, 'waits'))
      const blocksL = blocks.map((x) => linkOf(ctx, x, ms, st.forecast_end, 'blocks'))
      const p = projects.get(t.project_id)!
      const m = t.milestone_id ? ms.get(t.milestone_id) : null
      const acc = taskAccess(ctx, t)
      const revs = t.target_revisions ?? []
      const holdUp = waitingOn.find((x) => x.held_up)
      const headline = breached
        ? `Overdue since ${fmtDate(t.due_on)}`
        : waitingStage
          ? `${STAGE[sg].label} since ${fmtDate(since)}`
          : forecastLate
            ? `${holdUp ? `Waiting on “${holdUp.title}” (${userNameOf(ctx, holdUp.owner_id)}); f` : 'F'}orecast end ${fmtDate(st.forecast_end)}, target ${fmtDate(t.due_on)}`
            : st.breach?.kind === 'milestone'
              ? st.breach.message
              : shouldStart
                ? `Should have started ${fmtDate(t.start_on)}`
                : t.slip_flagged_on
                  ? `Slip flagged ${fmtDate(t.slip_flagged_on)}; forecast end ${fmtDate(st.forecast_end)}, target ${fmtDate(t.due_on)}`
                  : over
                    ? `Logged ${Math.round(logged * 10) / 10}h of ${t.est_hours}h estimate at ${prog}%`
                : `Forecast end ${fmtDate(st.forecast_end)}, target ${fmtDate(t.due_on)}`
      out.push({
        id: t.id, wbs: wbsOf(t, ms), title: t.title, project_id: p.id, project_code: p.code, project_name: p.name, general: isGeneral(ctx, t) || p.id === generalProjectId(ctx),
        milestone_id: m && !m.deleted_at ? m.id : null, milestone_label: m && !m.deleted_at ? m.name : null, milestone_no: m && !m.deleted_at ? m.no : null,
        owner_id: t.owner_id, backup_id: t.backup_id, reviewer_id: reviewerOf(ctx, t), complexity: t.complexity, tag: t.tag ?? null, est_hours: t.est_hours, logged_hours: Math.round(logged * 10) / 10,
        stage: sg, progress: prog, status: t.status, start_on: t.start_on, due_on: t.due_on, baseline_due_on: t.baseline_due_on ?? revs[0]?.from ?? null, revised_on: revs.length ? revs[revs.length - 1].at.slice(0, 10) : null,
        revisions: revs.length, slip_flagged_on: t.slip_flagged_on ?? null, slip_note: t.slip_note ?? null, actual_start_on: t.actual_start_on ?? null,
        forecast_start: st.forecast_start, forecast_end: st.forecast_end, note: t.blocked_reason ?? null, stage_since: since,
        breached, high_risk: highRisk, critical, float_days: st.float_days, reasons, headline,
        waiting_on: waitingOn, blocks: blocksL, comments: comments.get(t.id) ?? 0, version: t.version,
        can_move: canMoveTask(ctx, t), can_edit: acc.can_edit, can_submit: canSubmit(ctx, t), can_review: canReviewTask(ctx, t) && !selfReview(ctx, t),
      })
    }
    const rank = (x: RiskRow) => (x.breached ? 0 : x.high_risk && x.critical ? 1 : x.high_risk ? 2 : 3)
    out.sort((a, b) => rank(a) - rank(b) || a.due_on.localeCompare(b.due_on) || a.wbs.localeCompare(b.wbs, undefined, { numeric: true }))
    return out
  })

  r.get('/tasks/:id', ({ ctx, params }) => taskDetail(ctx, visibleTask(ctx, params.id)))

  r.get('/tasks/:id/comments', ({ ctx, params }) => {
    visibleTask(ctx, params.id)
    return rows(ctx, 'comments')
      .filter((c) => c.task_id === params.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  })

  r.post('/tasks/:id/comments', ({ ctx, params, body }) => {
    const t = visibleTask(ctx, params.id)
    if (!taskAccess(ctx, t).can_comment) err(403, 'FORBIDDEN', 'Only people on this project can comment on its tasks.')
    const text = String(body.body ?? '').trim()
    if (!text) err(422, 'VALIDATION', 'Write a comment first.', 'body')
    if (text.length > 4000) err(422, 'VALIDATION', 'Keep comments under 4,000 characters.', 'body')
    let parent: string | null = body.parent_id ?? null
    if (parent) {
      const pc = find(ctx, 'comments', parent, 'Comment')
      if (pc.task_id !== t.id) err(422, 'VALIDATION', 'Reply to a comment on this task.', 'parent_id')
      if (pc.parent_id) parent = pc.parent_id // flatten to one reply level
    }
    const users = new Map(rows(ctx, 'users').filter((u) => u.status === 'active').map((u) => [u.id, u]))
    const mentions = [...new Set<string>((Array.isArray(body.mentions) ? body.mentions : []).filter((id: string) => users.has(id)))]
    const c = insert(ctx, 'comments', { task_id: t.id, body: text, mentions, author_id: ctx.user.id, parent_id: parent } as never)
    const ms = milestoneMap(ctx)
    const code = wbsOf(t, ms)
    const snippet = text.length > 90 ? text.slice(0, 88) + '…' : text
    for (const uid of mentions) if (uid !== ctx.user.id) notify(ctx, uid, 'NTF-03', 'You were mentioned', `${ctx.user.name} mentioned you on ${code} ${t.title}: “${snippet}”`, `/tasks/${t.id}`)
    logActivity(ctx, 'task', t.id, 'comment', `Commented on ${code} ${t.title}`)
    return c
  })

  r.get('/my-tasks', ({ ctx, query }) => {
    const me = ctx.user.id
    const ms = milestoneMap(ctx)
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const liveProject = (t: E.Task) => {
      const s = projects.get(t.project_id)?.status
      return s !== 'closed' && s !== 'completed'
    }
    const all = rows(ctx, 'tasks').filter((t) => t.status !== 'done' && liveProject(t))
    const tasks = all.filter((t) => t.owner_id === me).map((t) => myTask(ctx, t, ms, projects, false))
    // Covering (G7.02): I'm the backup and the owner is on leave on ANY day of the viewed week,
    // or the owner delegated their task follow-ups to me (respecting the delegation's project scope).
    const wk = typeof query.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.week) ? weekStart(query.week) : weekStart(ctx.today)
    const cov = coveringFor(ctx, me, wk, addDays(wk, 6))
    const covering = all
      .filter((t) => cov.has(t.id))
      .map((t) => ({ ...myTask(ctx, t, ms, projects, true), covering_days: cov.get(t.id)!.days, covering_reason: cov.get(t.id)!.reason }))
    // Hours this week (all my entries in the current week) for the summary strip
    const mon = weekStart(ctx.today)
    const sun = addDays(mon, 6)
    const hours_this_week = rows(ctx, 'timesheet_entries')
      .filter((e) => e.user_id === me && e.work_date >= mon && e.work_date <= sun && e.kind !== 'leave')
      .reduce((s, e) => s + e.hours, 0)
    const backing = all.filter((t) => t.backup_id === me && t.owner_id !== me).length
    void getDb
    return { tasks, covering, hours_this_week, backing, week: wk }
  })
}
