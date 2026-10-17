// Client-side draft model for the week grid. Totals here are display hints only; the server re-validates everything.
import type { RowInput, WeekRow, WeekView, WorkItem } from '@/api/work'
import { INTERNAL_CODES, LEAVE_TYPE } from '@/domain/labels'
import type { LeaveType } from '@/types/entities'

export interface DraftRow extends RowInput {
  uid: string
  label: string
  sublabel: string
  wbs: string | null
  project_code: string | null
  est_hours: number | null
  logged_hours: number | null
  locked_reason: string | null
}

let n = 0
const uid = () => `r${Date.now().toString(36)}${(n++).toString(36)}`

export function fromView(v: WeekView): DraftRow[] {
  return v.rows.map((r: WeekRow) => ({
    uid: uid(),
    kind: r.kind,
    task_id: r.task_id,
    internal_code: r.internal_code,
    leave_type: r.leave_type,
    note: r.note,
    hours: { ...r.hours },
    label: r.label,
    sublabel: r.sublabel,
    wbs: r.wbs,
    project_code: r.project_code,
    est_hours: r.est_hours,
    logged_hours: r.logged_hours,
    locked_reason: r.locked_reason,
    project_id: r.kind === 'internal' ? r.project_id ?? null : null,
  }))
}

export const leaveLabel = (t: LeaveType) => (t === 'lwp' || t === 'optional_holiday' ? LEAVE_TYPE[t] : `${LEAVE_TYPE[t]} leave`)

export function fromItem(it: WorkItem, extra: { project_id?: string | null; note?: string; hours?: Record<string, number> } = {}): DraftRow {
  const label = it.kind === 'task' ? it.label.replace(/^\d+\.\d+\s/, '') : it.kind === 'leave' ? leaveLabel(it.leave_type!) : INTERNAL_CODES[it.internal_code!] ?? it.label
  return {
    uid: uid(),
    kind: it.kind,
    task_id: it.task_id,
    internal_code: it.internal_code,
    leave_type: it.leave_type,
    note: it.kind === 'internal' ? extra.note ?? '' : '',
    hours: { ...(extra.hours ?? {}) },
    project_id: it.kind === 'internal' ? extra.project_id ?? null : null,
    label,
    sublabel: it.kind === 'task' ? it.hint : it.kind === 'leave' ? 'Leave' : 'Activity',
    wbs: it.wbs,
    project_code: it.project_code,
    est_hours: null,
    logged_hours: null,
    locked_reason: null,
  }
}

export function toInput(rows: DraftRow[]): RowInput[] {
  return rows.map((r) => ({ kind: r.kind, task_id: r.task_id, internal_code: r.internal_code, leave_type: r.leave_type, note: r.note, project_id: r.kind === 'internal' ? r.project_id ?? null : null, hours: Object.fromEntries(Object.entries(r.hours).filter(([, h]) => h > 0)) }))
}

export function signature(rows: DraftRow[]) {
  return JSON.stringify(toInput(rows))
}

export const rowTotal = (r: DraftRow) => Object.values(r.hours).reduce((s, h) => s + (h || 0), 0)
export const dayTotal = (rows: DraftRow[], date: string) => rows.reduce((s, r) => s + (r.hours[date] || 0), 0)
/** Hours that count toward the daily minimum (lunch, tea and stand-up only when the company counts breaks). Display hint; the server decides. */
export const countedTotal = (rows: DraftRow[], date: string, breaksCount: boolean) => rows.reduce((s, r) => s + (r.kind === 'internal' && r.internal_code === 'breaks' && !breaksCount ? 0 : r.hours[date] || 0), 0)
export const round2 = (x: number) => Math.round(x * 100) / 100

/** Parse "7.5", "7,5", "7:30", "7h30" → hours; null when empty; NaN when junk. */
export function parseHours(s: string): number | null {
  const t = s.trim().toLowerCase().replace(',', '.')
  if (!t) return null
  const hm = t.match(/^(\d{1,2})\s*[:h]\s*(\d{1,2})m?$/)
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60
  const n = Number(t.replace(/h$/, ''))
  return Number.isFinite(n) ? n : NaN
}
export function snap(h: number, step: number) {
  return Math.max(0, Math.round(h / step) * step)
}
export function fmtH(h: number) {
  if (!h) return ''
  return String(round2(h))
}

/** Day tone: success ≥ min, warning ≥ 80%, danger below (past working days only). */
export function dayTone(total: number, min: number, past: boolean): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!min) return 'neutral'
  if (total >= min) return 'success'
  if (!past) return total > 0 ? 'warning' : 'neutral'
  return total >= min * 0.8 ? 'warning' : 'danger'
}
