// People & HR seed: leave policies and requests, appraisal cycles (one closed, one running), goals, feedback,
// recruitment candidates + interviews, onboarding / exit checklists and the asset register.
// Seereon gets the full picture; Kalinga gets policies and two assets only.
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import type { DB } from '../server'
import type { SeedHelpers } from './index'
import { addDays, isWorkingDay, type CalendarCtx } from '@/domain/calendar'

const T1 = 'tn_seereon'
const T2 = 'tn_kalinga'
const L = (lakh: number) => Math.round(lakh * 100000 * 100) // lakh rupees → paise
const RS = (rupees: number) => rupees * 100

export function seed(db: DB, h: SeedHelpers) {
  const { today } = h
  const ts = (d: string, hm = '05:30') => `${d}T${hm}:00Z`
  const at = <T extends object>(tenant: string, data: T, created?: string) => {
    const b = h.base(tenant)
    return { ...b, ...(created ? { created_at: created, updated_at: created } : {}), ...data }
  }
  const U = (key: string) => `u_${key}`
  const seereonUsers = db.users.filter((u) => u.tenant_id === T1)
  if (!seereonUsers.length) return
  const t1 = db.tenants.find((t) => t.id === T1)!
  const cal: CalendarCtx = { settings: t1.settings, holidays: db.holidays.filter((x) => x.tenant_id === T1) }
  const workDays = (from: string, to: string) => {
    const out: string[] = []
    for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(d, cal)) out.push(d)
    return out
  }
  const nextWorking = (from: string, skip = 0) => {
    let d = from
    let left = skip
    while (!isWorkingDay(d, cal) || left > 0) {
      if (isWorkingDay(d, cal)) left--
      d = addDays(d, 1)
    }
    return d
  }

  /* ---------------- Leave policies ---------------- */
  for (const tn of [T1, T2]) {
    const pol: [E.LeaveType, number, number, B.LeavePolicy['accrual']][] = [['casual', 12, 0, 'upfront'], ['sick', 8, 0, 'upfront'], ['earned', 15, 30, 'monthly'], ['compensatory', 4, 0, 'upfront']]
    for (const [type, annual_days, carry_forward_max, accrual] of pol) db.leave_policies.push(at(tn, { type, annual_days, carry_forward_max, accrual }))
  }

  /* ---------------- Leave requests ---------------- */
  const existingLeave = new Set(db.leave.filter((l) => l.tenant_id === T1).map((l) => `${l.user_id}|${l.date}`))
  const req = (key: string, from: string, to: string, type: E.LeaveType, reason: string, status: B.LeaveRequest['status'], approver: string, opts: { half?: boolean; decided?: string; why?: string; created?: string } = {}) => {
    const days = opts.half ? 0.5 : workDays(from, to).length
    const r = at(T1, {
      user_id: U(key), from_on: from, to_on: to, type, portion: opts.half ? 'half' : 'full', days, reason, status, approver_id: U(approver),
      decided_by: status === 'approved' || status === 'rejected' ? U(approver) : null, decided_at: status === 'approved' || status === 'rejected' ? ts(opts.decided ?? today) : null,
      decision_reason: opts.why ?? null,
    } as Omit<B.LeaveRequest, keyof E.Base>, opts.created ? ts(opts.created) : undefined) as B.LeaveRequest
    db.leave_requests.push(r)
    if (status === 'approved')
      for (const d of opts.half ? [from] : workDays(from, to))
        if (!existingLeave.has(`${U(key)}|${d}`)) db.leave.push(at(T1, { user_id: U(key), date: d, type, portion: opts.half ? 'half' : 'full', source: 'hr', approved_by: U(approver) } as Omit<E.Leave, keyof E.Base>) as E.Leave)
    return r
  }
  const nw = nextWorking(addDays(today, 7))
  req('bijaya', nw, nextWorking(addDays(nw, 1)), 'casual', 'Sister’s wedding in Cuttack', 'pending', 'subhankar', { created: addDays(today, -1) })
  req('jayashree', nextWorking(addDays(today, 3)), nextWorking(addDays(today, 3)), 'sick', 'Dental procedure, recovery day', 'pending', 'subhankar', { created: today })
  const bf = nextWorking(addDays(today, 16))
  req('baishali', bf, nextWorking(addDays(bf, 2)), 'earned', 'Family trip to Puri', 'pending', 'santosh', { created: addDays(today, -2) })
  const pf = nextWorking(addDays(today, 24))
  req('pragyasmita', pf, nextWorking(addDays(pf, 1)), 'casual', 'Moving house — need two days', 'approved', 'subhankar', { decided: addDays(today, -3), created: addDays(today, -4) })
  const jf = nextWorking(addDays(today, -20))
  req('jagannath', jf, nextWorking(addDays(jf, 1)), 'earned', 'Visiting parents in Berhampur', 'approved', 'subhankar', { decided: addDays(today, -26), created: addDays(today, -28) })
  const sf = nextWorking(addDays(today, 5))
  req('subham', sf, sf, 'casual', 'Personal errand at the bank', 'rejected', 'santosh', { decided: addDays(today, -1), why: 'Client demo with Mother’s Group that day — please pick another date.', created: addDays(today, -2) })
  req('priya', nextWorking(addDays(today, 10)), nextWorking(addDays(today, 10)), 'casual', 'Half day for a school meeting', 'approved', 'santosh', { half: true, decided: addDays(today, -1), created: addDays(today, -2) })

  /* ---------------- Ankit Sahu (past employee) ---------------- */
  const lastDay = addDays(today, -24)
  const resigned = addDays(lastDay, -30)
  const ankit: E.User = {
    ...h.base(T1), id: 'u_ankit', email: 'ankit@seereon.co.in', name: 'Ankit Sahu', title: 'QA Engineer', role: 'employee', reports_to_id: U('subhankar'), grants: [], role_key: 'employee', extra_permissions: [], revoked_permissions: [], status: 'deactivated',
    last_login_at: ts(lastDay), avatar_hue: 75, phone: null, joined_on: addDays(today, -520), department: 'delivery', two_factor: false, prefs: {},
  }
  db.users.push(ankit)

  /* ---------------- Appraisal cycles ---------------- */
  const team = ['subhankar', 'hritesh', 'bijaya', 'jagannath', 'jayashree', 'pragyasmita', 'baishali', 'subham', 'priya']
  const mgrOf = (k: string) => db.users.find((u) => u.id === U(k))?.reports_to_id ?? null
  const closed = at(T1, { name: 'H2 FY25-26', period_from: '2025-10-01', period_to: '2026-03-31', status: 'closed', self_due: '2026-04-10', manager_due: '2026-04-20', hr_due: '2026-04-30', weights: { goals: 30, tasks: 40, timesheets: 15, behaviour: 15 } } as Omit<B.AppraisalCycle, keyof E.Base>, ts('2026-03-25')) as B.AppraisalCycle
  closed.id = 'ac_h2_fy2526'
  const active = at(T1, {
    name: 'H1 FY26-27', period_from: '2026-04-01', period_to: '2026-09-30', status: 'manager_review', self_due: addDays(today, -6), manager_due: addDays(today, 6), hr_due: addDays(today, 16),
    weights: { goals: 35, tasks: 35, timesheets: 15, behaviour: 15 },
  } as Omit<B.AppraisalCycle, keyof E.Base>, ts(addDays(today, -25))) as B.AppraisalCycle
  active.id = 'ac_h1_fy2627'
  db.appraisal_cycles.push(closed, active)

  type Past = [string, number, number, number, number, number, string | null] // key, self, mgr, final, increment, on_time, promotion
  const past: Past[] = [
    ['subhankar', 4, 4, 4, 12, 0.86, null], ['hritesh', 4, 4.5, 4.5, 15, 0.92, 'Lead MERN Developer'], ['bijaya', 4, 3, 3, 8, 0.71, null], ['jagannath', 3, 3.5, 3.5, 9, 0.78, null],
    ['jayashree', 4, 3, 3, 7, 0.68, null], ['pragyasmita', 3, 4, 4, 11, 0.88, null], ['baishali', 4, 4, 4, 10, 0.83, null], ['subham', 3, 3, 3, 6, 0.74, null], ['priya', 4, 4, 4, 10, 0.9, null],
  ]
  const comments = {
    self: 'Delivered every committed module this half, picked up client calls when needed and mentored the newer developers on code reviews.',
    mgr: 'Reliable delivery with good ownership. Needs to flag risks earlier and write clearer estimates for multi-week tasks.',
    hr: 'Calibrated against the team; rating reflects on-time delivery and goal achievement.',
  }
  for (const [k, sr, mr, fr, inc, ot, promo] of past) {
    const a = at(T1, {
      cycle_id: closed.id, user_id: U(k), manager_id: mgrOf(k), status: 'completed', self_rating: sr, self_comments: comments.self, manager_rating: mr, manager_comments: comments.mgr,
      hr_rating: fr, hr_comments: comments.hr, final_rating: fr, increment_pct: inc, promotion_to: promo,
      metrics: { on_time_pct: ot, avg_variance_days: Math.round((1 - ot) * 30) / 10, first_pass_pct: Math.min(1, ot + 0.05), avg_quality: 3 + ot * 1.5, tasks_completed: 18 + Math.round(ot * 10), timesheet_compliance: Math.min(1, ot + 0.08), late_submissions: Math.round((1 - ot) * 6), goals_score: ot, approval_sla_pct: k === 'subhankar' ? 0.8 : null, score_tasks: Math.round((1 + 4 * ot) * 10) / 10, score_timesheets: Math.round((1 + 4 * Math.min(1, ot + 0.08)) * 10) / 10, score_goals: Math.round((1 + 4 * ot) * 10) / 10, score_behaviour: mr, suggested: Math.round(((1 + 4 * ot) * 0.85 + mr * 0.15) * 10) / 10 },
      submitted_self_at: ts('2026-04-08'), submitted_manager_at: ts('2026-04-18'), closed_at: ts('2026-04-28'),
    } as Omit<B.Appraisal, keyof E.Base>, ts('2026-03-31')) as B.Appraisal
    a.id = `apr_h2_${k}`
    db.appraisals.push(a)
  }
  // running cycle: a mix of stages
  type Cur = [string, B.AppraisalStatus, number | null, number | null]
  const cur: Cur[] = [
    ['subhankar', 'hr_pending', 4, 4], ['hritesh', 'manager_pending', 4, null], ['bijaya', 'manager_pending', 4, null], ['jagannath', 'hr_pending', 3, 4],
    ['jayashree', 'self_pending', null, null], ['pragyasmita', 'manager_pending', 4, null], ['baishali', 'manager_pending', 4, null], ['subham', 'self_pending', null, null], ['priya', 'hr_pending', 4, 4],
  ]
  for (const [k, st, sr, mr] of cur) {
    const a = at(T1, {
      cycle_id: active.id, user_id: U(k), manager_id: mgrOf(k), status: st, self_rating: sr, self_comments: sr ? 'This half I shipped the modules assigned to me, handled production fixes and improved test coverage on my area.' : '',
      manager_rating: mr, manager_comments: mr ? 'Strong half with dependable delivery. Next step: own estimates end to end and raise blockers on day one.' : '', hr_rating: null, hr_comments: '', final_rating: null, increment_pct: null, promotion_to: null,
      metrics: {}, submitted_self_at: sr ? ts(addDays(today, -8)) : null, submitted_manager_at: mr ? ts(addDays(today, -2)) : null, closed_at: null,
    } as Omit<B.Appraisal, keyof E.Base>, ts(addDays(today, -25))) as B.Appraisal
    a.id = `apr_h1_${k}`
    db.appraisals.push(a)
  }

  /* ---------------- Goals ---------------- */
  type G = [string, string, number, string, number, number, string, string?, boolean?]
  const goalSets: Record<string, G[]> = {
    subhankar: [['Deliver HRMS phase 2 on baseline', 'Delivery', 40, 'Milestones achieved on time', 4, 3, 'milestones'], ['Approve timesheets within SLA', 'People', 25, 'Weeks approved within 2 working days', 95, 88, '%'], ['Reduce sent-back tasks', 'Quality', 35, 'First-pass approval rate', 85, 80, '%']],
    hritesh: [['Ship EduReon parent app v1', 'Delivery', 40, 'Screens released to production', 24, 20, 'screens'], ['Raise unit-test coverage', 'Quality', 35, 'Coverage on core services', 70, 64, '%'], ['Mentor two juniors', 'People', 25, 'Paired review sessions', 12, 10, 'sessions']],
    bijaya: [['Payroll API performance', 'Delivery', 40, 'p95 latency of run endpoint', 100, 60, 'ms target met'], ['Close assigned bugs on time', 'Quality', 35, 'Bugs closed within SLA', 30, 21, 'bugs'], ['Complete FastAPI advanced course', 'Learning', 25, 'Modules completed', 10, 6, 'modules']],
    jagannath: [['HRMS payroll engine', 'Delivery', 45, 'Payroll rules implemented', 18, 15, 'rules'], ['Document APIs', 'Quality', 30, 'Endpoints documented', 40, 40, 'endpoints'], ['Reduce production incidents', 'Quality', 25, 'Incident-free weeks', 20, 17, 'weeks']],
    jayashree: [['Payroll approval workflow UI', 'Delivery', 40, 'Screens delivered', 8, 5, 'screens'], ['Accessibility fixes', 'Quality', 30, 'Issues resolved', 25, 12, 'issues'], ['Learn React Query patterns', 'Learning', 30, 'Internal demos given', 2, 0, 'demos', undefined, false]],
    pragyasmita: [['Laravel to React migration', 'Delivery', 40, 'Modules migrated', 6, 5, 'modules'], ['Code review turnaround', 'Quality', 30, 'Reviews within 1 day', 90, 92, '%'], ['Client UAT sign-offs', 'Delivery', 30, 'Sign-offs received', 3, 2, 'sign-offs']],
    baishali: [['New logo revenue', 'Revenue', 50, 'Won deal value', 40, 31, 'lakh ₹'], ['Content calendar', 'Marketing', 25, 'Posts published', 60, 52, 'posts'], ['BNI referrals converted', 'Revenue', 25, 'Referrals converted', 6, 4, 'deals']],
    subham: [['Qualified pipeline', 'Revenue', 50, 'Qualified opportunities', 20, 11, 'deals'], ['Demos delivered', 'Revenue', 30, 'Product demos', 25, 17, 'demos'], ['CRM hygiene', 'Process', 20, 'Deals updated weekly', 100, 72, '%']],
    priya: [['Payroll on time', 'Operations', 40, 'Payroll runs finalised by the 1st', 6, 6, 'runs'], ['Statutory filings on time', 'Compliance', 35, 'Filings before due date', 18, 17, 'filings'], ['Policy acknowledgements', 'People', 25, 'Staff who acknowledged handbook', 100, 90, '%']],
  }
  for (const [k, gs] of Object.entries(goalSets)) {
    gs.forEach(([title, kra, weight, measure, target, current, unit, , approved], i) => {
      const ok = approved !== false
      db.goals.push(at(T1, {
        user_id: U(k), cycle_id: active.id, title, kra, weight, measure, target, current: ok ? current : 0, unit, due_on: active.period_to,
        status: !ok ? 'draft' : current >= target ? 'achieved' : current / target < 0.6 ? 'at_risk' : 'on_track', manager_approved: ok,
      } as Omit<B.Goal, keyof E.Base>, ts(addDays(today, -170 + i))) as B.Goal)
    })
    // last cycle: one headline goal each, closed out
    const g = gs[0]
    db.goals.push(at(T1, { user_id: U(k), cycle_id: closed.id, title: `${g[0]} (H2)`, kra: g[1], weight: 100, measure: g[3], target: g[4], current: Math.round(g[4] * 0.9), unit: g[6], due_on: closed.period_to, status: 'achieved', manager_approved: true } as Omit<B.Goal, keyof E.Base>, ts('2025-10-05')) as B.Goal)
  }

  /* ---------------- Feedback ---------------- */
  const fb: [string, string, B.Feedback['kind'], string, B.Feedback['visibility'], number][] = [
    ['subhankar', 'hritesh', 'praise', 'Handled the EduReon release night calmly and fixed the push-notification bug before the client noticed.', 'public', -9],
    ['santosh', 'subhankar', 'praise', 'The Mother’s Group demo was tight — clear scope and the team knew their parts.', 'public', -15],
    ['subhankar', 'jayashree', 'improvement', 'Please raise blockers in the daily update the same day; the payroll API wait cost us three days.', 'manager', -6],
    ['subhankar', 'jayashree', 'one_on_one', '1:1 — agreed to pair with Jagannath on API contracts and to split UI tasks under 2 days each.', 'private', -5],
    ['hritesh', 'bijaya', 'praise', 'Thanks for turning around the leave API changes so quickly — unblocked the mobile build.', 'public', -12],
    ['santosh', 'baishali', 'improvement', 'Proposals are strong; follow-ups after demos need to happen within 48 hours.', 'private', -20],
    ['priya', 'pragyasmita', 'praise', 'First to acknowledge the updated handbook and helped two colleagues with the form.', 'public', -3],
    ['subhankar', 'jagannath', 'one_on_one', '1:1 — payroll engine on track; wants to move towards solution design next half.', 'private', -10],
  ]
  for (const [from, to, kind, body, visibility, d] of fb) db.feedback.push(at(T1, { to_user_id: U(to), from_user_id: U(from), kind, body, visibility, at: ts(addDays(today, d), '09:15') } as Omit<B.Feedback, keyof E.Base>, ts(addDays(today, d), '09:15')) as B.Feedback)

  /* ---------------- Recruitment ---------------- */
  const qa = db.openings.find((o) => o.tenant_id === T1 && o.role === 'QA engineer')
  const fl = db.openings.find((o) => o.tenant_id === T1 && o.role === 'Flutter developer')
  const cand = (id: string, opening: E.Opening, data: Partial<B.Candidate>, createdAgo: number) => {
    const c = at(T1, {
      opening_id: opening.id, name: '', email: '', phone: '', source: 'job_portal', stage: 'applied', experience_years: 2, current_ctc_paise: null, expected_ctc_paise: null, offer_ctc_paise: null,
      notice_days: 30, resume_file_id: null, rating: null, notes: '', rejected_reason: null, joining_on: null, user_id: null, ...data,
    } as Omit<B.Candidate, keyof E.Base>, ts(addDays(today, -createdAgo))) as B.Candidate
    c.id = id
    db.candidates.push(c)
    return c
  }
  const iv = (cid: string, round: number, kind: B.Interview['kind'], ago: number, who: string, result: B.Interview['result'], rating: number | null, feedback: string) =>
    db.interviews.push(at(T1, { candidate_id: cid, round, kind, scheduled_at: ts(addDays(today, -ago), '06:30'), interviewer_id: U(who), result, rating, feedback } as Omit<B.Interview, keyof E.Base>) as B.Interview)
  if (qa) {
    cand('cand_qa_1', qa, { name: 'Sourav Mishra', email: 'sourav.mishra@gmail.com', phone: '+91 98610 22451', source: 'job_portal', stage: 'applied', experience_years: 2, expected_ctc_paise: L(4.2) }, 2)
    cand('cand_qa_2', qa, { name: 'Ipsita Behera', email: 'ipsita.b@outlook.com', phone: '+91 70080 11934', source: 'linkedin', stage: 'screening', experience_years: 3, current_ctc_paise: L(3.6), expected_ctc_paise: L(4.8), notes: 'Selenium + Postman, wants manual + automation mix.' }, 6)
    cand('cand_qa_3', qa, { name: 'Rohan Das', email: 'rohan.das@gmail.com', phone: '+91 94370 55120', source: 'referral', stage: 'interview', experience_years: 4, current_ctc_paise: L(5), expected_ctc_paise: L(6.2), rating: 4, notes: 'Referred by Hritesh. Strong API testing.' }, 14)
    iv('cand_qa_3', 1, 'technical', 5, 'hritesh', 'pass', 4, 'Good grasp of API test design and Playwright basics; clear communicator.')
    db.interviews.push(at(T1, { candidate_id: 'cand_qa_3', round: 2, kind: 'manager', scheduled_at: ts(addDays(today, 2), '07:00'), interviewer_id: U('subhankar'), result: 'pending', rating: null, feedback: '' } as Omit<B.Interview, keyof E.Base>) as B.Interview)
    cand('cand_qa_4', qa, { name: 'Smruti Ranjan Sahoo', email: 'smruti.sahoo@yahoo.com', phone: '+91 90400 77812', source: 'campus', stage: 'interview', experience_years: 1, expected_ctc_paise: L(3.4), notes: 'Fresher from CET Bhubaneswar.' }, 9)
    db.interviews.push(at(T1, { candidate_id: 'cand_qa_4', round: 1, kind: 'technical', scheduled_at: ts(addDays(today, 1), '08:30'), interviewer_id: U('jagannath'), result: 'pending', rating: null, feedback: '' } as Omit<B.Interview, keyof E.Base>) as B.Interview)
    cand('cand_qa_5', qa, { name: 'Ananya Pradhan', email: 'ananya.pradhan@gmail.com', phone: '+91 89170 40021', source: 'agency', stage: 'rejected', experience_years: 3, expected_ctc_paise: L(7.5), rejected_reason: 'Expected CTC well above band; weak on test planning.' }, 20)
    iv('cand_qa_5', 1, 'technical', 12, 'hritesh', 'fail', 2, 'Could not design test cases for the leave approval flow; mostly UI clicking experience.')
  }
  if (fl) {
    cand('cand_fl_1', fl, { name: 'Debasish Swain', email: 'debasish.swain@gmail.com', phone: '+91 97770 31288', source: 'linkedin', stage: 'offer', experience_years: 3, current_ctc_paise: L(5.4), expected_ctc_paise: L(7), offer_ctc_paise: L(6.6), notice_days: 15, rating: 5, joining_on: addDays(today, 14), notes: 'Built two production Flutter apps; available in two weeks.' }, 26)
    iv('cand_fl_1', 1, 'technical', 16, 'hritesh', 'pass', 5, 'Excellent state management and offline-first approach; shipped apps on both stores.')
    iv('cand_fl_1', 2, 'manager', 11, 'subhankar', 'pass', 4, 'Good fit for EduReon mobile; agreed on joining timeline and expectations.')
    iv('cand_fl_1', 3, 'hr', 8, 'priya', 'pass', 4, 'Notice of 15 days confirmed; references checked and positive.')
  }
  for (const c of db.candidates.filter((x) => x.tenant_id === T1))
    db.activity_log.push(at(T1, { entity: 'candidate', entity_id: c.id, action: 'created', summary: `Priya Mohapatra added ${c.name}`, actor_id: U('priya'), at: c.created_at } as Omit<E.ActivityLog, keyof E.Base>) as E.ActivityLog)

  /* ---------------- Lifecycle checklists ---------------- */
  const ritika = db.invites.find((i) => i.tenant_id === T1 && i.email === 'ritika@seereon.co.in')
  if (ritika) {
    const start = addDays(today, 6)
    const tpl: [string, string, B.ChecklistItem['owner_role'], number, boolean][] = [
      ['offer_signed', 'Offer letter signed', 'ops', -7, true], ['documents', 'Documents collected (ID, PAN, bank)', 'ops', -3, false], ['laptop', 'Laptop issued (asset)', 'it', 0, false],
      ['accounts', 'Email & accounts created', 'it', 0, false], ['buddy', 'Buddy assigned', 'manager', 0, true], ['policies', 'Policy acknowledgements', 'employee', 3, false],
      ['checkin_30', '30-day check-in', 'manager', 30, false], ['checkin_60', '60-day check-in', 'manager', 60, false], ['checkin_90', '90-day check-in', 'manager', 90, false],
    ]
    db.lifecycle_checklists.push(at(T1, {
      user_id: ritika.id, kind: 'onboarding', status: 'open', start_on: start, last_day: null, exit_reason: null, exit_type: null, rehire_eligible: null,
      items: tpl.map(([id, label, owner_role, due_offset_days, done]) => ({ id, label, owner_role, due_offset_days, done_on: done ? addDays(today, -3) : null, done_by: done ? (owner_role === 'manager' ? U('subhankar') : U('priya')) : null })),
    } as Omit<B.LifecycleChecklist, keyof E.Base>, ts(addDays(today, -8))) as B.LifecycleChecklist)
  }
  {
    const ld = 30
    const tpl: [string, string, B.ChecklistItem['owner_role'], number, boolean][] = [
      ['resignation', 'Resignation received', 'ops', 0, true], ['notice', 'Notice period agreed', 'manager', 2, true], ['kt', 'Knowledge transfer', 'manager', ld - 5, true],
      ['exit_interview', 'Exit interview', 'ops', ld - 2, true], ['asset_return', 'Asset return', 'it', ld, false], ['access', 'Access revoked', 'it', ld, true],
      ['fnf', 'Full & final settlement', 'finance', ld + 30, false], ['experience_letter', 'Experience letter issued', 'ops', ld + 7, true],
    ]
    db.lifecycle_checklists.push(at(T1, {
      user_id: ankit.id, kind: 'offboarding', status: 'open', start_on: resigned, last_day: lastDay, exit_reason: 'Moved to a product company in Bengaluru for a QA lead role.', exit_type: 'resignation', rehire_eligible: true,
      items: tpl.map(([id, label, owner_role, due_offset_days, done]) => ({ id, label, owner_role, due_offset_days, done_on: done ? addDays(resigned, Math.min(due_offset_days, ld)) : null, done_by: done ? (owner_role === 'manager' ? U('subhankar') : U('priya')) : null })),
    } as Omit<B.LifecycleChecklist, keyof E.Base>, ts(resigned)) as B.LifecycleChecklist)
  }

  /* ---------------- Assets ---------------- */
  type A = [string, string, B.Asset['category'], string, string | null, number, number, number | null]
  const assets: A[] = [
    ['SEE-LAP-001', 'MacBook Pro 14" M3', 'laptop', 'C02XK1M3MD6R', 'santosh', -420, 189900, 365],
    ['SEE-LAP-002', 'Dell Latitude 5440', 'laptop', 'DL5440-7KQ2', 'subhankar', -400, 92000, 1095],
    ['SEE-LAP-003', 'Lenovo ThinkPad E14 Gen 5', 'laptop', 'PF4XQ2LM', 'hritesh', -370, 78500, 1095],
    ['SEE-LAP-004', 'Lenovo ThinkPad E14 Gen 5', 'laptop', 'PF4XQ2LN', 'bijaya', -300, 78500, 1095],
    ['SEE-LAP-005', 'HP ProBook 440 G10', 'laptop', '5CD3291K7T', 'jagannath', -290, 71000, 730],
    ['SEE-LAP-006', 'HP ProBook 440 G10', 'laptop', '5CD3291K8B', 'jayashree', -250, 71000, 730],
    ['SEE-LAP-007', 'Dell Vostro 3520', 'laptop', 'DV3520-9PL1', 'pragyasmita', -200, 58000, 365],
    ['SEE-LAP-008', 'HP 15s Ryzen 5', 'laptop', '5CG2341QWX', 'baishali', -330, 52000, 365],
    ['SEE-LAP-009', 'HP 15s Ryzen 5', 'laptop', '5CG2341QWZ', 'subham', -160, 52000, 365],
    ['SEE-LAP-010', 'Dell Inspiron 3530', 'laptop', 'DI3530-3HN8', 'priya', -310, 55000, 365],
    ['SEE-LAP-011', 'Lenovo IdeaPad Slim 3', 'laptop', 'PW0B7K2Q', null, -20, 48500, 365],
    ['SEE-MON-001', 'Dell 24" P2423 monitor', 'monitor', 'CN0P2423-11', 'ankit', -500, 14500, 1095],
    ['SEE-MON-002', 'LG 27" 4K monitor', 'monitor', 'LG27UL-552', 'hritesh', -120, 26500, 1095],
    ['SEE-LIC-001', 'Figma Professional (annual)', 'licence', 'FIG-SEE-2026', 'jayashree', -60, 15800, 305],
  ]
  for (const [tag, name, category, serial, who, ago, cost, warranty] of assets) {
    const purchase = addDays(today, ago)
    const a = at(T1, {
      tag, name, category, serial, status: who ? 'assigned' : 'in_stock', assigned_to: who ? U(who) : null, assigned_on: who ? addDays(purchase, 2) : null, purchase_on: purchase,
      purchase_cost_paise: RS(cost), warranty_until: warranty ? addDays(purchase, warranty) : null, notes: tag === 'SEE-LAP-011' ? 'Reserved for Ritika Senapati (joining).' : '',
    } as Omit<B.Asset, keyof E.Base>, ts(purchase)) as B.Asset
    db.assets.push(a)
    db.activity_log.push(at(T1, { entity: 'asset', entity_id: a.id, action: 'created', summary: `Priya Mohapatra registered ${tag} (${name})`, actor_id: U('priya'), at: ts(purchase) } as Omit<E.ActivityLog, keyof E.Base>) as E.ActivityLog)
    if (who) db.activity_log.push(at(T1, { entity: 'asset', entity_id: a.id, action: 'assigned', summary: `Priya Mohapatra assigned ${tag} to ${db.users.find((u) => u.id === U(who))?.name}`, actor_id: U('priya'), at: ts(addDays(purchase, 2)) } as Omit<E.ActivityLog, keyof E.Base>) as E.ActivityLog)
  }

  /* ---------------- Kalinga: two assets ---------------- */
  const k1 = db.users.find((u) => u.id === 'u_k_sneha')
  db.assets.push(
    at(T2, { tag: 'KS-LAP-001', name: 'Lenovo ThinkPad E14', category: 'laptop', serial: 'KS-PF55A1', status: k1 ? 'assigned' : 'in_stock', assigned_to: k1?.id ?? null, assigned_on: k1 ? addDays(today, -4) : null, purchase_on: addDays(today, -30), purchase_cost_paise: RS(76000), warranty_until: addDays(today, 700), notes: '' } as Omit<B.Asset, keyof E.Base>) as B.Asset,
    at(T2, { tag: 'KS-LAP-002', name: 'Dell Latitude 3440', category: 'laptop', serial: 'KS-DL3440-2', status: 'in_stock', assigned_to: null, assigned_on: null, purchase_on: addDays(today, -30), purchase_cost_paise: RS(68000), warranty_until: addDays(today, 700), notes: '' } as Omit<B.Asset, keyof E.Base>) as B.Asset,
  )
}
