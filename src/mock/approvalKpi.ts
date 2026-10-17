// Approval KPI (Feature Guide §9, BR-11) — the single calculation every screen uses.
//
// A manager has `approval.sla_working_days` working days after a week is submitted to approve or reject it.
//   • on time   — decided on or before the due date
//   • lapse     — decided after the due date, or still waiting past it (negative KPI)
// Decisions are credited to whoever DECIDED (`decided_by`), so a delegate's approvals count toward the
// delegate's KPI, not the original approver's. Weeks still waiting count against their current approver.
// Auto-approved weeks of the top person are not approvals and are ignored.
import type * as E from '@/types/entities'
import { addDays } from '@/domain/calendar'
import { rows, type Ctx } from './server'
import { slaDue } from './analytics'

export interface ApprovalKpi {
  user_id: string
  window_days: number
  /** decisions made in the window */
  decided: number
  on_time: number
  /** decisions in the window made after the deadline */
  late: number
  /** waiting right now, past the deadline */
  overdue_now: number
  /** waiting right now, still inside the deadline */
  waiting_within: number
  /** late decisions in the window + overdue right now */
  lapses: number
  /** on time ÷ (on time + lapses); null when there was nothing to approve */
  on_time_pct: number | null
}

const empty = (user_id: string, window_days: number): ApprovalKpi => ({ user_id, window_days, decided: 0, on_time: 0, late: 0, overdue_now: 0, waiting_within: 0, lapses: 0, on_time_pct: null })

function isDecision(w: E.TimesheetWeek) {
  return (w.status === 'approved' || w.status === 'rejected') && !!w.decided_by && w.decided_by !== w.user_id && !!w.decided_at
}

/** Was this decision late? Uses the stored flag, else recomputes from the submission date. */
function decidedLate(ctx: Ctx, w: E.TimesheetWeek) {
  if (w.late) return true
  if (!w.submitted_at || !w.decided_at) return false
  return w.decided_at.slice(0, 10) > slaDue(ctx, w.submitted_at)
}

/** Approval KPI for every approver with activity in the last `days` days (keyed by user id). */
export function approvalKpis(ctx: Ctx, days = 30): Map<string, ApprovalKpi> {
  const since = addDays(ctx.today, -days)
  const out = new Map<string, ApprovalKpi>()
  const get = (id: string) => {
    let k = out.get(id)
    if (!k) out.set(id, (k = empty(id, days)))
    return k
  }
  for (const w of rows(ctx, 'timesheet_weeks')) {
    if (isDecision(w)) {
      if (w.decided_at!.slice(0, 10) < since) continue
      const k = get(w.decided_by!)
      k.decided++
      if (decidedLate(ctx, w)) k.late++
      else k.on_time++
    } else if (w.status === 'submitted' && w.submitted_at && w.approver_id && w.approver_id !== w.user_id) {
      const k = get(w.approver_id)
      if (ctx.today > slaDue(ctx, w.submitted_at)) k.overdue_now++
      else k.waiting_within++
    }
  }
  for (const k of out.values()) {
    k.lapses = k.late + k.overdue_now
    const base = k.on_time + k.lapses
    k.on_time_pct = base ? Math.round((k.on_time / base) * 1000) / 1000 : null
  }
  return out
}

/** Approval KPI of one person over the last `days` days (zeros when they approved nothing). */
export function approvalKpi(ctx: Ctx, userId: string, days = 30): ApprovalKpi {
  return approvalKpis(ctx, days).get(userId) ?? empty(userId, days)
}
