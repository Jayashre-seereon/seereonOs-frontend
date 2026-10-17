// Module D — Operations register (UI-33): recurring duties, Mark done roll-forward, NTF-13 reminders.
import type * as E from '@/types/entities'
import { err, find, getDb, has, hasAny, insert, logActivity, notify, remove, requireAction, rows, update, userName, type Ctx, type Router } from '../server'
import { addDays, addMonths, diffDays, fmtDate, fyLabel, monthOf, monthRange, quarterOf, weekStart } from '@/domain/calendar'
import { effectiveWeekStatus, isTimesheetUser } from './reports'
import { milestoneState } from '../analytics'

export type OpsGroup = 'overdue' | 'due' | 'upcoming' | 'done'
export interface OpsRow extends E.OpsItem {
  owner_name: string
  group: OpsGroup
  days: number // days until due (negative = overdue)
}
/** One completed occurrence of a recurring duty (kept on the item so the 90-day on-time rate is real). */
export interface OpsHistory { due_on: string; done_on: string; period: string; on_time: boolean; by: string | null }
type OpsItemX = E.OpsItem & { history?: OpsHistory[] }
export interface OpsOccurrence { key: string; id: string; item: string; category: E.OpsItem['category']; recurring: E.Recurrence; owner_id: string; owner_name: string; due_on: string; period: string; days: number; status: 'overdue' | 'upcoming'; current: boolean; version: number }
export interface OpsSummary {
  kpis: { on_time_90: number | null; done_90: number; on_time_90_count: number; overdue_now: number; due_10: number; tracked: number }
  occurrences: OpsOccurrence[]
  people: { can: boolean; people: number; missing_last_week: number; pending_approval: number; on_leave_today: number; last_week: string }
  payroll: { can: boolean; month: string; label: string; status: 'not_started' | 'draft' | 'final'; run_id: string | null; last_label: string; last_status: 'not_started' | 'draft' | 'final'; last_run_id: string | null }
  invoicing: { can: boolean; outstanding: number; overdue_count: number; overdue_amount: number; achieved_not_invoiced: number; achieved_count: number; collected_month: number }
}
/** The period a due date belongs to: week (Monday), month, quarter or financial year. */
export function periodOf(due: string, rec: E.Recurrence, fyStart = 4): string {
  switch (rec) {
    case 'weekly':
      return weekStart(due)
    case 'monthly':
      return monthOf(due)
    case 'quarterly': {
      const q = quarterOf(due, fyStart)
      return `Q${q.q} ${fyLabel(q.fy)}`
    }
    case 'yearly':
      return fyLabel(quarterOf(due, fyStart).fy)
    default:
      return due
  }
}

export interface OpsResult {
  items: OpsRow[]
  counts: Record<OpsGroup, number>
  openings: { open: number; interviewing: number; offered: number; total_positions: number }
  can_edit: boolean
}

const CATS: E.OpsItem['category'][] = ['payroll', 'compliance', 'finance', 'admin', 'hr', 'it']
const RECS: E.Recurrence[] = ['none', 'weekly', 'monthly', 'quarterly', 'yearly']
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** "Due" = within the next 7 days; later = upcoming. */
const DUE_WINDOW = 7

export function nextDue(due: string, rec: E.Recurrence): string {
  switch (rec) {
    case 'weekly':
      return addDays(due, 7)
    case 'monthly':
      return addMonths(due, 1)
    case 'quarterly':
      return addMonths(due, 3)
    case 'yearly':
      return addMonths(due, 12)
    default:
      return due
  }
}

function groupOf(ctx: Ctx, i: E.OpsItem): OpsGroup {
  if (i.status === 'done') return 'done'
  if (i.due_on < ctx.today) return 'overdue'
  if (i.due_on <= addDays(ctx.today, DUE_WINDOW)) return 'due'
  return 'upcoming'
}
function view(ctx: Ctx, i: E.OpsItem): OpsRow {
  return { ...i, owner_name: userName(ctx, i.owner_id), group: groupOf(ctx, i), days: diffDays(i.due_on, ctx.today) }
}

function validate(ctx: Ctx, b: Partial<E.OpsItem>, creating: boolean) {
  if (creating || 'item' in b) if (!b.item || String(b.item).trim().length < 3) err(422, 'VALIDATION', 'Name the responsibility (at least 3 characters).', 'item')
  if (creating || 'category' in b) if (!b.category || !CATS.includes(b.category)) err(422, 'VALIDATION', 'Choose an area.', 'category')
  if (creating || 'recurring' in b) if (!b.recurring || !RECS.includes(b.recurring)) err(422, 'VALIDATION', 'Choose how often it repeats.', 'recurring')
  if (creating || 'due_on' in b) if (!b.due_on || !DATE.test(b.due_on)) err(422, 'VALIDATION', 'Pick a due date.', 'due_on')
  if (creating || 'owner_id' in b) if (!b.owner_id || !rows(ctx, 'users').some((u) => u.id === b.owner_id && u.status === 'active')) err(422, 'VALIDATION', 'Choose an active owner.', 'owner_id')
}

/** NTF-13 to the owner for overdue items — at most once per item per day. */
function remindOverdue(ctx: Ctx, items: OpsRow[]) {
  const sent = new Set(getDb().notifications.filter((n) => n.tenant_id === ctx.tenant.id && n.type === 'NTF-13' && n.created_at.slice(0, 10) === ctx.today).map((n) => n.user_id + '|' + n.body))
  for (const i of items) {
    if (i.group !== 'overdue') continue
    const body = `${i.item} was due ${fmtDate(i.due_on)} (${-i.days} day${i.days === -1 ? '' : 's'} ago).`
    const tag = i.owner_id + '|' + body
    if (sent.has(tag)) continue
    sent.add(tag)
    notify(ctx, i.owner_id, 'NTF-13', 'Ops item overdue', body, '/operations')
  }
}

export function register(r: Router) {
  r.get('/ops', ({ ctx, query }) => {
    requireAction(ctx, 'ops.manage', 'The operations register is for admins and operations.')
    let list = rows(ctx, 'ops_items').map((i) => view(ctx, i))
    remindOverdue(ctx, list)
    if (query.owner_id) list = list.filter((i) => i.owner_id === query.owner_id)
    if (query.category) list = list.filter((i) => i.category === query.category)
    const q = String(query.q ?? '').trim().toLowerCase()
    if (q) list = list.filter((i) => `${i.item} ${i.notes}`.toLowerCase().includes(q))
    list.sort((a, b) => a.due_on.localeCompare(b.due_on))
    const counts = { overdue: 0, due: 0, upcoming: 0, done: 0 } as Record<OpsGroup, number>
    for (const i of list) counts[i.group]++
    const op = rows(ctx, 'openings')
    const out: OpsResult = {
      items: list,
      counts,
      openings: {
        open: op.filter((o) => o.status === 'open').length,
        interviewing: op.filter((o) => o.status === 'interviewing').length,
        offered: op.filter((o) => o.status === 'offered').length,
        total_positions: op.filter((o) => !['filled', 'on_hold'].includes(o.status)).reduce((s, o) => s + o.count, 0),
      },
      can_edit: true,
    }
    return out
  })

  // Feature Guide §14: recurring-duty KPIs, due & overdue occurrences, and the other operations tabs' summaries.
  r.get('/ops/summary', ({ ctx }) => opsSummary(ctx))

  r.post('/ops', ({ ctx, body }) => {
    requireAction(ctx, 'ops.manage', 'Only admins and operations can add ops items.')
    const b = body as Partial<E.OpsItem>
    validate(ctx, b, true)
    const i = insert(ctx, 'ops_items', { item: b.item!.trim(), category: b.category!, owner_id: b.owner_id!, due_on: b.due_on!, recurring: b.recurring!, status: 'open', last_done_on: null, notes: (b.notes ?? '').trim() } as never) as E.OpsItem
    logActivity(ctx, 'ops_item', i.id, 'create', `Added ops item ${i.item}`)
    if (i.owner_id !== ctx.user.id) notify(ctx, i.owner_id, 'NTF-13', 'New ops responsibility', `${i.item} — first due ${fmtDate(i.due_on)}.`, '/operations')
    return view(ctx, i)
  })

  r.patch('/ops/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'ops.manage', 'Only admins and operations can edit ops items.')
    const cur = find(ctx, 'ops_items', params.id, 'Ops item')
    const b = body as Partial<E.OpsItem>
    validate(ctx, b, false)
    const patch: Partial<E.OpsItem> = {}
    for (const k of ['item', 'category', 'owner_id', 'due_on', 'recurring', 'notes'] as const) if (k in b) (patch as Record<string, unknown>)[k] = typeof b[k] === 'string' ? (b[k] as string).trim() : b[k]
    if ('status' in b && (b.status === 'open' || b.status === 'done')) patch.status = b.status
    const u = update(ctx, 'ops_items', cur.id, patch as never, ifMatch)
    logActivity(ctx, 'ops_item', cur.id, 'update', `Edited ops item ${u.item}`)
    return view(ctx, u)
  })

  r.post('/ops/:id/done', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'ops.manage', 'Only admins and operations can mark ops items done.')
    const cur = find(ctx, 'ops_items', params.id, 'Ops item')
    if (cur.status === 'done') err(409, 'OPS_DONE', 'This item is already done.')
    const on = DATE.test(String(body.done_on ?? '')) ? String(body.done_on) : ctx.today
    if (on > ctx.today) err(422, 'VALIDATION', 'The done date cannot be in the future.', 'done_on')
    const fyS = ctx.tenant.settings['company.fy_start_month'] ?? 4
    const hist: OpsHistory[] = [...((cur as OpsItemX).history ?? []), { due_on: cur.due_on, done_on: on, period: periodOf(cur.due_on, cur.recurring, fyS), on_time: on <= cur.due_on, by: ctx.user.id }].slice(-80)
    const patch: Partial<OpsItemX> = { last_done_on: on, history: hist }
    if (cur.recurring === 'none') patch.status = 'done'
    else {
      // roll forward; if it was very late, keep rolling until the next due is after the done date
      let next = nextDue(cur.due_on, cur.recurring)
      let guard = 0
      while (next <= on && guard++ < 60) next = nextDue(next, cur.recurring)
      patch.due_on = next
    }
    const u = update(ctx, 'ops_items', cur.id, patch as never, ifMatch)
    const late = on > cur.due_on
    logActivity(ctx, 'ops_item', cur.id, 'done', `Marked ${cur.item} done${late ? ` (${diffDays(on, cur.due_on)}d late)` : ''}${u.status === 'open' ? `; next due ${u.due_on}` : ''}`)
    return { item: view(ctx, u), late, next_due: u.status === 'open' ? u.due_on : null }
  })

  r.del('/ops/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'ops.manage', 'Only admins and operations can delete ops items.')
    const cur = find(ctx, 'ops_items', params.id, 'Ops item')
    remove(ctx, 'ops_items', cur.id, ifMatch)
    logActivity(ctx, 'ops_item', cur.id, 'delete', `Deleted ops item ${cur.item}`)
    return { ok: true }
  })
}

/** Occurrences of open duties that are overdue or due within the next 10 days (a missed weekly duty shows each missed week). */
function occurrences(ctx: Ctx, items: OpsItemX[]): OpsOccurrence[] {
  const t = ctx.today
  const horizon = addDays(t, 10)
  const fyS = ctx.tenant.settings['company.fy_start_month'] ?? 4
  const out: OpsOccurrence[] = []
  for (const i of items) {
    if (i.status !== 'open') continue
    let d = i.due_on
    let first = true
    let g = 0
    while (d <= horizon && g++ < 60) {
      out.push({ key: `${i.id}:${d}`, id: i.id, item: i.item, category: i.category, recurring: i.recurring, owner_id: i.owner_id, owner_name: userName(ctx, i.owner_id), due_on: d, period: periodOf(d, i.recurring, fyS), days: diffDays(d, t), status: d < t ? 'overdue' : 'upcoming', current: first, version: i.version })
      first = false
      if (i.recurring === 'none') break
      d = nextDue(d, i.recurring)
    }
  }
  return out.sort((a, b) => a.due_on.localeCompare(b.due_on) || a.item.localeCompare(b.item))
}

export function opsSummary(ctx: Ctx): OpsSummary {
  if (!hasAny(ctx, 'ops.manage', 'finance.view')) err(403, 'FORBIDDEN', 'Operations is for admins and operations.')
  const t = ctx.today
  const items = rows(ctx, 'ops_items') as OpsItemX[]
  const occ = occurrences(ctx, items)
  const since = addDays(t, -90)
  const hist = items.flatMap((i) => (i.history ?? []).filter((h) => h.due_on >= since && h.due_on <= t))
  const missed = occ.filter((o) => o.status === 'overdue' && o.due_on >= since)
  const onTime = hist.filter((h) => h.on_time).length
  const denom = hist.length + missed.length
  // people & timesheets
  const people = rows(ctx, 'users').filter(isTimesheetUser)
  const lastMon = addDays(weekStart(t), -7)
  const weeks = rows(ctx, 'timesheet_weeks')
  const missing = people.filter((u) => {
    const st = effectiveWeekStatus(ctx, weeks.find((w) => w.user_id === u.id && w.week_start === lastMon), lastMon)
    return st !== 'approved' && st !== 'submitted'
  }).length
  // payroll
  const runs = rows(ctx, 'payroll_runs')
  const ym = monthOf(t)
  const lm = monthOf(addMonths(ym + '-01', -1))
  const lbl = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
  const cur = runs.find((r) => r.month === ym)
  const last = runs.find((r) => r.month === lm)
  // invoicing & collections
  const canMoney = has(ctx, 'finance.view')
  const invoices = rows(ctx, 'invoices')
  const outstanding = invoices.filter((i) => i.amount_paise > i.paid_amount_paise)
  const overdue = outstanding.filter((i) => i.due_on < t)
  const live = new Set(rows(ctx, 'projects').filter((p) => !['closed', 'npa'].includes(p.status)).map((p) => p.id))
  // "Achieved" matches the effective definition used on the CEO dashboard, margins and milestone pages:
  // formally achieved (achieved_on set) OR all of the milestone's tasks done (milestoneState achieved_*).
  const liveTasks = rows(ctx, 'tasks').filter((x) => live.has(x.project_id))
  const achieved = rows(ctx, 'milestones').filter(
    (m) => !m.deleted_at && live.has(m.project_id) && m.billing_status === 'none' && m.billing_amount_paise > 0 && milestoneState(ctx, m, liveTasks).state.startsWith('achieved'),
  )
  const mr = monthRange(ym)
  const collected = rows(ctx, 'payments').filter((p) => p.paid_on >= mr.from && p.paid_on <= mr.to).reduce((s, p) => s + p.amount_paise, 0)
  return {
    kpis: {
      on_time_90: denom ? onTime / denom : null,
      done_90: hist.length,
      on_time_90_count: onTime,
      overdue_now: occ.filter((o) => o.status === 'overdue').length,
      due_10: occ.filter((o) => o.status === 'upcoming').length,
      tracked: items.filter((i) => i.status === 'open').length,
    },
    occurrences: occ,
    people: { can: hasAny(ctx, 'people.view_all', 'team.view', 'ops.manage'), people: people.length, missing_last_week: missing, pending_approval: weeks.filter((w) => w.status === 'submitted').length, on_leave_today: rows(ctx, 'leave').filter((l) => l.date === t).length, last_week: lastMon },
    payroll: { can: hasAny(ctx, 'payroll.run', 'payroll.finalise'), month: ym, label: lbl(ym), status: cur ? cur.status : 'not_started', run_id: cur?.id ?? null, last_label: lbl(lm), last_status: last ? last.status : 'not_started', last_run_id: last?.id ?? null },
    invoicing: {
      can: canMoney,
      outstanding: canMoney ? outstanding.reduce((s, i) => s + i.amount_paise - i.paid_amount_paise, 0) : 0,
      overdue_count: canMoney ? overdue.length : 0,
      overdue_amount: canMoney ? overdue.reduce((s, i) => s + i.amount_paise - i.paid_amount_paise, 0) : 0,
      achieved_not_invoiced: canMoney ? achieved.reduce((s, m) => s + m.billing_amount_paise, 0) : 0,
      achieved_count: canMoney ? achieved.length : 0,
      collected_month: canMoney ? collected : 0,
    },
  }
}
