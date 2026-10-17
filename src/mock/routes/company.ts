import { dealValue } from '@/domain/sales'
// Company layer (v3): approvals inbox, goals & OKRs, audit trail.
// The inbox is computed straight from the other areas' tables (role- and reporting-line-scoped);
// its inline actions call those areas' own contract endpoints from the client.
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import { err, find, getDb, insert, logActivity, permissionsOf, remove, rows, update, userName, type Ctx, type Router, has, hasAny } from '../server'
import { isPermissionKey } from '@/domain/permissionCatalog'
import { cal, revenueBetween, slaDue } from '../analytics'
import { taskStats, teamOf, workingDayVariance } from '../performance'
import { canDecide, sweepLocks } from './timesheets'
import { addDays, addWorkingDays, diffDays, fmtDate, isWorkingDay, quarterOf, weekLabel, weekStart, workingDaysBetween } from '@/domain/calendar'
import { calendarFor } from '../server'
import { ENTITY_LABEL, METRIC_META } from '@/api/company'
import { changesToCheck, mcConfig } from '../makerChecker'
import { wfInboxRows, wfLinkedAppraisals } from './workflowsV7'
import { escalateIfDue, escalationTarget, register as registerWorkflows, stepDue, stepLabel, type WfState } from '../workflows'
import { reviewerOf } from './taskflow'

/* ================================================================== */
/* Shared                                                              */
/* ================================================================== */
const S = (ctx: Ctx) => ctx.tenant.settings
export interface PersonLite {
  id: string
  name: string
  title: string
  hue: number
}
function personOf(ctx: Ctx, id: string | null | undefined): PersonLite | null {
  if (!id) return null
  const u = rows(ctx, 'users').find((x) => x.id === id)
  return u ? { id: u.id, name: u.name, title: u.title, hue: u.avatar_hue } : null
}
const dateOf = (s: string | null | undefined) => (s ? s.slice(0, 10) : null)

/* ================================================================== */
/* Approvals inbox                                                     */
/* ================================================================== */
export type InboxKind = 'timesheet' | 'unlock' | 'task_review' | 'leave' | 'expense' | 'purchase_order' | 'vendor_bill' | 'appraisal' | 'change_request' | 'document' | 'change' | 'workflow'
export type InboxGroup = 'timesheets' | 'tasks' | 'leave' | 'expenses' | 'purchases' | 'bills' | 'appraisals' | 'changes' | 'other'
export type InboxAction = 'approve' | 'reject' | 'pay' | 'send_back' | 'open'
export type FactType = 'text' | 'money' | 'date' | 'datetime' | 'hours' | 'number' | 'days'
export interface InboxFact {
  label: string
  value: string | number | null
  type: FactType
  tone?: 'danger' | 'warning' | 'success'
}
export interface InboxItem {
  id: string // `${kind}:${entity_id}:${stage}`
  kind: InboxKind
  group: InboxGroup
  stage: 'approve' | 'pay' | 'review' | 'read'
  entity_id: string
  version: number
  title: string
  subtitle: string
  requester: PersonLite | null
  amount: number | null // paise
  submitted_at: string | null
  due_at: string | null // ISO date
  overdue: boolean
  days_waiting: number
  link: string
  screen: string // owning screen, for "Open in …"
  actions: InboxAction[]
  bulk: boolean // eligible for bulk approval (no warnings, supported kind)
  warnings: string[]
  facts: InboxFact[]
  note: string | null // the requester's own words (reason, description, submission note)
  via_delegation?: boolean
  week_start?: string
  user_id?: string
  task_id?: string
  /** "Step 2 of 2 · CEO approval" on multi-step workflow items */
  step_label?: string | null
  /** Who the item escalates to when its step deadline passes */
  escalates_to?: string | null
}
export interface InboxView {
  items: InboxItem[]
  counts: Record<InboxGroup | 'all' | 'overdue', number>
  sla_days: number
  bulk_enabled: boolean
  can_pay_expenses: boolean
}

const GROUP_OF: Record<InboxKind, InboxGroup> = {
  timesheet: 'timesheets', unlock: 'timesheets', task_review: 'tasks', leave: 'leave', expense: 'expenses', purchase_order: 'purchases', vendor_bill: 'bills', appraisal: 'appraisals', change_request: 'other', document: 'other', change: 'changes', workflow: 'other',
}
const SCREEN_OF: Record<InboxKind, string> = {
  timesheet: 'Timesheet approvals', unlock: 'Timesheet approvals', task_review: 'Task', leave: 'Leave', expense: 'Expenses', purchase_order: 'Purchases', vendor_bill: 'Purchases', appraisal: 'Appraisals', change_request: 'Project changes', document: 'Documents', change: 'Change approvals', workflow: 'Workflows',
}
/** Workflow extras for an item: step label, step deadline (overrides the generic 2-day SLA) and escalation target. */
function wfExtras(ctx: Ctx, rec: unknown, fallbackDue: string | null) {
  const r = rec as Partial<WfState>
  return { step_label: stepLabel(r), due_at: stepDue(ctx, r) ?? fallbackDue, escalates_to: escalationTarget(ctx, r)?.name ?? null }
}
/** Lazy escalation: anything past its step deadline with an escalation target moves on when the inbox is read. */
function sweepEscalations(ctx: Ctx) {
  for (const x of rows(ctx, 'leave_requests')) if (x.status === 'pending') escalateIfDue(ctx, 'leave_requests', x, 'leave_request', `${userName(ctx, x.user_id)}’s leave from ${fmtDate(x.from_on)}`, '/leave')
  for (const x of rows(ctx, 'expense_claims')) if (x.status === 'submitted') escalateIfDue(ctx, 'expense_claims', x, 'expense', `${userName(ctx, x.user_id)}’s expense claim “${x.description}”`, '/expenses?tab=approve')
  for (const x of rows(ctx, 'purchase_orders')) if (x.status === 'pending') escalateIfDue(ctx, 'purchase_orders', x, 'purchase_order', x.number, '/purchases?tab=pos')
  for (const x of rows(ctx, 'vendor_bills')) if (x.status === 'received') escalateIfDue(ctx, 'vendor_bills', x as never, 'vendor_bill', `Bill ${x.number}`, '/purchases?tab=bills')
  for (const x of rows(ctx, 'timesheet_weeks')) if (x.status === 'submitted') escalateIfDue(ctx, 'timesheet_weeks', x, 'timesheet_week', `${userName(ctx, x.user_id)}’s ${weekLabel(x.week_start)}`, '/approvals')
  for (const x of rows(ctx, 'tasks')) if (x.status === 'in_review') escalateIfDue(ctx, 'tasks', x as never, 'task', `Task “${x.title}”`, '/team-tasks?tab=review')
}

function due2(ctx: Ctx, submitted: string | null): string | null {
  if (!submitted) return null
  return addWorkingDays(submitted.slice(0, 10), ctx.tenant.settings['approval.sla_working_days'] ?? 2, cal(ctx))
}

function mk(ctx: Ctx, p: Omit<InboxItem, 'id' | 'group' | 'screen' | 'overdue' | 'days_waiting' | 'bulk'> & { bulk?: boolean }): InboxItem {
  const overdue = !!p.due_at && ctx.today > p.due_at
  const sub = dateOf(p.submitted_at)
  return {
    ...p,
    id: `${p.kind}:${p.entity_id}:${p.stage}`,
    group: GROUP_OF[p.kind],
    screen: SCREEN_OF[p.kind],
    overdue,
    days_waiting: sub ? Math.max(0, diffDays(ctx.today, sub)) : 0,
    bulk: !!p.bulk && p.warnings.length === 0,
  }
}

/** Short working days in a submitted week (past working days below the minimum). */
function weekShortDays(ctx: Ctx, w: E.TimesheetWeek, entries: E.TimesheetEntry[]) {
  const minH = S(ctx)['calendar.min_hours_per_day']
  const c = calendarFor(ctx, w.user_id)
  let total = 0
  let short = 0
  for (let i = 0; i < 7; i++) {
    const d = addDays(w.week_start, i)
    const h = entries.filter((e) => e.work_date === d).reduce((s, e) => s + e.hours, 0)
    total += h
    if (d <= ctx.today && isWorkingDay(d, c) && h < minH) short++
  }
  return { total: Math.round(total * 100) / 100, short }
}

function delegatorsOf(ctx: Ctx, me: string): Set<string> {
  return new Set(rows(ctx, 'delegations').filter((d) => d.to_user_id === me && d.from_on <= ctx.today && d.to_on >= ctx.today).map((d) => d.from_user_id))
}

type Members = Map<string, Set<string>>
function projectMembers(ctx: Ctx): Members {
  const m: Members = new Map()
  const add = (p: string, u: string | null | undefined) => {
    if (!u) return
    if (!m.has(p)) m.set(p, new Set())
    m.get(p)!.add(u)
  }
  for (const t of rows(ctx, 'tasks')) {
    add(t.project_id, t.owner_id)
    add(t.project_id, t.backup_id)
  }
  for (const a of rows(ctx, 'allocations')) add(a.project_id, a.user_id)
  for (const p of rows(ctx, 'projects')) add(p.id, p.pm_id)
  return m
}
/** Mirrors the documents area's visibility rule (company → all; documents.view_all → all; company managers-only →
 *  documents.manage / documents.company; project → PM and team). */
function canSeeDoc(ctx: Ctx, d: B.DocumentRec, members: Members, projects: Map<string, E.Project>) {
  if (d.archived) return false
  if (d.visibility === 'company') return true
  if (has(ctx, 'documents.view_all')) return true
  if (!d.project_id) return hasAny(ctx, 'documents.manage', 'documents.company')
  if (projects.get(d.project_id)?.pm_id === ctx.user.id) return true
  if (d.visibility === 'managers') return false
  return members.get(d.project_id)?.has(ctx.user.id) ?? false
}

export function inboxItems(ctx: Ctx): InboxItem[] {
  if (ctx.isSuper && ctx.tenant.id === '__none__') return []
  const me = ctx.user.id
  // Overrides — each inbox item follows the permission that lets someone decide it outside the routed approver:
  const taskAdmin = has(ctx, 'projects.manage_all') // review any task / handle any change request
  const leaveAdmin = has(ctx, 'people.manage') && has(ctx, 'leave.approve') // unrouted leave
  const spendAdmin = has(ctx, 'budgets.manage') // unrouted claims, purchase orders, vendor bill approval
  const out: InboxItem[] = []
  const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const del = delegatorsOf(ctx, me)
  const mine = (approver: string | null | undefined) => !!approver && (approver === me || del.has(approver))

  /* ---- timesheets + unlock requests ---- */
  sweepLocks(ctx)
  if (!ctx.viewAs) sweepEscalations(ctx)
  const entriesByWeek = new Map<string, E.TimesheetEntry[]>()
  for (const e of rows(ctx, 'timesheet_entries')) (entriesByWeek.get(e.week_id) ?? entriesByWeek.set(e.week_id, []).get(e.week_id)!).push(e)
  for (const w of rows(ctx, 'timesheet_weeks')) {
    const unlock = w.status === 'locked' && !!w.unlock_requested_at
    if (w.status !== 'submitted' && !unlock) continue
    const d = canDecide(ctx, w)
    if (!d.ok) continue
    const u = users.get(w.user_id)
    if (unlock) {
      out.push(mk(ctx, {
        kind: 'unlock', stage: 'review', entity_id: w.id, version: w.version, title: `Unlock ${weekLabel(w.week_start)}`, subtitle: `${u?.name ?? '—'} · locked week`,
        requester: personOf(ctx, w.user_id), amount: null, submitted_at: w.unlock_requested_at, due_at: due2(ctx, w.unlock_requested_at),
        link: '/approvals', actions: ['open'], warnings: [], note: w.unlock_reason, via_delegation: d.viaDelegation, week_start: w.week_start, user_id: w.user_id,
        facts: [
          { label: 'Week', value: weekLabel(w.week_start), type: 'text' },
          { label: 'Requested', value: w.unlock_requested_at, type: 'datetime' },
        ],
      }))
      continue
    }
    const { total, short } = weekShortDays(ctx, w, entriesByWeek.get(w.id) ?? [])
    const due = w.submitted_at ? slaDue(ctx, w.submitted_at) : null
    const warnings = short ? [`${short} working day${short > 1 ? 's' : ''} below ${S(ctx)['calendar.min_hours_per_day']}h`] : []
    out.push(mk(ctx, {
      kind: 'timesheet', stage: 'approve', entity_id: w.id, version: w.version, title: `Timesheet · ${weekLabel(w.week_start)}`, subtitle: `${u?.name ?? '—'} · ${total}h`,
      requester: personOf(ctx, w.user_id), amount: null, submitted_at: w.submitted_at, link: '/approvals', actions: ['approve', 'reject'],
      warnings, note: null, via_delegation: d.viaDelegation, week_start: w.week_start, user_id: w.user_id, bulk: true, ...wfExtras(ctx, w, due),
      facts: [
        { label: 'Week', value: weekLabel(w.week_start), type: 'text' },
        { label: 'Total', value: total, type: 'hours' },
        { label: 'Short days', value: short, type: 'number', tone: short ? 'danger' : undefined },
        { label: 'Submitted', value: w.submitted_at, type: 'datetime' },
      ],
    }))
  }

  /* ---- task reviews ---- */
  const reviews = rows(ctx, 'task_reviews')
  for (const t of rows(ctx, 'tasks')) {
    if (t.status !== 'in_review') continue
    const p = projects.get(t.project_id)
    const reviewer = reviewerOf(ctx, t)
    if (t.owner_id === me && !taskAdmin) continue
    if (!(taskAdmin || mine(reviewer))) continue
    if (taskAdmin && t.owner_id === me && reviewer !== me) continue
    const open = reviews.filter((r) => r.task_id === t.id && !r.decision).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0]
    const submittedAt = open?.submitted_at ?? (t.submitted_on ? t.submitted_on + 'T09:00:00Z' : t.updated_at)
    const subDay = submittedAt.slice(0, 10)
    const variance = workingDayVariance(ctx, t.due_on, subDay)
    const round = open?.round ?? t.review_round ?? 1
    const warnings: string[] = []
    if (variance > 0 && !(open?.delay_reason_code ?? t.delay_reason_code)) warnings.push('Submitted late without a delay reason')
    out.push(mk(ctx, {
      kind: 'task_review', stage: 'review', entity_id: t.id, version: t.version, task_id: t.id, title: t.title, subtitle: `${p?.code ?? ''} · ${userName(ctx, t.owner_id)}${round > 1 ? ` · round ${round}` : ''}`,
      requester: personOf(ctx, t.owner_id), amount: null, submitted_at: submittedAt, link: `/tasks/${t.id}`, actions: ['approve', 'send_back'],
      warnings, note: open?.submission_note || null, via_delegation: reviewer !== me && mine(reviewer), ...wfExtras(ctx, t, due2(ctx, submittedAt)),
      facts: [
        { label: 'Project', value: p ? `${p.code} · ${p.name}` : '—', type: 'text' },
        { label: 'Due', value: t.due_on, type: 'date' },
        { label: 'Submitted', value: submittedAt, type: 'datetime' },
        { label: 'Timeliness', value: variance < 0 ? `${-variance} working day${variance < -1 ? 's' : ''} early` : variance === 0 ? 'On the due date' : `${variance} working day${variance > 1 ? 's' : ''} late`, type: 'text', tone: variance > 0 ? 'danger' : 'success' },
        { label: 'Estimate', value: t.est_hours, type: 'hours' },
        { label: 'Review round', value: round, type: 'number' },
        ...(open?.delay_reason || t.delay_reason ? [{ label: 'Delay reason', value: (open?.delay_reason ?? t.delay_reason) as string, type: 'text' as const }] : []),
        ...(open?.proof_url ? [{ label: 'Proof', value: open.proof_url, type: 'text' as const }] : []),
      ],
    }))
  }

  /* ---- leave requests ---- */
  for (const l of rows(ctx, 'leave_requests')) {
    if (l.status !== 'pending' || l.user_id === me) continue
    if (!(mine(l.approver_id) || (leaveAdmin && !l.approver_id))) continue
    const u = users.get(l.user_id)
    const range = l.from_on === l.to_on ? fmtDate(l.from_on) : `${fmtDate(l.from_on)} – ${fmtDate(l.to_on)}`
    const warnings: string[] = []
    if (l.from_on <= ctx.today) warnings.push('Starts today or has already started')
    out.push(mk(ctx, {
      kind: 'leave', stage: 'approve', entity_id: l.id, version: l.version, title: `${l.days} day${l.days === 1 ? '' : 's'} ${l.type === 'lwp' ? 'leave without pay' : `${l.type} leave`}`, subtitle: `${u?.name ?? '—'} · ${range}`,
      requester: personOf(ctx, l.user_id), amount: null, submitted_at: l.created_at, link: '/leave', actions: ['approve', 'reject'], warnings, note: l.reason || null,
      via_delegation: l.approver_id !== me && mine(l.approver_id), ...wfExtras(ctx, l, due2(ctx, l.created_at)),
      facts: [
        { label: 'From', value: l.from_on, type: 'date' },
        { label: 'To', value: l.to_on, type: 'date' },
        { label: 'Days', value: l.days, type: 'number' },
        { label: 'Portion', value: l.portion === 'half' ? 'Half day' : 'Full day', type: 'text' },
      ],
    }))
  }

  /* ---- expenses: approve (approver) and pay (finance) ---- */
  const canPay = has(ctx, 'expenses.pay')
  for (const x of rows(ctx, 'expense_claims')) {
    const u = users.get(x.user_id)
    const p = x.project_id ? projects.get(x.project_id) : null
    const base = {
      kind: 'expense' as const, entity_id: x.id, version: x.version, requester: personOf(ctx, x.user_id), amount: x.amount_paise, link: '/expenses', note: x.description || null,
      facts: [
        { label: 'Category', value: x.category.replace(/_/g, ' '), type: 'text' as const },
        { label: 'Spent on', value: x.spent_on, type: 'date' as const },
        { label: 'Amount', value: x.amount_paise, type: 'money' as const },
        { label: 'Project', value: p ? `${p.code} · ${p.name}` : 'None', type: 'text' as const },
        { label: 'Billable to client', value: x.billable_to_client ? 'Yes' : 'No', type: 'text' as const },
        { label: 'Receipt', value: x.receipt_file_id ? 'Attached' : 'Missing', type: 'text' as const, tone: x.receipt_file_id ? undefined : ('danger' as const) },
      ],
    }
    if (x.status === 'submitted' && x.user_id !== me && (mine(x.approver_id) || (spendAdmin && !x.approver_id))) {
      const warnings: string[] = []
      if (!x.receipt_file_id) warnings.push('No receipt attached')
      if (diffDays(ctx.today, x.spent_on) > 30) warnings.push('Spent more than 30 days ago')
      if (x.billable_to_client && !x.project_id) warnings.push('Billable to a client but no project chosen')
      out.push(mk(ctx, { ...base, stage: 'approve', title: x.description || 'Expense claim', subtitle: `${u?.name ?? '—'} · ${x.category.replace(/_/g, ' ')}`, submitted_at: x.updated_at, actions: ['approve', 'reject'], warnings, bulk: true, ...wfExtras(ctx, x, due2(ctx, x.updated_at)) }))
    } else if (x.status === 'approved' && !x.paid_on && canPay && x.user_id !== me) {
      out.push(mk(ctx, { ...base, stage: 'pay', title: `Pay: ${x.description || 'expense claim'}`, subtitle: `${u?.name ?? '—'} · approved by ${userName(ctx, x.decided_by)}`, submitted_at: x.decided_at, due_at: due2(ctx, x.decided_at), actions: ['pay'], warnings: [] }))
    }
  }

  /* ---- purchase orders ---- */
  const vendors = new Map(rows(ctx, 'vendors').map((v) => [v.id, v]))
  for (const po of rows(ctx, 'purchase_orders')) {
    if (po.status !== 'pending' || po.requested_by === me) continue
    if (!(spendAdmin || mine(po.approver_id))) continue
    const v = vendors.get(po.vendor_id)
    const p = po.project_id ? projects.get(po.project_id) : null
    out.push(mk(ctx, {
      kind: 'purchase_order', stage: 'approve', entity_id: po.id, version: po.version, title: `${po.number} · ${v?.name ?? 'Vendor'}`, subtitle: `${userName(ctx, po.requested_by)} · ${po.budget_category}`,
      requester: personOf(ctx, po.requested_by), amount: po.amount_paise, submitted_at: po.updated_at, link: '/purchases', actions: ['approve', 'reject'], warnings: [], note: po.lines.map((l) => `${l.qty} × ${l.description}`).join('; ') || null,
      ...wfExtras(ctx, po, due2(ctx, po.updated_at)),
      facts: [
        { label: 'Vendor', value: v?.name ?? '—', type: 'text' },
        { label: 'Amount', value: po.amount_paise, type: 'money' },
        { label: 'GST', value: `${po.gst_pct}%`, type: 'text' },
        { label: 'Budget', value: po.budget_category, type: 'text' },
        { label: 'Project', value: p ? `${p.code} · ${p.name}` : 'None', type: 'text' },
        { label: 'Needed by', value: po.needed_by, type: 'date' },
      ],
    }))
  }

  /* ---- vendor bills ---- */
  {
    for (const b of rows(ctx, 'vendor_bills')) {
      if (b.status !== 'received' && b.status !== 'approved') continue
      const v = vendors.get(b.vendor_id)
      const pay = b.status === 'approved'
      // approve: the bill's workflow approver or spend authority; pay: procurement.manage
      const bApprover = (b as { approver_id?: string | null }).approver_id
      if (pay ? !has(ctx, 'procurement.manage') : !(spendAdmin || (mine(bApprover) && b.created_by !== me))) continue
      const po = b.po_id ? rows(ctx, 'purchase_orders').find((x) => x.id === b.po_id) : null
      const warnings: string[] = []
      if (!pay && !b.po_id) warnings.push('No purchase order linked')
      if (!pay && po && b.amount_paise > po.amount_paise) warnings.push('Bill is higher than its purchase order')
      out.push(mk(ctx, {
        kind: 'vendor_bill', stage: pay ? 'pay' : 'approve', entity_id: b.id, version: b.version, title: `${pay ? 'Pay' : 'Approve'} bill ${b.number}`, subtitle: `${v?.name ?? 'Vendor'} · due ${fmtDate(b.due_on)}`,
        requester: null, amount: b.amount_paise + b.gst_paise - b.tds_paise, submitted_at: pay ? b.updated_at : b.bill_date + 'T09:00:00Z', link: '/purchases', actions: [pay ? 'pay' : 'approve'], warnings, note: null,
        ...(pay ? { due_at: b.due_on } : wfExtras(ctx, b, due2(ctx, b.bill_date))),
        facts: [
          { label: 'Vendor', value: v?.name ?? '—', type: 'text' },
          { label: 'Bill date', value: b.bill_date, type: 'date' },
          { label: 'Due', value: b.due_on, type: 'date', tone: b.due_on < ctx.today ? 'danger' : undefined },
          { label: 'Amount', value: b.amount_paise, type: 'money' },
          { label: 'GST', value: b.gst_paise, type: 'money' },
          { label: 'TDS', value: b.tds_paise, type: 'money' },
          { label: 'Purchase order', value: po?.number ?? 'None', type: 'text' },
        ],
      }))
    }
  }

  /* ---- appraisals ---- */
  const cycles = new Map(rows(ctx, 'appraisal_cycles').map((c) => [c.id, c]))
  const hr = has(ctx, 'appraisals.manage')
  const wfManaged = wfLinkedAppraisals(ctx) // v7: these appear below as workflow steps instead
  for (const a of rows(ctx, 'appraisals')) {
    if (wfManaged.has(a.id)) continue
    const c = cycles.get(a.cycle_id)
    const asManager = a.status === 'manager_pending' && mine(a.manager_id)
    const asHr = a.status === 'hr_pending' && hr && a.user_id !== me
    if (!asManager && !asHr) continue
    const u = users.get(a.user_id)
    const submitted = asManager ? a.submitted_self_at : a.submitted_manager_at
    const due = c ? (asManager ? c.manager_due : c.hr_due) : due2(ctx, submitted)
    out.push(mk(ctx, {
      kind: 'appraisal', stage: 'review', entity_id: a.id, version: a.version, title: `${asManager ? 'Manager' : 'HR'} review · ${u?.name ?? '—'}`, subtitle: `${c?.name ?? 'Appraisal'} · ${asManager ? 'self-review done' : 'manager review done'}`,
      requester: personOf(ctx, a.user_id), amount: null, submitted_at: submitted, due_at: due, link: `/appraisals/${a.id}`, actions: ['open'], warnings: [], note: (asManager ? a.self_comments : a.manager_comments) || null,
      facts: [
        { label: 'Cycle', value: c?.name ?? '—', type: 'text' },
        { label: 'Self rating', value: a.self_rating, type: 'number' },
        ...(asHr ? [{ label: 'Manager rating', value: a.manager_rating, type: 'number' as const }] : []),
        { label: 'Due', value: due, type: 'date' },
      ],
    }))
  }

  /* ---- v7 workflow steps waiting for me (owner: workflows — src/mock/routes/workflowsV7.ts) ---- */
  for (const w of wfInboxRows(ctx)) {
    out.push({
      ...mk(ctx, {
        kind: 'workflow', stage: 'review', entity_id: w.id, version: w.version, title: w.title, subtitle: `${w.template_name} · ${w.stage_name}`,
        requester: personOf(ctx, w.subject_id), amount: null, submitted_at: w.started_at, due_at: w.due_on, link: `/workflows/run/${w.id}`, actions: ['open'], warnings: [], note: w.note || null,
        via_delegation: w.via_delegation, step_label: w.step_label, escalates_to: w.escalates_to,
        facts: [
          { label: 'Workflow', value: w.template_name, type: 'text' },
          { label: 'Stage', value: w.stage_name, type: 'text' },
          { label: 'Due', value: w.due_on, type: 'date' },
        ],
      }),
      group: w.process === 'appraisal' || w.process === 'promotion' ? 'appraisals' : 'other',
    })
  }

  /* ---- change requests on my projects ---- */
  for (const cr of rows(ctx, 'change_requests')) {
    if (cr.status !== 'raised' && cr.status !== 'estimated') continue
    const p = projects.get(cr.project_id)
    if (!p || !(taskAdmin || mine(p.pm_id))) continue
    if (cr.raised_by === me && !taskAdmin && p.pm_id !== me) continue
    out.push(mk(ctx, {
      kind: 'change_request', stage: 'review', entity_id: cr.id, version: cr.version, title: cr.title, subtitle: `${p.code} · ${cr.status === 'raised' ? 'needs an estimate' : 'estimated, needs a decision'}`,
      requester: personOf(ctx, cr.raised_by), amount: cr.value_paise || null, submitted_at: cr.created_at, due_at: due2(ctx, cr.created_at), link: `/projects/${p.id}/changes`, actions: ['open'], warnings: [], note: cr.description || null,
      facts: [
        { label: 'Project', value: `${p.code} · ${p.name}`, type: 'text' },
        { label: 'Status', value: cr.status === 'raised' ? 'Raised' : 'Estimated', type: 'text' },
        { label: 'Hours', value: cr.hours, type: 'hours' },
        { label: 'Value', value: cr.value_paise, type: 'money' },
      ],
    }))
  }

  /* ---- maker-checker: changes I can check (never my own) ---- */
  if (!ctx.viewAs) {
    const sla = mcConfig(ctx).sla_days
    for (const c of changesToCheck(ctx)) {
      out.push(mk(ctx, {
        kind: 'change', stage: 'approve', entity_id: c.id, version: c.version, title: c.summary, subtitle: `${c.entity_label} · ${c.maker_name}`,
        requester: personOf(ctx, c.maker_id), amount: null, submitted_at: c.created_at, due_at: addWorkingDays(c.created_at.slice(0, 10), sla, cal(ctx)), link: `/changes?id=${c.id}`,
        actions: ['approve', 'reject'], warnings: [], note: null,
        facts: [
          { label: 'Area', value: c.entity_label, type: 'text' },
          { label: 'Proposed by', value: c.maker_name, type: 'text' },
          { label: 'Needs', value: c.required_permission_label, type: 'text' },
          { label: 'Proposed', value: c.created_at, type: 'datetime' },
        ],
      }))
    }
  }

  /* ---- must-read documents I haven't acknowledged ---- */
  const docs = rows(ctx, 'documents').filter((d) => d.must_read && !d.archived)
  if (docs.length) {
    const members = projectMembers(ctx)
    const acks = rows(ctx, 'document_acks').filter((a) => a.user_id === me)
    const versions = rows(ctx, 'document_versions')
    for (const d of docs) {
      if (!canSeeDoc(ctx, d, members, projects)) continue
      if (acks.some((a) => a.document_id === d.id && a.version === d.current_version)) continue
      const v = versions.find((x) => x.document_id === d.id && x.version === d.current_version)
      const published = v?.uploaded_at ?? d.updated_at
      // a new joiner's clock starts when they joined, not when the policy was published
      const at = ctx.user.created_at > published ? ctx.user.created_at : published
      const p = d.project_id ? projects.get(d.project_id) : null
      out.push(mk(ctx, {
        kind: 'document', stage: 'read', entity_id: d.id, version: d.version, title: `Read: ${d.title}`, subtitle: `${p ? p.code : 'Company library'} · version ${d.current_version}`,
        requester: personOf(ctx, v?.uploaded_by ?? d.owner_id), amount: null, submitted_at: at, due_at: due2(ctx, at), link: `/documents?doc=${d.id}`, actions: ['open'], warnings: [], note: v?.note || d.description || null,
        facts: [
          { label: 'Library', value: p ? `${p.code} · ${p.name}` : 'Company', type: 'text' },
          { label: 'Version', value: d.current_version, type: 'number' },
          { label: 'Updated', value: published, type: 'datetime' },
        ],
      }))
    }
  }

  /* ---- v7: letters issued to me that I haven't acknowledged (payslips need no acknowledgement) ---- */
  for (const d of rows(ctx, 'issued_documents')) {
    if (d.employee_id !== me || d.status !== 'issued' || d.category === 'payslip') continue
    const at = (d.issued_on ?? d.created_at.slice(0, 10)) + 'T09:00:00Z'
    out.push(mk(ctx, {
      kind: 'document', stage: 'read', entity_id: d.id, version: d.version, title: `Acknowledge: ${d.title}`, subtitle: `${d.ref_no ?? 'Issued document'} · issued ${fmtDate(d.issued_on ?? d.created_at.slice(0, 10))}`,
      requester: personOf(ctx, d.issued_by), amount: null, submitted_at: at, due_at: due2(ctx, at), link: `/documents/issued/${d.id}`, actions: ['open'], warnings: [], note: null,
      facts: [
        { label: 'Document', value: d.title, type: 'text' },
        { label: 'Reference', value: d.ref_no ?? '—', type: 'text' },
        { label: 'Issued', value: at, type: 'datetime' },
      ],
    }))
  }

  const rank = (i: InboxItem) => (i.overdue ? 0 : 1)
  out.sort((a, b) => rank(a) - rank(b) || (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') || (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
  return out
}

/* ---------------- "My requests" ---------------- */
export type RequestState = 'pending' | 'approved' | 'rejected' | 'paid' | 'draft' | 'cancelled' | 'sent_back'
export interface MyRequest {
  id: string
  kind: InboxKind
  title: string
  subtitle: string
  state: RequestState
  state_label: string
  submitted_at: string | null
  decided_at: string | null
  decided_by: string | null
  waiting_on: string | null
  reason: string | null
  amount: number | null
  link: string
}
function myRequests(ctx: Ctx): MyRequest[] {
  const me = ctx.user.id
  const out: MyRequest[] = []
  const since = addDays(ctx.today, -90)
  const recent = (d: string | null | undefined) => !d || d.slice(0, 10) >= since
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  for (const w of rows(ctx, 'timesheet_weeks')) {
    if (w.user_id !== me || !['submitted', 'approved', 'rejected'].includes(w.status) || !recent(w.submitted_at)) continue
    const st: RequestState = w.status === 'submitted' ? 'pending' : w.status === 'approved' ? 'approved' : 'sent_back'
    out.push({ id: 'ts:' + w.id, kind: 'timesheet', title: `Timesheet · ${weekLabel(w.week_start)}`, subtitle: 'Weekly timesheet', state: st, state_label: { pending: 'Waiting', approved: 'Approved', sent_back: 'Sent back' }[st as 'pending'] ?? st, submitted_at: w.submitted_at, decided_at: w.decided_at, decided_by: w.decided_by ? userName(ctx, w.decided_by) : null, waiting_on: st === 'pending' ? userName(ctx, w.approver_id) : null, reason: w.reject_reason, amount: null, link: `/timesheet/${w.week_start}` })
  }
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  for (const r of rows(ctx, 'task_reviews')) {
    if (r.submitted_by !== me || !recent(r.submitted_at)) continue
    const t = tasks.get(r.task_id)
    if (!t) continue
    const p = projects.get(t.project_id)
    const st: RequestState = !r.decision ? 'pending' : r.decision === 'approved' ? 'approved' : 'sent_back'
    out.push({ id: 'tr:' + r.id, kind: 'task_review', title: t.title, subtitle: `${p?.code ?? ''} · task submission${r.round > 1 ? `, round ${r.round}` : ''}`, state: st, state_label: st === 'pending' ? 'In review' : st === 'approved' ? `Approved${r.quality_rating ? ` · ${r.quality_rating}/5` : ''}` : 'Sent back', submitted_at: r.submitted_at, decided_at: r.decided_at, decided_by: r.decided_by ? userName(ctx, r.decided_by) : null, waiting_on: st === 'pending' ? userName(ctx, reviewerOf(ctx, t)) : null, reason: r.decision_reason, amount: null, link: `/tasks/${t.id}` })
  }
  // in-review tasks with no review rows yet (older data)
  for (const t of tasks.values()) {
    if (t.owner_id !== me || t.status !== 'in_review') continue
    if (rows(ctx, 'task_reviews').some((r) => r.task_id === t.id)) continue
    const p = projects.get(t.project_id)
    out.push({ id: 'tk:' + t.id, kind: 'task_review', title: t.title, subtitle: `${p?.code ?? ''} · task submission`, state: 'pending', state_label: 'In review', submitted_at: t.submitted_on ? t.submitted_on + 'T09:00:00Z' : t.updated_at, decided_at: null, decided_by: null, waiting_on: userName(ctx, reviewerOf(ctx, t)), reason: null, amount: null, link: `/tasks/${t.id}` })
  }
  for (const l of rows(ctx, 'leave_requests')) {
    if (l.user_id !== me || !recent(l.created_at)) continue
    const st: RequestState = l.status === 'pending' ? 'pending' : l.status
    out.push({ id: 'lv:' + l.id, kind: 'leave', title: `${l.days} day${l.days === 1 ? '' : 's'} ${l.type === 'lwp' ? 'leave without pay' : `${l.type} leave`}`, subtitle: l.from_on === l.to_on ? fmtDate(l.from_on) : `${fmtDate(l.from_on)} – ${fmtDate(l.to_on)}`, state: st, state_label: { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }[l.status], submitted_at: l.created_at, decided_at: l.decided_at, decided_by: l.decided_by ? userName(ctx, l.decided_by) : null, waiting_on: st === 'pending' ? userName(ctx, l.approver_id) : null, reason: l.decision_reason, amount: null, link: '/leave' })
  }
  for (const x of rows(ctx, 'expense_claims')) {
    if (x.user_id !== me || x.status === 'draft' || !recent(x.created_at)) continue
    const st: RequestState = x.status === 'submitted' ? 'pending' : x.status
    out.push({ id: 'ex:' + x.id, kind: 'expense', title: x.description || 'Expense claim', subtitle: `${x.category.replace(/_/g, ' ')} · spent ${fmtDate(x.spent_on)}`, state: st, state_label: { pending: 'Waiting', approved: 'Approved · to be paid', rejected: 'Rejected', paid: 'Paid' }[st as 'pending'] ?? st, submitted_at: x.updated_at, decided_at: x.paid_on ? x.paid_on + 'T09:00:00Z' : x.decided_at, decided_by: x.decided_by ? userName(ctx, x.decided_by) : null, waiting_on: st === 'pending' ? userName(ctx, x.approver_id) : null, reason: x.decision_reason, amount: x.amount_paise, link: '/expenses' })
  }
  for (const po of rows(ctx, 'purchase_orders')) {
    if (po.requested_by !== me || po.status === 'draft' || !recent(po.created_at)) continue
    const st: RequestState = po.status === 'pending' ? 'pending' : po.status === 'closed' ? 'approved' : po.status
    out.push({ id: 'po:' + po.id, kind: 'purchase_order', title: `${po.number}`, subtitle: po.budget_category, state: st, state_label: { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', closed: 'Closed' }[po.status as 'pending'] ?? st, submitted_at: po.created_at, decided_at: po.decided_at, decided_by: po.decided_by ? userName(ctx, po.decided_by) : null, waiting_on: st === 'pending' ? userName(ctx, po.approver_id) || 'Admin' : null, reason: po.decision_reason, amount: po.amount_paise, link: '/purchases' })
  }
  for (const cr of rows(ctx, 'change_requests')) {
    if (cr.raised_by !== me || !recent(cr.created_at)) continue
    const p = projects.get(cr.project_id)
    const st: RequestState = cr.status === 'raised' || cr.status === 'estimated' ? 'pending' : cr.status === 'rejected' ? 'rejected' : 'approved'
    out.push({ id: 'cr:' + cr.id, kind: 'change_request', title: cr.title, subtitle: `${p?.code ?? ''} · change request`, state: st, state_label: st === 'pending' ? (cr.status === 'raised' ? 'Raised' : 'Estimated') : st === 'rejected' ? 'Rejected' : cr.status === 'done' ? 'Done' : 'Approved', submitted_at: cr.created_at, decided_at: cr.decided_at, decided_by: cr.decided_by ? userName(ctx, cr.decided_by) : null, waiting_on: st === 'pending' ? userName(ctx, p?.pm_id) : null, reason: null, amount: cr.value_paise || null, link: p ? `/projects/${p.id}/changes` : '/projects' })
  }
  // Multi-step workflows: say which step a pending request is on.
  const recs = new Map<string, unknown>([
    ...rows(ctx, 'expense_claims').map((x) => ['ex:' + x.id, x] as [string, unknown]),
    ...rows(ctx, 'leave_requests').map((x) => ['lv:' + x.id, x] as [string, unknown]),
    ...rows(ctx, 'purchase_orders').map((x) => ['po:' + x.id, x] as [string, unknown]),
    ...rows(ctx, 'timesheet_weeks').map((x) => ['ts:' + x.id, x] as [string, unknown]),
  ])
  for (const m of out) {
    if (m.state !== 'pending') continue
    const lab = stepLabel(recs.get(m.id) as Partial<WfState> | undefined)
    if (lab) m.state_label = `Waiting · ${lab.split(' · ')[0].toLowerCase()}`
  }
  out.sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''))
  return out
}

/* ================================================================== */
/* Goals & OKRs                                                        */
/* ================================================================== */
export type KRMetric = B.KeyResult['metric']
export type OkrStatus = 'on_track' | 'at_risk' | 'off_track' | 'done' | 'not_started'

export interface CheckIn {
  id: string
  at: string
  by: string
  summary: string
}
export interface KRView extends B.KeyResult {
  owner: PersonLite | null
  auto: boolean
  kind: 'money' | 'percent' | 'number'
  progress: number | null // 0..1
  basis: string | null // what window / scope the auto value covers
  forecast: number | null // money metrics: expected by period end
  redacted: boolean
  checkins: CheckIn[]
  can_edit: boolean
  can_check_in: boolean
}
export interface ObjectiveView extends B.Objective {
  owner: PersonLite | null
  parent_title: string | null
  key_results: KRView[]
  progress: number | null
  expected: number
  computed_status: OkrStatus
  can_edit: boolean
}
export interface OkrPeriod {
  label: string
  from: string
  to: string
  current: boolean
}
export interface OkrView {
  period: OkrPeriod
  periods: OkrPeriod[]
  elapsed: number
  days_left: number
  objectives: ObjectiveView[]
  scorecard: { objectives: number; progress: number | null; on_track: number; at_risk: number; off_track: number; done: number; company_progress: number | null; krs: number }
  owners: PersonLite[]
  can: { company: boolean; team: boolean; person: boolean }
}

function periodsAround(ctx: Ctx): OkrPeriod[] {
  const fy = S(ctx)['company.fy_start_month']
  const cur = quarterOf(ctx.today, fy)
  const out: OkrPeriod[] = []
  const seen = new Set<string>()
  const add = (anchor: string) => {
    const q = quarterOf(anchor, fy)
    if (seen.has(q.label)) return
    seen.add(q.label)
    out.push({ label: q.label, from: q.from, to: q.to, current: q.label === cur.label })
  }
  for (const o of rows(ctx, 'objectives')) add(o.period_from)
  add(addDays(cur.from, -1))
  add(ctx.today)
  add(addDays(cur.to, 1))
  return out.sort((a, b) => b.from.localeCompare(a.from))
}

/** People in an objective's scope: company → everyone; team → owner + reporting tree; person → owner. */
function scopeOf(ctx: Ctx, o: B.Objective): string[] | null {
  if (o.level === 'company') return null
  if (o.level === 'team') return [o.owner_id, ...teamOf(ctx, o.owner_id).map((u) => u.id)]
  return [o.owner_id]
}

function complianceBetween(ctx: Ctx, from: string, to: string, ids: string[] | null) {
  const users = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && (!ids || ids.includes(u.id)))
  const weeks = rows(ctx, 'timesheet_weeks')
  const byKey = new Map(weeks.map((w) => [w.user_id + '|' + w.week_start, w]))
  let due = 0
  let ok = 0
  const lastMonday = addDays(weekStart(ctx.today), -7)
  for (let mon = weekStart(from); mon <= lastMonday && mon <= to; mon = addDays(mon, 7)) {
    for (const u of users) {
      if (u.joined_on > addDays(mon, 6)) continue
      due++
      const w = byKey.get(u.id + '|' + mon)
      if (w && (w.status === 'submitted' || w.status === 'approved')) ok++
    }
  }
  return due ? (ok / due) * 100 : null
}

interface AutoValue {
  value: number | null
  basis: string
  forecast: number | null
}
function autoValue(ctx: Ctx, o: B.Objective, kr: B.KeyResult): AutoValue {
  const from = o.period_from
  const to = o.period_to < ctx.today ? o.period_to : ctx.today
  if (from > ctx.today) return { value: null, basis: 'Period has not started', forecast: null }
  const ids = scopeOf(ctx, o)
  const scopeLabel = o.level === 'company' ? 'company' : o.level === 'team' ? `${userName(ctx, o.owner_id).split(' ')[0]}’s team` : userName(ctx, o.owner_id).split(' ')[0]
  const span = o.period_to < ctx.today ? 'whole period' : 'period to date'
  // Rate metrics need a few weeks of data; at the very start of a period they use a trailing 30 days.
  const elapsedWd = workingDaysBetween(from, to, cal(ctx))
  const early = elapsedWd < 10
  const rFrom = early ? addDays(ctx.today, -29) : from
  const rateBasis = early ? `Last 30 days (${scopeLabel}) — the period has just started` : `${span[0].toUpperCase()}${span.slice(1)} · ${scopeLabel}`
  switch (kr.metric) {
    case 'revenue_billed':
    case 'revenue_collected': {
      const r = revenueBetween(ctx, from, to)
      const full = revenueBetween(ctx, from, o.period_to, { scheduled: true })
      return { value: kr.metric === 'revenue_billed' ? r.billed : r.collected, basis: `Ledger, ${span}`, forecast: o.period_to > ctx.today ? (kr.metric === 'revenue_billed' ? full.billed : null) : null }
    }
    case 'deals_won_value': {
      const won = rows(ctx, 'deals').filter((d) => d.stage === 'won' && d.won_on && d.won_on >= from && d.won_on <= to && (!ids || ids.includes(d.owner_id)))
      return { value: won.reduce((s, d) => s + dealValue(d), 0), basis: `${won.length} deal${won.length === 1 ? '' : 's'} won · ${span} · ${scopeLabel}`, forecast: null }
    }
    case 'on_time_task_pct': {
      const s = taskStats(ctx, { userIds: ids ?? undefined, from: rFrom, to })
      return { value: s.on_time_pct === null ? null : Math.round(s.on_time_pct * 1000) / 10, basis: `${rateBasis} · ${s.completed} task${s.completed === 1 ? '' : 's'} done`, forecast: null }
    }
    case 'timesheet_compliance': {
      const lastMonday = addDays(weekStart(ctx.today), -7)
      const cFrom = early || weekStart(from) > lastMonday ? addDays(lastMonday, -21) : from
      const v = complianceBetween(ctx, cFrom, to, ids)
      return { value: v === null ? null : Math.round(v * 10) / 10, basis: early ? `Last 4 completed weeks (${scopeLabel})` : `Completed weeks, ${span} · ${scopeLabel}`, forecast: null }
    }
    case 'margin_pct': {
      const r = revenueBetween(ctx, rFrom, to)
      return { value: r.margin === null ? null : Math.round(r.margin * 1000) / 10, basis: early ? 'Ledger, last 30 days' : `Ledger, ${span}`, forecast: null }
    }
    case 'headcount': {
      const n = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && (!ids || ids.includes(u.id))).length
      return { value: n, basis: `Active people today · ${scopeLabel}`, forecast: null }
    }
    case 'leakage': {
      const l = rows(ctx, 'revenue_leakage').filter((x) => x.date >= from && x.date <= to && x.status !== 'recovered')
      return { value: l.reduce((s, x) => s + x.amount_paise - (x.recovered_paise ?? 0), 0), basis: `${l.length} open item${l.length === 1 ? '' : 's'} · ${span}`, forecast: null }
    }
    default:
      return { value: kr.current, basis: '', forecast: null }
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
function progressOf(start: number, target: number, current: number | null): number | null {
  if (current === null || current === undefined) return null
  if (target === start) return current === target ? 1 : 0
  return clamp01((current - start) / (target - start))
}
function statusOf(progress: number | null, expected: number, started: boolean): OkrStatus {
  if (!started) return 'not_started'
  if (progress === null) return 'on_track'
  if (progress >= 1) return 'on_track'
  const e = Math.max(expected, 0.02)
  if (progress >= 0.9 * e) return 'on_track'
  if (progress >= 0.6 * e) return 'at_risk'
  return 'off_track'
}
function elapsedOf(ctx: Ctx, from: string, to: string) {
  if (ctx.today < from) return 0
  if (ctx.today > to) return 1
  return clamp01((diffDays(ctx.today, from) + 1) / (diffDays(to, from) + 1))
}

function isManagerOf(ctx: Ctx, ownerId: string) {
  return teamOf(ctx, ctx.user.id).some((u) => u.id === ownerId)
}
function hasReports(ctx: Ctx) {
  return rows(ctx, 'users').some((u) => u.reports_to_id === ctx.user.id && u.status === 'active')
}
function canEditObjective(ctx: Ctx, o: Pick<B.Objective, 'level' | 'owner_id'>) {
  if (has(ctx, 'okrs.manage')) return true
  if (o.level === 'company') return false
  if (o.owner_id === ctx.user.id) return o.level === 'person' || hasReports(ctx)
  return isManagerOf(ctx, o.owner_id)
}
function canSeeFinance(ctx: Ctx, metric: KRMetric) {
  if (!METRIC_META[metric].finance) return true
  if (has(ctx, 'finance.view')) return true
  return metric === 'deals_won_value' && hasAny(ctx, 'deals.edit_own', 'projects.edit')
}

function checkinsOf(ctx: Ctx): Map<string, CheckIn[]> {
  const m = new Map<string, CheckIn[]>()
  for (const a of rows(ctx, 'activity_log')) {
    if (a.entity !== 'key_result') continue
    ;(m.get(a.entity_id) ?? m.set(a.entity_id, []).get(a.entity_id)!).push({ id: a.id, at: a.at, by: userName(ctx, a.actor_id), summary: a.summary })
  }
  for (const v of m.values()) v.sort((a, b) => b.at.localeCompare(a.at))
  return m
}

function viewObjective(ctx: Ctx, o: B.Objective, all: B.Objective[], krs: B.KeyResult[], ci: Map<string, CheckIn[]>): ObjectiveView {
  const editable = canEditObjective(ctx, o)
  const kv: KRView[] = krs
    .filter((k) => k.objective_id === o.id)
    .map((k) => {
      const meta = METRIC_META[k.metric]
      const auto = k.metric !== 'manual'
      const a = auto ? autoValue(ctx, o, k) : { value: k.current, basis: null as string | null, forecast: null }
      const current = a.value
      const progress = progressOf(k.start_value, k.target, current)
      const redacted = !canSeeFinance(ctx, k.metric)
      return {
        ...k,
        current: redacted ? (null as unknown as number) : (current as number),
        start_value: redacted ? (null as unknown as number) : k.start_value,
        target: redacted ? (null as unknown as number) : k.target,
        owner: personOf(ctx, k.owner_id),
        auto,
        kind: k.metric === 'manual' ? (k.unit === '%' ? 'percent' : k.unit === '₹' ? 'money' : 'number') : meta.kind,
        progress,
        basis: a.basis,
        forecast: redacted ? null : a.forecast,
        redacted,
        checkins: (ci.get(k.id) ?? []).slice(0, 12),
        can_edit: editable,
        can_check_in: !auto && (editable || k.owner_id === ctx.user.id),
      }
    })
  const ps = kv.map((k) => k.progress).filter((p): p is number => p !== null)
  const progress = ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : null
  const expected = elapsedOf(ctx, o.period_from, o.period_to)
  const computed: OkrStatus = o.status === 'done' ? 'done' : statusOf(progress, expected, ctx.today >= o.period_from)
  const parent = o.parent_id ? all.find((x) => x.id === o.parent_id) : null
  return { ...o, owner: personOf(ctx, o.owner_id), parent_title: parent?.title ?? null, key_results: kv, progress, expected, computed_status: computed, can_edit: editable }
}

function okrView(ctx: Ctx, periodLabel: string | undefined, ownerId: string | undefined): OkrView {
  const periods = periodsAround(ctx)
  const period = periods.find((p) => p.label === periodLabel) ?? periods.find((p) => p.current) ?? periods[0]
  const all = rows(ctx, 'objectives')
  const krs = rows(ctx, 'key_results')
  const ci = checkinsOf(ctx)
  let objs = all.filter((o) => o.period === period.label)
  if (ownerId) objs = objs.filter((o) => o.owner_id === ownerId || krs.some((k) => k.objective_id === o.id && k.owner_id === ownerId))
  const levelRank = { company: 0, team: 1, person: 2 }
  const views = objs.map((o) => viewObjective(ctx, o, all, krs, ci)).sort((a, b) => levelRank[a.level] - levelRank[b.level] || a.created_at.localeCompare(b.created_at))
  const ps = views.map((v) => v.progress).filter((p): p is number => p !== null)
  const company = views.filter((v) => v.level === 'company').map((v) => v.progress).filter((p): p is number => p !== null)
  const ownerIds = [...new Set(all.filter((o) => o.period === period.label).flatMap((o) => [o.owner_id, ...krs.filter((k) => k.objective_id === o.id).map((k) => k.owner_id)]))]
  return {
    period,
    periods,
    elapsed: elapsedOf(ctx, period.from, period.to),
    days_left: Math.max(0, diffDays(period.to, ctx.today)),
    objectives: views,
    scorecard: {
      objectives: views.length,
      progress: ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : null,
      on_track: views.filter((v) => v.computed_status === 'on_track').length,
      at_risk: views.filter((v) => v.computed_status === 'at_risk').length,
      off_track: views.filter((v) => v.computed_status === 'off_track').length,
      done: views.filter((v) => v.computed_status === 'done').length,
      company_progress: company.length ? company.reduce((s, p) => s + p, 0) / company.length : null,
      krs: views.reduce((s, v) => s + v.key_results.length, 0),
    },
    owners: ownerIds.map((id) => personOf(ctx, id)).filter((p): p is PersonLite => !!p).sort((a, b) => a.name.localeCompare(b.name)),
    can: { company: has(ctx, 'okrs.manage'), team: has(ctx, 'okrs.manage') || hasReports(ctx), person: true },
  }
}

const METRICS = Object.keys(METRIC_META) as KRMetric[]
function cleanTitle(v: unknown, label = 'Title') {
  const t = String(v ?? '').trim()
  if (t.length < 3) err(422, 'VALIDATION', `${label} needs at least 3 characters.`, 'title')
  if (t.length > 160) err(422, 'VALIDATION', `${label} can be at most 160 characters.`, 'title')
  return t
}
function num(v: unknown, field: string, label: string) {
  const n = Number(v)
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) err(422, 'VALIDATION', `${label} must be a number.`, field)
  return n
}

/* ================================================================== */
/* Audit trail                                                         */
/* ================================================================== */
export type AuditSource = 'activity' | 'project_status' | 'deal_stage' | 'task_review' | 'admin'
export interface AuditRow {
  id: string
  at: string
  actor: PersonLite | null
  source: AuditSource
  entity: string
  entity_label: string
  entity_id: string
  action: string
  summary: string
  before: string | null
  after: string | null
  link: string | null
}
export interface AuditResult {
  items: AuditRow[]
  total: number
  page: number
  page_size: number
  entities: { value: string; label: string; count: number }[]
  actors: PersonLite[]
}
const entityLabel = (e: string) => ENTITY_LABEL[e] ?? e.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function auditRows(ctx: Ctx): AuditRow[] {
  const d = getDb()
  const tasks = new Map(rows(ctx, 'tasks').map((t) => [t.id, t]))
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const deals = new Map(rows(ctx, 'deals').map((x) => [x.id, x]))
  const weeks = new Map(rows(ctx, 'timesheet_weeks').map((w) => [w.id, w]))
  const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  const objectives = new Map(rows(ctx, 'objectives').map((o) => [o.id, o]))
  const krs = new Map(rows(ctx, 'key_results').map((k) => [k.id, k]))
  const docs = new Map(rows(ctx, 'documents').map((x) => [x.id, x]))
  const ref = (entity: string, id: string): { label: string; link: string | null } => {
    switch (entity) {
      case 'project': {
        const p = projects.get(id)
        return { label: p ? `${p.code} · ${p.name}` : id, link: p ? `/projects/${p.id}` : null }
      }
      case 'task': {
        const t = tasks.get(id)
        return { label: t ? t.title : id, link: t ? `/tasks/${t.id}` : null }
      }
      case 'deal': {
        const x = deals.get(id)
        return { label: x ? `${x.title} · ${x.client}` : id, link: x ? `/sales/${x.id}` : null }
      }
      case 'timesheet_week': {
        const w = weeks.get(id)
        return { label: w ? `${users.get(w.user_id)?.name ?? '—'} · ${weekLabel(w.week_start)}` : id, link: w ? `/timesheet/${w.week_start}` : null }
      }
      case 'user':
        return { label: users.get(id)?.name ?? id, link: null }
      case 'objective':
        return { label: objectives.get(id)?.title ?? id, link: '/okrs' }
      case 'key_result':
        return { label: krs.get(id)?.title ?? id, link: '/okrs' }
      case 'document':
        return { label: docs.get(id)?.title ?? id, link: '/documents' }
      case 'expense':
      case 'expense_claim': {
        const x = rows(ctx, 'expense_claims').find((e) => e.id === id)
        return { label: x ? `${x.description || 'Expense'} · ${users.get(x.user_id)?.name ?? ''}` : id, link: '/expenses' }
      }
      case 'leave_request': {
        const x = rows(ctx, 'leave_requests').find((e) => e.id === id)
        return { label: x ? `${users.get(x.user_id)?.name ?? ''} · ${fmtDate(x.from_on)}` : id, link: '/leave' }
      }
      case 'purchase_order': {
        const x = rows(ctx, 'purchase_orders').find((e) => e.id === id)
        return { label: x?.number ?? id, link: '/purchases' }
      }
      case 'vendor_bill': {
        const x = rows(ctx, 'vendor_bills').find((e) => e.id === id)
        return { label: x?.number ?? id, link: '/purchases' }
      }
      case 'appraisal': {
        const x = rows(ctx, 'appraisals').find((e) => e.id === id)
        return { label: x ? users.get(x.user_id)?.name ?? id : id, link: x ? `/appraisals/${x.id}` : null }
      }
      default:
        return { label: id, link: null }
    }
  }
  const out: AuditRow[] = []
  for (const a of rows(ctx, 'activity_log')) {
    const r = ref(a.entity, a.entity_id)
    const arrow = a.summary.match(/^(?:.*?:\s)?(.+?)\s→\s(.+?)(?::\s.*)?$/)
    out.push({ id: a.id, at: a.at, actor: personOf(ctx, a.actor_id), source: 'activity', entity: a.entity, entity_label: r.label, entity_id: a.entity_id, action: a.action, summary: a.summary, before: arrow ? arrow[1] : null, after: arrow ? arrow[2] : null, link: r.link })
  }
  for (const h of rows(ctx, 'project_status_history')) {
    // the projects area also logs status changes to activity_log; keep the structured row only
    const r = ref('project', h.project_id)
    out.push({ id: h.id, at: h.changed_at, actor: personOf(ctx, h.changed_by), source: 'project_status', entity: 'project', entity_label: r.label, entity_id: h.project_id, action: 'status_changed', summary: `Project status ${h.from_status ?? 'new'} → ${h.to_status}${h.reason ? `: ${h.reason}` : ''}`, before: h.from_status, after: h.to_status, link: r.link })
  }
  for (const h of rows(ctx, 'deal_stage_history')) {
    const r = ref('deal', h.deal_id)
    out.push({ id: h.id, at: h.at, actor: personOf(ctx, h.by), source: 'deal_stage', entity: 'deal', entity_label: r.label, entity_id: h.deal_id, action: 'stage_changed', summary: `Deal stage ${h.from_stage ?? 'new'} → ${h.to_stage}${h.reason ? `: ${h.reason}` : ''}`, before: h.from_stage, after: h.to_stage, link: r.link })
  }
  for (const tr of rows(ctx, 'task_reviews')) {
    if (!tr.decision || !tr.decided_at) continue
    const r = ref('task', tr.task_id)
    out.push({ id: tr.id, at: tr.decided_at, actor: personOf(ctx, tr.decided_by), source: 'task_review', entity: 'task', entity_label: r.label, entity_id: tr.task_id, action: tr.decision === 'approved' ? 'review_approved' : 'review_sent_back', summary: tr.decision === 'approved' ? `Approved task (round ${tr.round})${tr.quality_rating ? `, rated ${tr.quality_rating}/5` : ''}` : `Sent back task (round ${tr.round}): ${tr.decision_reason ?? ''}`, before: 'In review', after: tr.decision === 'approved' ? 'Done' : 'In progress', link: r.link })
  }
  for (const a of d.admin_audit.filter((x) => x.tenant_id === ctx.tenant.id)) {
    const actor = d.users.find((u) => u.id === a.actor_id)
    out.push({ id: a.id, at: a.at, actor: actor ? { id: actor.id, name: actor.name, title: actor.title, hue: actor.avatar_hue } : null, source: 'admin', entity: 'workspace', entity_label: ctx.tenant.name, entity_id: ctx.tenant.id, action: a.action, summary: `Platform admin: ${a.action.replace(/_/g, ' ')}${a.reason ? ` — ${a.reason}` : ''}`, before: null, after: null, link: null })
  }
  // de-duplicate project status changes that also appear in the activity log within the same minute
  const statusKeys = new Set(out.filter((x) => x.source === 'project_status').map((x) => `${x.entity_id}|${x.at.slice(0, 16)}`))
  const reviewKeys = new Set(out.filter((x) => x.source === 'task_review').map((x) => `${x.entity_id}|${x.at.slice(0, 16)}`))
  const filtered = out.filter(
    (x) =>
      !(x.source === 'activity' && x.entity === 'project' && x.action === 'project.status' && statusKeys.has(`${x.entity_id}|${x.at.slice(0, 16)}`)) &&
      !(x.source === 'activity' && x.entity === 'task' && /^(approved|sent back)/i.test(x.summary) && reviewKeys.has(`${x.entity_id}|${x.at.slice(0, 16)}`)),
  )
  filtered.sort((a, b) => b.at.localeCompare(a.at))
  return filtered
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
export function register(r: Router) {
  /* ---------- approval workflow configuration (src/mock/workflows.ts) ---------- */
  registerWorkflows(r)

  /* ---------- people who hold a permission (pickers: deal owners, PMs, ops owners) ---------- */
  r.get('/directory/holders', ({ ctx, query }) => {
    const keys = String(query.perm ?? '').split(',').map((s) => s.trim()).filter(isPermissionKey)
    if (!keys.length) err(422, 'VALIDATION', 'Name at least one permission.', 'perm')
    return rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && keys.some((k) => permissionsOf(u).includes(k))).map((u) => u.id)
  })

  /* ---------- inbox ---------- */
  r.get('/inbox', ({ ctx }) => {
    const items = inboxItems(ctx)
    const counts = { all: items.length, overdue: items.filter((i) => i.overdue).length, timesheets: 0, tasks: 0, leave: 0, expenses: 0, purchases: 0, bills: 0, appraisals: 0, changes: 0, other: 0 } as InboxView['counts']
    for (const i of items) counts[i.group]++
    const v: InboxView = { items, counts, sla_days: S(ctx)['approval.sla_working_days'], bulk_enabled: S(ctx)['approval.bulk_approve'], can_pay_expenses: has(ctx, 'expenses.pay') }
    return v
  })
  r.get('/inbox/summary', ({ ctx }) => {
    if (ctx.isSuper && !rows(ctx, 'users').length) return { pending: 0, overdue: 0 }
    const items = inboxItems(ctx)
    return { pending: items.length, overdue: items.filter((i) => i.overdue).length }
  })
  r.get('/inbox/mine', ({ ctx }) => myRequests(ctx))

  /* ---------- OKRs ---------- */
  r.get('/okrs', ({ ctx, query }) => okrView(ctx, query.period ? String(query.period) : undefined, query.owner ? String(query.owner) : undefined))

  r.post('/okrs/objectives', ({ ctx, body }) => {
    const level = body.level as B.Objective['level']
    if (!['company', 'team', 'person'].includes(level)) err(422, 'VALIDATION', 'Choose company, team or personal.', 'level')
    const title = cleanTitle(body.title, 'Objective')
    const owner_id = String(body.owner_id ?? (level === 'company' ? ctx.user.id : ctx.user.id))
    find(ctx, 'users', owner_id, 'Owner')
    if (!canEditObjective(ctx, { level, owner_id }))
      err(403, 'FORBIDDEN', level === 'company' ? 'Only the CEO (admin) sets company objectives.' : level === 'team' ? 'Team objectives are set by managers for their own team.' : 'You can set personal objectives for yourself or people who report to you.')
    const periods = periodsAround(ctx)
    const p = periods.find((x) => x.label === body.period) ?? periods.find((x) => x.current)!
    let parent_id: string | null = body.parent_id ? String(body.parent_id) : null
    if (parent_id) {
      const parent = find(ctx, 'objectives', parent_id, 'Parent objective')
      if (parent.level === 'person' || (level === 'team' && parent.level !== 'company') || level === 'company') err(422, 'OKR_PARENT', 'Align a team objective to a company one, and a personal objective to a company or team one.', 'parent_id')
      if (parent.period !== p.label) err(422, 'OKR_PARENT', 'The parent objective must be in the same period.', 'parent_id')
    } else parent_id = null
    const o = insert(ctx, 'objectives', { title, level, owner_id, period: p.label, period_from: p.from, period_to: p.to, parent_id, status: 'on_track' })
    logActivity(ctx, 'objective', o.id, 'created', `Added ${level} objective “${title}” for ${p.label}`)
    return o
  })

  r.patch('/okrs/objectives/:id', ({ ctx, params, body, ifMatch }) => {
    const o = find(ctx, 'objectives', params.id, 'Objective')
    if (!canEditObjective(ctx, o)) err(403, 'FORBIDDEN', 'Only the owner, their manager or an admin can change this objective.')
    const patch: Partial<B.Objective> = {}
    if ('title' in body) patch.title = cleanTitle(body.title, 'Objective')
    if ('parent_id' in body) {
      const pid = body.parent_id ? String(body.parent_id) : null
      if (pid) {
        const parent = find(ctx, 'objectives', pid, 'Parent objective')
        if (pid === o.id || parent.level === 'person' || o.level === 'company' || (o.level === 'team' && parent.level !== 'company') || parent.period !== o.period) err(422, 'OKR_PARENT', 'Align a team objective to a company one, and a personal objective to a company or team one, in the same period.', 'parent_id')
      }
      patch.parent_id = pid
    }
    if ('status' in body) {
      if (body.status !== 'done' && body.status !== 'on_track') err(422, 'VALIDATION', 'An objective can only be marked done or reopened.', 'status')
      patch.status = body.status
    }
    const out = update(ctx, 'objectives', o.id, patch, ifMatch)
    logActivity(ctx, 'objective', o.id, patch.status === 'done' ? 'closed' : patch.status ? 'reopened' : 'updated', patch.status === 'done' ? `Marked “${out.title}” done` : patch.status ? `Reopened “${out.title}”` : `Updated “${out.title}”`)
    return out
  })

  r.del('/okrs/objectives/:id', ({ ctx, params }) => {
    const o = find(ctx, 'objectives', params.id, 'Objective')
    if (!canEditObjective(ctx, o)) err(403, 'FORBIDDEN', 'Only the owner, their manager or an admin can delete this objective.')
    if (rows(ctx, 'objectives').some((x) => x.parent_id === o.id)) err(409, 'OKR_HAS_CHILDREN', 'Other objectives are aligned to this one. Re-align or delete them first.')
    for (const k of rows(ctx, 'key_results').filter((k) => k.objective_id === o.id)) remove(ctx, 'key_results', k.id)
    remove(ctx, 'objectives', o.id)
    logActivity(ctx, 'objective', o.id, 'deleted', `Deleted objective “${o.title}”`)
    return { ok: true }
  })

  const krInput = (ctx: Ctx, body: Record<string, unknown>, existing?: B.KeyResult) => {
    const metric = (body.metric ?? existing?.metric ?? 'manual') as KRMetric
    if (!METRICS.includes(metric)) err(422, 'VALIDATION', 'Choose how this key result is measured.', 'metric')
    const meta = METRIC_META[metric]
    const title = 'title' in body || !existing ? cleanTitle(body.title, 'Key result') : existing.title
    const start_value = 'start_value' in body || !existing ? num(body.start_value ?? 0, 'start_value', 'Start value') : existing.start_value
    const target = 'target' in body || !existing ? num(body.target, 'target', 'Target') : existing.target
    if (target === start_value) err(422, 'VALIDATION', 'Target must differ from the start value.', 'target')
    if (meta.kind === 'percent' && (target < 0 || target > 100)) err(422, 'VALIDATION', 'A percentage target must be between 0 and 100.', 'target')
    const unit = metric === 'manual' ? String(body.unit ?? existing?.unit ?? '').trim().slice(0, 16) : meta.unit
    const owner_id = String(body.owner_id ?? existing?.owner_id ?? ctx.user.id)
    find(ctx, 'users', owner_id, 'Owner')
    return { title, metric, start_value, target, unit, owner_id }
  }

  r.post('/okrs/objectives/:id/key-results', ({ ctx, params, body }) => {
    const o = find(ctx, 'objectives', params.id, 'Objective')
    if (!canEditObjective(ctx, o)) err(403, 'FORBIDDEN', 'Only the owner, their manager or an admin can add key results.')
    const v = krInput(ctx, body)
    if (rows(ctx, 'key_results').filter((k) => k.objective_id === o.id).length >= 6) err(409, 'OKR_TOO_MANY', 'Keep it to five or six key results per objective.')
    const k = insert(ctx, 'key_results', { ...v, objective_id: o.id, current: v.start_value })
    logActivity(ctx, 'key_result', k.id, 'created', `Added key result “${k.title}” (${METRIC_META[k.metric].label})`)
    return k
  })

  r.patch('/okrs/key-results/:id', ({ ctx, params, body, ifMatch }) => {
    const k = find(ctx, 'key_results', params.id, 'Key result')
    const o = find(ctx, 'objectives', k.objective_id, 'Objective')
    if (!canEditObjective(ctx, o)) err(403, 'FORBIDDEN', 'Only the objective owner, their manager or an admin can change key results.')
    const v = krInput(ctx, body, k)
    const out = update(ctx, 'key_results', k.id, v, ifMatch)
    logActivity(ctx, 'key_result', k.id, 'updated', `Changed key result: target ${k.target} → ${out.target}`)
    return out
  })

  r.del('/okrs/key-results/:id', ({ ctx, params }) => {
    const k = find(ctx, 'key_results', params.id, 'Key result')
    const o = find(ctx, 'objectives', k.objective_id, 'Objective')
    if (!canEditObjective(ctx, o)) err(403, 'FORBIDDEN', 'Only the objective owner, their manager or an admin can remove key results.')
    remove(ctx, 'key_results', k.id)
    logActivity(ctx, 'objective', o.id, 'kr_deleted', `Removed key result “${k.title}”`)
    return { ok: true }
  })

  r.post('/okrs/key-results/:id/check-in', ({ ctx, params, body, ifMatch }) => {
    const k = find(ctx, 'key_results', params.id, 'Key result')
    const o = find(ctx, 'objectives', k.objective_id, 'Objective')
    if (k.metric !== 'manual') err(409, 'OKR_AUTO', 'This key result is calculated from live data. It updates on its own.')
    if (!(canEditObjective(ctx, o) || k.owner_id === ctx.user.id)) err(403, 'FORBIDDEN', 'Only the key result owner, the objective owner or their manager can check in.')
    const value = num(body.value, 'value', 'Current value')
    const note = String(body.note ?? '').trim()
    if (note.length < 5) err(422, 'VALIDATION', 'Add a short note on what changed (at least 5 characters).', 'note')
    const before = k.current
    const out = update(ctx, 'key_results', k.id, { current: value }, ifMatch)
    const u = k.unit ? (k.unit === '%' ? '%' : ` ${k.unit}`) : ''
    logActivity(ctx, 'key_result', k.id, 'check_in', `${before}${u} → ${value}${u}: ${note}`)
    return out
  })

  /* ---------- audit ---------- */
  r.get('/audit', ({ ctx, query }) => {
    if (!has(ctx, 'audit.view')) err(403, 'FORBIDDEN', 'The audit trail is for admins.')
    const all = auditRows(ctx)
    const q = String(query.q ?? '').trim().toLowerCase()
    const actor = query.actor ? String(query.actor) : ''
    const entity = query.entity ? String(query.entity) : ''
    const from = query.from ? String(query.from) : ''
    const to = query.to ? String(query.to) : ''
    const matchBase = (x: AuditRow) => (!actor || x.actor?.id === actor) && (!from || x.at.slice(0, 10) >= from) && (!to || x.at.slice(0, 10) <= to) && (!q || `${x.summary} ${x.entity_label} ${x.actor?.name ?? ''} ${x.action}`.toLowerCase().includes(q))
    const base = all.filter(matchBase)
    const list = entity ? base.filter((x) => x.entity === entity) : base
    const counts = new Map<string, number>()
    for (const x of base) counts.set(x.entity, (counts.get(x.entity) ?? 0) + 1)
    const size = query.all ? 5000 : 100
    const page = Math.max(1, Number(query.page ?? 1))
    const actors = new Map<string, PersonLite>()
    for (const x of all) if (x.actor) actors.set(x.actor.id, x.actor)
    const res: AuditResult = {
      items: list.slice((page - 1) * size, page * size),
      total: list.length,
      page,
      page_size: size,
      entities: [...counts.entries()].map(([value, count]) => ({ value, label: entityLabel(value), count })).sort((a, b) => b.count - a.count),
      actors: [...actors.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }
    return res
  })
}
