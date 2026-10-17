// Module E backend: report datasets (tenant-scoped rows), the ReportSpec executor, saved reports,
// and the AI endpoints (rule-based planner + data tools). Numbers are always computed here.
import { canSeeTask } from './tasks'
import type * as E from '@/types/entities'
import type { DatasetId, ReportSpec } from '@/types/reports'
import { err, find, getDb, insert, has, hasAny, logActivity, nowISO, permissionsOf, remove, rows, update, userName, canSeeMargins, canSeeSalaries, type Ctx, type Router } from '../server'
import { allocationOn, avgAllocation, cal, costedEntries, expandLedger, milestoneState, pipeline, projectMetrics, redactMetrics, slaDue, taskActuals } from '../analytics'
import { addDays, addMonths, diffDays, isWorkingDay, monthOf, monthRange, weekStart, workingDaysBetween, workingDaysInMonth, fyStartYear, fyRange } from '@/domain/calendar'
import { costPerHour, rateOn, salesCompensation } from '@/domain/costing'
import { DEAL_STAGE, STREAM } from '@/domain/labels'
import { DATASET_MAP, datasetsFor, fieldOf, type DatasetDefX } from '@/reports/datasets'
import { describeSpec, runSpec, sanitizeSpec, type DataRow, type ReportResultX } from '@/reports/engine'
import { planQuestion, SUGGESTIONS, type PlannerEntities } from '@/reports/planner'
import { narrate } from '@/reports/narrative'
import type * as BZ from '@/types/business'
import { DELAY_REASON_LABEL, taskStats, taskTimeliness, teamOf as perfTeamOf } from '../performance'
import { budgetStatement, leakageRows, poTotal, type BillX, type ExpenseX, type POX } from './spend'
import { METRIC_META } from '@/api/company'
import { revenueBetween } from '../analytics'
import { maxISO, minISO, quarterOf } from '@/domain/calendar'
import { myProjectIds } from './projects'

/* ------------------------------------------------------------------ */
/* Scope helpers                                                        */
/* ------------------------------------------------------------------ */
export const S = (ctx: Ctx) => ctx.tenant.settings
export const nameOf = (ctx: Ctx) => {
  const m = new Map(rows(ctx, 'users').map((u) => [u.id, u.name]))
  return (id: string | null | undefined) => (id ? m.get(id) ?? '—' : null)
}
/** Direct and indirect reports of a manager. */
export function teamOf(ctx: Ctx, mgrId: string): Set<string> {
  const users = rows(ctx, 'users')
  const out = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (depth > 6) return
    for (const u of users) if (u.reports_to_id === id && !out.has(u.id)) {
      out.add(u.id)
      walk(u.id, depth + 1)
    }
  }
  walk(mgrId, 0)
  return out
}
/** Projects in the viewer's scope: projects.view_all → every project; otherwise ones they PM, work on, are allocated to or sold. */
export function myProjects(ctx: Ctx): E.Project[] {
  const all = rows(ctx, 'projects')
  if (has(ctx, 'projects.view_all')) return all
  const ids = myProjectIds(ctx)
  return all.filter((p) => ids.has(p.id))
}
/** Scope of people-level rows (hours, tasks, claims, people):
 *  'all'  — people.view_all (HR, leadership)
 *  'team' — line managers / project managers (team.view or projects.edit): reports + people on projects in scope
 *  'own'  — everyone else: their own rows only. */
export function rowScope(ctx: Ctx): 'all' | 'team' | 'own' {
  if (has(ctx, 'people.view_all')) return 'all'
  if (hasAny(ctx, 'team.view', 'projects.edit')) return 'team'
  return 'own'
}
export function grantsOf(ctx: Ctx) {
  return { margins: canSeeMargins(ctx), salaries: canSeeSalaries(ctx) }
}
export function visibleDatasets(ctx: Ctx): DatasetDefX[] {
  if (!hasAny(ctx, 'reports.view', 'ai.use')) return []
  return datasetsFor(ctx.perms)
}
function aiEnabled(ctx: Ctx) {
  return S(ctx)['ai.enabled'] !== false
}

/** Effective week status: an open week that has ended is locked (BR-06) unless unlocked. */
export function effectiveWeekStatus(ctx: Ctx, w: E.TimesheetWeek | undefined, monday: string): E.WeekStatus | 'missing' {
  const ended = addDays(monday, 6) < ctx.today
  if (!w) return ended ? 'locked' : 'missing'
  if (w.status === 'open' && ended && S(ctx)['timesheet.weekly_lock'] && !(w.unlock_until && w.unlock_until >= ctx.today)) return 'locked'
  return w.status
}

export function taskCode(ms: E.Milestone | undefined, t: E.Task) {
  const frozen = (t as E.Task & { wbs_code?: string | null }).wbs_code
  if (frozen) return frozen
  return `${ms ? ms.no : 0}.${t.no}`
}

/* ------------------------------------------------------------------ */
/* Dataset row builders                                                 */
/* ------------------------------------------------------------------ */
type Builder = (ctx: Ctx) => DataRow[]

const B: Record<DatasetId, Builder> = {
  projects(ctx) {
    const nm = nameOf(ctx)
    const cm = canSeeMargins(ctx)
    return myProjects(ctx).map((p) => {
      const m = redactMetrics(ctx, projectMetrics(ctx, p), cm)
      return {
        id: p.id, code: p.code, name: p.name, client: p.client, type: p.type, status: p.status, stream: p.stream, billing_model: p.billing_model, pm: nm(p.pm_id), priority: p.priority,
        start_on: p.start_on, end_on: p.end_on, contract_value: m.contract_value, invoiced: m.invoiced, collected: m.collected, outstanding: m.outstanding, uninvoiced: m.uninvoiced,
        est_hours: m.est_hours, actual_hours: m.actual_hours, remaining_hours: m.remaining_hours, progress: m.progress, effort_ratio: m.effort_ratio, spi: m.spi,
        planned_cost: m.planned_cost, projected_cost: m.projected_cost, actual_cost: m.actual_cost, projected_margin: m.projected_margin, actual_margin: m.actual_margin, projected_markup: m.projected_markup,
        health: m.health, open_tasks: m.open_tasks, overdue_tasks: m.overdue_tasks, blocked_tasks: m.blocked_tasks, overdue_milestones: m.overdue_milestones,
      }
    })
  },
  milestones(ctx) {
    const nm = nameOf(ctx)
    const projs = new Map(myProjects(ctx).map((p) => [p.id, p]))
    const tasks = rows(ctx, 'tasks')
    return rows(ctx, 'milestones')
      .filter((m) => !m.deleted_at && projs.has(m.project_id))
      .map((m) => {
        const p = projs.get(m.project_id)!
        const st = milestoneState(ctx, m, tasks)
        const open = !m.achieved_on && st.state !== 'achieved_on_time' && st.state !== 'achieved_late'
        return {
          id: m.id, project_id: p.id, label: `M${m.no} ${m.name}`, project: p.name, client: p.client, no: m.no, pm: nm(p.pm_id), planned_start: m.planned_start, planned_end: m.planned_end, baseline_end: m.baseline_end,
          slip_days: diffDays(m.planned_end, m.baseline_end), billing_amount: m.billing_amount_paise, billing_status: m.billing_status, state: st.state, progress: st.progress, achieved_on: m.achieved_on,
          is_overdue: st.state === 'overdue', is_open: open, days_to_due: diffDays(m.planned_end, ctx.today),
        }
      })
  },
  tasks(ctx) {
    const nm = nameOf(ctx)
    const act = taskActuals(ctx)
    const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const mss = new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
    const reviews = reviewsByTask(ctx)
    return visibleTasks(ctx).map((t) => {
      const p = projs.get(t.project_id)
      const ms = t.milestone_id ? mss.get(t.milestone_id) : undefined
      const a = act.get(t.id)?.hours ?? 0
      const open = t.status !== 'done'
      const tl = taskTimeliness(ctx, t)
      const rs = reviews.get(t.id) ?? []
      return {
        id: t.id, project_id: t.project_id, code: taskCode(ms, t), title: t.title, project: p?.name ?? '—', client: p?.client ?? null, milestone: ms ? `M${ms.no} ${ms.name}` : 'No milestone',
        owner: nm(t.owner_id), owner_id: t.owner_id, backup: nm(t.backup_id), status: t.status, complexity: t.complexity, start_on: t.start_on, due_on: t.due_on, done_on: t.done_on,
        days_overdue: open && t.due_on < ctx.today ? diffDays(ctx.today, t.due_on) : 0, is_overdue: open && t.due_on < ctx.today, is_blocked: t.status === 'blocked', is_open: open,
        on_time: tl ? tl.timeliness !== 'late' : null, est: t.est_hours, actual: Math.round(a * 100) / 100, effort_ratio: t.est_hours > 0 && a > 0 ? Math.round((a / t.est_hours) * 1000) / 1000 : null,
        kind: t.kind ?? (p?.code === 'GEN' ? 'general' : 'project'), assigned_by: nm(t.assigned_by), reviewer: nm(t.reviewer_id), priority: t.priority ?? 'normal',
        submitted_on: t.submitted_on ?? null, approved_on: t.approved_on ?? null, timeliness: tl?.timeliness ?? null, variance_days: tl?.variance ?? null,
        delay_reason: t.delay_reason_code ? DELAY_REASON_LABEL[t.delay_reason_code] ?? t.delay_reason_code : t.delay_reason ? 'Other' : null, quality_rating: t.quality_rating ?? null,
        review_rounds: Math.max(rs.length, t.review_round ?? 0), sent_back_count: rs.filter((r) => r.decision === 'sent_back').length,
        on_time_rate: tl ? (tl.timeliness === 'late' ? 0 : 1) : null, is_late: tl?.timeliness === 'late', is_in_review: t.status === 'in_review',
      }
    })
  },
  hours(ctx) {
    const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
    const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
    const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const mss = new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
    const sal = canSeeSalaries(ctx)
    let es = costedEntries(ctx)
    const scope = rowScope(ctx)
    if (scope === 'own') es = es.filter((e) => e.user_id === ctx.user.id)
    else if (scope === 'team') {
      const team = teamOf(ctx, ctx.user.id)
      team.add(ctx.user.id)
      const mine = new Set(myProjects(ctx).map((p) => p.id))
      es = es.filter((e) => team.has(e.user_id) || (e.task_id && mine.has(tasks.get(e.task_id)?.project_id ?? '')))
    }
    return es.map((e) => {
      const t = e.task_id ? tasks.get(e.task_id) : undefined
      const p = t ? projs.get(t.project_id) : undefined
      const u = users.get(e.user_id)
      return {
        date: e.work_date, person: u?.name ?? '—', department: u?.department ?? null, project: p?.name ?? (e.kind === 'task' ? '—' : null), client: p?.client ?? null,
        task: t ? `${taskCode(t.milestone_id ? mss.get(t.milestone_id) : undefined, t)} ${t.title}` : null, kind: e.kind, internal_code: e.internal_code, leave_type: e.leave_type,
        hours: e.hours, approved: e.approved, week_status: e.week_status, cost: sal ? Math.round(e.cost) : null,
      }
    })
  },
  allocations(ctx) {
    const nm = nameOf(ctx)
    const projs = new Map(myProjects(ctx).map((p) => [p.id, p]))
    const mss = new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
    const c = cal(ctx)
    const minH = S(ctx)['calendar.min_hours_per_day']
    return rows(ctx, 'allocations')
      .filter((a) => projs.has(a.project_id))
      .map((a) => {
        const wd = workingDaysBetween(a.from_on, a.to_on, c)
        const ms = a.milestone_id ? mss.get(a.milestone_id) : undefined
        return {
          person: nm(a.user_id), project: projs.get(a.project_id)!.name, milestone: ms ? `M${ms.no} ${ms.name}` : '—', pct: a.pct / 100, from_on: a.from_on, to_on: a.to_on,
          working_days: wd, planned_hours: Math.round(wd * minH * (a.pct / 100) * 10) / 10, is_active: a.from_on <= ctx.today && a.to_on >= ctx.today,
        }
      })
  },
  invoices(ctx) {
    const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const mss = new Map(rows(ctx, 'milestones').map((m) => [m.id, m]))
    return rows(ctx, 'invoices').filter((i) => i.status !== 'draft' && i.status !== 'cancelled').map((i) => {
      const p = projs.get(i.project_id)
      const ms = mss.get(i.milestone_id)
      const out = i.amount_paise - i.paid_amount_paise
      return {
        number: i.number, client: p?.client ?? '—', project: p?.name ?? '—', milestone: ms ? `M${ms.no} ${ms.name}` : '—', stream: p?.stream ?? null, invoiced_on: i.invoiced_on, due_on: i.due_on, paid_on: i.paid_on,
        amount: i.amount_paise, paid: i.paid_amount_paise, outstanding: out, status: out <= 0 ? 'paid' : i.paid_amount_paise > 0 ? 'partial' : 'unpaid',
        days_overdue: out > 0 && i.due_on < ctx.today ? diffDays(ctx.today, i.due_on) : 0, is_overdue: out > 0 && i.due_on < ctx.today, age_days: diffDays(ctx.today, i.invoiced_on),
      }
    })
  },
  ledger(ctx) {
    const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
    const invs = new Map(rows(ctx, 'invoices').map((i) => [i.id, i]))
    const all = rows(ctx, 'ledger_entries')
    const from = all.reduce((m, e) => (e.date < m ? e.date : m), ctx.today)
    const out: DataRow[] = expandLedger(ctx, from, addDays(ctx.today, 400)).map((e) => {
      const p = e.project_id ? projs.get(e.project_id) : undefined
      const client = p?.client ?? (e.description.includes(' — ') ? e.description.split(' — ').pop()!.trim() : null)
      const inc = e.kind === 'income'
      const collected = inc && !e.invoice_id && e.status === 'received' ? e.amount_paise : 0
      return {
        date: e.occurrence, kind: e.kind, category: e.category, description: e.description, stream: e.stream, project: p?.name ?? null, client: client && client !== 'Internal' ? client : null,
        amount: e.amount_paise, billed: inc ? e.amount_paise : 0, collected, spent: inc ? 0 : e.amount_paise, net: inc ? e.amount_paise : -e.amount_paise, status: e.status, entry: 'entry', recurring: e.recurring,
      }
    })
    for (const pay of rows(ctx, 'payments')) {
      const inv = invs.get(pay.invoice_id)
      if (!inv) continue
      const p = projs.get(inv.project_id)
      out.push({
        date: pay.paid_on, kind: 'income', category: 'Payment received', description: `${inv.number} · ${pay.reference}`, stream: p?.stream ?? null, project: p?.name ?? null, client: p?.client ?? null,
        amount: null, billed: 0, collected: pay.amount_paise, spent: 0, net: 0, status: 'received', entry: 'payment', recurring: false,
      })
    }
    return out
  },
  deals(ctx) {
    const nm = nameOf(ctx)
    const stale = S(ctx)['sales.stale_deal_days']
    return rows(ctx, 'deals').map((d) => {
      const open = d.stage !== 'won' && d.stage !== 'lost'
      const created = d.created_at.slice(0, 10)
      const idle = diffDays(ctx.today, d.last_activity_on)
      return {
        id: d.id, title: d.title, client: d.client, product: d.product, source: d.source, stage: d.stage, owner: nm(d.owner_id), is_open: open, is_won: d.stage === 'won', is_lost: d.stage === 'lost',
        value: d.value_paise, mrr: d.mrr_paise, weighted: open ? Math.round(d.value_paise * DEAL_STAGE[d.stage].chance) : d.stage === 'won' ? d.value_paise : 0, chance: DEAL_STAGE[d.stage].chance,
        win: d.stage === 'won' ? 1 : d.stage === 'lost' ? 0 : null, created_on: created, expected_close: d.expected_close, won_on: d.won_on, lost_on: d.lost_on, closed_on: d.won_on ?? d.lost_on ?? null,
        last_activity_on: d.last_activity_on, days_idle: open ? idle : null, is_stale: open && idle >= stale, cycle_days: d.won_on ? diffDays(d.won_on, created) : null, lost_reason: d.lost_reason,
      }
    })
  },
  deal_activities(ctx) {
    const nm = nameOf(ctx)
    const deals = new Map(rows(ctx, 'deals').map((d) => [d.id, d]))
    return rows(ctx, 'deal_activities').map((a) => {
      const d = deals.get(a.deal_id)
      return { date: a.date, type: a.type, deal: d?.title ?? '—', client: d?.client ?? null, stage: d?.stage ?? null, owner: nm(a.by), note: a.note }
    })
  },
  payroll(ctx) {
    return payrollRows(ctx)
  },
  people(ctx) {
    return peopleRows(ctx)
  },
  ops(ctx) {
    const nm = nameOf(ctx)
    return rows(ctx, 'ops_items').map((o) => ({
      item: o.item, category: o.category, owner: nm(o.owner_id), due_on: o.due_on, recurring: o.recurring, status: o.status, is_overdue: o.status === 'open' && o.due_on < ctx.today,
      days_overdue: o.status === 'open' && o.due_on < ctx.today ? diffDays(ctx.today, o.due_on) : 0, last_done_on: o.last_done_on,
    }))
  },
  task_reviews: taskReviewRows,
  leave_requests: leaveRows,
  expenses: expenseRows,
  purchases: purchaseRows,
  vendor_bills: vendorBillRows,
  budget_vs_actual: budgetRows,
  revenue_leakage: leakageDataRows,
  appraisals: appraisalRows,
  candidates: candidateRows,
  documents: documentRows,
  okr_key_results: okrRows,
}

/* ------------------------------------------------------------------ */
/* v3 business datasets                                                 */
/* ------------------------------------------------------------------ */
/** Tasks the viewer may report on — v7: the task visibility rule (tasks.view_all → every task; otherwise only tasks
 *  they own, cover, back up, review, are the concerned manager / PM / assigner of, watch or were tagged on). */
function visibleTasks(ctx: Ctx): E.Task[] {
  const tasks = rows(ctx, 'tasks')
  if (has(ctx, 'tasks.view_all')) return tasks
  return tasks.filter((t) => canSeeTask(ctx, t))
}
function reviewsByTask(ctx: Ctx) {
  const m = new Map<string, BZ.TaskReview[]>()
  for (const r of rows(ctx, 'task_reviews')) (m.get(r.task_id) ?? m.set(r.task_id, []).get(r.task_id)!).push(r)
  return m
}

function taskReviewRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const tasks = new Map(visibleTasks(ctx).map((t) => [t.id, t]))
  const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  return rows(ctx, 'task_reviews')
    .filter((r) => tasks.has(r.task_id))
    .map((r) => {
      const t = tasks.get(r.task_id)!
      const p = projs.get(t.project_id)
      const sub = r.submitted_at.slice(0, 10)
      const dec = r.decided_at ? r.decided_at.slice(0, 10) : null
      return {
        task: t.title, project: p?.name ?? '—', task_kind: t.kind ?? (p?.code === 'GEN' ? 'general' : 'project'), owner: nm(r.submitted_by ?? t.owner_id), reviewer: nm(r.decided_by ?? t.reviewer_id ?? p?.pm_id ?? null),
        round: r.round, submitted_at: sub, decision: r.decision ?? 'pending', decided_at: dec, decision_reason: r.decision === 'sent_back' ? r.decision_reason : null, quality_rating: r.quality_rating,
        delay_reason: r.delay_reason_code ? DELAY_REASON_LABEL[r.delay_reason_code] ?? r.delay_reason_code : r.delay_reason ? 'Other' : null, late_at_submission: sub > t.due_on,
        is_sent_back: r.decision === 'sent_back', is_approved: r.decision === 'approved', is_pending: !r.decision, days_to_decide: dec ? diffDays(dec, sub) : null,
      }
    })
}

function leaveRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  const me = ctx.user.id
  const hr = has(ctx, 'people.manage')
  const team = teamOf(ctx, me)
  return rows(ctx, 'leave_requests')
    .filter((r) => hr || r.user_id === me || r.approver_id === me || team.has(r.user_id))
    .map((r) => ({
      person: nm(r.user_id), manager: nm(users.get(r.user_id)?.reports_to_id), type: r.type, from_on: r.from_on, to_on: r.to_on, days: r.days, status: r.status, approver: nm(r.approver_id),
      decided_by: nm(r.decided_by), decision_reason: r.decision_reason, reason: r.reason, applied_on: r.created_at.slice(0, 10), is_pending: r.status === 'pending', is_approved: r.status === 'approved',
    }))
}

function expenseRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const me = ctx.user.id
  let list = rows(ctx, 'expense_claims') as ExpenseX[]
  // Finance-side roles (expenses.pay / finance.view) and HR see every claim.
  const scope = hasAny(ctx, 'expenses.pay', 'finance.view') ? 'all' : rowScope(ctx)
  if (scope === 'team') {
    const mine = new Set(myProjects(ctx).map((p) => p.id))
    const team = teamOf(ctx, me)
    list = list.filter((e) => e.user_id === me || e.approver_id === me || team.has(e.user_id) || (e.project_id && mine.has(e.project_id)))
  } else if (scope === 'own') list = list.filter((e) => e.user_id === me || e.approver_id === me)
  // drafts are private to their author
  list = list.filter((e) => e.status !== 'draft' || e.user_id === me)
  return list.map((e) => ({
    person: nm(e.user_id), project: e.project_id ? projs.get(e.project_id)?.name ?? '—' : null, category: e.category, description: e.description, amount: e.amount_paise, spent_on: e.spent_on, status: e.status,
    approver: nm(e.decided_by ?? e.approver_id), in_budget: e.in_budget, billable: e.billable_to_client, paid_on: e.paid_on, is_unpaid: e.status === 'approved' && !e.paid_on, is_pending: e.status === 'submitted',
  }))
}

function purchaseRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const vendors = new Map(rows(ctx, 'vendors').map((v) => [v.id, v]))
  const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const bills = rows(ctx, 'vendor_bills')
  return (rows(ctx, 'purchase_orders') as POX[]).map((po) => ({
    number: po.number, title: po.title ?? po.lines.map((l) => l.description).join(', '), vendor: vendors.get(po.vendor_id)?.name ?? '—', category: po.budget_category, project: po.project_id ? projs.get(po.project_id)?.name ?? '—' : null,
    amount: poTotal(po), status: po.status, requested_by: nm(po.requested_by), approver: nm(po.decided_by ?? po.approver_id), approved: po.status === 'approved' || po.status === 'closed', is_pending: po.status === 'pending',
    over_budget: !!po.over_budget, raised_on: po.created_at.slice(0, 10), needed_by: po.needed_by, billed: bills.filter((b) => b.po_id === po.id && b.status !== 'disputed').reduce((a, b) => a + b.amount_paise + b.gst_paise, 0),
  }))
}

function vendorBillRows(ctx: Ctx): DataRow[] {
  const vendors = new Map(rows(ctx, 'vendors').map((v) => [v.id, v]))
  const pos = new Map((rows(ctx, 'purchase_orders') as POX[]).map((p) => [p.id, p]))
  return (rows(ctx, 'vendor_bills') as BillX[]).map((b) => {
    const unpaid = b.status !== 'paid'
    const overdue = unpaid && b.status !== 'disputed' && b.due_on < ctx.today
    return {
      number: b.number, vendor: vendors.get(b.vendor_id)?.name ?? '—', po: b.po_id ? pos.get(b.po_id)?.number ?? null : null, category: b.category ?? (b.po_id ? pos.get(b.po_id)?.budget_category : null) ?? vendors.get(b.vendor_id)?.category ?? 'Other',
      amount: b.amount_paise, gst: b.gst_paise, tds: b.tds_paise, total: b.amount_paise + b.gst_paise, payable: b.amount_paise + b.gst_paise - b.tds_paise, bill_date: b.bill_date, due_on: b.due_on, status: b.status, paid_on: b.paid_on,
      is_overdue: overdue, is_unpaid: unpaid, days_overdue: overdue ? diffDays(ctx.today, b.due_on) : 0,
    }
  })
}

/** Budget vs actual per category-month, straight from the Spend module's budgetStatement (current and previous FY). */
function budgetRows(ctx: Ctx): DataRow[] {
  const fy = fyStartYear(ctx.today, S(ctx)['company.fy_start_month'])
  const out: DataRow[] = []
  for (const y of [fy - 1, fy]) {
    const st = budgetStatement(ctx, y)
    if (!st.has_budgets && !st.expense.length && !st.revenue.length) continue
    for (const l of [...st.expense, ...st.revenue]) {
      const overYtd = l.kind === 'expense' && l.over && l.ytd_actual > 0
      st.months.forEach((m, i) => {
        const budget = l.monthly_budget[i] ?? 0
        const actual = (l.monthly_actual[i] ?? 0) + (l.monthly_committed[i] ?? 0)
        const variance = l.kind === 'expense' ? budget - actual : actual - budget
        out.push({
          category: l.label, kind: l.kind, month: `${m}-01`, budget, actual, variance, variance_pct: budget ? variance / budget : null,
          is_over: l.kind === 'expense' ? actual > budget : actual < budget, over_budget_ytd: overYtd, has_budget: l.has_budget,
        })
      })
    }
  }
  return out
}

function leakageDataRows(ctx: Ctx): DataRow[] {
  return leakageRows(ctx).map((r) => ({
    kind: r.kind, client: r.client, project: r.project_name, amount: r.amount_paise, recovered: r.recovered_paise, net: r.amount_paise - r.recovered_paise, date: r.date, status: r.status, auto: r.auto,
    recoverable: r.recoverable, reason: r.reason, source: r.source ?? (r.auto ? 'System' : 'Recorded manually'),
  }))
}

/* Appraisal system score — mirrors computeMetrics in routes/hr.ts (not exported there). Completed appraisals use the stored snapshot. */
function tsCompliance(ctx: Ctx, u: E.User, from: string, to: string) {
  const weeksAll = rows(ctx, 'timesheet_weeks')
  const adopted = weeksAll.reduce((m, w) => (w.week_start < m ? w.week_start : m), ctx.today)
  const start = weekStart(maxISO(maxISO(from, u.joined_on), adopted))
  const end = minISO(to, addDays(weekStart(ctx.today), -1))
  const by = new Map(weeksAll.filter((w) => w.user_id === u.id).map((w) => [w.week_start, w]))
  let expected = 0
  let approved = 0
  let late = 0
  for (let m = start; addDays(m, 6) <= end; m = addDays(m, 7)) {
    expected++
    const w = by.get(m)
    if (w?.status === 'approved') approved++
    if (w?.late) late++
  }
  return { late, pct: expected ? approved / expected : null }
}
function approvalSlaOf(ctx: Ctx, managerId: string, from: string, to: string) {
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
function liveAppraisalMetrics(ctx: Ctx, a: BZ.Appraisal, c: BZ.AppraisalCycle): { on_time_pct: number | null; suggested: number | null } {
  const u = rows(ctx, 'users').find((x) => x.id === a.user_id)
  if (!u) return { on_time_pct: null, suggested: null }
  const r1 = (n: number) => Math.round(n * 10) / 10
  const ts = taskStats(ctx, { userIds: [a.user_id], from: c.period_from, to: c.period_to })
  const tc = tsCompliance(ctx, u, c.period_from, c.period_to)
  const goals = rows(ctx, 'goals').filter((g) => g.user_id === a.user_id && g.cycle_id === c.id && g.manager_approved && g.weight > 0)
  const gw = goals.reduce((s, g) => s + g.weight, 0)
  const gs = gw ? goals.reduce((s, g) => s + g.weight * Math.min(1, g.target ? g.current / g.target : 0), 0) / gw : null
  const isMgr = rows(ctx, 'users').some((x) => x.reports_to_id === a.user_id)
  const sla = isMgr ? approvalSlaOf(ctx, a.user_id, c.period_from, c.period_to) : null
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
  const comps: [number | null, number][] = [[gs === null ? null : scale(gs), c.weights.goals], [scoreTasks, c.weights.tasks], [scoreTs, c.weights.timesheets], [a.manager_rating, c.weights.behaviour]]
  const avail = comps.filter((x) => x[0] !== null && x[1] > 0)
  const wsum = avail.reduce((s, x) => s + x[1], 0)
  return { on_time_pct: ts.on_time_pct, suggested: wsum ? r1(avail.reduce((s, x) => s + (x[0] as number) * x[1], 0) / wsum) : null }
}
function appraisalRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const hr = has(ctx, 'appraisals.manage')
  const team = teamOf(ctx, ctx.user.id)
  const cycles = new Map(rows(ctx, 'appraisal_cycles').map((c) => [c.id, c]))
  return rows(ctx, 'appraisals')
    .filter((a) => cycles.has(a.cycle_id) && (hr || (a.user_id !== ctx.user.id && (a.manager_id === ctx.user.id || team.has(a.user_id)))))
    .map((a) => {
      const c = cycles.get(a.cycle_id)!
      const done = a.status === 'completed'
      const snap = a.metrics as Record<string, number | null>
      const m = done && snap && Object.keys(snap).length ? { on_time_pct: snap.on_time_pct ?? null, suggested: snap.suggested ?? null } : liveAppraisalMetrics(ctx, a, c)
      return {
        cycle: c.name, period_from: c.period_from, person: nm(a.user_id), manager: nm(a.manager_id), status: a.status, self_rating: a.self_rating, manager_rating: a.manager_rating, final_rating: a.final_rating,
        increment_pct: a.increment_pct === null ? null : a.increment_pct / 100, on_time_pct: m.on_time_pct, system_score: m.suggested, is_completed: done, promotion_to: a.promotion_to,
      }
    })
}

function candidateRows(ctx: Ctx): DataRow[] {
  if (!has(ctx, 'recruitment.manage')) return []
  const sal = canSeeSalaries(ctx)
  const openings = new Map(rows(ctx, 'openings').map((o) => [o.id, o]))
  const log = rows(ctx, 'activity_log').filter((x) => x.entity === 'candidate' && x.action === 'hired')
  return rows(ctx, 'candidates').map((c) => {
    const hiredAt = c.stage === 'hired' ? (log.find((x) => x.entity_id === c.id)?.at ?? c.updated_at).slice(0, 10) : ctx.today
    return {
      opening: openings.get(c.opening_id)?.role ?? '—', name: c.name, source: c.source, stage: c.stage, experience: c.experience_years, expected_ctc: sal ? c.expected_ctc_paise : null,
      days_in_pipeline: Math.max(0, diffDays(hiredAt, c.created_at.slice(0, 10))), applied_on: c.created_at.slice(0, 10), rating: c.rating,
      is_active: !['hired', 'rejected', 'withdrawn'].includes(c.stage), is_hired: c.stage === 'hired',
    }
  })
}

/* Documents — visibility mirrors routes/documents.ts (canSeeAs / canManageAs / isRequired, not exported there). */
function documentRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const projs = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const members = new Map<string, Set<string>>()
  const add = (p: string, u: string | null | undefined) => {
    if (!u) return
    if (!members.has(p)) members.set(p, new Set())
    members.get(p)!.add(u)
  }
  for (const t of rows(ctx, 'tasks')) {
    add(t.project_id, t.owner_id)
    add(t.project_id, t.backup_id)
  }
  for (const a of rows(ctx, 'allocations')) add(a.project_id, a.user_id)
  for (const p of projs.values()) add(p.id, p.pm_id)
  const pmOf = (pid: string | null) => (pid ? projs.get(pid)?.pm_id ?? null : null)
  type V = { id: string; perms: ReadonlySet<string> }
  const canManageAs = (v: V, d: BZ.DocumentRec) => (!d.project_id ? v.perms.has('documents.company') : (v.perms.has('documents.manage') && (v.perms.has('documents.view_all') || pmOf(d.project_id) === v.id)))
  const canSeeAs = (v: V, d: BZ.DocumentRec) => {
    if (d.archived && !canManageAs(v, d)) return false
    if (d.visibility === 'company') return true
    if (v.perms.has('documents.view_all')) return true
    if (!d.project_id) return v.perms.has('documents.manage') || v.perms.has('documents.company')
    if (pmOf(d.project_id) === v.id) return true
    if (d.visibility === 'managers') return false
    return members.get(d.project_id)?.has(v.id) ?? false
  }
  const isRequired = (v: V, d: BZ.DocumentRec) => {
    if (!canSeeAs(v, d)) return false
    if (!d.project_id || d.visibility === 'company') return true
    if (pmOf(d.project_id) === v.id) return true
    if (d.visibility === 'managers') return v.perms.has('documents.view_all')
    return members.get(d.project_id)?.has(v.id) ?? false
  }
  const me: V = { id: ctx.user.id, perms: ctx.perms }
  const active = rows(ctx, 'users').filter((u) => u.status === 'active')
  const acks = rows(ctx, 'document_acks')
  const versions = rows(ctx, 'document_versions')
  return rows(ctx, 'documents')
    .filter((d) => canSeeAs(me, d))
    .map((d) => {
      const cur = acks.filter((a) => a.document_id === d.id && a.version === d.current_version)
      let acknowledged: number | null = null
      let pending: number | null = null
      let audience: number | null = null
      if (d.must_read && canManageAs(me, d)) {
        const aud = active.filter((u) => isRequired({ id: u.id, perms: new Set(permissionsOf(u)) }, d))
        const ids = new Set(aud.map((u) => u.id))
        audience = aud.length
        acknowledged = new Set(cur.filter((a) => ids.has(a.user_id)).map((a) => a.user_id)).size
        pending = audience - acknowledged
      }
      const v = versions.find((x) => x.document_id === d.id && x.version === d.current_version)
      return {
        title: d.title, project: d.project_id ? projs.get(d.project_id)?.name ?? '—' : 'Company library', category: d.category, visibility: d.visibility, version: d.current_version, must_read: d.must_read,
        acknowledged, pending, audience, ack_pct: audience ? (acknowledged ?? 0) / audience : null,
        my_ack: !d.must_read ? 'not_required' : cur.some((a) => a.user_id === me.id) ? 'acknowledged' : isRequired(me, d) ? 'pending' : 'not_required',
        owner: nm(d.owner_id), updated_on: (v?.uploaded_at ?? d.updated_at).slice(0, 10), archived: d.archived,
      }
    })
}

/* OKR key results — auto values mirror autoValue/statusOf in routes/company.ts (not exported there). */
function okrRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const fyS = S(ctx)['company.fy_start_month']
  const objectives = rows(ctx, 'objectives')
  const objMap = new Map(objectives.map((o) => [o.id, o]))
  const finance = has(ctx, 'finance.view')
  const seeFinance = (metric: BZ.KeyResult['metric']) => !METRIC_META[metric].finance || finance || (metric === 'deals_won_value' && hasAny(ctx, 'deals.edit_own', 'projects.edit'))
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
  const progressOf = (start: number, target: number, current: number | null) => (current === null || current === undefined ? null : target === start ? (current === target ? 1 : 0) : clamp01((current - start) / (target - start)))
  const elapsedOf = (from: string, to: string) => (ctx.today < from ? 0 : ctx.today > to ? 1 : clamp01((diffDays(ctx.today, from) + 1) / (diffDays(to, from) + 1)))
  const statusOf = (p: number | null, expected: number, started: boolean) => {
    if (!started) return 'not_started'
    if (p === null || p >= 1) return 'on_track'
    const e = Math.max(expected, 0.02)
    return p >= 0.9 * e ? 'on_track' : p >= 0.6 * e ? 'at_risk' : 'off_track'
  }
  const scopeOf = (o: BZ.Objective): string[] | null => (o.level === 'company' ? null : o.level === 'team' ? [o.owner_id, ...perfTeamOf(ctx, o.owner_id).map((u) => u.id)] : [o.owner_id])
  const compliance = (from: string, to: string, ids: string[] | null) => {
    const users = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && (!ids || ids.includes(u.id)))
    const byKey = new Map(rows(ctx, 'timesheet_weeks').map((w) => [w.user_id + '|' + w.week_start, w]))
    let due = 0
    let ok = 0
    const lastMonday = addDays(weekStart(ctx.today), -7)
    for (let mon = weekStart(from); mon <= lastMonday && mon <= to; mon = addDays(mon, 7))
      for (const u of users) {
        if (u.joined_on > addDays(mon, 6)) continue
        due++
        const w = byKey.get(u.id + '|' + mon)
        if (w && (w.status === 'submitted' || w.status === 'approved')) ok++
      }
    return due ? (ok / due) * 100 : null
  }
  const autoValue = (o: BZ.Objective, kr: BZ.KeyResult): number | null => {
    const from = o.period_from
    const to = o.period_to < ctx.today ? o.period_to : ctx.today
    if (from > ctx.today) return null
    const ids = scopeOf(o)
    const early = workingDaysBetween(from, to, cal(ctx)) < 10
    const rFrom = early ? addDays(ctx.today, -29) : from
    switch (kr.metric) {
      case 'revenue_billed':
        return revenueBetween(ctx, from, to).billed
      case 'revenue_collected':
        return revenueBetween(ctx, from, to).collected
      case 'deals_won_value':
        return rows(ctx, 'deals').filter((d) => d.stage === 'won' && d.won_on && d.won_on >= from && d.won_on <= to && (!ids || ids.includes(d.owner_id))).reduce((s, d) => s + d.value_paise, 0)
      case 'on_time_task_pct': {
        const s = taskStats(ctx, { userIds: ids ?? undefined, from: rFrom, to })
        return s.on_time_pct === null ? null : Math.round(s.on_time_pct * 1000) / 10
      }
      case 'timesheet_compliance': {
        const lastMonday = addDays(weekStart(ctx.today), -7)
        const cFrom = early || weekStart(from) > lastMonday ? addDays(lastMonday, -21) : from
        const v = compliance(cFrom, to, ids)
        return v === null ? null : Math.round(v * 10) / 10
      }
      case 'margin_pct': {
        const r = revenueBetween(ctx, rFrom, to)
        return r.margin === null ? null : Math.round(r.margin * 1000) / 10
      }
      case 'headcount':
        return rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && (!ids || ids.includes(u.id))).length
      case 'leakage':
        return rows(ctx, 'revenue_leakage').filter((x) => x.date >= from && x.date <= to && x.status !== 'recovered').reduce((s, x) => s + x.amount_paise - (x.recovered_paise ?? 0), 0)
      default:
        return kr.current
    }
  }
  const krs = rows(ctx, 'key_results')
  const objProgress = new Map<string, number[]>()
  const out: DataRow[] = []
  const pending: { row: DataRow; o: BZ.Objective }[] = []
  for (const k of krs) {
    const o = objMap.get(k.objective_id)
    if (!o) continue
    const auto = k.metric !== 'manual'
    const current = auto ? autoValue(o, k) : k.current
    const progress = progressOf(k.start_value, k.target, current)
    const visible = seeFinance(k.metric)
    const money = METRIC_META[k.metric].kind === 'money' || (k.metric === 'manual' && k.unit === '₹')
    const show = (v: number | null) => (!visible || v === null ? null : money ? Math.round(v / 100) : v)
    const expected = elapsedOf(o.period_from, o.period_to)
    const row: DataRow = {
      objective: o.title, key_result: k.title, level: o.level, owner: nm(k.owner_id), objective_owner: nm(o.owner_id), period: o.period || quarterOf(o.period_from, fyS).label, period_from: o.period_from,
      metric: k.metric, current: show(current), target: show(k.target), unit: money ? '₹' : k.unit, progress_pct: progress, status: o.status === 'done' ? 'done' : statusOf(progress, expected, ctx.today >= o.period_from),
      objective_status: null, auto,
    }
    pending.push({ row, o })
    const list = objProgress.get(o.id) ?? []
    if (progress !== null) list.push(progress)
    objProgress.set(o.id, list)
  }
  for (const { row, o } of pending) {
    const ps = objProgress.get(o.id) ?? []
    const p = ps.length ? ps.reduce((s, x) => s + x, 0) / ps.length : null
    row.objective_status = o.status === 'done' ? 'done' : statusOf(p, elapsedOf(o.period_from, o.period_to), ctx.today >= o.period_from)
    out.push(row)
  }
  return out
}

/** Payroll lines from runs; months without a run in the FY (up to this month) are estimated from CTC. */
function payrollRows(ctx: Ctx): DataRow[] {
  const users = rows(ctx, 'users')
  const umap = new Map(users.map((u) => [u.id, u]))
  const runs = rows(ctx, 'payroll_runs')
  const lines = rows(ctx, 'payroll_lines')
  const out: DataRow[] = []
  const covered = new Set<string>()
  for (const run of runs) {
    for (const l of lines.filter((x) => x.run_id === run.id)) {
      const u = umap.get(l.user_id)
      covered.add(`${run.month}|${l.user_id}`)
      out.push({ month: `${run.month}-01`, person: u?.name ?? '—', department: u?.department ?? null, role: u?.role ?? null, ctc: l.monthly_ctc_paise, base: l.base_paise, deduction: l.deduction_paise, variable: l.variable_paise, net: l.net_paise, working_days: l.working_days, unapproved_days: l.unapproved_days, lwp_days: l.lwp_days, status: run.status })
    }
  }
  const rates = rows(ctx, 'cost_rates')
  const deals = rows(ctx, 'deals')
  const c = cal(ctx)
  const fyS = S(ctx)['company.fy_start_month']
  const start = addMonths(fyRange(fyStartYear(ctx.today, fyS) - 1, fyS).from, 0)
  for (let m = start; monthOf(m) <= monthOf(ctx.today); m = addMonths(m, 1)) {
    const ym = monthOf(m)
    const end = monthRange(ym).to
    for (const u of users) {
      if (u.is_super_admin || u.status === 'invited' || covered.has(`${ym}|${u.id}`)) continue
      if (u.joined_on > end) continue
      const r = rateOn(rates, u.id, end)
      if (!r) continue
      const achieved = deals.filter((d) => d.owner_id === u.id && d.stage === 'won' && d.won_on && monthOf(d.won_on) === ym).reduce((s, d) => s + d.value_paise, 0)
      const comp = salesCompensation(r.monthly_ctc_paise, r.variable_pct, r.sales_target_paise, achieved, S(ctx)['pay.variable_threshold_pct'])
      out.push({ month: `${ym}-01`, person: u.name, department: u.department, role: u.role, ctc: r.monthly_ctc_paise, base: comp.base, deduction: 0, variable: comp.variableEarned, net: comp.base + comp.variableEarned, working_days: workingDaysInMonth(ym, c), unapproved_days: 0, lwp_days: 0, status: 'estimate' })
    }
  }
  return out
}

/** Weekly timesheet status grid for the last `n` completed weeks (oldest first). */
export function weekHistory(ctx: Ctx, userId: string, n: number, endMonday = addDays(weekStart(ctx.today), -7)) {
  const weeks = rows(ctx, 'timesheet_weeks').filter((w) => w.user_id === userId)
  const byStart = new Map(weeks.map((w) => [w.week_start, w]))
  const out: { week_start: string; status: E.WeekStatus | 'missing' }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const mon = addDays(endMonday, -7 * i)
    out.push({ week_start: mon, status: effectiveWeekStatus(ctx, byStart.get(mon), mon) })
  }
  return out
}
export function isTimesheetUser(u: E.User) {
  return u.status === 'active' && !u.is_super_admin
}

function peopleRows(ctx: Ctx): DataRow[] {
  const nm = nameOf(ctx)
  const sal = canSeeSalaries(ctx)
  const rates = rows(ctx, 'cost_rates')
  const tasks = rows(ctx, 'tasks')
  const act = taskActuals(ctx)
  const entries = costedEntries(ctx)
  const c = cal(ctx)
  const minH = S(ctx)['calendar.min_hours_per_day']
  let users = rows(ctx, 'users').filter(isTimesheetUser)
  if (rowScope(ctx) !== 'all') {
    const team = teamOf(ctx, ctx.user.id)
    const mine = new Set(myProjects(ctx).map((p) => p.id))
    for (const t of tasks) if (mine.has(t.project_id) && t.owner_id) team.add(t.owner_id)
    team.add(ctx.user.id)
    users = users.filter((u) => team.has(u.id))
  }
  let d = ctx.today
  const next10: string[] = []
  while (next10.length < 10) {
    if (isWorkingDay(d, c)) next10.push(d)
    d = addDays(d, 1)
  }
  const from30 = addDays(ctx.today, -29)
  return users.map((u) => {
    const r = rateOn(rates, u.id, ctx.today)
    const mine = tasks.filter((t) => t.owner_id === u.id)
    const done = mine.filter((t) => t.status === 'done')
    const doneEst = done.reduce((s, t) => s + t.est_hours, 0)
    const doneAct = done.reduce((s, t) => s + (act.get(t.id)?.hours ?? 0), 0)
    const hist = weekHistory(ctx, u.id, 8)
    const ok = hist.filter((h) => h.status === 'approved' || h.status === 'submitted').length
    const last = hist[hist.length - 1]
    return {
      name: u.name, title: u.title, role: u.role, department: u.department, manager: nm(u.reports_to_id), joined_on: u.joined_on,
      ctc: sal && r ? r.monthly_ctc_paise : null, cost_per_hour: sal && r ? Math.round(costPerHour(r.monthly_ctc_paise, workingDaysInMonth(monthOf(ctx.today), c), minH)) : null,
      allocation_today: allocationOn(ctx, u.id, ctx.today) / 100, allocation_next_10d: next10.reduce((s, x) => s + allocationOn(ctx, u.id, x), 0) / 10 / 100,
      open_tasks: mine.filter((t) => t.status !== 'done').length, overdue_tasks: mine.filter((t) => t.status !== 'done' && t.due_on < ctx.today).length,
      effort_ratio: doneEst && doneAct ? Math.round((doneAct / doneEst) * 1000) / 1000 : null, on_time: done.length ? done.filter((t) => t.done_on && t.done_on <= t.due_on).length / done.length : null,
      hours_30d: entries.filter((e) => e.user_id === u.id && e.work_date >= from30 && e.kind !== 'leave').reduce((s, e) => s + e.hours, 0),
      last_week_status: last.status === 'missing' ? 'locked' : last.status, unsubmitted_weeks_8w: hist.length - ok, ts_compliance_8w: ok / hist.length,
    }
  })
}

/** Rows for a dataset, with any field the viewer can't see stripped (defence in depth). */
export function datasetRows(ctx: Ctx, id: DatasetId): { ds: DatasetDefX; rows: DataRow[] } {
  const ds = visibleDatasets(ctx).find((d) => d.id === id)
  if (!ds) err(403, 'FORBIDDEN', `Your role can’t report on ${DATASET_MAP[id]?.label.toLowerCase() ?? id}. Ask an admin if you need it.`)
  const allowed = new Set(ds.fields.map((f) => f.key))
  const raw = B[id](ctx)
  const hidden = DATASET_MAP[id].fields.filter((f) => !allowed.has(f.key)).map((f) => f.key)
  if (hidden.length) for (const r of raw) for (const k of hidden) r[k] = null
  return { ds, rows: raw }
}

export function executeSpec(ctx: Ctx, spec: Partial<ReportSpec>): ReportResultX {
  if (!spec || typeof spec !== 'object' || !spec.dataset) err(422, 'VAL_REPORT', 'Pick a dataset for the report.', 'dataset')
  const { ds, rows: data } = datasetRows(ctx, spec.dataset as DatasetId)
  const { spec: clean, warnings } = sanitizeSpec(spec as ReportSpec & Record<string, unknown>, ds)
  return runSpec(clean, ds, data, { today: ctx.today, fyStart: S(ctx)['company.fy_start_month'] }, warnings)
}

/* ------------------------------------------------------------------ */
/* Saved reports                                                        */
/* ------------------------------------------------------------------ */
export interface SavedReportView extends E.SavedReport {
  owner_name: string
  can_edit: boolean
  dataset_label: string
  preview: { labels: string[]; values: number[]; kind: string; value?: number | null; format: string } | null
}
/** Workspace administrators (settings.edit) curate everyone's saved reports and the system templates. */
const curatesReports = (ctx: Ctx) => has(ctx, 'settings.edit')
function canEditReport(ctx: Ctx, r: E.SavedReport) {
  return r.owner_id === ctx.user.id || curatesReports(ctx)
}
function visibleReports(ctx: Ctx) {
  const ds = new Set(visibleDatasets(ctx).map((d) => d.id))
  return rows(ctx, 'saved_reports').filter((r) => ds.has(r.spec.dataset) && (r.owner_id === ctx.user.id || r.shared || r.source === 'system' || curatesReports(ctx)))
}
function previewOf(ctx: Ctx, r: E.SavedReport): SavedReportView['preview'] {
  try {
    const res = executeSpec(ctx, r.spec)
    const m = res.columns.find((c) => c.role === 'measure')
    const d = res.columns.find((c) => c.role === 'dimension')
    const format = m?.type === 'money' ? 'money' : m?.type === 'percent' ? 'percent' : m?.unit === 'hours' ? 'hours' : 'number'
    if (!m) return { labels: [], values: [], kind: 'table', value: res.rowCount, format: 'number' }
    if (!d) return { labels: [], values: [], kind: 'kpi', value: res.totals[m.key] ?? null, format }
    const rs = res.rows.slice(0, 12)
    return { labels: rs.map((x) => String(x[d.key])), values: rs.map((x) => Number(x[m.key] ?? 0)), kind: r.spec.chart, value: res.totals[m.key] ?? null, format }
  } catch {
    return null
  }
}
function view(ctx: Ctx, r: E.SavedReport, withPreview = true): SavedReportView {
  return { ...r, owner_name: userName(ctx, r.owner_id), can_edit: canEditReport(ctx, r), dataset_label: DATASET_MAP[r.spec.dataset]?.label ?? r.spec.dataset, preview: withPreview ? previewOf(ctx, r) : null }
}
function validateSaved(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim()
  if (name.length < 2) err(422, 'VAL_REPORT', 'Give the report a name of at least 2 characters.', 'name')
  if (name.length > 120) err(422, 'VAL_REPORT', 'Keep the name under 120 characters.', 'name')
  if (!body.spec || typeof body.spec !== 'object') err(422, 'VAL_REPORT', 'The report has no definition. Pick a dataset first.', 'spec')
  const schedule = ['none', 'weekly', 'monthly'].includes(String(body.schedule)) ? (body.schedule as E.SavedReport['schedule']) : 'none'
  return { name, description: String(body.description ?? '').trim().slice(0, 400), schedule }
}

/* ------------------------------------------------------------------ */
/* AI helpers                                                           */
/* ------------------------------------------------------------------ */
export function plannerEntities(ctx: Ctx): PlannerEntities {
  const users = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin)
  const projects = myProjects(ctx)
  const dsIds = new Set(visibleDatasets(ctx).map((d) => d.id))
  const deals = dsIds.has('deals') ? rows(ctx, 'deals') : []
  return {
    people: users.map((u) => ({ name: u.name, role: u.role })),
    projects: projects.map((p) => ({ name: p.name, code: p.code, client: p.client })),
    clients: [...new Set([...projects.map((p) => p.client).filter((c) => c !== 'Internal'), ...deals.map((d) => d.client)])],
    products: [...new Set(deals.map((d) => d.product))],
    categories: dsIds.has('ledger') ? [...new Set(rows(ctx, 'ledger_entries').map((e) => e.category))] : [],
  }
}
function planFor(ctx: Ctx, question: string) {
  const q = String(question ?? '').trim()
  if (q.length < 3) err(422, 'VAL_AI', 'Ask a question of at least a few words, for example “revenue by stream this FY”.', 'question')
  if (q.length > 600) err(422, 'VAL_AI', 'Keep the question under 600 characters.', 'question')
  const datasets = visibleDatasets(ctx)
  if (!datasets.length) err(403, 'FORBIDDEN', 'Your role has no report data. Ask an admin for access.')
  const plan = planQuestion(q, { today: ctx.today, fyStart: S(ctx)['company.fy_start_month'], role: ctx.role, personal: rowScope(ctx) === 'own', datasets, entities: plannerEntities(ctx), me: ctx.user.name })
  return plan
}

/* Data tools (small JSON, server-computed) used by the LLM path. */
export function toolProjectHealth(ctx: Ctx) {
  const cm = canSeeMargins(ctx)
  return myProjects(ctx)
    .filter((p) => p.status === 'active' || p.status === 'initiated' || p.status === 'on_hold')
    .map((p) => {
      const m = redactMetrics(ctx, projectMetrics(ctx, p), cm)
      return { project: p.name, client: p.client, status: p.status, health: m.health, progress_pct: Math.round(m.progress * 100), spi: m.spi === null ? null : Math.round(m.spi * 100) / 100, effort_ratio: m.effort_ratio === null ? null : Math.round(m.effort_ratio * 100) / 100, projected_margin_pct: m.projected_margin === null ? null : Math.round(m.projected_margin * 1000) / 10, overdue_tasks: m.overdue_tasks, blocked_tasks: m.blocked_tasks, overdue_milestones: m.overdue_milestones, next_milestone: m.next_milestone ? `M${m.next_milestone.no} ${m.next_milestone.name} due ${m.next_milestone.planned_end}` : null }
    })
}
export function toolPipeline(ctx: Ctx) {
  if (!has(ctx, 'deals.edit_own')) err(403, 'FORBIDDEN', 'Pipeline data is for sales and admins.')
  const p = pipeline(ctx)
  const rupees = (x: number | null) => (x === null ? null : Math.round(x / 100))
  return { open_value_rupees: rupees(p.open_value), weighted_value_rupees: rupees(p.weighted_value), open_deals: p.open_count, won_value_rupees: rupees(p.won_value), won_deals: p.won_count, lost_deals: p.lost_count, win_rate_pct: p.win_rate === null ? null : Math.round(p.win_rate * 1000) / 10, avg_cycle_days: p.avg_cycle_days === null ? null : Math.round(p.avg_cycle_days), stale_deals: p.stale.map((d) => ({ deal: d.title, client: d.client, stage: d.stage, value_rupees: rupees(d.value_paise), days_idle: diffDays(ctx.today, d.last_activity_on) })) }
}
export function toolApprovals(ctx: Ctx) {
  const weeks = rows(ctx, 'timesheet_weeks').filter((w) => w.status === 'submitted' && w.submitted_at)
  const scoped = has(ctx, 'people.view_all') ? weeks : weeks.filter((w) => w.approver_id === ctx.user.id || teamOf(ctx, ctx.user.id).has(w.user_id))
  const nm = nameOf(ctx)
  return scoped.map((w) => {
    const due = slaDue(ctx, w.submitted_at!)
    return { person: nm(w.user_id), approver: nm(w.approver_id), week_start: w.week_start, due_by: due, overdue: due < ctx.today }
  })
}
export function toolEntities(ctx: Ctx, kind: string) {
  const e = plannerEntities(ctx)
  if (kind === 'people') return e.people
  if (kind === 'projects') return e.projects
  if (kind === 'clients') return e.clients
  if (kind === 'products') return e.products
  if (kind === 'ledger_categories') return e.categories
  err(422, 'VAL_AI', 'kind must be people, projects, clients, products or ledger_categories.')
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */
const RO = { allowViewAsWrite: true } // POSTs that only read

export function register(r: Router) {
  r.get('/reports/datasets', ({ ctx }) => visibleDatasets(ctx))

  r.post('/reports/run', ({ ctx, body }) => executeSpec(ctx, body?.spec ?? body), RO)

  r.get('/reports', ({ ctx, query }) => {
    const q = String(query.q ?? '').trim().toLowerCase()
    const list = visibleReports(ctx)
      .filter((x) => !q || (x.name + ' ' + x.description).toLowerCase().includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
    return list.map((x) => view(ctx, x, query.preview !== '0'))
  })
  r.get('/reports/:id', ({ ctx, params }) => {
    const rep = find(ctx, 'saved_reports', params.id, 'Report')
    if (!visibleReports(ctx).some((x) => x.id === rep.id)) err(404, 'NOT_FOUND', 'Report not found.')
    return view(ctx, rep, false)
  })
  r.post('/reports', ({ ctx, body }) => {
    if (!has(ctx, 'reports.build')) err(403, 'FORBIDDEN', 'Your role can’t save reports.')
    const v = validateSaved(body)
    const { ds } = datasetRows(ctx, body.spec.dataset)
    const { spec } = sanitizeSpec(body.spec, ds)
    const pinned = !!body.pinned
    const rep = insert(ctx, 'saved_reports', { name: v.name, description: v.description, spec: { ...spec, title: spec.title || v.name }, owner_id: ctx.user.id, shared: !!body.shared, pinned, source: body.source === 'ai' ? 'ai' : 'builder', schedule: v.schedule, last_run_at: null } as never)
    logActivity(ctx, 'report', rep.id, 'create', `Saved report “${v.name}”`)
    return view(ctx, rep, false)
  })
  r.patch('/reports/:id', ({ ctx, params, body, ifMatch }) => {
    const rep = find(ctx, 'saved_reports', params.id, 'Report')
    if (!canEditReport(ctx, rep)) err(403, 'FORBIDDEN', 'Only the owner or an admin can change this report. Duplicate it to make your own copy.')
    const patch: Partial<E.SavedReport> = {}
    if (body.name !== undefined || body.spec !== undefined) {
      const v = validateSaved({ name: body.name ?? rep.name, spec: body.spec ?? rep.spec, schedule: body.schedule ?? rep.schedule, description: body.description ?? rep.description })
      patch.name = v.name
      patch.description = v.description
      patch.schedule = v.schedule
    }
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 400)
    if (body.schedule !== undefined) patch.schedule = ['none', 'weekly', 'monthly'].includes(body.schedule) ? body.schedule : 'none'
    if (body.spec) {
      const { ds } = datasetRows(ctx, body.spec.dataset)
      patch.spec = sanitizeSpec(body.spec, ds).spec
    }
    if (body.shared !== undefined) patch.shared = !!body.shared
    if (body.pinned !== undefined) patch.pinned = !!body.pinned
    const out = update(ctx, 'saved_reports', rep.id, patch, ifMatch)
    logActivity(ctx, 'report', rep.id, 'update', `Updated report “${out.name}”`)
    return view(ctx, out, false)
  })
  r.del('/reports/:id', ({ ctx, params, ifMatch }) => {
    const rep = find(ctx, 'saved_reports', params.id, 'Report')
    if (!canEditReport(ctx, rep)) err(403, 'FORBIDDEN', 'Only the owner or an admin can delete this report.')
    if (rep.source === 'system' && !curatesReports(ctx)) err(403, 'FORBIDDEN', 'System templates can’t be deleted.')
    remove(ctx, 'saved_reports', rep.id, ifMatch)
    logActivity(ctx, 'report', rep.id, 'delete', `Deleted report “${rep.name}”`)
    return { ok: true }
  })
  r.post('/reports/:id/pin', ({ ctx, params, body }) => {
    const rep = find(ctx, 'saved_reports', params.id, 'Report')
    if (!canEditReport(ctx, rep)) err(403, 'FORBIDDEN', 'Only the owner or an admin can pin this report for everyone. Duplicate it to pin your own copy.')
    return view(ctx, update(ctx, 'saved_reports', rep.id, { pinned: body?.pinned === undefined ? !rep.pinned : !!body.pinned }), false)
  })
  r.post('/reports/:id/share', ({ ctx, params, body }) => {
    const rep = find(ctx, 'saved_reports', params.id, 'Report')
    if (!canEditReport(ctx, rep)) err(403, 'FORBIDDEN', 'Only the owner or an admin can change sharing.')
    return view(ctx, update(ctx, 'saved_reports', rep.id, { shared: body?.shared === undefined ? !rep.shared : !!body.shared }), false)
  })
  r.post('/reports/:id/duplicate', ({ ctx, params }) => {
    if (!has(ctx, 'reports.build')) err(403, 'FORBIDDEN', 'Your role can’t save reports.')
    const rep = find(ctx, 'saved_reports', params.id, 'Report')
    if (!visibleReports(ctx).some((x) => x.id === rep.id)) err(404, 'NOT_FOUND', 'Report not found.')
    const copy = insert(ctx, 'saved_reports', { name: `${rep.name} (copy)`.slice(0, 120), description: rep.description, spec: rep.spec, owner_id: ctx.user.id, shared: false, pinned: false, source: 'builder', schedule: 'none', last_run_at: null } as never)
    return view(ctx, copy, false)
  })
  r.post(
    '/reports/:id/run',
    ({ ctx, params, body }) => {
      const rep = find(ctx, 'saved_reports', params.id, 'Report')
      if (!visibleReports(ctx).some((x) => x.id === rep.id)) err(404, 'NOT_FOUND', 'Report not found.')
      const spec = body?.period ? { ...rep.spec, period: body.period } : rep.spec
      const res = executeSpec(ctx, body?.compare ? { ...spec, compare: body.compare } : spec)
      if (!ctx.viewAs) {
        rep.last_run_at = nowISO()
        void getDb
      }
      return res
    },
    RO,
  )

  /* ---------------- AI ---------------- */
  const aiGuard = (ctx: Ctx) => {
    if (!aiEnabled(ctx)) err(403, 'AI_DISABLED', 'The AI assistant is turned off for this workspace. An admin can turn it on in Settings → Company.')
    if (!has(ctx, 'ai.use')) err(403, 'FORBIDDEN', 'Your role can’t use the AI assistant.')
  }
  r.get('/ai/context', ({ ctx }) => {
    return { enabled: aiEnabled(ctx), today: ctx.today, fy_start_month: S(ctx)['company.fy_start_month'], datasets: visibleDatasets(ctx), entities: plannerEntities(ctx), suggestions: SUGGESTIONS[ctx.role] ?? SUGGESTIONS.employee, me: ctx.user.name, tenant: ctx.tenant.name, currency: 'INR', money_unit: 'paise' }
  })
  r.post(
    '/ai/plan',
    ({ ctx, body }) => {
      aiGuard(ctx)
      const plan = planFor(ctx, body?.question)
      return { spec: plan.spec, explanation: plan.explanation, confidence: plan.confidence, intent: plan.intent, source: 'rules' as const }
    },
    RO,
  )
  r.post(
    '/ai/answer',
    ({ ctx, body }) => {
      aiGuard(ctx)
      let spec: ReportSpec
      let explanation: string
      let source: 'rules' | 'llm' = 'rules'
      let confidence = 1
      if (body?.spec) {
        spec = body.spec
        explanation = String(body.explanation ?? '')
        source = body.source === 'llm' ? 'llm' : 'rules'
      } else {
        const plan = planFor(ctx, body?.question)
        spec = plan.spec
        explanation = plan.explanation
        confidence = plan.confidence
      }
      const result = executeSpec(ctx, spec)
      return { spec: result.spec, explanation, confidence, source, result, narrative: narrate(result, { fyStart: S(ctx)['company.fy_start_month'] }), described: describeSpec(result.spec) }
    },
    RO,
  )
  r.get('/ai/tools/project_health', ({ ctx }) => {
    aiGuard(ctx)
    return toolProjectHealth(ctx)
  })
  r.get('/ai/tools/pipeline', ({ ctx }) => {
    aiGuard(ctx)
    return toolPipeline(ctx)
  })
  r.get('/ai/tools/approvals', ({ ctx }) => {
    aiGuard(ctx)
    return toolApprovals(ctx)
  })
  r.get('/ai/tools/entities', ({ ctx, query }) => {
    aiGuard(ctx)
    return toolEntities(ctx, String(query.kind ?? ''))
  })
}

// silence unused (kept for future server-side schedule runner)
void avgAllocation
void STREAM
void fieldOf
