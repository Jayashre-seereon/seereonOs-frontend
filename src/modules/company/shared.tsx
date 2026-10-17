// Shared formatting + labels for the company screens (inbox, OKRs, audit).
import type { FactType, InboxGroup, InboxItem, InboxKind, KRView, OkrStatus, RequestState } from '@/api/company'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import type { Tone } from '@/domain/labels'
import { fmtHours, fmtMoney, fmtMoneyCompact, fmtNum } from '@/domain/money'

export const KIND_LABEL: Record<InboxKind, string> = {
  timesheet: 'Timesheet',
  unlock: 'Unlock request',
  task_review: 'Task review',
  leave: 'Leave',
  expense: 'Expense',
  purchase_order: 'Purchase order',
  vendor_bill: 'Vendor bill',
  appraisal: 'Appraisal',
  change_request: 'Change request',
  document: 'Must-read document',
  change: 'Change to check',
  workflow: 'Workflow step',
}
export function kindLabel(i: InboxItem) {
  if (i.kind === 'expense' && i.stage === 'pay') return 'Expense to pay'
  if (i.kind === 'vendor_bill') return i.stage === 'pay' ? 'Bill to pay' : 'Bill to approve'
  return KIND_LABEL[i.kind]
}
export const GROUP_LABEL: Record<InboxGroup, string> = {
  timesheets: 'Timesheets',
  tasks: 'Tasks',
  leave: 'Leave',
  expenses: 'Expenses',
  purchases: 'Purchases',
  bills: 'Bills',
  appraisals: 'Appraisals',
  changes: 'Changes to check',
  other: 'Other',
}
export const GROUP_ORDER: InboxGroup[] = ['changes', 'timesheets', 'tasks', 'leave', 'expenses', 'purchases', 'bills', 'appraisals', 'other']

export function fmtFact(v: string | number | null, t: FactType): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (t) {
    case 'money':
      return fmtMoney(Number(v))
    case 'date':
      return fmtDate(String(v))
    case 'datetime':
      return fmtDateTime(String(v))
    case 'hours':
      return fmtHours(Number(v))
    case 'number':
      return fmtNum(Number(v), 1)
    case 'days':
      return `${v}d`
    default:
      return String(v)
  }
}

export function dueText(i: Pick<InboxItem, 'due_at' | 'overdue'>, today: string) {
  if (!i.due_at) return 'No deadline'
  if (i.overdue) return `Overdue since ${fmtDate(i.due_at)}`
  if (i.due_at === today) return 'Due today'
  return `Due ${fmtDate(i.due_at)}`
}

export const REQUEST_TONE: Record<RequestState, Tone> = {
  pending: 'warning',
  approved: 'success',
  paid: 'success',
  rejected: 'danger',
  sent_back: 'danger',
  draft: 'neutral',
  cancelled: 'neutral',
}

export const OKR_STATUS: Record<OkrStatus, { label: string; tone: Tone }> = {
  on_track: { label: 'On track', tone: 'success' },
  at_risk: { label: 'At risk', tone: 'warning' },
  off_track: { label: 'Off track', tone: 'danger' },
  done: { label: 'Done', tone: 'brand' },
  not_started: { label: 'Not started', tone: 'neutral' },
}
export const LEVEL_LABEL = { company: 'Company', team: 'Team', person: 'Personal' } as const

/** Format a key-result value in its own unit (money is paise). */
export function fmtKR(k: Pick<KRView, 'kind' | 'unit'>, v: number | null | undefined, compact = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (k.kind === 'money') return compact ? fmtMoneyCompact(v) : fmtMoney(v)
  if (k.kind === 'percent') return `${fmtNum(v, 1)}%`
  return k.unit ? `${fmtNum(v, 1)} ${k.unit}` : fmtNum(v, 1)
}
export const pct = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `${Math.round(p * 100)}%`)
export const toneOfProgress = (s: OkrStatus): Tone => OKR_STATUS[s].tone
