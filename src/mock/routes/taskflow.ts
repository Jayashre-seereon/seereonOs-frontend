// v3 task governance — review flow (submit / approve / send back), manager-assigned tasks, delivery analytics.
// Rules live here; projects.ts (status / PATCH) and tasks.ts (detail, my tasks) call the helpers below.
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import type { AssignOptions, ReviewQueueRow, TaskAnalytics, TaskAnalyticsRow, TeamTaskRow } from '@/api/tasks'
import type { TeamTaskRowV5 } from '@/api/work'
import { err, find, has, insert, permissionsOf, logActivity, notify, nowISO, rows, update, userName, warn, type Ctx, type Router } from '../server'
import { cal, openBlockers, syncMilestoneDates } from '../analytics'
import { STAGE, TASK_STAGES, progressOf, stageOf, statusForStage } from '@/domain/delivery'
import { DELAY_REASON_LABEL, taskStats, taskTimeliness, teamOf, timelinessOf, workingDayVariance, type TaskStats } from '../performance'
import { addDays, fmtDate, isRealISODate, isWorkingDay } from '@/domain/calendar'
import { canEdit, nextTaskNo, syncAchieved } from './projects'
import { canSeeTask } from './tasks'
import { advanceApproval, ensureWf, startApproval, stepLabel, wfClear, wfPatch, type WfState } from '../workflows'

/** Review-workflow state stored on the task while it is in review (see src/mock/workflows.ts). */
type TaskWf = E.Task & Partial<WfState> & { wf_approver_id?: string | null }
/** "Step 2 of 2 · Delivery head review" for multi-step task reviews (null otherwise). */
export const reviewStepLabel = (t: E.Task) => (t.status === 'in_review' ? stepLabel(t as TaskWf) : null)

const ISO = { test: (s: string) => isRealISODate(s) }
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

/* ================================================================== */
/* Helpers (shared with projects.ts / tasks.ts)                        */
/* ================================================================== */
export const generalProjectId = (ctx: Ctx) => `p_general_${ctx.tenant.slug}`
/** v7: tenants created after the demo seed have no built-in General & admin project yet; create it on first use
 *  (same shape as the seed: internal, active, the workspace admin as PM) so self-tasks and general work always work. */
export function ensureGeneralProject(ctx: Ctx): E.Project {
  const id = generalProjectId(ctx)
  const cur = rows(ctx, 'projects').find((p) => p.id === id)
  if (cur) return cur
  const admin = rows(ctx, 'users').find((u) => u.status === 'active' && permissionsOf(u).includes('projects.manage_all') && !u.reports_to_id) ?? ctx.user
  return insert(ctx, 'projects', {
    id, code: 'GEN', name: 'General & admin', client: 'Internal', type: 'service', status: 'active', pm_id: admin.id,
    start_on: addDays(ctx.today, -365), end_on: addDays(ctx.today, 3650), contract_value_paise: 0, billing_model: 'fixed', stream: 'services',
    description: 'Internal work assigned by line managers: admin, compliance, learning, presales support, internal tooling.', priority: 3, deal_id: null, baseline_end_on: addDays(ctx.today, 3650), color_hue: 210,
  } as never) as E.Project
}

function userOf(ctx: Ctx, id: string | null | undefined) {
  return id ? rows(ctx, 'users').find((u) => u.id === id) ?? null : null
}
/** The top person: reports to nobody and can manage every project (may review their own work). */
export function isTop(ctx: Ctx, id: string | null | undefined) {
  const u = userOf(ctx, id)
  return !!u && !u.reports_to_id && permissionsOf(u).includes('projects.manage_all')
}
/** Company-wide task oversight (team tasks, review queue, analytics): anyone who can see everyone's people records. */
export function wideTaskScope(ctx: Ctx) {
  return has(ctx, 'people.view_all')
}
export function isGeneral(ctx: Ctx, t: E.Task) {
  return t.kind === 'general' || t.project_id === generalProjectId(ctx)
}
/** Reviewer = task.reviewer_id ?? project PM (project tasks) ?? assigner / owner's manager (general tasks). Never the owner (unless top). */
export function reviewerOf(ctx: Ctx, t: E.Task): string | null {
  // While in review, the task-review workflow decides who acts on the current step.
  const wfr = (t as TaskWf).wf_approver_id
  if (t.status === 'in_review' && wfr) return wfr
  return baseReviewerOf(ctx, t)
}
/** The v3 reviewer rule (also the input to the task-review workflow's “Task reviewer” step). */
function baseReviewerOf(ctx: Ctx, t: E.Task): string | null {
  const owner = userOf(ctx, t.owner_id)
  let r: string | null = t.reviewer_id ?? null
  if (!r) {
    const p = rows(ctx, 'projects').find((x) => x.id === t.project_id)
    r = !isGeneral(ctx, t) && p?.pm_id ? p.pm_id : t.assigned_by ?? owner?.reports_to_id ?? p?.pm_id ?? null
  }
  if (r && r === t.owner_id && !isTop(ctx, r)) r = owner?.reports_to_id ?? null
  return r
}
export function isManagerOf(ctx: Ctx, managerId: string, userId: string | null | undefined) {
  if (!userId) return false
  return teamOf(ctx, managerId).some((u) => u.id === userId)
}
/** Line-manager rights on a general task: assigner, reviewer or the owner's manager. */
export function canManageGeneral(ctx: Ctx, t: E.Task) {
  if (!isGeneral(ctx, t)) return false
  const me = ctx.user.id
  return has(ctx, 'projects.manage_all') || t.assigned_by === me || reviewerOf(ctx, t) === me || isManagerOf(ctx, me, t.owner_id)
}
export function canSubmit(ctx: Ctx, t: E.Task) {
  const me = ctx.user.id
  return (t.owner_id === me || t.backup_id === me) && ['todo', 'in_progress', 'blocked'].includes(t.status)
}
export function selfReview(ctx: Ctx, t: E.Task) {
  return t.owner_id === ctx.user.id && !isTop(ctx, ctx.user.id)
}
export function canReviewTask(ctx: Ctx, t: E.Task) {
  if (selfReview(ctx, t)) return false
  return has(ctx, 'projects.manage_all') || reviewerOf(ctx, t) === ctx.user.id
}
function assertReviewer(ctx: Ctx, t: E.Task) {
  if (selfReview(ctx, t)) err(403, 'TASK_SELF_REVIEW', 'You can’t review your own task. Your manager or the project manager approves it.')
  if (!canReviewTask(ctx, t)) err(403, 'FORBIDDEN', `Only ${userName(ctx, reviewerOf(ctx, t))} (the reviewer) or an admin can review this task.`)
}
export function reviewsOf(ctx: Ctx, taskId: string) {
  return rows(ctx, 'task_reviews')
    .filter((r) => r.task_id === taskId)
    .sort((a, b) => a.round - b.round)
}
function openReview(ctx: Ctx, t: E.Task) {
  const rs = reviewsOf(ctx, t.id)
  const last = rs[rs.length - 1]
  return last && !last.decision ? last : null
}
export function reschedulesOf(ctx: Ctx, taskId: string) {
  return rows(ctx, 'activity_log')
    .filter((a) => a.entity === 'task' && a.entity_id === taskId && a.action === 'task.rescheduled')
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((a) => ({ at: a.at, actor_id: a.actor_id, summary: a.summary }))
}
/** Working days late if finished on `on` (0 when on/before due). */
export function lateBy(ctx: Ctx, due: string, on: string) {
  return on > due ? workingDayVariance(ctx, due, on) : 0
}
function code(ctx: Ctx, t: E.Task) {
  const m = t.milestone_id ? rows(ctx, 'milestones').find((x) => x.id === t.milestone_id && !x.deleted_at) : null
  return `${m ? m.no : 0}.${t.no}`
}
function text(v: unknown) {
  return typeof v === 'string' ? v.trim() : ''
}

/** Approve: done_on = date of the latest submission, timeliness against due_on via performance.ts. */
export function approveTask(ctx: Ctx, t: E.Task, rating: unknown, note: string | null, direct = false) {
  const q = Number(rating)
  if (!Number.isInteger(q) || q < 1 || q > 5) err(422, 'VALIDATION', 'Rate the quality of the work from 1 to 5 stars.', 'quality_rating')
  if (note && note.length > 1000) err(422, 'VALIDATION', 'Keep the note under 1,000 characters.', 'note')
  let rv = openReview(ctx, t)
  if (!rv) {
    // Reviewer marked done directly: record a review round so history stays complete.
    const round = (reviewsOf(ctx, t.id).at(-1)?.round ?? 0) + 1
    rv = insert(ctx, 'task_reviews', {
      task_id: t.id, round, submitted_by: t.owner_id ?? ctx.user.id, submitted_at: nowISO(), submission_note: direct ? `Marked done directly by ${ctx.user.name}` : '', proof_url: null,
      delay_reason_code: null, delay_reason: null, decision: null, decided_by: null, decided_at: null, decision_reason: null, quality_rating: null,
    } as never) as B.TaskReview
  }
  const doneOn = (t.status === 'in_review' && t.submitted_on) || rv.submitted_at.slice(0, 10) || ctx.today
  const variance = workingDayVariance(ctx, t.due_on, doneOn)
  const timeliness = timelinessOf(variance)
  update(ctx, 'task_reviews', rv.id, { decision: 'approved', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: note || null, quality_rating: q })
  const out = update(ctx, 'tasks', t.id, {
    status: 'done', done_on: doneOn, submitted_on: t.submitted_on ?? doneOn, approved_by: ctx.user.id, approved_on: ctx.today, timeliness, variance_days: variance, quality_rating: q,
    review_round: rv.round, blocked_reason: null, stage: 'completed', progress: 100, actual_start_on: t.actual_start_on ?? t.start_on,
  })
  syncAchieved(ctx, t.milestone_id)
  const c = code(ctx, out)
  const tl = timeliness === 'early' ? `early by ${-variance}d` : timeliness === 'late' ? `late by ${variance}d` : 'on time'
  logActivity(ctx, 'task', t.id, 'task.approved', `Approved (round ${rv.round}, ${q}/5, ${tl})${note ? `: ${note}` : ''}`)
  logActivity(ctx, 'project', t.project_id, 'task.status', `${c} ${out.title}: approved by ${ctx.user.name}`)
  if (t.owner_id && t.owner_id !== ctx.user.id) notify(ctx, t.owner_id, 'NTF-05', 'Task approved', `${ctx.user.name} approved ${c} ${out.title} · ${q}/5 · finished ${tl}.`, `/tasks/${t.id}`)
  // Unblock dependents
  const deps = rows(ctx, 'task_dependencies').filter((d) => d.depends_on_task_id === t.id)
  for (const d of deps) {
    const nt = rows(ctx, 'tasks').find((x) => x.id === d.task_id)
    if (nt?.owner_id && nt.owner_id !== ctx.user.id && openBlockers(ctx, nt.id).length === 0)
      notify(ctx, nt.owner_id, 'NTF-14', 'You can start a task', `${code(ctx, nt)} ${nt.title} is unblocked: ${c} is done.`, `/tasks/${nt.id}`)
  }
  // v7: watchers and the concerned manager hear about completion; recurring tasks roll to the next occurrence
  const toldDone = new Set([ctx.user.id, t.owner_id ?? ''])
  for (const uid of [t.concerned_manager_id, ...(t.watcher_ids ?? [])]) if (uid && !toldDone.has(uid)) {
    toldDone.add(uid)
    notify(ctx, uid, 'NTF-05', 'Task completed', `${c} ${out.title} was approved by ${ctx.user.name} (${tl}).`, `/tasks/${t.id}`)
  }
  spawnNextOccurrence(ctx, out)
  return out
}

/* ================================================================== */
/* v5 task stages (Feature Guide §7, KPI “Task statuses”)               */
/* ================================================================== */
type TaskX = E.Task & { cancelled_on?: string | null; cancel_reason?: string | null }
const ACTIVE_GROUPS = new Set(['active', 'testing'])
/** Who may move a task: the project's editors, line managers of general tasks, owner, backup, a task delegate or the reviewer. */
function moveRights(ctx: Ctx, t: E.Task) {
  const p = find(ctx, 'projects', t.project_id, 'Project')
  const editor = canEdit(ctx, p) || canManageGeneral(ctx, t)
  // Task follow-ups delegated to me (Delegation.include_tasks, scoped by project) count as covering.
  const delegate = rows(ctx, 'delegations').some((d) => d.to_user_id === ctx.user.id && d.from_user_id === t.owner_id && d.include_tasks !== false && (!d.project_id || d.project_id === t.project_id) && d.from_on <= ctx.today && d.to_on >= ctx.today)
  return { p, editor, ok: editor || delegate || t.owner_id === ctx.user.id || t.backup_id === ctx.user.id || canReviewTask(ctx, t) }
}
export const canMoveTask = (ctx: Ctx, t: E.Task) => moveRights(ctx, t).ok
export function assertCanMove(ctx: Ctx, t: E.Task) {
  const { p, editor, ok } = moveRights(ctx, t)
  if (!ok) err(403, 'FORBIDDEN', 'Only the task owner, their backup or the project manager can change it.')
  return { p, editor }
}
function blockerMessage(ctx: Ctx, t: E.Task) {
  const open = openBlockers(ctx, t.id)
  if (!open.length) return null
  const list = open.map((d) => `${code(ctx, d)} ${d.title} (${userName(ctx, d.owner_id)}, ${STAGE[stageOf(d)].label})`).join(', ')
  return `This task waits on ${list}. Finish ${open.length === 1 ? 'it' : 'them'} first or remove the dependency.`
}
/**
 * Move a task to a detailed stage. Status (the summary every rule and KPI uses) is derived with statusForStage.
 * Rules: no active/testing stage while a dependency is open (TASK_BLOCKED names the task and owner);
 * Completed goes through review (owner submits; reviewer approves with a rating); testing stages raise progress
 * to at least 60/75/90%; the first move into development stamps actual_start_on.
 */
export function applyStage(ctx: Ctx, t: E.Task, stage: E.TaskStage, opts: { progress?: unknown; note?: unknown; quality_rating?: unknown } = {}) {
  const { p, editor } = assertCanMove(ctx, t)
  if (!STAGE[stage]) err(422, 'VALIDATION', 'Choose a valid stage.', 'stage')
  const cur = stageOf(t)
  const note = typeof opts.note === 'string' ? opts.note.trim() : ''
  if (t.status === 'in_review') {
    if (stage === 'completed' && canReviewTask(ctx, t)) err(409, 'USE_REVIEW_FLOW', 'This task is waiting for review. Approve it (with a rating) or send it back.', 'stage')
    err(409, 'USE_REVIEW_FLOW', `This task is waiting for ${userName(ctx, reviewerOf(ctx, t))}'s review. The reviewer approves it or sends it back.`, 'stage')
  }
  if (stage === 'completed') {
    if (t.status === 'done') return t
    if (selfReview(ctx, t) || !canReviewTask(ctx, t)) err(409, 'USE_REVIEW_FLOW', `Tasks are completed through review. Submit it for review — ${userName(ctx, reviewerOf(ctx, t))} approves it.`, 'stage')
    const msg = blockerMessage(ctx, t)
    if (msg) err(409, 'TASK_BLOCKED', msg, 'stage')
    if (opts.quality_rating === undefined || opts.quality_rating === null) err(422, 'VALIDATION', 'Rate the quality of the work (1–5) to mark it completed.', 'quality_rating')
    return approveTask(ctx, t, opts.quality_rating, note || null, true)
  }
  if (t.status === 'done' && !editor && !canReviewTask(ctx, t)) err(403, 'FORBIDDEN', 'Only the reviewer or the project manager can reopen an approved task.')
  const def = STAGE[stage]
  if (ACTIVE_GROUPS.has(def.group)) {
    const msg = blockerMessage(ctx, t)
    if (msg) err(409, 'TASK_BLOCKED', msg, 'stage')
  }
  if (stage === 'blocked' && note.length < 3 && !t.blocked_reason) err(422, 'VALIDATION', 'Say what is blocking the task (at least 3 characters).', 'note')
  if ((stage === 'waiting_feedback' || stage === 'on_hold') && note.length < 5) err(422, 'VALIDATION', stage === 'on_hold' ? 'Say why the task is on hold (at least 5 characters).' : 'Say whose feedback you are waiting for and on what (at least 5 characters).', 'note')
  let prog = t.status === 'done' ? 90 : progressOf(t)
  if (opts.progress !== undefined && opts.progress !== null && opts.progress !== '') {
    const n = Number(opts.progress)
    if (!Number.isInteger(n) || n < 0 || n > 100) err(422, 'VALIDATION', 'Progress must be a whole number from 0 to 100.', 'progress')
    prog = n
  }
  prog = Math.min(99, Math.max(prog, def.minProgress))
  if (stage === cur && prog === progressOf(t) && t.status !== 'done' && !note) return t
  const waiting = def.group === 'waiting'
  const reopen = t.status === 'done' ? { approved_by: null, approved_on: null, timeliness: null, variance_days: null, quality_rating: null } : {}
  const out = update(ctx, 'tasks', t.id, {
    stage, progress: prog, status: statusForStage(stage, t.status === 'done' ? 'todo' : t.status), done_on: null,
    blocked_reason: waiting ? note || t.blocked_reason : null,
    actual_start_on: t.actual_start_on ?? (ACTIVE_GROUPS.has(def.group) ? ctx.today : null),
    ...reopen,
  } as never)
  syncAchieved(ctx, t.milestone_id)
  const c = code(ctx, out)
  logActivity(ctx, 'task', t.id, 'task.stage', `${STAGE[cur].label} → ${def.label} (${prog}%)${note ? `: ${note}` : ''}`)
  logActivity(ctx, 'project', t.project_id, 'task.status', `${c} ${out.title}: ${def.label}`)
  if (waiting && p.pm_id && p.pm_id !== ctx.user.id) notify(ctx, p.pm_id, 'NTF-14', `${c} is ${def.label.toLowerCase()}`, `${out.title}${note ? `: ${note}` : ''}`, `/projects/${p.id}/schedule`)
  return out
}

/* ================================================================== */
/* Row builders                                                        */
/* ================================================================== */
function teamRow(ctx: Ctx, t: E.Task, projects: Map<string, E.Project>, reviews: B.TaskReview[], resched: Map<string, number>): TeamTaskRow & TeamTaskRowV5 {
  const p = projects.get(t.project_id)
  const mine = reviews.filter((r) => r.task_id === t.id).sort((a, b) => a.round - b.round)
  const sentBack = mine.filter((r) => r.decision === 'sent_back')
  const tl = taskTimeliness(ctx, t)
  return {
    id: t.id, wbs: code(ctx, t), title: t.title, status: t.status, owner_id: t.owner_id, reviewer_id: reviewerOf(ctx, t), assigned_by: t.assigned_by ?? null,
    project_id: t.project_id, project_code: p?.code ?? '', project_name: p?.name ?? '—', general: isGeneral(ctx, t), priority: t.priority ?? 'normal',
    start_on: t.start_on, due_on: t.due_on, done_on: t.done_on, submitted_on: t.submitted_on ?? null, est_hours: t.est_hours, review_round: t.review_round ?? mine.length,
    timeliness: tl?.timeliness ?? null, variance_days: tl?.variance ?? null,
    overdue_days: t.status !== 'done' && t.status !== 'in_review' && t.due_on < ctx.today ? lateBy(ctx, t.due_on, ctx.today) : 0,
    delay_reason_code: t.delay_reason_code ?? null, delay_reason: t.delay_reason ?? null, quality_rating: t.quality_rating ?? null,
    sent_back_count: sentBack.length, last_sent_back_reason: sentBack.at(-1)?.decision_reason ?? null, reschedule_count: resched.get(t.id) ?? 0,
    stage: stageOf(t), progress: progressOf(t), tag: t.tag ?? null, complexity: t.complexity, backup_id: t.backup_id, version: t.version,
    can_move: canMoveTask(ctx, t), can_submit: canSubmit(ctx, t), can_review: t.status === 'in_review' ? canReviewTask(ctx, t) : canReviewTask(ctx, t) && !selfReview(ctx, t),
  }
}
function reschedCounts(ctx: Ctx) {
  const m = new Map<string, number>()
  for (const a of rows(ctx, 'activity_log')) if (a.entity === 'task' && a.action === 'task.rescheduled') m.set(a.entity_id, (m.get(a.entity_id) ?? 0) + 1)
  return m
}
/** Tasks a manager oversees: their team's, ones they assigned or review, and tasks on projects they manage. Admin/ops: everything. */
function managedTasks(ctx: Ctx) {
  const me = ctx.user.id
  const all = rows(ctx, 'tasks')
  if (wideTaskScope(ctx) && has(ctx, 'tasks.view_all')) return all
  const team = new Set(teamOf(ctx, me).map((u) => u.id))
  const myProjects = new Set(rows(ctx, 'projects').filter((p) => p.pm_id === me).map((p) => p.id))
  // v7: never wider than the task visibility rule (tasks.view_all, else tasks the manager is related to)
  return all.filter((t) => ((t.owner_id && team.has(t.owner_id)) || t.assigned_by === me || reviewerOf(ctx, t) === me || myProjects.has(t.project_id) || t.concerned_manager_id === me) && (has(ctx, 'tasks.view_all') || canSeeTask(ctx, t) || (t.owner_id && team.has(t.owner_id))))
}

/* ================================================================== */
/* Analytics                                                           */
/* ================================================================== */
function topReasons(s: TaskStats, n = 3) {
  return Object.entries(s.delay_reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([code, count]) => ({ code, label: DELAY_REASON_LABEL[code] ?? code, count }))
}
export function taskAnalytics(ctx: Ctx, q: { from?: string; to?: string; scope?: string; group?: string }): TaskAnalytics {
  const me = ctx.user.id
  const wide = wideTaskScope(ctx) && has(ctx, 'tasks.analytics')
  const team = teamOf(ctx, me)
  let scope: TaskAnalytics['scope'] = q.scope === 'company' || q.scope === 'team' || q.scope === 'me' ? q.scope : wide ? 'company' : team.length ? 'team' : 'me'
  if (scope === 'company' && !wide) scope = team.length ? 'team' : 'me'
  if (scope === 'team' && !team.length && !wide) scope = 'me'
  if (!has(ctx, 'tasks.analytics') && !team.length) scope = 'me'
  const active = rows(ctx, 'users').filter((u) => u.status === 'active')
  const people = scope === 'me' ? active.filter((u) => u.id === me) : scope === 'team' ? (team.length ? team : []) : active
  const ids = people.map((u) => u.id)
  const from = q.from && ISO.test(q.from) ? q.from : undefined
  const to = q.to && ISO.test(q.to) ? q.to : undefined
  const total = taskStats(ctx, { userIds: ids, from, to })
  const group = q.group === 'project' || q.group === 'manager' ? q.group : 'person'
  let out: TaskAnalyticsRow[] = []
  if (group === 'person') {
    out = people.map((u) => {
      const s = taskStats(ctx, { userIds: [u.id], from, to })
      return { key: u.id, label: u.name, user_id: u.id, stats: s, top_reasons: topReasons(s) }
    })
  } else if (group === 'project') {
    const pids = new Set(rows(ctx, 'tasks').filter((t) => t.owner_id && ids.includes(t.owner_id)).map((t) => t.project_id))
    out = rows(ctx, 'projects')
      .filter((p) => pids.has(p.id))
      .map((p) => {
        const s = taskStats(ctx, { userIds: ids, projectId: p.id, from, to })
        return { key: p.id, label: `${p.code} · ${p.name}`, project_id: p.id, stats: s, top_reasons: topReasons(s) }
      })
  } else {
    out = active
      .filter((u) => teamOf(ctx, u.id).length && (scope === 'company' || u.id === me || ids.includes(u.id)))
      .map((u) => {
        const s = taskStats(ctx, { userIds: teamOf(ctx, u.id).map((x) => x.id), from, to })
        return { key: u.id, label: u.name, user_id: u.id, stats: s, top_reasons: topReasons(s) }
      })
  }
  out = out.filter((r) => r.stats.assigned > 0).sort((a, b) => b.stats.assigned - a.stats.assigned || a.label.localeCompare(b.label))
  const personRows = group === 'person' ? out : people.map((u) => ({ user_id: u.id, stats: taskStats(ctx, { userIds: [u.id], from, to }) }))
  const top_late = personRows
    .filter((r) => r.stats.late > 0)
    .map((r) => ({ user_id: r.user_id!, late: r.stats.late, completed: r.stats.completed, avg_variance_days: r.stats.avg_variance_days }))
    .sort((a, b) => b.late - a.late || (b.avg_variance_days ?? 0) - (a.avg_variance_days ?? 0))
    .slice(0, 5)
  const allTasks = rows(ctx, 'tasks')
  const reviews = rows(ctx, 'task_reviews')
  const mineOpen = allTasks.filter((t) => t.owner_id === me && t.status !== 'done')
  const lastDecision = (t: E.Task) => reviews.filter((r) => r.task_id === t.id).sort((a, b) => b.round - a.round)[0]
  return {
    scope, from: from ?? '', to: to ?? '', total, rows: out, top_late,
    delay_reasons: topReasons(total, 9),
    mine: {
      review_queue: allTasks.filter((t) => t.status === 'in_review' && reviewerOf(ctx, t) === me && t.owner_id !== me).length + allTasks.filter((t) => t.status === 'in_review' && t.owner_id === me && isTop(ctx, me) && reviewerOf(ctx, t) === me).length,
      my_in_review: mineOpen.filter((t) => t.status === 'in_review').length,
      my_sent_back_open: mineOpen.filter((t) => t.status !== 'in_review' && lastDecision(t)?.decision === 'sent_back').length,
      my_overdue_open: mineOpen.filter((t) => t.status !== 'in_review' && t.due_on < ctx.today).length,
      my_to_submit: mineOpen.filter((t) => t.status === 'in_progress').length,
    },
  }
}

/* ================================================================== */
/* v7 — one create rule for every entry point (CEO point 7)           */
/* ================================================================== */
const P_CODES: Record<string, E.Task['priority']> = { P1: 'urgent', P2: 'high', P3: 'normal', P4: 'low' }
export const RECURRENCES = ['none', 'weekly', 'monthly'] as const
const TAG_KEYS = ['feature', 'bug', 'improvement', 'documentation', 'support', 'meeting']
const MAX_ATTACH_BYTES = 750 * 1024
/** Who may create a task for whom:
 *  · project tasks — the project's editors (PM of the project with tasks.edit, or projects.manage_all), for anyone;
 *  · General & admin — yourself (self-task, reviewed by your manager), your reports (tasks.assign_team) or anyone (projects.manage_all). */
export function createRights(ctx: Ctx, p: E.Project, ownerId: string | null): { ok: boolean; why: string } {
  const me = ctx.user.id
  const general = p.id === generalProjectId(ctx)
  if (has(ctx, 'projects.manage_all')) return { ok: true, why: '' }
  if (!general) {
    if (canEdit(ctx, p) && (has(ctx, 'tasks.edit') || has(ctx, 'projects.edit'))) return { ok: true, why: '' }
    return { ok: false, why: `Only the project manager of ${p.code} (${userName(ctx, p.pm_id)}) can add tasks to it. Create it under General & admin, or ask them.` }
  }
  if (ownerId === me) return { ok: true, why: '' }
  if (ownerId && has(ctx, 'tasks.assign_team') && isManagerOf(ctx, me, ownerId)) return { ok: true, why: '' }
  return { ok: false, why: has(ctx, 'tasks.assign_team') ? `${userName(ctx, ownerId)} isn’t in your reporting line. You can create general tasks for yourself and your reports.` : 'You can create general tasks for yourself. Your manager assigns work to others.' }
}
function strList(v: unknown, max: number, maxLen: number, field: string, label: string): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) err(422, 'VALIDATION', `${label} must be a list.`, field)
  const out = [...new Set((v as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'object' && x && 'text' in x ? String((x as { text: unknown }).text ?? '').trim() : '')).filter(Boolean))]
  if (out.length > max) err(422, 'VALIDATION', `Keep ${label.toLowerCase()} to ${max} or fewer.`, field)
  for (const x of out) if (x.length > maxLen) err(422, 'VALIDATION', `Each of the ${label.toLowerCase()} must be under ${maxLen} characters.`, field)
  return out
}
function activePerson(ctx: Ctx, id: unknown, field: string, label: string, required: boolean) {
  const v = typeof id === 'string' ? id.trim() : ''
  if (!v) {
    if (required) err(422, 'VALIDATION', `Choose the ${label.toLowerCase()}.`, field)
    return null
  }
  const u = userOf(ctx, v)
  if (!u || u.status !== 'active') err(422, 'VALIDATION', `Choose an active person as ${label.toLowerCase()}.`, field)
  return u
}
export function validAttachment(ctx: Ctx, b: Record<string, unknown>) {
  const name = text(b.name)
  if (!name) err(422, 'VALIDATION', 'The file needs a name.', 'attachments')
  if (name.length > 160) err(422, 'VALIDATION', 'Keep file names under 160 characters.', 'attachments')
  const size = Number(b.size ?? 0)
  const data = typeof b.data_url === 'string' ? b.data_url : null
  if (!Number.isFinite(size) || size < 0) err(422, 'VALIDATION', 'The file size is not valid.', 'attachments')
  if (size > MAX_ATTACH_BYTES || (data && data.length > MAX_ATTACH_BYTES * 1.4)) err(422, 'FILE_REJECTED', `${name} is larger than 750 KB. Attach a link in the description for big files.`, 'attachments')
  if (data && !/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(data)) err(422, 'FILE_REJECTED', `${name} could not be read. Choose the file again.`, 'attachments')
  return { id: `att_${Math.random().toString(36).slice(2, 10)}`, name, size: Math.round(size), type: text(b.type) || 'application/octet-stream', data_url: data, uploaded_by: ctx.user.id, at: nowISO() }
}
/** Create a task with the full professional field set. Validates, numbers it (WBS numbers are never reused), stores
 *  dependencies, notifies assignee / reviewer / concerned manager / watchers and logs it. The owner's timesheet picks it
 *  up as a work item because they own it. */
export function createTaskCore(ctx: Ctx, body: Record<string, any>, opts: { recurrenceOf?: string | null; silent?: boolean } = {}): E.Task {
  const me = ctx.user.id
  const title = text(body.title)
  if (title.length < 3) err(422, 'VALIDATION', 'Give the task a title (at least 3 characters).', 'title')
  if (title.length > 200) err(422, 'VALIDATION', 'Keep the title under 200 characters.', 'title')
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (description.length > 6000) err(422, 'VALIDATION', 'Keep the description under 6,000 characters.', 'description')
  const pid = text(body.project_id)
  if (!pid) err(422, 'VALIDATION', 'Choose the concerned project, or General & admin for non-project work.', 'project_id')
  if (pid === generalProjectId(ctx)) ensureGeneralProject(ctx)
  const p = find(ctx, 'projects', pid, 'Project')
  const general = p.id === generalProjectId(ctx)
  if (!['active', 'initiated'].includes(p.status) && !general) err(422, 'VALIDATION', `${p.code} is ${p.status.replace('_', ' ')}. Add tasks to an active project or General & admin.`, 'project_id')
  const owner = activePerson(ctx, body.owner_id, 'owner_id', 'Owner', true)!
  const rights = createRights(ctx, p, owner.id)
  if (!rights.ok) err(403, 'FORBIDDEN', rights.why, 'owner_id')
  // milestone: required on a project that has milestones (General & admin has none)
  const live = rows(ctx, 'milestones').filter((m) => m.project_id === p.id && !m.deleted_at)
  let m: E.Milestone | null = null
  if (body.milestone_id) {
    m = live.find((x) => x.id === body.milestone_id) ?? null
    if (!m) err(422, 'VALIDATION', 'Choose a milestone of this project.', 'milestone_id')
  } else if (!general && live.length) err(422, 'VALIDATION', 'Choose the milestone this task delivers. Its target end feeds the milestone deadline.', 'milestone_id')
  const backup = activePerson(ctx, body.backup_id, 'backup_id', 'Backup', false)
  if (backup && backup.id === owner.id) err(422, 'VALIDATION', 'The backup must be a different person from the owner.', 'backup_id')
  // reviewer: required; defaults to the project PM (project work) or the assigning manager / owner's manager
  let reviewerId = text(body.reviewer_id)
  if (!reviewerId) reviewerId = (!general && p.pm_id && p.pm_id !== owner.id ? p.pm_id : owner.id !== me ? me : owner.reports_to_id ?? (isTop(ctx, owner.id) ? owner.id : null)) ?? ''
  const reviewer = activePerson(ctx, reviewerId, 'reviewer_id', 'Task reviewer', true)!
  if (reviewer.id === owner.id && !isTop(ctx, reviewer.id)) err(422, 'TASK_SELF_REVIEW', 'The reviewer approves completion, so it must be someone other than the owner (usually the PM or their manager).', 'reviewer_id')
  const cmRaw = body.concerned_manager_id === undefined ? owner.reports_to_id : body.concerned_manager_id
  const cm = activePerson(ctx, cmRaw, 'concerned_manager_id', 'Concerned manager', false)
  if (cm && cm.id === owner.id && !isTop(ctx, cm.id)) err(422, 'VALIDATION', 'The concerned manager must be someone other than the owner.', 'concerned_manager_id')
  // priority: P1–P4 or the stored values
  const prRaw = text(body.priority) || 'normal'
  const priority = (P_CODES[prRaw] ?? prRaw) as E.Task['priority']
  if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) err(422, 'VALIDATION', 'Priority must be P1, P2, P3 or P4.', 'priority')
  const complexity = (text(body.complexity) || 'medium') as E.Complexity
  if (!['low', 'medium', 'high', 'very_high'].includes(complexity)) err(422, 'VALIDATION', 'Complexity must be low, medium, high or very high.', 'complexity')
  const tag = text(body.tag) || 'feature'
  if (!TAG_KEYS.includes(tag)) err(422, 'VALIDATION', 'Choose a task type: Feature, Bug, Improvement, Documentation, Support or Meeting.', 'tag')
  const est = Number(body.est_hours)
  if (body.est_hours === undefined || body.est_hours === null || body.est_hours === '' || !Number.isFinite(est) || est < 0.5 || est > 999) err(422, 'VALIDATION', 'Estimated hours must be between 0.5 and 999.', 'est_hours')
  const start_on = text(body.start_on)
  if (!ISO.test(start_on)) err(422, 'VALIDATION', 'Set a start date.', 'start_on')
  const due_on = text(body.due_on)
  if (!ISO.test(due_on)) err(422, 'VALIDATION', 'Set an end / due date.', 'due_on')
  if (due_on < start_on) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'due_on')
  if (!opts.recurrenceOf && due_on < ctx.today) err(422, 'DATE_RANGE', 'The end date is in the past. Pick today or later.', 'due_on')
  const c = cal(ctx)
  if (!isWorkingDay(start_on, c)) warn(ctx, 'NON_WORKING_DAY', `${fmtDate(start_on)} (start) is a holiday or weekly off.`)
  if (!isWorkingDay(due_on, c)) warn(ctx, 'NON_WORKING_DAY', `${fmtDate(due_on)} (end) is a holiday or weekly off.`)
  if (!general && (start_on < p.start_on || due_on > p.end_on)) warn(ctx, 'OUTSIDE_PROJECT', `The task runs outside ${p.code}’s dates (${fmtDate(p.start_on)} – ${fmtDate(p.end_on)}).`)
  if (m && due_on > m.planned_end) warn(ctx, 'MS_SLIP', `It ends after M${m.no}’s deadline (${fmtDate(m.planned_end)}), so the milestone deadline moves to ${fmtDate(due_on)}.`)
  // dependencies: tasks of the same project (a new task has no dependents, so no cycle is possible)
  const depIds = strList(body.depends_on, 30, 64, 'depends_on', 'Dependencies')
  const allTasks = rows(ctx, 'tasks')
  for (const id of depIds) {
    const d = allTasks.find((x) => x.id === id)
    if (!d || d.project_id !== p.id) err(422, 'VALIDATION', 'Dependencies must be tasks of the same project.', 'depends_on')
  }
  const watchers = strList(body.watcher_ids, 20, 64, 'watcher_ids', 'Watchers')
  for (const w of watchers) activePerson(ctx, w, 'watcher_ids', 'Watcher', true)
  const criteria = strList(body.acceptance_criteria, 30, 300, 'acceptance_criteria', 'Acceptance criteria').map((x) => ({ text: x, done: false }))
  const labels = strList(body.labels, 10, 30, 'labels', 'Labels')
  const recurrence = (text(body.recurrence) || 'none') as E.Task['recurrence']
  if (!RECURRENCES.includes(recurrence as 'none')) err(422, 'VALIDATION', 'Repeat must be none, weekly or monthly.', 'recurrence')
  const files = Array.isArray(body.attachments) ? (body.attachments as Record<string, unknown>[]) : []
  if (files.length > 5) err(422, 'VALIDATION', 'Attach up to 5 files.', 'attachments')
  const attachments = files.map((f) => validAttachment(ctx, f))
  let parent: E.Task | null = null
  if (body.parent_task_id) {
    parent = allTasks.find((x) => x.id === body.parent_task_id) ?? null
    if (!parent) err(422, 'VALIDATION', 'The parent task no longer exists.', 'parent_task_id')
  }
  const billable = typeof body.billable === 'boolean' ? body.billable : !general
  if (billable && general) warn(ctx, 'BILLABLE_GENERAL', 'General & admin work is marked billable — make sure a client is charged for it.')
  const no = nextTaskNo(ctx, p.id, m?.id ?? null, true)
  const wbs_code = `${m ? m.no : 0}.${no}`
  const wasEmpty = !!m && !allTasks.some((x) => x.milestone_id === m!.id)
  const t = insert(ctx, 'tasks', {
    project_id: p.id, milestone_id: m?.id ?? null, no, wbs_code, title, owner_id: owner.id, backup_id: backup?.id ?? null, est_hours: Math.round(est * 4) / 4, start_on, due_on, done_on: null,
    complexity, status: 'todo', description, blocked_reason: null,
    stage: 'new', progress: 0, tag, actual_start_on: null, baseline_due_on: due_on, target_revisions: [], slip_flagged_on: null, slip_note: null,
    kind: general ? 'general' : 'project', assigned_by: me, reviewer_id: reviewer.id, priority, review_round: 0, submitted_on: null, approved_by: null, approved_on: null,
    timeliness: null, variance_days: null, delay_reason_code: null, delay_reason: null, quality_rating: null,
    concerned_manager_id: cm?.id ?? null, watcher_ids: watchers, acceptance_criteria: criteria, labels, billable, recurrence, recurrence_of: opts.recurrenceOf ?? null,
    attachments, parent_task_id: parent?.id ?? null,
  } as never) as E.Task
  for (const id of depIds) insert(ctx, 'task_dependencies', { task_id: t.id, depends_on_task_id: id })
  if (m) {
    m.empty_since = null
    if (m.achieved_on) m.achieved_on = null
    syncMilestoneDates(ctx, m.id, wasEmpty)
  }
  const where = general ? 'General & admin' : `${p.code}${m ? ` / M${m.no}` : ''}`
  logActivity(ctx, 'task', t.id, 'task.created', `${ctx.user.name} created ${wbs_code} ${title} for ${owner.name} (${where}), ${fmtDate(start_on)} – ${fmtDate(due_on)}, ${Math.round(est * 4) / 4}h · reviewer ${reviewer.name}${cm ? ` · concerned manager ${cm.name}` : ''}${opts.recurrenceOf ? ' · next occurrence' : ''}`)
  logActivity(ctx, 'project', p.id, 'task.created', `Added ${wbs_code} ${title} → ${owner.name}`)
  if (parent) logActivity(ctx, 'task', parent.id, 'task.followup', `Follow-up ${wbs_code} ${title} created for ${owner.name}`)
  if (!opts.silent) {
    const told = new Set<string>([me])
    const pr = priority === 'urgent' || priority === 'high' ? ` · ${priority === 'urgent' ? 'P1' : 'P2'}` : ''
    const tell = (uid: string | null | undefined, title2: string, body2: string) => {
      if (!uid || told.has(uid)) return
      told.add(uid)
      notify(ctx, uid, 'NTF-14', title2, body2, `/tasks/${t.id}`)
    }
    tell(owner.id, 'Task assigned to you', `${ctx.user.name}: ${wbs_code} ${title} · ${where} · due ${fmtDate(due_on)}${pr}`)
    tell(backup?.id, 'You are the backup on a task', `${wbs_code} ${title} (owner ${owner.name}) · due ${fmtDate(due_on)}`)
    tell(reviewer.id, 'You review a new task', `${wbs_code} ${title} for ${owner.name} · due ${fmtDate(due_on)}. You approve it when it’s submitted.`)
    tell(cm?.id, 'New task in your team', `${owner.name} has ${wbs_code} ${title} · due ${fmtDate(due_on)}${pr}`)
    for (const w of watchers) tell(w, 'You’re watching a new task', `${wbs_code} ${title} · owner ${owner.name} · due ${fmtDate(due_on)}`)
  }
  return t
}
/** Recurring tasks: when one is approved, the next occurrence is created (same people and fields, dates moved). */
export function spawnNextOccurrence(ctx: Ctx, t: E.Task): E.Task | null {
  if (!t.recurrence || t.recurrence === 'none') return null
  if (rows(ctx, 'tasks').some((x) => x.recurrence_of === t.id)) return null
  const shift = (d: string) => {
    if (t.recurrence === 'weekly') return addDays(d, 7)
    const [y, mo, da] = d.split('-').map(Number)
    const nm = new Date(Date.UTC(y, mo, 1))
    const last = new Date(Date.UTC(nm.getUTCFullYear(), nm.getUTCMonth() + 1, 0)).getUTCDate()
    return `${nm.getUTCFullYear()}-${String(nm.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(da, last)).padStart(2, '0')}`
  }
  const c = cal(ctx)
  const nextWorking = (d: string) => {
    let x = d
    for (let i = 0; i < 10 && !isWorkingDay(x, c); i++) x = addDays(x, 1)
    return x
  }
  let start = nextWorking(shift(t.start_on))
  let due = nextWorking(shift(t.due_on))
  while (due < ctx.today) {
    start = nextWorking(t.recurrence === 'weekly' ? addDays(start, 7) : shift(start))
    due = nextWorking(t.recurrence === 'weekly' ? addDays(due, 7) : shift(due))
  }
  const p = rows(ctx, 'projects').find((x) => x.id === t.project_id)
  const moveToGeneral = !p || (!['active', 'initiated'].includes(p.status) && p.id !== generalProjectId(ctx))
  const owner = userOf(ctx, t.owner_id)
  if (!owner || owner.status !== 'active') return null
  const live = (id: string | null | undefined) => (id && userOf(ctx, id)?.status === 'active' ? id : null)
  const ms = t.milestone_id ? rows(ctx, 'milestones').find((x) => x.id === t.milestone_id && !x.deleted_at) : null
  // created as the original assigner would; rights are not re-checked for an automatic occurrence
  const out = insertOccurrence(ctx, t, moveToGeneral ? generalProjectId(ctx) : t.project_id, moveToGeneral ? null : ms?.id ?? null, start, due, { reviewer: live(t.reviewer_id), cm: live(t.concerned_manager_id), backup: live(t.backup_id) })
  logActivity(ctx, 'task', t.id, 'task.recurred', `Next ${t.recurrence} occurrence created: due ${fmtDate(due)}`)
  notify(ctx, owner.id, 'NTF-14', 'Next occurrence of a recurring task', `${out.title} · due ${fmtDate(due)}`, `/tasks/${out.id}`)
  return out
}
function insertOccurrence(ctx: Ctx, t: E.Task, pid: string, msId: string | null, start: string, due: string, who: { reviewer: string | null; cm: string | null; backup: string | null }) {
  const general = pid === generalProjectId(ctx)
  const no = nextTaskNo(ctx, pid, msId, true)
  const m = msId ? rows(ctx, 'milestones').find((x) => x.id === msId) : null
  const wbs_code = `${m ? m.no : 0}.${no}`
  const row = insert(ctx, 'tasks', {
    project_id: pid, milestone_id: msId, no, wbs_code, title: t.title, owner_id: t.owner_id, backup_id: who.backup, est_hours: t.est_hours, start_on: start, due_on: due, done_on: null,
    complexity: t.complexity, status: 'todo', description: t.description, blocked_reason: null,
    stage: 'new', progress: 0, tag: t.tag ?? 'feature', actual_start_on: null, baseline_due_on: due, target_revisions: [], slip_flagged_on: null, slip_note: null,
    kind: general ? 'general' : 'project', assigned_by: t.assigned_by ?? ctx.user.id, reviewer_id: who.reviewer, priority: t.priority ?? 'normal', review_round: 0, submitted_on: null, approved_by: null, approved_on: null,
    timeliness: null, variance_days: null, delay_reason_code: null, delay_reason: null, quality_rating: null,
    concerned_manager_id: who.cm, watcher_ids: t.watcher_ids ?? [], acceptance_criteria: (t.acceptance_criteria ?? []).map((x) => ({ text: x.text, done: false })), labels: t.labels ?? [],
    billable: t.billable ?? !general, recurrence: t.recurrence, recurrence_of: t.id, attachments: [], parent_task_id: t.parent_task_id ?? null,
  } as never) as E.Task
  if (msId) syncMilestoneDates(ctx, msId)
  logActivity(ctx, 'task', row.id, 'task.created', `Created automatically: the next ${t.recurrence} occurrence of ${t.title}, due ${fmtDate(due)}`)
  return row
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
export function register(r: Router) {
  /* ---------- submit for review ---------- */
  r.post('/tasks/:id/submit', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    const me = ctx.user.id
    if (t.owner_id !== me && t.backup_id !== me) err(403, 'FORBIDDEN', 'Only the task owner (or their backup) can submit it for review.')
    if (t.status === 'in_review') err(409, 'INVALID_STATE', 'This task is already waiting for review.')
    if (t.status === 'done') err(409, 'INVALID_STATE', 'This task is already approved.')
    const open = openBlockers(ctx, t.id)
    if (open.length) err(409, 'TASK_BLOCKED', `This task waits on ${open.map((d) => `${code(ctx, d)} ${d.title} (${userName(ctx, d.owner_id)})`).join(', ')}. Finish ${open.length === 1 ? 'it' : 'them'} first or ask the PM to remove the dependency.`)
    const note = text(body.note)
    if (note.length < 5) err(422, 'VALIDATION', 'Describe what you delivered (at least 5 characters) so the reviewer knows what to check.', 'note')
    if (note.length > 2000) err(422, 'VALIDATION', 'Keep the note under 2,000 characters.', 'note')
    const proof = text(body.proof_url) || null
    if (proof && !/^https?:\/\/\S+\.\S+/.test(proof)) err(422, 'VALIDATION', 'The proof link must be a full web address starting with https://', 'proof_url')
    const late = ctx.today > t.due_on
    let reasonCode: string | null = null
    let reason: string | null = null
    if (late) {
      reasonCode = text(body.delay_reason_code) || null
      reason = text(body.delay_reason) || null
      if (!reasonCode || !(reasonCode in DELAY_REASON_LABEL)) err(422, 'DELAY_REASON_REQUIRED', `This task was due ${fmtDate(t.due_on)}. Choose why it’s late.`, 'delay_reason_code')
      if (!reason || reason.length < 15) err(422, 'DELAY_REASON_REQUIRED', 'Explain the delay in at least 15 characters — what happened and what you did about it.', 'delay_reason')
    }
    const round = (reviewsOf(ctx, t.id).at(-1)?.round ?? 0) + 1
    insert(ctx, 'task_reviews', {
      task_id: t.id, round, submitted_by: me, submitted_at: nowISO(), submission_note: note, proof_url: proof,
      delay_reason_code: reasonCode as B.DelayReasonCode | null, delay_reason: reason, decision: null, decided_by: null, decided_at: null, decision_reason: null, quality_rating: null,
    } as never)
    const legacy = baseReviewerOf(ctx, t)
    const wf = startApproval(ctx, 'task_review', { requester_id: t.owner_id ?? me, reviewer_id: legacy, project_id: isGeneral(ctx, t) ? null : t.project_id }, legacy)
    const out = update(ctx, 'tasks', t.id, {
      status: 'in_review', submitted_on: ctx.today, review_round: round, blocked_reason: null,
      ...(late ? { delay_reason_code: reasonCode, delay_reason: reason } : {}),
      ...wfPatch(wf), wf_approver_id: wf.approver_id,
    } as never)
    const c = code(ctx, out)
    const lb = late ? lateBy(ctx, t.due_on, ctx.today) : 0
    logActivity(ctx, 'task', t.id, 'task.submitted', `Submitted for review (round ${round})${late ? ` ${lb}d late — ${DELAY_REASON_LABEL[reasonCode!]}: ${reason}` : ''}`)
    logActivity(ctx, 'project', t.project_id, 'task.status', `${c} ${out.title}: submitted for review`)
    const rev = reviewerOf(ctx, out)
    if (rev && rev !== me) notify(ctx, rev, 'NTF-04', round > 1 ? 'Task resubmitted for review' : 'Task waiting for your review', `${ctx.user.name} submitted ${c} ${out.title}${late ? ` · ${lb}d late (${DELAY_REASON_LABEL[reasonCode!]})` : ''}.`, '/team-tasks?tab=review')
    return out
  })

  /* ---------- approve ---------- */
  r.post('/tasks/:id/approve', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    assertReviewer(ctx, t)
    if (t.status !== 'in_review') err(409, 'INVALID_STATE', t.status === 'done' ? 'This task is already approved.' : 'Only tasks submitted for review can be approved. Ask the owner to submit it.')
    const q = Number(body.quality_rating)
    if (!Number.isInteger(q) || q < 1 || q > 5) err(422, 'VALIDATION', 'Rate the quality of the work from 1 to 5 stars.', 'quality_rating')
    const tw = t as TaskWf
    const legacy = baseReviewerOf(ctx, t)
    const st = ensureWf(ctx, tw, 'task_review', { requester_id: t.owner_id ?? ctx.user.id, reviewer_id: legacy, project_id: isGeneral(ctx, t) ? null : t.project_id }, legacy, reviewerOf(ctx, t))
    const adv = advanceApproval(ctx, st, ctx.user.id)
    if (adv.next) {
      // Multi-step review: record this step and hand the task to the next reviewer.
      const nx = adv.next
      const note = text(body.note) || null
      const out = update(ctx, 'tasks', t.id, { ...wfPatch(adv.state), wf_approver_id: nx.approver_id } as never)
      const c = code(ctx, out)
      logActivity(ctx, 'task', t.id, 'task.review_step', `Step ${st.wf_step + 1} of ${st.wf_chain.length} (${adv.done?.name ?? 'review'}) approved by ${ctx.user.name} · ${q}/5${note ? `: ${note}` : ''}; sent to ${userName(ctx, nx.approver_id)}`)
      notify(ctx, nx.approver_id, 'NTF-04', 'Task waiting for your review', `${c} ${out.title} was approved by ${ctx.user.name} and needs your review (${nx.name}).`, '/team-tasks?tab=review')
      warn(ctx, 'NEXT_APPROVAL', `Step ${st.wf_step + 1} of ${st.wf_chain.length} approved — sent to ${userName(ctx, nx.approver_id)} for ${nx.name.toLowerCase()}.`)
      return out
    }
    const out = approveTask(ctx, t, body.quality_rating, text(body.note) || null)
    return update(ctx, 'tasks', t.id, { ...wfPatch(adv.state), wf_approver_id: null } as never)
  })

  /* ---------- send back ---------- */
  r.post('/tasks/:id/send-back', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    assertReviewer(ctx, t)
    if (t.status !== 'in_review') err(409, 'INVALID_STATE', 'Only tasks waiting for review can be sent back.')
    const reason = text(body.reason)
    if (reason.length < 10) err(422, 'VALIDATION', 'Say what needs to change (at least 10 characters) so the owner can fix it.', 'reason')
    if (reason.length > 2000) err(422, 'VALIDATION', 'Keep the reason under 2,000 characters.', 'reason')
    let newDue: string | null = text(body.new_due_on) || null
    if (newDue) {
      if (!ISO.test(newDue)) err(422, 'VALIDATION', 'The new due date needs a valid date.', 'new_due_on')
      if (newDue < ctx.today) err(422, 'DATE_RANGE', 'The new due date can’t be in the past.', 'new_due_on')
      if (newDue < t.start_on) err(422, 'DATE_RANGE', 'The new due date is before the task starts.', 'new_due_on')
      if (newDue === t.due_on) newDue = null
      else if (!isWorkingDay(newDue, cal(ctx))) warn(ctx, 'NON_WORKING_DAY', `${fmtDate(newDue)} is not a working day.`)
    }
    const rv = openReview(ctx, t)
    if (rv) update(ctx, 'task_reviews', rv.id, { decision: 'sent_back', decided_by: ctx.user.id, decided_at: nowISO(), decision_reason: reason })
    const back = stageOf(t)
    const backStage: E.TaskStage = STAGE[back].group === 'active' || STAGE[back].group === 'testing' ? back : 'in_development'
    const revPatch = newDue ? { due_on: newDue, baseline_due_on: t.baseline_due_on ?? t.due_on, target_revisions: [...(t.target_revisions ?? []), { from: t.due_on, to: newDue, at: nowISO(), by: ctx.user.id, reason: `Sent back: ${reason}` }] } : {}
    const out = update(ctx, 'tasks', t.id, { status: 'in_progress', stage: backStage, progress: Math.min(progressOf(t), 95), ...revPatch, ...wfClear(), wf_approver_id: null } as never)
    if (newDue) syncMilestoneDates(ctx, t.milestone_id)
    const c = code(ctx, out)
    logActivity(ctx, 'task', t.id, 'task.sent_back', `Sent back (round ${rv?.round ?? t.review_round ?? 1}): ${reason}`)
    if (newDue) logActivity(ctx, 'task', t.id, 'task.rescheduled', `Due moved ${fmtDate(t.due_on)} → ${fmtDate(newDue)} on send-back (original due ${t.due_on}): ${reason}`)
    logActivity(ctx, 'project', t.project_id, 'task.status', `${c} ${out.title}: sent back by ${ctx.user.name}`)
    if (t.owner_id && t.owner_id !== ctx.user.id)
      notify(ctx, t.owner_id, 'NTF-06', 'Task sent back', `${ctx.user.name} sent back ${c} ${out.title}: “${reason.length > 120 ? reason.slice(0, 118) + '…' : reason}”${newDue ? ` · now due ${fmtDate(newDue)}` : ''}`, `/tasks/${t.id}`)
    return out
  })

  /* ---------- v5: stage, progress, slip flag, cancel ---------- */
  r.post('/tasks/:id/stage', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    const stage = body.stage as E.TaskStage
    if (!TASK_STAGES.some((s) => s.key === stage)) err(422, 'VALIDATION', 'Choose a valid stage.', 'stage')
    return applyStage(ctx, t, stage, { progress: body.progress, note: body.note, quality_rating: body.quality_rating })
  })

  r.post('/tasks/:id/progress', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    assertCanMove(ctx, t)
    if (t.status === 'done') err(409, 'INVALID_STATE', 'This task is completed. Reopen it to change its progress.', 'progress')
    if (t.status === 'in_review') err(409, 'USE_REVIEW_FLOW', 'This task is waiting for review. The reviewer approves it or sends it back.', 'progress')
    const n = Number(body.progress)
    if (body.progress === '' || body.progress === null || !Number.isInteger(n) || n < 0 || n > 100) err(422, 'VALIDATION', 'Progress must be a whole number from 0 to 100.', 'progress')
    if (n === 100) err(422, 'VALIDATION', 'At 100% the task is finished: set the stage to Completed so it goes through review.', 'progress')
    let stage = stageOf(t)
    if (n < STAGE[stage].minProgress) err(422, 'VALIDATION', `${STAGE[stage].label} means at least ${STAGE[stage].minProgress}% done. Move the task back a stage first.`, 'progress')
    const note = text(body.note)
    if (note.length > 2000) err(422, 'VALIDATION', 'Keep the note under 2,000 characters.', 'note')
    const before = progressOf(t)
    // Progress on a task that hasn't started means work has started: move it into development (dependency rule applies).
    if (n > 0 && STAGE[stage].group === 'not_started') {
      const msg = blockerMessage(ctx, t)
      if (msg) err(409, 'TASK_BLOCKED', msg, 'progress')
      stage = 'in_development'
    }
    const out = update(ctx, 'tasks', t.id, { progress: n, stage, status: statusForStage(stage, t.status), actual_start_on: t.actual_start_on ?? (n > 0 ? ctx.today : null) } as never)
    logActivity(ctx, 'task', t.id, 'task.progress', `Progress ${before}% → ${n}%${note ? `: ${note}` : ''}`)
    if (note) insert(ctx, 'comments', { task_id: t.id, body: `Progress ${before}% → ${n}%. ${note}`, mentions: [], author_id: ctx.user.id, parent_id: null } as never)
    return out
  })

  r.post('/tasks/:id/flag-slip', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task')
    const { p } = assertCanMove(ctx, t)
    if (t.status === 'done') err(409, 'INVALID_STATE', 'This task is completed.', 'note')
    const note = text(body.note)
    if (note.length < 10) err(422, 'VALIDATION', 'Say why it will slip (at least 10 characters). It is kept as an early warning on the task.', 'note')
    let newDue = text(body.new_due_on) || null
    if (newDue) {
      if (!ISO.test(newDue)) err(422, 'VALIDATION', 'The new target end needs a valid date.', 'new_due_on')
      if (newDue < t.start_on) err(422, 'DATE_RANGE', 'The new target end is before the task starts.', 'new_due_on')
      if (newDue < ctx.today) err(422, 'DATE_RANGE', 'The new target end can’t be in the past.', 'new_due_on')
      if (newDue === t.due_on) newDue = null
      else if (!isWorkingDay(newDue, cal(ctx))) warn(ctx, 'NON_WORKING_DAY', `${fmtDate(newDue)} is not a working day.`)
    }
    const patch: Partial<E.Task> = { slip_flagged_on: ctx.today, slip_note: note }
    if (newDue) {
      patch.baseline_due_on = t.baseline_due_on ?? t.due_on
      patch.target_revisions = [...(t.target_revisions ?? []), { from: t.due_on, to: newDue, at: nowISO(), by: ctx.user.id, reason: note }]
      patch.due_on = newDue
    }
    const out = update(ctx, 'tasks', t.id, patch)
    if (newDue) syncMilestoneDates(ctx, t.milestone_id)
    const c = code(ctx, out)
    logActivity(ctx, 'task', t.id, 'task.slip_flagged', `Slip flagged${newDue ? `; target ${fmtDate(t.due_on)} → ${fmtDate(newDue)}` : ''}: ${note}`)
    if (newDue) logActivity(ctx, 'task', t.id, 'task.rescheduled', `Due moved ${fmtDate(t.due_on)} → ${fmtDate(newDue)} (slip flagged early): ${note}`)
    logActivity(ctx, 'project', t.project_id, 'task.slip_flagged', `${c} ${out.title}: slip flagged${newDue ? `, new target ${fmtDate(newDue)}` : ''}`)
    if (p.pm_id && p.pm_id !== ctx.user.id) notify(ctx, p.pm_id, 'NTF-14', `Slip flagged on ${c}`, `${ctx.user.name}: ${note}${newDue ? ` · new target ${fmtDate(newDue)}` : ''}`, `/projects/${p.id}/schedule`)
    return out
  })

  /** Remove a task that already has hours: it can't be deleted (hours feed cost and payroll), so it is closed as cancelled. */
  r.post('/tasks/:id/cancel', ({ ctx, params, body }) => {
    const t = find(ctx, 'tasks', params.id, 'Task') as TaskX
    const { p, editor } = assertCanMove(ctx, t)
    if (!editor) err(403, 'FORBIDDEN', 'Only the project manager can cancel a task.')
    if (t.status === 'done') err(409, 'INVALID_STATE', 'This task is already closed.')
    const reason = text(body.reason)
    if (reason.length < 5) err(422, 'VALIDATION', 'Say why the task is cancelled (at least 5 characters).', 'reason')
    const logged = rows(ctx, 'timesheet_entries').filter((e) => e.task_id === t.id).reduce((s2, e) => s2 + e.hours, 0)
    const out = update(ctx, 'tasks', t.id, {
      status: 'done', stage: 'completed', progress: 100, done_on: ctx.today, est_hours: Math.round(logged * 4) / 4, blocked_reason: null, timeliness: null, variance_days: null, quality_rating: null,
      cancelled_on: ctx.today, cancel_reason: reason, approved_by: ctx.user.id, approved_on: ctx.today,
    } as never)
    syncAchieved(ctx, t.milestone_id)
    const c = code(ctx, out)
    logActivity(ctx, 'task', t.id, 'task.cancelled', `Cancelled with ${logged}h logged: ${reason}`)
    logActivity(ctx, 'project', p.id, 'task.cancelled', `${c} ${out.title} cancelled (${logged}h logged stay on the project cost): ${reason}`)
    if (t.owner_id && t.owner_id !== ctx.user.id) notify(ctx, t.owner_id, 'NTF-14', 'Task cancelled', `${ctx.user.name} cancelled ${c} ${out.title}: ${reason}`, `/tasks/${t.id}`)
    return out
  })

  r.get('/tasks/:id/reviews', ({ ctx, params }) => {
    const tv = find(ctx, 'tasks', params.id, 'Task')
    if (!canSeeTask(ctx, tv) && !canEdit(ctx, find(ctx, 'projects', tv.project_id, 'Project'))) err(403, 'TASK_NOT_VISIBLE', 'This task isn’t yours, so its review history is private.')
    return reviewsOf(ctx, params.id)
  })

  /* ---------- manager screens ---------- */
  r.get('/team-tasks/review-queue', ({ ctx, query }) => {
    const me = ctx.user.id
    const all = String(query.all ?? '') === '1' && wideTaskScope(ctx)
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const reviews = rows(ctx, 'task_reviews')
    const rs = reschedCounts(ctx)
    return rows(ctx, 'tasks')
      .filter((t) => t.status === 'in_review' && (all || (reviewerOf(ctx, t) === me && !selfReview(ctx, t))))
      .map((t): ReviewQueueRow => {
        const base = teamRow(ctx, t, projects, reviews, rs)
        const latest = reviews.filter((x) => x.task_id === t.id).sort((a, b) => b.round - a.round)[0]
        const sub = (t.submitted_on ?? latest?.submitted_at.slice(0, 10)) || ctx.today
        return { ...base, latest, late_at_submission: lateBy(ctx, t.due_on, sub), can_review: canReviewTask(ctx, t) }
      })
      .sort((a, b) => (a.submitted_on ?? '').localeCompare(b.submitted_on ?? '') || a.due_on.localeCompare(b.due_on))
  })

  r.get('/team-tasks', ({ ctx }) => {
    const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const reviews = rows(ctx, 'task_reviews')
    const rs = reschedCounts(ctx)
    const since = addDays(ctx.today, -120)
    return managedTasks(ctx)
      .filter((t) => {
        const s = projects.get(t.project_id)?.status
        return t.status !== 'done' ? s !== 'closed' : (t.done_on ?? '') >= since
      })
      .map((t) => teamRow(ctx, t, projects, reviews, rs))
  })

  r.get('/team-tasks/options', ({ ctx }): AssignOptions => {
    const me = ctx.user.id
    const admin = has(ctx, 'projects.manage_all')
    const gen = generalProjectId(ctx)
    const ms = rows(ctx, 'milestones').filter((m) => !m.deleted_at)
    const projects = rows(ctx, 'projects')
      .filter((p) => ['active', 'initiated'].includes(p.status) && (p.id === gen || admin || p.pm_id === me))
      .sort((a, b) => (a.id === gen ? -1 : b.id === gen ? 1 : a.code.localeCompare(b.code)))
      .map((p) => ({
        id: p.id, code: p.code, name: p.name, general: p.id === gen, anyone: admin || (p.id !== gen && p.pm_id === me),
        milestones: ms.filter((m) => m.project_id === p.id).sort((a, b) => a.no - b.no).map((m) => ({ id: m.id, no: m.no, name: m.name })),
      }))
    return { general_project_id: gen, projects, team_ids: teamOf(ctx, me).map((u) => u.id), is_admin: admin }
  })

  /* ---------- manager assigns a task ---------- */
  r.post('/team-tasks', ({ ctx, body }) => {
    const me = ctx.user.id
    const owner = userOf(ctx, text(body.owner_id))
    if (!owner) err(422, 'VALIDATION', 'Choose who will do this task.', 'owner_id')
    if (owner.status !== 'active') err(422, 'VALIDATION', `${owner.name} is not active. Choose someone on the team today.`, 'owner_id')
    const title = text(body.title)
    if (title.length < 3) err(422, 'VALIDATION', 'Give the task a title (at least 3 characters).', 'title')
    if (title.length > 200) err(422, 'VALIDATION', 'Keep the title under 200 characters.', 'title')
    const description = text(body.description)
    if (description.length > 4000) err(422, 'VALIDATION', 'Keep the description under 4,000 characters.', 'description')
    const pid = text(body.project_id) || generalProjectId(ctx)
    const p = find(ctx, 'projects', pid, 'Project')
    if (!['active', 'initiated'].includes(p.status)) err(422, 'VALIDATION', `${p.code} is ${p.status.replace('_', ' ')}. Assign the task under an active project or General & admin.`, 'project_id')
    const general = p.id === generalProjectId(ctx)
    const allowed = has(ctx, 'projects.manage_all') || (!general && canEdit(ctx, p)) || isManagerOf(ctx, me, owner.id)
    if (!allowed) err(403, 'FORBIDDEN', `You can assign tasks to people in your reporting line, or to anyone on a project you manage. ${owner.name} isn’t in your team.`)
    const start_on = text(body.start_on) || ctx.today
    if (!ISO.test(start_on)) err(422, 'VALIDATION', 'Start needs a valid date.', 'start_on')
    const due_on = text(body.due_on)
    if (!ISO.test(due_on)) err(422, 'VALIDATION', 'Set a due date.', 'due_on')
    if (due_on < start_on) err(422, 'DATE_RANGE', 'The due date is before the start date.', 'due_on')
    if (due_on < ctx.today) err(422, 'DATE_RANGE', 'The due date is in the past. Pick today or later.', 'due_on')
    if (!isWorkingDay(due_on, cal(ctx))) warn(ctx, 'NON_WORKING_DAY', `${fmtDate(due_on)} is not a working day — the task is due on a holiday or weekly off.`)
    const est = Number(body.est_hours)
    if (!Number.isFinite(est) || est < 0.5 || est > 200) err(422, 'VALIDATION', 'Estimated effort must be between 0.5 and 200 hours.', 'est_hours')
    const priority = PRIORITIES.includes(body.priority) ? (body.priority as E.Task['priority']) : 'normal'
    let m: E.Milestone | null = null
    if (body.milestone_id) {
      m = rows(ctx, 'milestones').find((x) => x.id === body.milestone_id && x.project_id === p.id && !x.deleted_at) ?? null
      if (!m) err(422, 'VALIDATION', 'Choose a milestone of this project.', 'milestone_id')
    }
    let reviewer = text(body.reviewer_id) || me
    const rv = userOf(ctx, reviewer)
    if (!rv || rv.status !== 'active') err(422, 'VALIDATION', 'Choose an active reviewer.', 'reviewer_id')
    if (reviewer === owner.id && !isTop(ctx, reviewer)) {
      if (body.reviewer_id) err(422, 'TASK_SELF_REVIEW', 'The reviewer must be someone other than the owner.', 'reviewer_id')
      reviewer = owner.reports_to_id ?? me
    }
    const no = nextTaskNo(ctx, p.id, m?.id ?? null, true)
    const t = insert(ctx, 'tasks', {
      project_id: p.id, milestone_id: m?.id ?? null, no, title, owner_id: owner.id, backup_id: null, est_hours: Math.round(est * 4) / 4, start_on, due_on, done_on: null,
      complexity: (['low', 'medium', 'high', 'very_high'] as E.Complexity[]).includes(body.complexity) ? body.complexity : est > 40 ? 'high' : est > 12 ? 'medium' : 'low', status: 'todo', description, blocked_reason: null,
      stage: 'new', progress: 0, tag: body.tag ?? null, actual_start_on: null, baseline_due_on: due_on, target_revisions: [], slip_flagged_on: null, slip_note: null,
      kind: general ? 'general' : 'project', assigned_by: me, reviewer_id: reviewer, priority, review_round: 0, submitted_on: null, approved_by: null, approved_on: null,
      timeliness: null, variance_days: null, delay_reason_code: null, delay_reason: null, quality_rating: null,
    } as never) as E.Task
    if (m) {
      const wasEmpty = !rows(ctx, 'tasks').some((x) => x.milestone_id === m!.id && x.id !== t.id)
      m.empty_since = null
      if (m.achieved_on) m.achieved_on = null
      syncMilestoneDates(ctx, m.id, wasEmpty)
    }
    const c = `${m ? m.no : 0}.${no}`
    logActivity(ctx, 'task', t.id, 'task.created', `${ctx.user.name} assigned ${c} ${title} to ${owner.name}, due ${fmtDate(due_on)} · reviewer ${userName(ctx, reviewer)}`)
    logActivity(ctx, 'project', p.id, 'task.created', `Assigned ${c} ${title} → ${owner.name}`)
    if (owner.id !== me) notify(ctx, owner.id, 'NTF-14', 'Task assigned to you', `${ctx.user.name}: ${title} · due ${fmtDate(due_on)}${priority === 'urgent' || priority === 'high' ? ` · ${priority} priority` : ''}`, `/tasks/${t.id}`)
    return t
  })

  /* ---------- analytics ---------- */
  r.get('/analytics/tasks', ({ ctx, query }) =>
    taskAnalytics(ctx, { from: query.from as string | undefined, to: query.to as string | undefined, scope: query.scope as string | undefined, group: query.group as string | undefined }),
  )
}

void canEdit
