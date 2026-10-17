// v3 task governance seed: review history for completed work, tasks waiting for review, sent-back items,
// delay reasons, and general tasks that line managers assign outside client projects.
// Runs at the end of buildSeed, so db.tasks already holds the project WBS.
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import { addDays, isWorkingDay, minISO, type CalendarCtx } from '@/domain/calendar'
import type { SeedHelpers } from './index'

type Tl = 'early' | 'on_time' | 'late'

export function seed(db: DB, h: SeedHelpers) {
  const today = h.today
  const at = (d: string, hh = 10) => `${d}T${String(hh).padStart(2, '0')}:${String(Math.floor(h.rnd() * 50) + 5).padStart(2, '0')}:00Z`

  for (const tenant of db.tenants) {
    const T = tenant.id
    const users = db.users.filter((u) => u.tenant_id === T)
    if (!users.length) continue
    const calc: CalendarCtx = { settings: tenant.settings, holidays: db.holidays.filter((x) => x.tenant_id === T) }
    // Signed working-day variance (same definition as performance.workingDayVariance; the seed runs before the DB exists).
    const variance = (due: string, done: string) => {
      if (done === due) return 0
      let n = 0
      if (done > due) {
        for (let d = addDays(due, 1); d <= done; d = addDays(d, 1)) if (isWorkingDay(d, calc)) n++
        return n
      }
      for (let d = addDays(done, 1); d <= due; d = addDays(d, 1)) if (isWorkingDay(d, calc)) n--
      return n
    }
    const tl = (v: number): Tl => (v < 0 ? 'early' : v === 0 ? 'on_time' : 'late')
    const user = (id: string | null | undefined) => users.find((u) => u.id === id)
    const top = (id: string | null | undefined) => {
      const u = user(id)
      return !!u && u.role === 'admin' && !u.reports_to_id
    }
    const projects = db.projects.filter((p) => p.tenant_id === T)
    const gen = projects.find((p) => p.id === `p_general_${tenant.slug}`)
    const review = (r: Omit<B.TaskReview, keyof E.Base>) => {
      const row = { ...h.base(T), ...r } as B.TaskReview
      db.task_reviews.push(row)
      return row
    }
    const log = (entity_id: string, action: string, summary: string, actor_id: string, when: string) =>
      db.activity_log.push({ ...h.base(T), entity: 'task', entity_id, action, summary, actor_id, at: when } as E.ActivityLog)
    const reviewerFor = (t: E.Task) => {
      const p = projects.find((x) => x.id === t.project_id)
      let r = t.reviewer_id ?? (t.kind === 'general' ? t.assigned_by ?? null : p?.pm_id ?? null)
      if (r && r === t.owner_id && !top(r)) r = user(t.owner_id)?.reports_to_id ?? r
      return r
    }

    /* ---- 0. v5 plan detail that moves dates (before review history): target revisions, CR tasks, AMS run tasks ---- */
    if (T === 'tn_seereon') {
      const tByTitle = (title: string) => db.tasks.find((t) => t.tenant_id === T && t.title === title)
      const revise = (title: string, toOffsetDays: number, reasons: { reason: string; daysAgo: number; by: string }[]) => {
        const t = tByTitle(title)
        if (!t) return
        const base = t.due_on
        t.baseline_due_on = base
        const step = Math.round(toOffsetDays / reasons.length)
        let cur = base
        t.target_revisions = reasons.map((r, i) => {
          const to = i === reasons.length - 1 ? addDays(base, toOffsetDays) : addDays(cur, step)
          const rev = { from: cur, to, at: at(addDays(today, -r.daysAgo), 8), by: r.by, reason: r.reason }
          cur = to
          return rev
        })
        t.due_on = cur
      }
      // HRMS M2 slips 5 days: the approval workflow waits on the payroll run API (flagged early, see step 5)
      revise('Payroll approval workflow', 7, [{ reason: 'Payroll run API slipped and the client added arrears scenarios to the approval rules.', daysAgo: 3, by: 'u_subhankar' }])
      // Achieved milestones that moved: data migration (+6d), DMS phase 1 (+4d), SAMET launch (+2d)
      revise('Opening fee balances reconciliation', 6, [{ reason: 'Campus 2 shared the opening balance ledger a week late.', daysAgo: 30, by: 'u_subhankar' }])
      revise('Folder permissions', 4, [{ reason: 'Client asked for department-level inheritance rules.', daysAgo: 45, by: 'u_subhankar' }])
      revise('Admissions portal with payments', 2, [{ reason: 'Payment gateway KYC took two extra days.', daysAgo: 66, by: 'u_subhankar' }])
      // Territory reports: two reschedules (the activity log in step 3 records them)
      const tr = tByTitle('Territory & target reports')
      if (tr) {
        const orig = addDays(tr.due_on, -6)
        tr.baseline_due_on = orig
        tr.target_revisions = [
          { from: orig, to: addDays(orig, 3), at: at(addDays(today, -9), 8), by: 'u_subhankar', reason: 'Client asked to add region-wise targets to the report scope.' },
          { from: addDays(orig, 3), to: tr.due_on, at: at(addDays(today, -3), 8), by: 'u_subhankar', reason: 'Target master from Digitalratha arrived late; waiting on their sales ops team.' },
        ]
      }
      // AMS retainer quarters run on a service task each, so their deadlines (= last task's end) match the quarter
      const rcuNo = (msId: string) => Math.max(0, ...db.tasks.filter((t) => t.milestone_id === msId).map((t) => t.no)) + 1
      const amsTask = (id: string, msId: string, title: string, est: number, s: number, e: number, status: E.TaskStatus) => {
        if (!db.milestones.some((m) => m.id === msId) || db.tasks.some((t) => t.id === id)) return
        db.tasks.push({
          ...h.base(T), id, project_id: 'p_rcu', milestone_id: msId, no: rcuNo(msId), title, owner_id: 'u_santosh', backup_id: 'u_subhankar', est_hours: est, start_on: addDays(today, s), due_on: addDays(today, e), done_on: null,
          complexity: 'medium', status, description: 'Retainer service: incident tickets, small enhancements and the monthly service report to RCU IT.', blocked_reason: null,
        } as E.Task)
      }
      amsTask('t_rcu_q3_ops', 'ms_rcu_3', 'Q3 AMS tickets and monthly service reports', 120, -19, 72, 'in_progress')
      amsTask('t_rcu_q4_ops', 'ms_rcu_4', 'Q4 AMS tickets and monthly service reports', 120, 73, 165, 'todo')
      // CR-1 on EduReon (MGS): approved transport fee module, its tasks already added to M3
      const mgs3 = db.milestones.find((m) => m.id === 'ms_mgs_3')
      if (mgs3) {
        const n0 = Math.max(0, ...db.tasks.filter((t) => t.milestone_id === mgs3.id).map((t) => t.no))
        db.tasks.push(
          { ...h.base(T), id: 't_mgs_cr1_1', project_id: 'p_mgs', milestone_id: mgs3.id, no: n0 + 1, title: 'Transport routes and fee master', owner_id: 'u_pragyasmita', backup_id: null, est_hours: 16, start_on: addDays(today, -12), due_on: addDays(today, -6), done_on: addDays(today, -6), complexity: 'medium', status: 'done', description: 'From CR-1: Transport fee module', blocked_reason: null, cr_id: 'cr_mgs_1' } as E.Task,
          { ...h.base(T), id: 't_mgs_cr1_2', project_id: 'p_mgs', milestone_id: mgs3.id, no: n0 + 2, title: 'Monthly transport billing run', owner_id: 'u_jayashree', backup_id: 'u_pragyasmita', est_hours: 8, start_on: addDays(today, -5), due_on: addDays(today, 3), done_on: null, complexity: 'low', status: 'in_progress', description: 'From CR-1: Transport fee module', blocked_reason: null, cr_id: 'cr_mgs_1' } as E.Task,
        )
        db.task_dependencies.push({ ...h.base(T), task_id: 't_mgs_cr1_2', depends_on_task_id: 't_mgs_cr1_1' })
      }
    }

    /* ---- 1. governance fields on every existing project task ---- */
    const tasks = db.tasks.filter((t) => t.tenant_id === T)
    for (const t of tasks) {
      const p = projects.find((x) => x.id === t.project_id)
      t.kind = t.kind ?? (t.project_id === gen?.id ? 'general' : 'project')
      t.assigned_by = t.assigned_by ?? p?.pm_id ?? null
      t.reviewer_id = t.reviewer_id ?? reviewerFor(t)
      t.priority = t.priority ?? (p?.priority === 1 ? 'high' : 'normal')
      t.review_round = t.review_round ?? 0
    }

    /* ---- 2. review history for completed work ---- */
    const SENT_BACK_REASONS = [
      'Edge cases are not covered: the import fails silently on blank mobile numbers. Add row-level errors and resubmit.',
      'Works, but the screen does not follow the approved design for tablet. Fix the layout and attach screenshots.',
      'Totals on the summary do not tie back to the detail report. Reconcile and attach the reconciliation sheet.',
      'Missing unit tests for the failure paths and no README for deployment. Add both before I approve.',
    ]
    const LATE_REASONS: { code: B.DelayReasonCode; text: string }[] = [
      { code: 'client_delay', text: 'Client shared the final master data two days after the agreed date, so testing slipped.' },
      { code: 'underestimated', text: 'Arrears logic needed a second pass for mid-month joiners; the estimate missed this case.' },
      { code: 'dependency', text: 'Waited on the upstream API contract which changed during the week.' },
      { code: 'technical_issue', text: 'Staging database ran out of disk mid-migration; lost a day restoring and re-running.' },
    ]
    let k = 0
    for (const t of tasks.filter((x) => x.status === 'done' && x.done_on)) {
      k++
      const reviewer = t.reviewer_id ?? reviewerFor(t)
      if (!reviewer) continue
      // Realistic mix: most work lands on or before the due date, roughly a quarter slips.
      const OFFSETS = [0, -1, 0, 2, -2, 0, 1, 0, -1, 3]
      const done = minISO(addDays(t.due_on, OFFSETS[k % OFFSETS.length]), addDays(today, -1))
      t.done_on = done
      const v = variance(t.due_on, done)
      const late = v > 0
      const sentBack = k % 3 === 0
      const delay = late ? LATE_REASONS[k % LATE_REASONS.length] : null
      const rating = late ? 3 + (k % 2) : sentBack ? 4 : 4 + (k % 2)
      let round = 0
      if (sentBack) {
        round++
        const first = addDays(done, -3)
        review({
          task_id: t.id, round, submitted_by: t.owner_id!, submitted_at: at(first, 11), submission_note: 'Ready for review. Demo recording and test notes linked.',
          proof_url: 'https://drive.google.com/drive/folders/seereon-demo', delay_reason_code: first > t.due_on ? delay?.code ?? 'underestimated' : null,
          delay_reason: first > t.due_on ? delay?.text ?? 'Took longer than planned to stabilise.' : null,
          decision: 'sent_back', decided_by: reviewer, decided_at: at(addDays(first, 1), 6), decision_reason: SENT_BACK_REASONS[k % SENT_BACK_REASONS.length], quality_rating: null,
        })
        log(t.id, 'task.sent_back', `Sent back (round ${round}): ${SENT_BACK_REASONS[k % SENT_BACK_REASONS.length]}`, reviewer, at(addDays(first, 1), 6))
      }
      round++
      const approvedOn = minISO(addDays(done, 1), today)
      review({
        task_id: t.id, round, submitted_by: t.owner_id!, submitted_at: at(done, 12), submission_note: sentBack ? 'Fixed the review comments; attached the updated evidence.' : 'Completed as per acceptance criteria. Evidence attached.',
        proof_url: k % 2 ? 'https://drive.google.com/drive/folders/seereon-demo' : null, delay_reason_code: delay?.code ?? null, delay_reason: delay?.text ?? null,
        decision: 'approved', decided_by: reviewer, decided_at: at(approvedOn, 7), decision_reason: rating >= 5 ? 'Clean work, well documented.' : null, quality_rating: rating,
      })
      Object.assign(t, {
        submitted_on: done, approved_by: reviewer, approved_on: approvedOn, review_round: round, timeliness: tl(v), variance_days: v, quality_rating: rating,
        delay_reason_code: delay?.code ?? null, delay_reason: delay?.text ?? null,
      })
    }

    /* ---- 3. tasks waiting for review / sent back on live projects (Seereon) ---- */
    const byTitle = (title: string) => tasks.find((t) => t.title === title)
    const submit = (t: E.Task | undefined, daysAgo: number, note: string, proof: string | null, delayCode: B.DelayReasonCode | null = null, delayText: string | null = null, prior: { reason: string; daysAgo: number } | null = null) => {
      if (!t || !t.owner_id) return
      const reviewer = t.reviewer_id ?? reviewerFor(t)
      let round = 0
      if (prior) {
        round++
        const d = addDays(today, -prior.daysAgo)
        review({ task_id: t.id, round, submitted_by: t.owner_id, submitted_at: at(d, 9), submission_note: 'First version ready for review.', proof_url: proof, delay_reason_code: null, delay_reason: null, decision: 'sent_back', decided_by: reviewer, decided_at: at(addDays(d, 1), 5), decision_reason: prior.reason, quality_rating: null })
        if (reviewer) log(t.id, 'task.sent_back', `Sent back (round ${round}): ${prior.reason}`, reviewer, at(addDays(d, 1), 5))
      }
      round++
      const sub = addDays(today, -daysAgo)
      review({ task_id: t.id, round, submitted_by: t.owner_id, submitted_at: at(sub, 13), submission_note: note, proof_url: proof, delay_reason_code: delayCode, delay_reason: delayText, decision: null, decided_by: null, decided_at: null, decision_reason: null, quality_rating: null })
      Object.assign(t, { status: 'in_review', submitted_on: sub, review_round: round, done_on: null, delay_reason_code: delayCode ?? t.delay_reason_code ?? null, delay_reason: delayText ?? t.delay_reason ?? null, blocked_reason: null })
      log(t.id, 'task.submitted', `Submitted for review (round ${round})${delayCode ? ` — ${delayText}` : ''}`, t.owner_id, at(sub, 13))
    }
    const sendBackOpen = (t: E.Task | undefined, daysAgo: number, reason: string) => {
      if (!t || !t.owner_id) return
      const reviewer = t.reviewer_id ?? reviewerFor(t)
      const d = addDays(today, -daysAgo - 1)
      review({ task_id: t.id, round: 1, submitted_by: t.owner_id, submitted_at: at(d, 15), submission_note: 'Screens done, please review on staging.', proof_url: 'https://staging.edureon.in/counsellor', delay_reason_code: null, delay_reason: null, decision: 'sent_back', decided_by: reviewer, decided_at: at(addDays(today, -daysAgo), 6), decision_reason: reason, quality_rating: null })
      Object.assign(t, { status: 'in_progress', submitted_on: d, review_round: 1 })
      if (reviewer) log(t.id, 'task.sent_back', `Sent back (round 1): ${reason}`, reviewer, at(addDays(today, -daysAgo), 6))
    }

    if (T === 'tn_seereon') {
      submit(byTitle('Leave & attendance policies'), 1, 'All 14 leave types configured with accrual, carry-forward and encashment rules for both mines. Test matrix attached.', 'https://drive.google.com/file/d/leave-policy-test-matrix')
      submit(byTitle('Fee receipt printing & Razorpay go-live'), 0, 'Receipts print on the thermal printer at both campuses; Razorpay live keys switched and ₹1 test payment reconciled.', null, 'client_delay', 'Razorpay KYC for the second campus was approved only yesterday, so live payments could not be enabled on the due date.')
      // Open item that was sent back: Jayashree sees it pinned in My tasks
      sendBackOpen(byTitle('Enquiry forms and counsellor app'), 1, 'Validation messages are missing on mobile and the counsellor app crashes on Android 11 when attaching a document. Fix both and resubmit with a screen recording.')
      // Repeated rescheduling, visible in task history
      const tr = byTitle('Territory & target reports')
      if (tr) {
        const orig = addDays(tr.due_on, -6)
        log(tr.id, 'task.rescheduled', `Due moved ${orig} → ${addDays(orig, 3)}: Client asked to add region-wise targets to the report scope.`, 'u_subhankar', at(addDays(today, -9), 8))
        log(tr.id, 'task.rescheduled', `Due moved ${addDays(orig, 3)} → ${tr.due_on} (reschedule #2): Target master from Digitalratha arrived late; waiting on their sales ops team.`, 'u_subhankar', at(addDays(today, -3), 8))
      }
    }

    /* ---- 4. general tasks assigned by line managers ---- */
    if (!gen) continue
    let no = Math.max(0, ...db.tasks.filter((t) => t.project_id === gen.id && !t.milestone_id).map((t) => t.no))
    const general = (g: { key: string; title: string; desc: string; owner: string; by: string; est: number; s: number; due: number; status: E.TaskStatus; priority?: E.Task['priority'] }) => {
      if (!user(g.owner) || !user(g.by)) return undefined
      no++
      let reviewer = g.by
      if (reviewer === g.owner && !top(reviewer)) reviewer = user(g.owner)?.reports_to_id ?? reviewer
      const t: E.Task = {
        ...h.base(T), id: `t_gen_${tenant.slug}_${g.key}`, created_by: g.by, created_at: at(addDays(today, g.s - 1), 6), project_id: gen.id, milestone_id: null, no, title: g.title,
        owner_id: g.owner, backup_id: null, est_hours: g.est, start_on: addDays(today, g.s), due_on: addDays(today, g.due), done_on: null,
        complexity: g.est > 40 ? 'high' : g.est > 12 ? 'medium' : 'low', status: g.status, description: g.desc, blocked_reason: null,
        kind: 'general', assigned_by: g.by, reviewer_id: reviewer, priority: g.priority ?? 'normal', review_round: 0, submitted_on: null, approved_by: null, approved_on: null,
        timeliness: null, variance_days: null, delay_reason_code: null, delay_reason: null, quality_rating: null,
      }
      db.tasks.push(t)
      log(t.id, 'task.created', `Assigned ${g.title}`, g.by, t.created_at)
      return t
    }
    const approveDone = (t: E.Task | undefined, doneAgo: number, rating: number, delay: { code: B.DelayReasonCode; text: string } | null = null, sentBack: string | null = null) => {
      if (!t || !t.owner_id) return
      const done = addDays(today, -doneAgo)
      let round = 0
      if (sentBack) {
        round++
        review({ task_id: t.id, round, submitted_by: t.owner_id, submitted_at: at(addDays(done, -2), 10), submission_note: 'Draft ready.', proof_url: null, delay_reason_code: null, delay_reason: null, decision: 'sent_back', decided_by: t.reviewer_id ?? null, decided_at: at(addDays(done, -1), 6), decision_reason: sentBack, quality_rating: null })
      }
      round++
      const v = variance(t.due_on, done)
      const approvedOn = minISO(addDays(done, 1), today)
      review({ task_id: t.id, round, submitted_by: t.owner_id, submitted_at: at(done, 16), submission_note: 'Done — details in the linked folder.', proof_url: 'https://drive.google.com/drive/folders/seereon-admin', delay_reason_code: delay?.code ?? null, delay_reason: delay?.text ?? null, decision: 'approved', decided_by: t.reviewer_id ?? null, decided_at: at(approvedOn, 6), decision_reason: null, quality_rating: rating })
      Object.assign(t, { status: 'done', done_on: done, submitted_on: done, approved_by: t.reviewer_id, approved_on: approvedOn, review_round: round, timeliness: tl(v), variance_days: v, quality_rating: rating, delay_reason_code: delay?.code ?? null, delay_reason: delay?.text ?? null })
    }

    if (T === 'tn_seereon') {
      const iso = general({ key: 'iso', title: 'Prepare ISO surveillance audit evidence', desc: 'Collect evidence for clauses 7.5, 8.5 and 9.2: training records, project closure reports, internal audit minutes. Share one folder with the auditor.', owner: 'u_priya', by: 'u_santosh', est: 16, s: -12, due: 1, status: 'in_progress', priority: 'high' })
      submit(iso, 1, 'Evidence folder is complete for all three clauses; internal audit minutes signed. Index sheet on the first tab.', 'https://drive.google.com/drive/folders/iso-2026-surveillance')
      const cs = general({ key: 'casestudy', title: 'Update case study for Digitalratha', desc: 'Refresh the CRM case study with the 27% closing-rate lift, Mr Deepak’s quote and the new screenshots. One page PDF + website version.', owner: 'u_baishali', by: 'u_santosh', est: 8, s: -10, due: -3, status: 'in_progress' })
      submit(cs, 1, 'Updated with the 27% lift, approved quote and fresh screenshots. PDF and web copy attached.', 'https://drive.google.com/file/d/digitalratha-case-study-v3', 'client_delay', 'Waited for Digitalratha to approve the revised quote and logo usage; they signed off only on Tuesday.', { reason: 'Numbers don’t match the signed testimonial: the closing-rate lift is 27%, not 32%. Add Mr Deepak’s quote.', daysAgo: 5 })
      approveDone(general({ key: 'q3deck', title: 'Q3 delivery review deck for leadership', desc: 'Project-wise delivery, SPI, margin and hiring needs for the quarter review.', owner: 'u_subhankar', by: 'u_santosh', est: 10, s: -18, due: -10, status: 'todo' }), 12, 5)
      approveDone(general({ key: 'ptax', title: 'Renew professional tax registration', desc: 'Renew PT enrolment and registration certificates on the Odisha commercial tax portal.', owner: 'u_priya', by: 'u_santosh', est: 4, s: -28, due: -20, status: 'todo' }), 17, 4, { code: 'technical_issue', text: 'The commercial tax portal was down for three days during the renewal window; filed as soon as it came back.' })
      general({ key: 'laptop', title: 'Laptop reimaging for new joiner', desc: 'Reimage the spare ThinkPad, install the dev toolchain (Node 20, Python 3.12, Docker), enrol in MDM and hand over with the asset form.', owner: 'u_hritesh', by: 'u_subhankar', est: 6, s: -6, due: -2, status: 'in_progress' })
      approveDone(general({ key: 'backups', title: 'Set up staging backups for HRMS', desc: 'Nightly pg_dump to object storage with 14-day retention; restore drill documented.', owner: 'u_bijaya', by: 'u_subhankar', est: 8, s: -12, due: -6, status: 'todo' }), 6, 5)
      general({ key: 'checklist', title: 'Code review checklist for FastAPI services', desc: 'One-page checklist: auth, validation, pagination, logging, tests. Circulate to the team.', owner: 'u_jagannath', by: 'u_subhankar', est: 5, s: 0, due: 7, status: 'todo' })
      approveDone(general({ key: 'kt', title: 'Knowledge-transfer notes for EduReon v2', desc: 'Architecture, environments and release steps so a second developer can take over.', owner: 'u_jayashree', by: 'u_subhankar', est: 6, s: -16, due: -9, status: 'todo' }), 7, 3, { code: 'priority_change', text: 'Pulled onto the MGS go-live fixes for two days by the PM, so the notes slipped.' }, 'Release steps are missing the database migration order. Add it and the rollback steps.')
      general({ key: 'bni', title: 'BNI chapter presentation slides', desc: 'Ten-minute feature presentation: Seereon story, two client wins, clear referral ask.', owner: 'u_baishali', by: 'u_santosh', est: 4, s: 0, due: 5, status: 'todo' })
    } else if (T === 'tn_kalinga') {
      const gh = general({ key: 'github', title: 'Set up GitHub org and branch protections', desc: 'Create the org, teams and protected main branches with required reviews.', owner: 'u_k_arjun', by: 'u_k_rakesh', est: 4, s: -3, due: 1, status: 'in_progress' })
      submit(gh, 0, 'Org created with two teams; main is protected with one required review and status checks.', null)
      approveDone(general({ key: 'tools', title: 'Finalise project tooling list', desc: 'Pick tracker, CI and design tools for the OPD project.', owner: 'u_k_rakesh', by: 'u_k_ananya', est: 3, s: -5, due: -2, status: 'todo' }), 2, 4)
    }
  }

  /* ---- 5. v5 delivery detail: stages, progress, tags, baselines, slip flags, change requests ---- */
  for (const tenant of db.tenants) {
    const T = tenant.id
    const tasks = db.tasks.filter((t) => t.tenant_id === T)
    if (!tasks.length) continue
    const logged = new Map<string, { h: number; first: string }>()
    for (const e of db.timesheet_entries) {
      if (e.tenant_id !== T || e.kind !== 'task' || !e.task_id) continue
      const cur = logged.get(e.task_id) ?? { h: 0, first: e.work_date }
      cur.h += e.hours
      if (e.work_date < cur.first) cur.first = e.work_date
      logged.set(e.task_id, cur)
    }
    const stageLog = (t: E.Task, summary: string, daysAgo: number, by: string | null) =>
      db.activity_log.push({ ...h.base(T), entity: 'task', entity_id: t.id, action: 'task.stage', summary, actor_id: by ?? t.owner_id ?? '', at: `${addDays(today, -daysAgo)}T09:${String(10 + (daysAgo % 40)).padStart(2, '0')}:00Z` } as E.ActivityLog)
    let k = 0
    for (const t of tasks) {
      k++
      const lg = logged.get(t.id)
      t.baseline_due_on = t.baseline_due_on ?? t.due_on
      t.target_revisions = t.target_revisions ?? []
      t.slip_flagged_on = t.slip_flagged_on ?? null
      t.slip_note = t.slip_note ?? null
      if (t.status === 'done') {
        t.stage = 'completed'
        t.progress = 100
        t.actual_start_on = lg?.first && lg.first < t.start_on ? lg.first : t.start_on
      } else if (t.status === 'in_review') {
        t.stage = 'uat'
        t.progress = 95
        t.actual_start_on = lg?.first ?? t.start_on
      } else if (t.status === 'in_progress') {
        const r = t.est_hours ? (lg?.h ?? 0) / t.est_hours : 0
        if (r >= 0.9) {
          t.stage = 'uat'
          t.progress = 90
        } else if (r >= 0.7) {
          t.stage = 'functional_testing'
          t.progress = 75
        } else if (r >= 0.5) {
          t.stage = 'unit_testing'
          t.progress = 60
        } else {
          t.stage = 'in_development'
          t.progress = Math.max(20, Math.min(50, Math.round((r * 100) / 5) * 5 || 30))
        }
        t.actual_start_on = lg?.first ?? t.start_on
      } else if (t.status === 'blocked') {
        t.stage = 'blocked'
        t.progress = lg ? Math.min(40, Math.round(((lg.h / Math.max(1, t.est_hours)) * 100) / 5) * 5) : 0
        t.actual_start_on = lg?.first ?? null
      } else {
        t.stage = t.start_on <= addDays(today, 7) ? 'selected' : 'new'
        t.progress = 0
        t.actual_start_on = null
      }
      // tags: meetings, documentation, support work; features by default
      const ti = t.title.toLowerCase()
      t.tag =
        t.tag ??
        (/workshop|training|presentation|review deck/.test(ti) ? 'meeting'
          : /document|notes|checklist|case study|evidence/.test(ti) ? 'documentation'
            : /ams|hypercare|backups|laptop|registration|tooling/.test(ti) ? 'support'
              : /fix|performance/.test(ti) ? 'improvement'
                : 'feature')
      if (t.complexity === 'very_high') continue
    }

    if (T === 'tn_seereon') {
      const by = (title: string) => tasks.find((t) => t.title === title)
      // one very-high-complexity task feeds estimation accuracy
      const eng = by('Payroll engine: earnings, deductions, arrears')
      if (eng) eng.complexity = 'very_high'
      // bugs found in UAT
      for (const title of ['Fee receipt printing & Razorpay go-live', 'Payroll UI and payslip PDF']) {
        const t = by(title)
        if (t) t.tag = 'bug'
      }
      const payUi = by('Payroll UI and payslip PDF')
      if (payUi && payUi.status === 'in_progress') {
        payUi.stage = 'uat'
        payUi.progress = 90
      }
      // waiting for client feedback, with the note the PM sees on the risk list
      const train = by('Teacher training sessions')
      if (train && train.status !== 'done') {
        Object.assign(train, { stage: 'waiting_feedback', status: 'blocked', progress: 40, blocked_reason: 'Needs the final training slots for campus 2 from the school principal before we can close.' })
        stageLog(train, 'In development → Waiting for feedback (40%): Needs the final training slots for campus 2 from the school principal.', 4, 'u_subhankar')
      }
      // on hold with the project
      const route = by('Approval routing engine')
      if (route) {
        Object.assign(route, { stage: 'on_hold', status: 'blocked', progress: 35, blocked_reason: route.blocked_reason ?? 'Client server provisioning pending' })
        stageLog(route, 'In development → On hold (35%): Client server provisioning pending.', 6, 'u_subhankar')
      }
      const block = by('Payroll approval workflow')
      if (block) stageLog(block, 'Selected for development → Blocked (0%): Waiting on payroll engine run API', 5, 'u_jayashree')
      // early slip warnings (count toward the weekly scorecard)
      if (block) Object.assign(block, { slip_flagged_on: addDays(today, -3), slip_note: 'Run API stub only lands Thursday; approval rules need the arrears scenarios. Flagged early and moved the target by a week.' })
      const app = by('Parent app release (Play Store)')
      if (app && app.status !== 'done') Object.assign(app, { slip_flagged_on: addDays(today, -1), slip_note: 'Play Store review rejected the first build for a missing privacy-policy link; resubmitted, approval usually takes 2–3 days.' })
      // a task that should have started but hasn't
      const roster = by('Shift roster and punch integration')
      if (roster && roster.stage === 'new') roster.stage = 'selected'
      // Estimation accuracy (Feature Guide §15, screenshot 028): two of Hritesh's closed high-complexity tasks ran
      // ~25% over their estimates, so Insights suggests "Add N% to estimates" for him and for High complexity.
      // The estimate is set from the hours actually logged, so effort ratio, timesheet and costing stay consistent.
      const logged = new Map<string, number>()
      for (const e of db.timesheet_entries) if (e.tenant_id === T && e.task_id) logged.set(e.task_id, (logged.get(e.task_id) ?? 0) + e.hours)
      for (const [title, ratio] of [['Storage, versioning and search', 1.25], ['Admissions pipeline (LeadSync core)', 1.28]] as [string, number][]) {
        const t = by(title)
        const a = t ? logged.get(t.id) ?? 0 : 0
        if (t && t.status === 'done' && a > 0) t.est_hours = Math.max(1, Math.round(a / ratio))
      }

      /* change requests: CR numbers per project, client requester, impact, proposed tasks */
      const crs = db.change_requests.filter((c) => c.tenant_id === T)
      const mgsCr = crs.find((c) => c.project_id === 'p_mgs' && c.title === 'Transport fee module')
      if (mgsCr) {
        Object.assign(mgsCr, {
          id: 'cr_mgs_1', number: 1, requested_by_client: 'School CFO', requested_on: addDays(today, -32), impact_days: 3, note: 'Requested after the setup demo; parents asked for one bill with transport.',
          proposed_tasks: [{ title: 'Transport routes and fee master', est_hours: 16, owner_id: 'u_pragyasmita' }, { title: 'Monthly transport billing run', est_hours: 8, owner_id: 'u_jayashree' }],
          tasks_added_on: at(addDays(today, -14), 7),
        })
      }
      if (!crs.some((c) => c.project_id === 'p_mgs' && c.title === 'WhatsApp fee reminders'))
        db.change_requests.push({
          ...h.base(T), id: 'cr_mgs_2', project_id: 'p_mgs', title: 'WhatsApp fee reminders', description: 'Automatic WhatsApp reminders 7 and 2 days before each fee due date, with a delivery report.', hours: 16, value_paise: 4500000,
          status: 'estimated', raised_by: 'u_subhankar', milestone_id: null, decided_by: null, decided_at: null, number: 2, requested_by_client: 'Principal, main campus', requested_on: addDays(today, -7), impact_days: 2,
          note: 'Reduce fee defaults before the second-term fee cycle.', proposed_tasks: [{ title: 'WhatsApp reminder templates and schedule', est_hours: 10, owner_id: 'u_hritesh' }, { title: 'Reminder delivery report', est_hours: 6, owner_id: 'u_jayashree' }], tasks_added_on: null,
        } as E.ChangeRequest)
      const hrCr = crs.find((c) => c.project_id === 'p_hrms')
      if (hrCr) Object.assign(hrCr, { number: 1, requested_by_client: 'HR head, Mahanadi Minerals', requested_on: addDays(today, -10), impact_days: 5, note: 'Statutory inspection at the Joda mine flagged contract-worker wage registers.', proposed_tasks: [{ title: 'Form XIII contract labour register', est_hours: 24, owner_id: 'u_jagannath' }, { title: 'Wage register PDF and export', est_hours: 16, owner_id: 'u_hritesh' }], tasks_added_on: null })
      const crmCr = crs.find((c) => c.project_id === 'p_crm')
      if (crmCr) Object.assign(crmCr, { number: 1, hours: 0, requested_by_client: 'Mr Deepak (CEO)', requested_on: addDays(today, -4), impact_days: 0, note: 'Field sales team in Cuttack prefers Hindi screens.', proposed_tasks: [], tasks_added_on: null })
    }
    for (const c of db.change_requests.filter((x) => x.tenant_id === T)) {
      if (c.number === undefined) c.number = db.change_requests.filter((x) => x.tenant_id === T && x.project_id === c.project_id && x.number !== undefined).length + 1
      c.requested_on = c.requested_on ?? c.created_at.slice(0, 10)
      c.impact_days = c.impact_days ?? 0
      c.note = c.note ?? ''
      c.proposed_tasks = c.proposed_tasks ?? []
      c.tasks_added_on = c.tasks_added_on ?? null
    }
    void k
  }
  seedV7Fields(db)
  backfillWbsCodes(db)
}

/** v7 professional fields on every seeded task: a sensible reviewer (PM for project work, assigner / manager for
 *  general work) and concerned manager (owner's reporting manager), billable flag, labels; a few watchers and
 *  acceptance criteria on Seereon's live work, and one recurring weekly task. */
export function seedV7Fields(db: DB) {
  for (const tenant of db.tenants) {
    const T = tenant.id
    const users = db.users.filter((u) => u.tenant_id === T)
    const projects = new Map(db.projects.filter((p) => p.tenant_id === T).map((p) => [p.id, p]))
    const gen = `p_general_${tenant.slug}`
    const top = (id: string | null | undefined) => {
      const u = users.find((x) => x.id === id)
      return !!u && !u.reports_to_id
    }
    const mgr = (id: string | null | undefined) => users.find((u) => u.id === id)?.reports_to_id ?? null
    for (const t of db.tasks.filter((x) => x.tenant_id === T)) {
      const p = projects.get(t.project_id)
      const general = t.project_id === gen || t.kind === 'general'
      if (!t.reviewer_id) {
        let r = general ? t.assigned_by ?? mgr(t.owner_id) : p?.pm_id ?? mgr(t.owner_id)
        if (r && r === t.owner_id && !top(r)) r = mgr(t.owner_id)
        t.reviewer_id = r ?? null
      }
      if (t.concerned_manager_id === undefined) {
        const m = mgr(t.owner_id)
        t.concerned_manager_id = m && m !== t.owner_id ? m : null
      }
      if (t.billable === undefined) t.billable = !general && !!p
      if (!t.labels) {
        const ti = t.title.toLowerCase()
        t.labels = [
          ...(/api|integration|razorpay|punch|sync/.test(ti) ? ['integration'] : []),
          ...(/report|pdf|register|dashboard/.test(ti) ? ['reporting'] : []),
          ...(/ui|screen|app|portal/.test(ti) ? ['frontend'] : []),
          ...(/payroll|fee|invoice|billing/.test(ti) ? ['finance'] : []),
          ...(t.tag === 'bug' ? ['customer-reported'] : []),
        ].slice(0, 3)
      }
      t.watcher_ids = t.watcher_ids ?? []
      t.acceptance_criteria = t.acceptance_criteria ?? []
      t.recurrence = t.recurrence ?? 'none'
      t.attachments = t.attachments ?? []
    }
    if (T !== 'tn_seereon') continue
    const by = (title: string) => db.tasks.find((t) => t.tenant_id === T && t.title === title)
    const crit: [string, string[], string[]][] = [
      ['Payroll engine: earnings, deductions, arrears', ['Earnings and deductions match the client’s March payroll to the rupee', 'Arrears for a back-dated revision are computed and shown separately', 'Unit tests cover PF, ESI and PT slabs'], ['u_santosh']],
      ['Payroll UI and payslip PDF', ['Payslip PDF matches the approved template', 'Employee can download the last 12 payslips', 'Works on a 360 px phone screen'], ['u_priya']],
      ['Fee receipt printing & Razorpay go-live', ['Receipt number series continues from the legacy system', 'Razorpay live keys configured and a ₹1 test payment reconciled', 'Failed-payment retry shown to the parent'], ['u_santosh', 'u_baishali']],
      ['Payroll approval workflow', ['Two-level approval: HR then finance', 'Rejected runs return to draft with the reason'], ['u_priya']],
      ['Parent app release (Play Store)', ['Privacy policy link on the store listing', 'Release notes in English and Odia', 'Crash-free sessions above 99% in the closed track'], ['u_baishali']],
      ['Teacher training sessions', ['Attendance sheet signed for each campus', 'Recorded session shared with the principal'], []],
    ]
    for (const [title, items, watchers] of crit) {
      const t = by(title)
      if (!t) continue
      const done = t.status === 'done'
      t.acceptance_criteria = items.map((text, i) => ({ text, done: done || (t.progress ?? 0) >= 60 ? i < items.length - (done ? 0 : 1) : false }))
      t.watcher_ids = [...new Set([...(t.watcher_ids ?? []), ...watchers.filter((w) => users.some((u) => u.id === w) && w !== t.owner_id)])]
    }
    // the CEO follows the big fixed-price work; Debasish watches the infra items
    for (const t of db.tasks.filter((x) => x.tenant_id === T && x.status !== 'done' && x.priority === 'urgent')) t.watcher_ids = [...new Set([...(t.watcher_ids ?? []), 'u_santosh'].filter((w) => w !== t.owner_id))]
    for (const t of db.tasks.filter((x) => x.tenant_id === T && /backup|laptop|server|github/i.test(x.title))) t.watcher_ids = [...new Set([...(t.watcher_ids ?? []), 'u_debasish'].filter((w) => w !== t.owner_id))]
    // one recurring weekly general task (approving it creates next week's)
    const weekly = by('BNI chapter presentation slides') // the chapter meets every week
    if (weekly) {
      weekly.recurrence = 'weekly'
      weekly.billable = false
    }
  }
}

/** Feature Guide §4: "Numbers never change and are never reused". Every seeded task carries its permanent WBS code
 *  (milestone no + task no at creation); moving a task or deleting its milestone keeps it. Later seeds that add tasks
 *  without one fall back to the same computation at read time. */
export function backfillWbsCodes(db: DB) {
  const ms = new Map(db.milestones.map((m) => [m.id, m]))
  for (const t of db.tasks as (E.Task & { wbs_code?: string | null })[]) {
    if (t.wbs_code) continue
    const m = t.milestone_id ? ms.get(t.milestone_id) : null
    t.wbs_code = `${m && !m.deleted_at ? m.no : 0}.${t.no}`
  }
}
