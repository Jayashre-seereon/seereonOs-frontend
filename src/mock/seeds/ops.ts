// Feature Guide §14 / screenshot 026: the Seereon tenant's recurring duties with ~3 months of completion
// history (on-time vs late, so "duties done on time, last 90 days" is real), plus the "Tagged you" mentions
// and a "Covering" example for the employee view (screenshot 001).
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type { SeedHelpers } from './index'
import { addDays, addMonths, fyLabel, isWorkingDay, monthOf, quarterOf, weekStart, type CalendarCtx } from '@/domain/calendar'

const next = (d: string, r: E.Recurrence) => (r === 'weekly' ? addDays(d, 7) : r === 'monthly' ? addMonths(d, 1) : r === 'quarterly' ? addMonths(d, 3) : r === 'yearly' ? addMonths(d, 12) : d)
const prev = (d: string, r: E.Recurrence) => (r === 'weekly' ? addDays(d, -7) : r === 'monthly' ? addMonths(d, -1) : r === 'quarterly' ? addMonths(d, -3) : r === 'yearly' ? addMonths(d, -12) : d)
function periodOf(due: string, rec: E.Recurrence): string {
  if (rec === 'weekly') return weekStart(due)
  if (rec === 'monthly') return monthOf(due)
  const q = quarterOf(due, 4)
  if (rec === 'quarterly') return `Q${q.q} ${fyLabel(q.fy)}`
  if (rec === 'yearly') return fyLabel(q.fy)
  return due
}

export function seed(db: DB, h: SeedHelpers) {
  const T = 'tn_seereon'
  const tenant = db.tenants.find((t) => t.id === T)
  if (!tenant) return
  const users = db.users.filter((u) => u.tenant_id === T)
  const U = (first: string) => users.find((u) => u.email.startsWith(first + '@'))
  const priya = U('priya')
  const santosh = U('santosh')
  if (!priya || !santosh) return
  const today = h.today
  /** First date on or after today with this day of the month. */
  const dayOn = (dom: number) => {
    const here = `${today.slice(0, 8)}${String(dom).padStart(2, '0')}`
    return here >= today ? here : `${addMonths(today.slice(0, 8) + '01', 1).slice(0, 8)}${String(dom).padStart(2, '0')}`
  }
  const friday = (() => {
    const f = addDays(weekStart(today), 4)
    return f >= today ? f : addDays(f, 7)
  })()

  /* ---- recurring duties (replace the generic register for this tenant) ---- */
  db.ops_items = db.ops_items.filter((o) => o.tenant_id !== T)
  type Def = [string, E.OpsItem['category'], E.User, string, E.Recurrence, string, number]
  // [name, area, owner, current due, repeats, notes, on-time rate for history]
  const defs: Def[] = [
    ['Receivables follow-up calls', 'finance', priya, addDays(today, -3), 'weekly', 'Call every client with an invoice past its due date; log the promise-to-pay date.', 0.6],
    ['Payroll processing', 'payroll', priya, dayOn(1), 'monthly', 'Run payroll from approved timesheets; chase unapproved weeks first.', 0.75],
    ['Invoice achieved milestones', 'finance', priya, friday, 'weekly', 'Raise invoices for milestones achieved this week.', 0.7],
    ['Timesheet and attendance audit', 'hr', priya, friday, 'weekly', 'Check missing and short timesheets against leave.', 0.8],
    ['Monthly MIS to CEO', 'finance', priya, dayOn(5), 'monthly', 'Revenue, collections, costs and cash position for the month.', 0.67],
    ['TDS payment', 'compliance', santosh, dayOn(7), 'monthly', 'Deposit TDS by the 7th via challan ITNS 281.', 1],
    ['PF and ESI filing', 'compliance', priya, dayOn(15), 'monthly', 'ECR upload on the EPFO portal; ESIC contribution.', 0.67],
    ['GST return (GSTR-3B)', 'compliance', priya, dayOn(20), 'monthly', 'File GSTR-1 by the 11th and GSTR-3B by the 20th.', 0.67],
    ['Advance tax', 'finance', santosh, '2026-12-15', 'quarterly', 'Instalment due 15 Jun, 15 Sep, 15 Dec, 15 Mar.', 1],
    // yearly statutory filing and renewals (Feature Guide §14: "monthly, quarterly, yearly … statutory filings and renewals")
    ['Annual ROC filing (AOC-4 and MGT-7)', 'compliance', priya, `${today.slice(0, 4)}-10-29`, 'yearly', 'File the financial statements (AOC-4) within 30 days of the AGM and the annual return (MGT-7) within 60 days.', 1],
    ['Domain, SSL and Google Workspace renewal', 'it', priya, addDays(today, 47), 'yearly', 'Renew seereon.co.in, the SSL certificate and Workspace licences before they expire.', 1],
    ['ISO 9001:2015 certificate renewal (surveillance audit)', 'compliance', santosh, addMonths(addDays(today, -40), 12), 'yearly', 'Book the certification body and close last year’s observations before the audit.', 1],
  ]
  const cal: CalendarCtx = { settings: tenant.settings, holidays: db.holidays.filter((x) => x.tenant_id === T) }
  defs.forEach(([item, category, owner, due, rec, notes, rate], k) => {
    const history: { due_on: string; done_on: string; period: string; on_time: boolean; by: string | null }[] = []
    let d = prev(due, rec)
    let i = 0
    while (d >= addDays(today, -100) && i < 20) {
      // deterministic: every Nth occurrence is late so each duty lands near its rate
      const late = rate < 1 && ((i + k) % Math.max(2, Math.round(1 / (1 - rate)))) === 0
      let done = late ? addDays(d, 1 + ((i + k) % 4)) : addDays(d, -((i + k) % 2))
      if (done > today) done = today
      let g = 0
      while (!isWorkingDay(done, cal) && g++ < 5) done = late ? addDays(done, 1) : addDays(done, -1)
      history.unshift({ due_on: d, done_on: done, period: periodOf(d, rec), on_time: done <= d, by: owner.id })
      d = prev(d, rec)
      i++
    }
    const row = { ...h.base(T), id: `ops_${k + 1}`, item, category, owner_id: owner.id, due_on: due, recurring: rec, status: 'open' as const, last_done_on: history[history.length - 1]?.done_on ?? null, notes, history }
    db.ops_items.push(row as E.OpsItem)
  })
  void next

  /* ---- "Tagged you": Subhankar mentions Hritesh on the UAT task ---- */
  const hritesh = U('hritesh')
  const subhankar = U('subhankar')
  const jayashree = U('jayashree')
  if (hritesh && subhankar) {
    const tasks = db.tasks.filter((t) => t.tenant_id === T)
    // Feature Guide screenshot 001: "UAT round 1 with school staff" (Bug) on EduReon, where the school runs UAT.
    const edu = db.projects.find((p) => p.tenant_id === T && p.id === 'p_mgs') ?? db.projects.find((p) => p.tenant_id === T && /edureon/i.test(p.name))
    let uat = edu ? tasks.find((t) => t.project_id === edu.id && /uat round 1/i.test(t.title)) : undefined
    if (edu && !uat) {
      const goLive = db.milestones.filter((m) => m.project_id === edu.id && !m.deleted_at && !m.achieved_on).sort((a, b) => a.no - b.no)[0] ?? null
      const no = Math.max(0, ...tasks.filter((t) => t.project_id === edu.id && t.milestone_id === (goLive?.id ?? null)).map((t) => t.no)) + 1
      const row = {
        ...h.base(T), id: 't_mgs_uat1', project_id: edu.id, milestone_id: goLive?.id ?? null, no, title: 'UAT round 1 with school staff', owner_id: subhankar.id, backup_id: hritesh.id,
        est_hours: 16, start_on: addDays(today, -8), due_on: addDays(today, 6), done_on: null, complexity: 'medium', status: 'in_progress', kind: 'project', reviewer_id: subhankar.id,
        description: 'Admin and accounts staff at both campuses run the UAT scripts; defects are logged against this task and fixed by the development team.',
        blocked_reason: null, stage: 'uat', progress: 40, tag: 'bug', actual_start_on: addDays(today, -8), baseline_due_on: addDays(today, 6), priority: 'high',
      } as E.Task
      db.tasks.push(row)
      uat = row
    }
    if (uat) {
      const istAt = (daysAgo: number, hh: number, mm: number) => {
        // IST = UTC + 5:30
        const utcMin = hh * 60 + mm - 330
        return `${addDays(today, -daysAgo)}T${String(Math.floor(utcMin / 60)).padStart(2, '0')}:${String(utcMin % 60).padStart(2, '0')}:00Z`
      }
      db.comments.push(
        { ...h.base(T), id: 'cm_tag_1', task_id: uat.id, body: 'UAT round 1 started with admin staff at campus 1 and 2. @Hritesh Panda please stay on standby for fixes this week.', mentions: [hritesh.id], author_id: subhankar.id, parent_id: null, created_at: istAt(8, 9, 35) },
        { ...h.base(T), id: 'cm_tag_2', task_id: uat.id, body: 'Fee receipt number resets every month; school wants a continuous series per financial year. @Hritesh Panda', mentions: [hritesh.id], author_id: subhankar.id, parent_id: null, created_at: istAt(7, 16, 20) },
      )
    }
    /* ---- "Covering": Hritesh backs up one of Jayashree's open tasks while she is on leave this Friday ---- */
    if (jayashree) {
      const t = tasks.find((x) => x.owner_id === jayashree.id && x.status !== 'done' && (!x.backup_id || x.backup_id === hritesh.id))
      let day: string | null = null
      for (let d = addDays(today, 1); d <= addDays(weekStart(today), 5); d = addDays(d, 1)) if (!day && isWorkingDay(d, cal)) day = d
      if (t && day && !db.leave.some((l) => l.user_id === jayashree.id && l.date === day)) {
        t.backup_id = hritesh.id
        db.leave.push({ ...h.base(T), user_id: jayashree.id, date: day, type: 'casual', portion: 'full', source: 'hr', approved_by: subhankar.id })
      }
    }
  }
}
