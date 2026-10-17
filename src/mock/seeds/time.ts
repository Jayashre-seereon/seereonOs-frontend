// Time & people seed (workstream C, v5 Feature Guide parity). Runs after the base seed and the other seed
// extensions and reshapes the Seereon timesheet weeks into the states the guide shows:
//   • last week: Hritesh and Bijaya submitted (within the deadline), Jagannath / Jayashree / Pragyasmita locked,
//     Baishali submitted (overdue for Santosh), Subham sent back
//   • the week before: Pragyasmita and Priya submitted and overdue (approval lapses)
//   • one approval made by a delegate (credited to the delegate's approval KPI)
// plus productive hours per person, Friday demos with notes, HR-entered leave (incl. an optional holiday),
// a one-project delegation, the optional-holiday leave policy and a few "Lunch, tea and stand-up" rows.
import type * as E from '@/types/entities'
import type { DB } from '../server'
import type { SeedHelpers } from './index'
import { addDays, isWorkingDay, weekStart, type CalendarCtx } from '@/domain/calendar'

const T1 = 'tn_seereon'
const T2 = 'tn_kalinga'
const U = (k: string) => `u_${k}`

export function seed(db: DB, h: SeedHelpers) {
  const { today } = h
  const t1 = db.tenants.find((t) => t.id === T1)
  if (!t1) return
  const at = <T extends object>(tenant: string, data: T) => ({ ...h.base(tenant), ...data })
  const user = (k: string) => db.users.find((u) => u.id === U(k))
  const thisMon = weekStart(today)
  const wk = (n: number) => addDays(thisMon, -7 * n)
  const ts = (d: string, hm = '12:30') => `${d}T${hm}:00Z`

  /* ---------- optional holiday on the calendar + policy ---------- */
  if (!db.holidays.some((x) => x.tenant_id === T1 && x.date === '2026-09-15')) db.holidays.push(at(T1, { date: '2026-09-15', name: 'Nuakhai', optional: true }) as E.Holiday)
  for (const tn of [T1, T2])
    if (!db.leave_policies.some((p) => p.tenant_id === tn && p.type === 'optional_holiday'))
      db.leave_policies.push(at(tn, { type: 'optional_holiday', annual_days: 2, carry_forward_max: 0, accrual: 'upfront' }) as never)
  const cal: CalendarCtx = { settings: t1.settings, holidays: db.holidays.filter((x) => x.tenant_id === T1) }

  /* ---------- productive hours a day (Feature Guide §16 team table) ---------- */
  const productive: Record<string, number> = { santosh: 2, subhankar: 4, hritesh: 6, bijaya: 6, jagannath: 6, jayashree: 6, pragyasmita: 6, baishali: 5, subham: 5, priya: 6, debasish: 6 }
  for (const [k, v] of Object.entries(productive)) {
    const u = user(k)
    if (u) u.productive_hours = v
  }

  /* ---------- timesheet week states ---------- */
  const week = (k: string, mon: string) => db.timesheet_weeks.find((w) => w.user_id === U(k) && w.week_start === mon)
  const set = (k: string, mon: string, patch: Partial<E.TimesheetWeek>) => {
    const w = week(k, mon)
    if (w) Object.assign(w, patch)
    return w
  }
  const lockedPatch: Partial<E.TimesheetWeek> = { status: 'locked', submitted_at: null, decided_by: null, decided_at: null, late: false, reject_reason: null }
  // last week (wk 1)
  set('hritesh', wk(1), { status: 'submitted', submitted_at: ts(addDays(today, -1), '13:10'), decided_by: null, decided_at: null, late: false })
  set('bijaya', wk(1), { status: 'submitted', submitted_at: ts(addDays(today, -1), '15:40'), decided_by: null, decided_at: null, late: false })
  set('jayashree', wk(1), lockedPatch)
  set('pragyasmita', wk(1), lockedPatch)
  set('baishali', wk(1), { status: 'submitted', submitted_at: ts(addDays(wk(1), 5), '11:00'), decided_by: null, decided_at: null, late: false })
  // the week before (wk 2): Pragyasmita and Priya still waiting, past the deadline
  set('pragyasmita', wk(2), { status: 'submitted', submitted_at: ts(addDays(wk(2), 5)), decided_by: null, decided_at: null, late: false })
  set('priya', wk(2), { status: 'submitted', submitted_at: ts(addDays(wk(2), 5)), decided_by: null, decided_at: null, late: false })
  // wk 2: Subhankar was at a client site on Monday — Hritesh covered approvals (credited to Hritesh's KPI)
  const covered = set('jayashree', wk(2), { status: 'approved', decided_by: U('hritesh'), decided_at: ts(addDays(wk(2), 7), '06:00'), late: false })
  if (covered && !db.delegations.some((d) => d.tenant_id === T1 && d.from_user_id === U('subhankar') && d.from_on === addDays(wk(2), 7)))
    db.delegations.push(at(T1, { from_user_id: U('subhankar'), to_user_id: U('hritesh'), from_on: addDays(wk(2), 7), to_on: addDays(wk(2), 7), reason: 'Client site visit (Keonjhar) — Hritesh covers timesheet approvals', project_id: null, include_tasks: false }) as E.Delegation)

  /* ---------- leave: HR-entered (list on Settings → Leave) incl. this week's and an optional holiday ---------- */
  const minH = t1.settings['calendar.min_hours_per_day']
  const hasLeave = (k: string, d: string) => db.leave.some((l) => l.user_id === U(k) && l.date === d)
  const ensureWeekRow = (k: string, mon: string) => {
    let w = week(k, mon)
    if (!w) {
      w = at(T1, {
        id: `wk_${k}_${mon}`, user_id: U(k), week_start: mon, status: 'open', submitted_at: null, approver_id: user(k)?.reports_to_id ?? null, decided_by: null, decided_at: null,
        late: false, reject_reason: null, unlock_requested_at: null, unlock_reason: null, unlock_until: null,
      }) as E.TimesheetWeek
      db.timesheet_weeks.push(w)
    }
    return w
  }
  const addLeave = (k: string, d: string, type: E.LeaveType, by = 'priya') => {
    if (!isWorkingDay(d, cal) || hasLeave(k, d)) return
    db.leave.push(at(T1, { user_id: U(k), date: d, type, portion: 'full', source: 'hr', approved_by: U(by) }) as E.Leave)
    const w = ensureWeekRow(k, weekStart(d))
    db.timesheet_entries = db.timesheet_entries.filter((e) => !(e.week_id === w.id && e.work_date === d))
    db.timesheet_entries.push(at(T1, { week_id: w.id, user_id: U(k), work_date: d, kind: 'leave', task_id: null, internal_code: null, leave_type: type, hours: minH, note: 'Entered by HR' }) as E.TimesheetEntry)
  }
  addLeave('jagannath', addDays(thisMon, 1), 'casual') // Tue
  addLeave('jagannath', addDays(thisMon, 2), 'casual') // Wed
  addLeave('hritesh', addDays(thisMon, 8), 'casual')
  for (const d of [14, 15, 16]) addLeave('bijaya', addDays(thisMon, d), 'earned')
  if (week('jayashree', weekStart('2026-09-15'))) addLeave('jayashree', '2026-09-15', 'optional_holiday')

  // one-project delegation while Jagannath is away (covers SeerHR tasks and code reviews, not approvals)
  if (!db.delegations.some((d) => d.tenant_id === T1 && d.from_user_id === U('jagannath')))
    db.delegations.push(at(T1, { from_user_id: U('jagannath'), to_user_id: U('bijaya'), from_on: addDays(thisMon, 1), to_on: addDays(thisMon, 2), reason: 'Family function. Bijaya covers biometric integration questions and code reviews.', project_id: 'p_hrms', include_tasks: true }) as E.Delegation)

  /* ---------- Ankit Sahu (left on his offboarding last day): a cost rate and approved weeks up to his last day, so
     payroll shows him only in the months he was employed, prorated, with nothing to chase (Feature Guide §10) ---------- */
  const ankit = db.users.find((u) => u.id === 'u_ankit' && u.tenant_id === T1)
  const ankitLast = db.lifecycle_checklists.find((c) => c.user_id === 'u_ankit' && c.kind === 'offboarding')?.last_day ?? null
  if (ankit && ankitLast) {
    if (!db.cost_rates.some((r) => r.user_id === ankit.id))
      db.cost_rates.push(at(T1, { user_id: ankit.id, monthly_ctc_paise: 32_000_00, variable_pct: 0, sales_target_paise: null, effective_from: ankit.joined_on }) as E.CostRate)
    for (let mon = wk(9); mon <= weekStart(ankitLast); mon = addDays(mon, 7)) {
      if (week('ankit', mon)) continue
      const id = `wk_ankit_${mon}`
      db.timesheet_weeks.push(at(T1, {
        id, user_id: ankit.id, week_start: mon, status: 'approved', submitted_at: ts(addDays(mon, 5)), approver_id: U('subhankar'), decided_by: U('subhankar'), decided_at: ts(addDays(mon, 7), '06:00'),
        late: false, reject_reason: null, unlock_requested_at: null, unlock_reason: null, unlock_until: null,
      }) as E.TimesheetWeek)
      for (let i = 0; i < 6; i++) {
        const d = addDays(mon, i)
        if (d > ankitLast || !isWorkingDay(d, cal)) continue
        db.timesheet_entries.push(at(T1, { week_id: id, user_id: ankit.id, work_date: d, kind: 'internal', task_id: null, internal_code: 'admin', leave_type: null, hours: minH, note: 'QA regression runs and test-case handover', project_id: null }) as E.TimesheetEntry)
      }
    }
  }

  /* ---------- "Lunch, tea and stand-up" rows on this week's draft for two developers ---------- */
  for (const k of ['hritesh', 'pragyasmita']) {
    const w = week(k, thisMon)
    if (!w) continue
    for (let i = 0; i < 6; i++) {
      const d = addDays(thisMon, i)
      if (d >= today || !isWorkingDay(d, cal) || hasLeave(k, d)) continue
      // trim the day's activity time so the day stays near the minimum
      const act = db.timesheet_entries.find((e) => e.week_id === w.id && e.work_date === d && e.kind === 'internal' && e.hours >= 1.5)
      if (act) act.hours -= 1
      db.timesheet_entries.push(at(T1, { week_id: w.id, user_id: U(k), work_date: d, kind: 'internal', task_id: null, internal_code: 'breaks', leave_type: null, hours: 1, note: '', project_id: null }) as E.TimesheetEntry)
    }
  }

  /* ---------- Friday demos (stored on the week's demo day) ---------- */
  const demoDay = (mon: string) => {
    for (let d = addDays(mon, 4); d >= mon; d = addDays(d, -1)) if (isWorkingDay(d, cal)) return d
    return addDays(mon, 4)
  }
  const demos: [string, number, boolean, string][] = [
    ['hritesh', 1, true, 'Payslip PDF preview and download from the payroll screen'],
    ['bijaya', 1, true, 'Leave policy engine: carry-forward and half-day rules on staging'],
    ['jayashree', 1, false, ''],
    ['pragyasmita', 1, true, 'EduReon fee receipts with UPI reference, end to end'],
    ['jagannath', 1, false, ''],
    ['hritesh', 2, true, 'Payroll run screen with arrears column'],
    ['bijaya', 2, true, 'Employee master bulk import with validation report'],
    ['jagannath', 2, true, 'Payroll engine: earnings and deductions for 40 test employees'],
    ['jayashree', 2, true, 'Approval workflow screens (draft)'],
    ['pragyasmita', 2, false, ''],
  ]
  // the base seed flags a demo on a random day; demos live on the week's demo day only
  for (const u of db.daily_updates) if (u.tenant_id === T1 && u.demo_shown && u.date !== demoDay(weekStart(u.date))) u.demo_shown = false
  for (const [k, n, shown, note] of demos) {
    const d = demoDay(wk(n))
    const cur = db.daily_updates.find((x) => x.user_id === U(k) && x.date === d)
    if (cur) Object.assign(cur, { demo_shown: shown, demo_note: note })
    else
      db.daily_updates.push(at(T1, {
        user_id: U(k), date: d, done: shown ? 'Closed the week’s open review comments and ran the Friday demo for the team.' : 'Bug fixes and code review comments addressed.',
        proof_url: `https://github.com/seereon/${k === 'pragyasmita' ? 'edureon' : 'seerhr'}/pull/${120 + n * 7 + k.length}`, blocker: '', demo_shown: shown, demo_note: note,
      }) as E.DailyUpdate)
  }
}
