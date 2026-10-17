// Workstream A seed: a coherent costing picture for every Seereon project with a contract value.
// Runs after the delivery, timesheet and ops seeds and adapts to whatever milestones / tasks they produced:
//  0. v6: allocations always land on a milestone (Feature Guide §6) — any seeded "all milestones" row becomes one row
//     per milestone spanning that milestone's dates; the PM role keeps no margins permission (CEO only by default);
//  1. a resource plan per milestone (task owners and the delivery head), sized so the plan lands near a realistic
//     planned margin; task estimates follow the plan (allocated hours = working days × % × minimum hours a day ≈
//     estimate × 1.1); cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day);
//  2. a saved costing plan (additional costs, maintenance, contingency, markup, price = contract − approved CRs);
//  3. timesheets that match: on allocated days part of the day's internal time becomes task work on the project
//     (day totals unchanged), and weeks before the timesheet seed starts are back-filled as approved weeks, so
//     "allocation used" lands at 80–97% and actual-to-date cost reflects approved hours.
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type { SeedHelpers } from './index'
import { addDays, isWorkingDay, maxISO, minISO, monthOf, monthRange, weekStart, workingDaysBetween, workingDaysInMonth, type CalendarCtx } from '@/domain/calendar'
import { rateOn } from '@/domain/costing'

const T1 = 'tn_seereon'
const R = (rupees: number) => Math.round(rupees * 100)
// a person may be planned a little above 100% across projects (the Team tab flags it), but not more
const MAX_LOAD = 100
const half = (h: number) => Math.round(h * 2) / 2

interface Plan {
  targetMargin: number
  pmAllPct?: number // delivery head on "All milestones"
  additional: { category: string; description: string; rupees: number }[]
  maintenance: number
  contingency: number
}
const PLANS: Record<string, Plan> = {
  p_mgs: {
    targetMargin: 0.44, pmAllPct: 15, maintenance: 15000, contingency: 5,
    additional: [
      { category: 'software', description: 'Play Store developer account and SMS gateway credits', rupees: 9500 },
      { category: 'travel', description: 'Campus visits for data migration and teacher training', rupees: 12000 },
    ],
  },
  p_hrms: {
    targetMargin: 0.493, pmAllPct: 20, maintenance: 60000, contingency: 5,
    additional: [
      { category: 'hardware', description: 'Biometric punch devices for the shift attendance pilot', rupees: 42000 },
      { category: 'travel', description: 'Keonjhar site visits: workshops and payroll parallel run', rupees: 30000 },
      { category: 'third_party', description: 'Statutory compliance review by a payroll consultant', rupees: 18000 },
      { category: 'third_party', description: 'Contract QA team for payroll parallel runs and UAT support', rupees: 180000 },
    ],
  },
  p_crm: { targetMargin: 0.52, pmAllPct: 10, maintenance: 10000, contingency: 5, additional: [{ category: 'software', description: 'WhatsApp Business API credits for UAT', rupees: 6000 }] },
  p_rcu: { targetMargin: 0.5, maintenance: 0, contingency: 3, additional: [{ category: 'travel', description: 'AlUla onsite visit for Q3 release (flights and stay)', rupees: 145000 }, { category: 'software', description: 'SAP BTP trial and CPI tenant add-ons', rupees: 38000 }] },
  p_dms: { targetMargin: 0.46, maintenance: 20000, contingency: 5, additional: [{ category: 'software', description: 'Document OCR library licence', rupees: 15000 }] },
  p_samet: { targetMargin: 0.42, maintenance: 0, contingency: 5, additional: [{ category: 'software', description: 'Domain, SSL and hosting for year 1', rupees: 8000 }] },
}

/** v6: every allocation names a milestone. Rows seeded for "all milestones" become one row per milestone (its dates). */
function splitAllMilestoneRows(db: DB, h: SeedHelpers) {
  const out: E.Allocation[] = []
  for (const a of db.allocations) {
    if (a.milestone_id) {
      out.push(a)
      continue
    }
    const p = db.projects.find((x) => x.id === a.project_id)
    const ms = db.milestones.filter((m) => m.project_id === a.project_id && !m.deleted_at).sort((x, y) => x.no - y.no)
    let first = true
    for (const m of ms) {
      const from = maxISO(maxISO(m.planned_start, a.from_on), p?.start_on ?? a.from_on)
      const to = minISO(minISO(m.planned_end, a.to_on), p?.end_on ?? a.to_on)
      if (to < from) continue
      out.push(first ? { ...a, milestone_id: m.id, from_on: from, to_on: to } : { ...h.base(a.tenant_id), project_id: a.project_id, milestone_id: m.id, user_id: a.user_id, pct: a.pct, from_on: from, to_on: to })
      first = false
    }
  }
  db.allocations = out
}

export function seed(db: DB, h: SeedHelpers) {
  splitAllMilestoneRows(db, h)
  // Feature Guide §6: margins are visible only to the CEO and anyone given the margins permission — the delivery head
  // (PM role) does not have it by default; an admin can grant it as an extra permission.
  for (const u of db.users) {
    if (u.role_key !== 'project_manager') continue
    u.extra_permissions = (u.extra_permissions ?? []).filter((k) => k !== 'margins.view')
    const g = (u as unknown as { grants?: string[] }).grants
    if (Array.isArray(g)) (u as unknown as { grants: string[] }).grants = g.filter((k) => k !== 'margins')
  }
  const tenant = db.tenants.find((t) => t.id === T1)
  if (!tenant) return
  const S = tenant.settings
  const today = h.today
  const holidays = db.holidays.filter((x) => x.tenant_id === T1)
  const company: CalendarCtx = { settings: S, holidays }
  const leaveOf = new Map<string, Set<string>>()
  for (const l of db.leave) if (l.tenant_id === T1 && l.portion === 'full') (leaveOf.get(l.user_id) ?? leaveOf.set(l.user_id, new Set()).get(l.user_id)!).add(l.date)
  const userCal = (u: string): CalendarCtx => ({ settings: S, holidays, leaveDates: leaveOf.get(u) })
  const minH = S['calendar.min_hours_per_day'] || 9
  const users = new Map(db.users.filter((u) => u.tenant_id === T1).map((u) => [u.id, u]))
  const prodOf = (u: string) => {
    const x = users.get(u)?.productive_hours
    return typeof x === 'number' && x > 0 ? x : S['team.default_productive_hours'] ?? 6
  }
  const rates = db.cost_rates.filter((r) => r.tenant_id === T1)
  const wdmCache = new Map<string, number>()
  const wdm = (ym: string) => wdmCache.get(ym) ?? wdmCache.set(ym, workingDaysInMonth(ym, company)).get(ym)!
  const wd = (a: string, b: string) => (b < a ? 0 : workingDaysBetween(a, b, company))
  /** cost per hour = CTC ÷ (working days in the month × minimum hours) — the same rule the costing engine uses */
  const cph = (u: string, date: string) => {
    const r = rateOn(rates, u, date) ?? rates.filter((x) => x.user_id === u).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0]
    return r ? r.monthly_ctc_paise / (wdm(monthOf(date)) * minH) : 0
  }
  /** paid cost of pct% of a person's time over [from, to], month by month */
  const rangeCost = (u: string, pct: number, from: string, to: string) => {
    let c = 0
    for (let a = from; a <= to; ) {
      const b = minISO(monthRange(monthOf(a)).to, to)
      c += (wd(a, b) * pct * minH * cph(u, a)) / 100
      a = addDays(b, 1)
    }
    return c
  }

  type Row = { pid: string; user: string; ms: E.Milestone | null; from: string; to: string; pct: number; baseHours: number; fixed: boolean; tasks: E.Task[]; f: number; cap?: number; floor?: number }
  const allRows: Row[] = []
  // concurrent allocation per person-day across projects, so nobody is planned above 100%
  const usage = new Map<string, number>()
  const use = (u: string, from: string, to: string, pct: number) => {
    for (let d = from; d <= to; d = addDays(d, 1)) usage.set(`${u}:${d}`, (usage.get(`${u}:${d}`) ?? 0) + pct)
  }
  const peak = (u: string, from: string, to: string) => {
    let m = 0
    for (let d = from; d <= to; d = addDays(d, 1)) m = Math.max(m, usage.get(`${u}:${d}`) ?? 0)
    return m
  }
  for (const a of db.allocations) if (a.tenant_id === T1 && !PLANS[a.project_id] && !a.project_id.startsWith('p_general')) use(a.user_id, a.from_on, a.to_on, a.pct)

  // earlier commitments first, then CRM phase 2; the on-hold DMS gets what capacity is left
  for (const pid of ['p_samet', 'p_mgs', 'p_rcu', 'p_hrms', 'p_crm', 'p_dms']) {
    const plan = PLANS[pid]
    const p = db.projects.find((x) => x.id === pid && x.tenant_id === T1)
    if (!p || !p.contract_value_paise) continue
    const ms = db.milestones.filter((m) => m.project_id === p.id && !m.deleted_at).sort((a, b) => a.no - b.no)
    let tasks = db.tasks.filter((t) => t.project_id === p.id)
    // milestones without tasks (e.g. AMS retainer quarters) get one support task, so time can be logged against them
    for (const m of ms) {
      if (tasks.some((t) => t.milestone_id === m.id) || !p.pm_id) continue
      const done = !!m.achieved_on || m.planned_end < today
      const t: E.Task = {
        ...h.base(T1), project_id: p.id, milestone_id: m.id, no: 1, title: `${m.name}: support tickets and enhancements`, owner_id: p.pm_id, backup_id: null, est_hours: Math.max(16, Math.round(wd(m.planned_start, m.planned_end) * prodOf(p.pm_id) * 0.5)),
        start_on: m.planned_start, due_on: m.planned_end, done_on: done ? m.achieved_on ?? m.planned_end : null, complexity: 'medium', status: done ? 'done' : m.planned_start <= today ? 'in_progress' : 'todo',
        description: 'Retainer scope for the period: tickets, small enhancements and monthly releases.', blocked_reason: null, kind: 'project', assigned_by: p.pm_id, reviewer_id: p.pm_id,
        stage: done ? 'completed' : m.planned_start <= today ? 'in_development' : 'new', progress: done ? 100 : m.planned_start <= today ? Math.min(90, Math.round((wd(m.planned_start, today) / Math.max(1, wd(m.planned_start, m.planned_end))) * 100)) : 0,
        tag: 'support', approved_by: done ? p.pm_id : null, approved_on: done ? m.achieved_on ?? m.planned_end : null,
      }
      db.tasks.push(t)
      tasks = [...tasks, t]
    }
    // the delivery head is on every milestone at a fixed share (one row per milestone: cost lands on a milestone)
    const pmAll = plan.pmAllPct && p.pm_id && tasks.some((t) => t.owner_id === p.pm_id) ? p.pm_id : null
    const rows: Row[] = []
    for (const m of ms) {
      const from = maxISO(m.planned_start, p.start_on)
      const to = minISO(maxISO(m.baseline_end, m.planned_start), p.end_on)
      if (to < from) continue
      const mineAll = tasks.filter((t) => t.milestone_id === m.id)
      const owners = [...new Set(mineAll.filter((t) => t.owner_id).map((t) => t.owner_id!))]
      if (pmAll && !owners.includes(pmAll) && mineAll.length) {
        // the delivery head's time on this milestone is logged against a project-management task of its own
        const allDone = mineAll.every((t) => t.status === 'done')
        const done = !!m.achieved_on || allDone
        const started = m.planned_start <= today
        const end = m.achieved_on ?? (allDone ? mineAll.reduce((x, t) => maxISO(x, t.done_on ?? t.due_on), '0000-01-01') : m.planned_end)
        const t: E.Task = {
          ...h.base(T1), project_id: p.id, milestone_id: m.id, no: Math.max(0, ...mineAll.map((x) => x.no)) + 1, title: `${m.name}: project management and client reviews`, owner_id: pmAll, backup_id: null, est_hours: 8,
          start_on: from, due_on: minISO(m.planned_end, to), done_on: done ? end : null, complexity: 'low', status: done ? 'done' : started ? 'in_progress' : 'todo',
          description: 'Planning, stand-ups, client reviews and sign-off for this milestone.', blocked_reason: null, kind: 'project', assigned_by: pmAll, reviewer_id: p.pm_id === pmAll ? null : p.pm_id,
          stage: done ? 'completed' : started ? 'in_development' : 'new', progress: done ? 100 : started ? Math.min(90, Math.round((wd(from, today) / Math.max(1, wd(from, m.planned_end))) * 100)) : 0,
          tag: null, approved_by: done ? pmAll : null, approved_on: done ? end : null,
        } as E.Task
        db.tasks.push(t)
        tasks = [...tasks, t]
        owners.push(pmAll)
      }
      for (const u of owners) {
        const ts = tasks.filter((t) => t.milestone_id === m.id && t.owner_id === u)
        const fixed = u === pmAll && ts.length === 1 && ts[0].est_hours === 8 && ts[0].title.endsWith('project management and client reviews')
        rows.push({ pid, user: u, ms: m, from, to, pct: fixed ? plan.pmAllPct! : 0, baseHours: Math.max(8, ts.reduce((s, t) => s + t.est_hours, 0)), fixed, tasks: ts, f: 0.86 + h.rnd() * 0.11 })
      }
    }
    if (!rows.length) continue
    const crs = db.change_requests.filter((x) => x.project_id === p.id && (x.status === 'approved' || x.status === 'done')).reduce((s, x) => s + x.value_paise, 0)
    // approving a change request adds its value to the contract (Feature Guide §5); the base seed predates that rule
    p.contract_value_paise += crs
    const price = p.contract_value_paise - crs
    const additional = [...plan.additional]
    let add = additional.reduce((s, x) => s + R(x.rupees), 0)
    const maint = R(plan.maintenance)
    const rowCost = (r: Row) => rangeCost(r.user, r.pct, r.from, r.to)
    const target = ((price * (1 - plan.targetMargin) - maint) / (1 + plan.contingency / 100)) - add
    // allocated hours = baseHours × s × 1.1; find s so the resource plan meets the target (allocation capped at 100%)
    for (const r of rows) r.cap = Math.min(100, Math.max(5, Math.floor((MAX_LOAD - peak(r.user, r.from, r.to)) / 5) * 5))
    for (const r of rows) if (r.fixed) r.pct = Math.min(r.pct, r.cap!)
    // never plan below what the person has already logged on these tasks (allocation used stays ≤ ~100%)
    for (const r of rows) {
      const ids = new Set(r.tasks.map((t) => t.id))
      const logged = db.timesheet_entries.filter((e) => e.tenant_id === T1 && e.user_id === r.user && e.task_id && ids.has(e.task_id)).reduce((s2, e) => s2 + e.hours, 0)
      const days = wd(r.from, minISO(r.to, today))
      r.floor = days > 0 ? Math.min(100, Math.ceil(((logged / (days * minH * 0.95)) * 100) / 5) * 5) : 0
      r.cap = Math.max(r.cap!, r.floor)
      if (r.fixed) r.pct = Math.max(r.pct, r.floor)
    }
    const sized = (s: number) => {
      for (const r of rows) if (!r.fixed) r.pct = Math.max(5, r.floor ?? 0, Math.min(r.cap!, Math.round((r.baseHours * s * 1.1) / (Math.max(1, wd(r.from, r.to)) * minH) * 100 / 5) * 5))
      return rows.reduce((x, r) => x + rowCost(r), 0)
    }
    let lo = 0.05, hi = 40
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (sized(mid) < target) lo = mid
      else hi = mid
    }
    sized(hi)
    // estimates follow the plan: allocated hours ≈ estimate × 1.1
    for (const r of rows) {
      const allocH = wd(r.from, r.to) * (r.pct / 100) * minH
      const base = r.tasks.reduce((s, t) => s + t.est_hours, 0)
      const want = allocH / 1.1
      for (const t of r.tasks) t.est_hours = Math.max(2, Math.round(base > 0 ? (t.est_hours * want) / base : want / r.tasks.length))
    }
    const res = rows.reduce((s, r) => s + Math.round(rowCost(r)), 0)
    // the team is fully booked elsewhere: the rest of the build is bought in (keeps the plan at its target margin)
    if (res < target * 0.95) {
      const rupees = Math.round((target - res) / 100 / 1000) * 1000
      additional.push({ category: 'third_party', description: 'Freelance developer for the build (in-house team fully booked)', rupees })
      add += R(rupees)
    }
    const cont = Math.round(((res + add) * plan.contingency) / 100)
    const total = res + add + maint + cont
    db.allocations = db.allocations.filter((a) => a.project_id !== p.id)
    for (const r of rows) db.allocations.push({ ...h.base(T1), project_id: p.id, milestone_id: r.ms ? r.ms.id : null, user_id: r.user, pct: r.pct, from_on: r.from, to_on: r.to })
    p.costing = {
      additional_costs: additional.map((x, i) => ({ id: `ac${i + 1}`, category: x.category, description: x.description, amount_paise: R(x.rupees) })),
      maintenance_paise: maint,
      contingency_pct: plan.contingency,
      markup_pct: total > 0 ? Math.round(((price - total) / total) * 10000) / 100 : 0,
      price_paise: price,
      saved_at: p.start_on + 'T06:30:00Z',
      saved_by: p.pm_id,
    }
    for (const r of rows) use(r.user, r.from, r.to, r.pct)
    allRows.push(...rows)
  }

  /* ---------------- timesheets that match the allocations ---------------- */
  const entries = db.timesheet_entries
  const weeks = db.timesheet_weeks
  const weekOf = new Map(weeks.filter((w) => w.tenant_id === T1).map((w) => [`${w.user_id}:${w.week_start}`, w]))
  const firstWeek = new Map<string, string>()
  for (const w of weeks) if (w.tenant_id === T1 && (!firstWeek.has(w.user_id) || w.week_start < firstWeek.get(w.user_id)!)) firstWeek.set(w.user_id, w.week_start)
  const dayEntries = new Map<string, E.TimesheetEntry[]>()
  for (const e of entries) if (e.tenant_id === T1) (dayEntries.get(`${e.user_id}:${e.work_date}`) ?? dayEntries.set(`${e.user_id}:${e.work_date}`, []).get(`${e.user_id}:${e.work_date}`)!).push(e)
  const taskFor = (r: Row, d: string) => {
    const active = r.tasks.filter((t) => t.start_on <= d && d <= (t.done_on ?? t.due_on))
    if (active.length) return active[Math.floor(h.rnd() * active.length)]
    return [...r.tasks].sort((a, b) => Math.min(Math.abs(Date.parse(a.start_on) - Date.parse(d)), Math.abs(Date.parse(a.due_on) - Date.parse(d))) - Math.min(Math.abs(Date.parse(b.start_on) - Date.parse(d)), Math.abs(Date.parse(b.due_on) - Date.parse(d))))[0]
  }
  const ensureWeek = (u: string, d: string): E.TimesheetWeek | null => {
    const mon = weekStart(d)
    const k = `${u}:${mon}`
    const w = weekOf.get(k)
    if (w) return w
    const first = firstWeek.get(u)
    if (first && mon >= first) return null // inside the seeded timesheet range: leave gaps as the time seed made them
    if (mon >= weekStart(today)) return null
    const fri = addDays(mon, 4)
    const nw: E.TimesheetWeek = {
      ...h.base(T1), user_id: u, week_start: mon, status: 'approved', submitted_at: addDays(mon, 5) + 'T12:00:00Z', approver_id: users.get(u)?.reports_to_id ?? null,
      decided_by: users.get(u)?.reports_to_id ?? u, decided_at: addDays(mon, 7) + 'T06:00:00Z', late: false, reject_reason: null, unlock_requested_at: null, unlock_reason: null, unlock_until: null,
    }
    weeks.push(nw)
    weekOf.set(k, nw)
    // a back-filled week has full days: the project rows are added below; fill the rest with internal time
    for (let d2 = mon; d2 <= fri; d2 = addDays(d2, 1)) {
      if (!isWorkingDay(d2, userCal(u))) continue
      const e1: E.TimesheetEntry = { ...h.base(T1), week_id: nw.id, user_id: u, work_date: d2, kind: 'internal', task_id: null, internal_code: 'meeting', leave_type: null, hours: 1, note: 'Stand-ups and reviews' }
      const e2: E.TimesheetEntry = { ...h.base(T1), week_id: nw.id, user_id: u, work_date: d2, kind: 'internal', task_id: null, internal_code: users.get(u)?.department === 'sales' ? 'presales' : 'admin', leave_type: null, hours: minH - 1, note: '' }
      entries.push(e1, e2)
      dayEntries.set(`${u}:${d2}`, [e1, e2])
    }
    return nw
  }

  // per person-day demand from every costed row (plus the internal EduReon v2 allocations already seeded)
  const internalRows: Row[] = db.allocations
    .filter((a) => a.tenant_id === T1 && !PLANS[a.project_id] && !a.project_id.startsWith('p_general'))
    .map((a) => ({ pid: a.project_id, user: a.user_id, ms: db.milestones.find((m) => m.id === a.milestone_id) ?? null, from: a.from_on, to: a.to_on, pct: a.pct, baseHours: 0, fixed: true, tasks: db.tasks.filter((t) => t.project_id === a.project_id && t.owner_id === a.user_id && (!a.milestone_id || t.milestone_id === a.milestone_id)), f: 0.85 }))
  const demand = new Map<string, { r: Row; want: number }[]>()
  // each row logs up to f × its allocated hours to date in total (hours the time seed already logged count)
  const budget = new Map<Row, number>()
  for (const r of [...allRows, ...internalRows]) {
    if (!r.tasks.length) continue
    const end = minISO(r.to, today)
    const ids = new Set(r.tasks.map((t) => t.id))
    const logged = db.timesheet_entries.filter((e) => e.tenant_id === T1 && e.user_id === r.user && e.task_id && ids.has(e.task_id) && e.work_date >= r.from && e.work_date <= end).reduce((s2, e) => s2 + e.hours, 0)
    budget.set(r, Math.max(0, wd(r.from, end) * (r.pct / 100) * minH * r.f - logged))
    for (let d = r.from; d <= end; d = addDays(d, 1)) {
      if (!isWorkingDay(d, userCal(r.user))) continue
      const want = half((r.pct / 100) * minH * r.f)
      if (want <= 0) continue
      ;(demand.get(`${r.user}:${d}`) ?? demand.set(`${r.user}:${d}`, []).get(`${r.user}:${d}`)!).push({ r, want })
    }
  }
  const SWAP = ['learning', 'presales', 'admin', 'meeting']
  for (const [key, list] of demand) {
    const [u, d] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)]
    const w = ensureWeek(u, d)
    if (!w) continue
    const day = dayEntries.get(key) ?? []
    if (day.some((e) => e.kind === 'leave')) continue
    let available = day.filter((e) => e.kind === 'internal').reduce((s, e) => s + e.hours, 0) - 1 // keep an hour of meetings
    if (available <= 0) continue
    // what each row still needs today; when the day can't hold it all, every row gets the same share
    const needs = list.map(({ r, want }) => {
      const ids = new Set(r.tasks.map((t) => t.id))
      const have = day.filter((e) => e.kind === 'task' && e.task_id && ids.has(e.task_id)).reduce((s, e) => s + e.hours, 0)
      return { r, need: Math.max(0, Math.min(want - have, budget.get(r) ?? 0)) }
    })
    const totalNeed = needs.reduce((s, x) => s + x.need, 0)
    const share = totalNeed > available ? available / totalNeed : 1
    for (const { r, need } of needs) {
      let add = half(Math.min(available, need * share))
      if (add <= 0) continue
      available -= add
      // take the hours from internal codes (learning / presales / admin first), so the day total stays the same
      let got = 0
      for (const code of SWAP) {
        for (const e of day.filter((x) => x.kind === 'internal' && x.internal_code === code)) {
          if (add <= 0) break
          const take = half(Math.min(e.hours - (code === 'meeting' ? 1 : 0), add))
          if (take <= 0) continue
          e.hours = half(e.hours - take)
          add -= take
          got += take
        }
      }
      if (got <= 0) continue
      budget.set(r, (budget.get(r) ?? 0) - got)
      const t = taskFor(r, d)
      const same = day.find((e) => e.kind === 'task' && e.task_id === t.id)
      if (same) same.hours += got
      else {
        const ne: E.TimesheetEntry = { ...h.base(T1), week_id: w.id, user_id: u, work_date: d, kind: 'task', task_id: t.id, internal_code: null, leave_type: null, hours: got, note: '' }
        entries.push(ne)
        day.push(ne)
      }
    }
  }
  db.timesheet_entries = entries.filter((e) => e.kind !== 'internal' || e.hours > 0)

  // progress of open development work follows the hours actually logged (earned ≈ logged), so % complete and the
  // actual-to-date margin don't run ahead of the work done; testing stages keep their stage minimum
  const loggedOf = new Map<string, number>()
  for (const e of db.timesheet_entries) if (e.tenant_id === T1 && e.task_id) loggedOf.set(e.task_id, (loggedOf.get(e.task_id) ?? 0) + e.hours)
  const costed = new Set(allRows.map((r) => r.pid))
  for (const t of db.tasks) {
    if (!costed.has(t.project_id) || t.status === 'done' || t.status === 'in_review') continue
    if (t.stage && !['new', 'selected', 'in_development', 'blocked', 'on_hold', 'waiting_feedback'].includes(t.stage)) continue
    const byHours = Math.round(((loggedOf.get(t.id) ?? 0) / Math.max(1, t.est_hours)) * 100 / 5) * 5
    if (typeof t.progress === 'number' && t.progress > byHours) t.progress = Math.max(byHours, t.status === 'todo' ? 0 : 5)
  }
  // finished work: the estimate made at planning sits close to what the task really took (effort ratio actual ÷
  // estimated mostly 0.85–1.15; about one task in eight overran by more than 20% and is flagged)
  let n = 0
  for (const t of db.tasks) {
    if (!costed.has(t.project_id) || t.status !== 'done') continue
    const lg = loggedOf.get(t.id) ?? 0
    if (lg <= 0) continue
    const r = n++ % 8 === 5 ? 1.24 + h.rnd() * 0.12 : 0.86 + h.rnd() * 0.28
    t.est_hours = Math.max(2, Math.round(lg / r))
  }
}
