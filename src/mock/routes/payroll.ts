import { dealValue } from '@/domain/sales'
// Module C — payroll (UI-22). BR-12..BR-16, VAL-F21 (one run per month, final is frozen).
import type * as E from '@/types/entities'
import type { PayrollLineView, PayrollListItem, PayrollRunView } from '@/api/work'
import { err, find, getDb, has, insert, logActivity, nowISO, persist, requireAction, rows, update, userName, warn, type Ctx, type Router } from '../server'
import { assertBaseVersion, eligibleCheckers, needsChecker, pendingBrief, propose, registerApplier, type PendingBrief } from '../makerChecker'
import { cal } from '../analytics'
import { applyLock, resolveApprover } from './timesheets'
import { addDays, fmtDate, isWorkingDay, monthOf, monthRange, parseISO, weekStart, workingDaysInMonth } from '@/domain/calendar'
import { rateOn, salesCompensation } from '@/domain/costing'
import { fmtMoney } from '@/domain/money'
import { generatePayslips } from './docsV7'

type StoredLine = E.PayrollLine & Omit<PayrollLineView, keyof E.PayrollLine | 'user'>

const monthName = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

/** A leaver's last working day: the offboarding checklist's last day, else the day they were deactivated. */
function lastDayOf(ctx: Ctx, u: E.User): string | null {
  if (u.status !== 'deactivated') return null
  const exit = rows(ctx, 'lifecycle_checklists').find((c) => c.kind === 'offboarding' && c.user_id === u.id && c.last_day)
  return exit?.last_day ?? u.updated_at.slice(0, 10)
}

function computeLines(ctx: Ctx, month: string) {
  const s = ctx.tenant.settings
  const c = cal(ctx)
  const { from, to } = monthRange(month)
  const wdMonth = workingDaysInMonth(month, c)
  const deductOn = s['pay.deduct_unapproved_days']
  const threshold = s['pay.variable_threshold_pct']
  const rates = rows(ctx, 'cost_rates')
  const weeks = rows(ctx, 'timesheet_weeks')
  const leave = rows(ctx, 'leave')
  const deals = rows(ctx, 'deals')
  const warnings: string[] = []
  const noRate: string[] = []
  const pendingPeople: string[] = []
  const lines: Omit<StoredLine, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version' | 'run_id'>[] = []
  // Deactivated people are on a month's payroll only if they were still employed in it (prorated to their last day).
  const users = rows(ctx, 'users').filter((u) => u.status !== 'invited' && u.joined_on <= to && !(u.status === 'deactivated' && (lastDayOf(ctx, u) ?? '') < from))
  for (const u of users.sort((a, b) => a.name.localeCompare(b.name))) {
    const rate = rateOn(rates, u.id, to)
    const start = u.joined_on > from ? u.joined_on : from
    // leavers are paid up to their last day (deactivation)
    const lastDay = lastDayOf(ctx, u) ?? to
    const end = lastDay < to ? lastDay : to
    let working = 0
    let approved = 0
    let unapproved = 0 // not approved: the week is over and locked, rejected, still a draft or missing
    let pending = 0 // the week isn't over yet, or it is submitted and waiting for the manager
    let lwp = 0
    const perWeek = new Map<string, { days: number; status: E.WeekStatus | 'missing' }>()
    const lv = new Map(leave.filter((l) => l.user_id === u.id && l.date >= from && l.date <= to).map((l) => [l.date, l]))
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!isWorkingDay(d, { ...c, leaveDates: undefined })) continue
      working++
      const l = lv.get(d)
      const isLwp = l?.type === 'lwp'
      if (isLwp) lwp += l!.portion === 'full' ? 1 : 0.5
      const wk = weekStart(d)
      const w = weeks.find((x) => x.user_id === u.id && x.week_start === wk)
      const st = w ? applyLock(ctx, w).status : 'missing'
      if (st === 'approved') approved++
      else {
        // An LWP full day is deducted once as LWP, not again as unapproved.
        const portion = isLwp ? (l!.portion === 'full' ? 0 : 0.5) : 1
        const weekOver = addDays(wk, 6) < ctx.today
        if (portion > 0 && (!weekOver || st === 'submitted')) {
          pending += portion
          const cur = perWeek.get(wk) ?? { days: 0, status: st }
          cur.days += portion
          perWeek.set(wk, cur)
        } else if (portion > 0) {
          unapproved += portion
          const cur = perWeek.get(wk) ?? { days: 0, status: st }
          cur.days += portion
          perWeek.set(wk, cur)
        }
      }
    }
    const ap = resolveApprover(ctx, u)
    const weekStates = [...perWeek.entries()].map(([wk, v]) => ({ wk, ...v }))
    const notSubmitted = weekStates.filter((x) => (x.status === 'missing' || x.status === 'locked' || x.status === 'open' || x.status === 'rejected') && addDays(x.wk, 6) < ctx.today).length
    const waiting = weekStates.filter((x) => x.status === 'submitted').length
    const notOver = weekStates.filter((x) => x.status !== 'submitted' && addDays(x.wk, 6) >= ctx.today).length
    const flags = [
      ...(notSubmitted ? [`${notSubmitted} week${notSubmitted > 1 ? 's' : ''} not submitted`] : []),
      ...(waiting ? [`${waiting} week${waiting > 1 ? 's' : ''} waiting for ${ap ? userName(ctx, ap) : 'approval'}`] : []),
      ...(notOver ? [`${notOver} week${notOver > 1 ? 's' : ''} not over yet`] : []),
      // Feature Guide §10: pending days are deducted at calculation time; chase the approval first, then recalculate.
      ...(pending > 0 && deductOn ? [`${pending % 1 ? pending.toFixed(1) : pending} pending day${pending === 1 ? '' : 's'} deducted — chase first`] : []),
    ]
    const extra = { pending_days: pending, approver_name: ap ? userName(ctx, ap) : null, self_approves: !ap, employee_code: u.employee_code ?? null, flags }
    if (!rate) {
      noRate.push(u.name)
      lines.push({
        user_id: u.id, monthly_ctc_paise: 0, base_paise: 0, working_days: working, approved_days: approved, unapproved_days: unapproved, unapproved_weeks: [...perWeek.keys()].sort(),
        lwp_days: lwp, deduction_paise: 0, variable_paise: 0, net_paise: 0,
        unapproved_detail: [...perWeek.entries()].sort().map(([week_start, v]) => ({ week_start, ...v })), would_deduct_paise: 0, deduct_applied: deductOn, sales: null, no_rate: true, ...extra,
      })
      continue
    }
    const ctc = rate.monthly_ctc_paise
    const isSales = rate.variable_pct > 0
    const achieved = deals.filter((d) => d.owner_id === u.id && d.stage === 'won' && d.won_on && monthOf(d.won_on) === month).reduce((sum, d) => sum + dealValue(d), 0)
    const target = s['pay.target_default'] === 'ctc' ? ctc : rate.sales_target_paise ?? ctc
    const comp = isSales ? salesCompensation(ctc, rate.variable_pct, target, achieved, threshold) : null
    const base = comp ? comp.base : ctc
    // Prorate joiners: base for the days they were employed in the month
    const fullWd = wdMonth || 1
    const perDay = base / fullWd
    const proratedBase = working < fullWd ? Math.round(perDay * working) : base
    const lwpDed = Math.round(perDay * lwp)
    // Deduction = base ÷ working days × (unapproved days + LWP days); unapproved = not approved + still pending.
    const unapprovedDed = Math.round(perDay * (unapproved + pending))
    const deduction = lwpDed + (deductOn ? unapprovedDed : 0)
    const variable = comp ? comp.variableEarned : 0
    if (unapproved > 0 || pending > 0) pendingPeople.push(u.name)
    lines.push({
      user_id: u.id, monthly_ctc_paise: ctc, base_paise: proratedBase, working_days: working, approved_days: approved, unapproved_days: unapproved,
      unapproved_weeks: [...perWeek.keys()].sort(), lwp_days: lwp, deduction_paise: Math.min(proratedBase, deduction), variable_paise: variable,
      net_paise: Math.max(0, proratedBase - Math.min(proratedBase, deduction) + variable),
      unapproved_detail: [...perWeek.entries()].sort().map(([week_start, v]) => ({ week_start, ...v })),
      would_deduct_paise: unapprovedDed, deduct_applied: deductOn,
      sales: comp ? { target_paise: comp.target, achieved_paise: achieved, achievement: comp.achievement, variable_at_stake_paise: comp.variable, threshold_pct: threshold } : null,
      no_rate: false,
      ...extra,
    })
  }
  if (noRate.length) warnings.push(`No cost rate for ${noRate.join(', ')}. Add one in Settings → Cost rates; they are paid ₹0 in this run.`)
  if (pendingPeople.length)
    warnings.push(`${pendingPeople.length} ${pendingPeople.length === 1 ? 'person has' : 'people have'} unsubmitted or unapproved weeks (${pendingPeople.join(', ')}). Chase the approvals before you pay. ${deductOn ? 'Their pending and not-approved days are deducted in this calculation — recalculate after the weeks are approved.' : 'Deduction is switched off, so they are shown as “would deduct” only.'}`)
  if (to >= ctx.today) warnings.push(`${monthName(month)} isn’t over yet. Days after today count as unapproved until their weeks are approved.`)
  return { lines, warnings }
}

function writeLines(ctx: Ctx, run: E.PayrollRun) {
  const { lines, warnings } = computeLines(ctx, run.month)
  const db = getDb()
  db.payroll_lines = db.payroll_lines.filter((l) => !(l.tenant_id === ctx.tenant.id && l.run_id === run.id))
  for (const l of lines) insert(ctx, 'payroll_lines', { run_id: run.id, ...l } as never)
  run.warnings = warnings
  persist()
}

/** v4 extras on the run view (maker-checked finalisation); not part of the shared PayrollRunView type. */
export interface PayrollFinaliseState {
  pending_finalise: PendingBrief | null
  /** Finalising needs a second person (maker-checker on for payroll finalisation). */
  finalise_needs_checker: boolean
  /** The viewer may finalise directly (holds “Finalise payroll”) or request it (maker-checker on). */
  can_finalise: boolean
  finalise_checkers: string[]
}
function finaliseState(ctx: Ctx, run: E.PayrollRun): PayrollFinaliseState {
  const mc = needsChecker(ctx, 'payroll_finalise')
  return {
    pending_finalise: pendingBrief(ctx, 'payroll_finalise', run.id),
    finalise_needs_checker: mc,
    can_finalise: run.status === 'draft' && (mc ? has(ctx, 'payroll.run') : has(ctx, 'payroll.finalise')),
    finalise_checkers: mc ? eligibleCheckers(ctx, 'payroll.finalise', ctx.user.id).map((u) => u.name) : [],
  }
}
function runView(ctx: Ctx, run: E.PayrollRun): PayrollRunView {
  // Seeded final runs have no lines yet: generate them once (then they stay frozen).
  let lines = rows(ctx, 'payroll_lines').filter((l) => l.run_id === run.id) as StoredLine[]
  if (!lines.length) {
    writeLines(ctx, run)
    if (run.status === 'final') run.warnings = []
    lines = rows(ctx, 'payroll_lines').filter((l) => l.run_id === run.id) as StoredLine[]
  }
  const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  const out: PayrollLineView[] = lines.map((l) => {
    const u = users.get(l.user_id)
    return {
      ...l,
      unapproved_detail: l.unapproved_detail ?? l.unapproved_weeks.map((w) => ({ week_start: w, days: 0, status: 'missing' as const })),
      would_deduct_paise: l.would_deduct_paise ?? 0,
      deduct_applied: l.deduct_applied ?? ctx.tenant.settings['pay.deduct_unapproved_days'],
      sales: l.sales ?? null,
      no_rate: l.no_rate ?? false,
      user: { id: l.user_id, name: u?.name ?? '—', title: u?.title ?? '', role: u?.role ?? 'employee', avatar_hue: u?.avatar_hue ?? 150 },
    }
  })
  const sum = (f: (l: PayrollLineView) => number) => out.reduce((s, l) => s + f(l), 0)
  return {
    run,
    lines: out,
    totals: {
      ctc: sum((l) => l.monthly_ctc_paise), base: sum((l) => l.base_paise), deduction: sum((l) => l.deduction_paise), would_deduct: sum((l) => l.would_deduct_paise),
      variable: sum((l) => l.variable_paise), net: sum((l) => l.net_paise), unapproved_days: sum((l) => l.unapproved_days), lwp_days: sum((l) => l.lwp_days), pending_days: sum((l) => l.pending_days ?? 0),
    },
    deduct_enabled: ctx.tenant.settings['pay.deduct_unapproved_days'],
    working_days: workingDaysInMonth(run.month, cal(ctx)),
    ...finaliseState(ctx, run),
  } as PayrollRunView
}
/** v7 documents: a run's lines as shown on the payroll page (payslips are issued from these). */
export function payrollRunLines(ctx: Ctx, runId: string): { run: E.PayrollRun; lines: PayrollLineView[]; working_days: number } {
  const run = find(ctx, 'payroll_runs', runId, 'Payroll run')
  const v = runView(ctx, run)
  return { run, lines: v.lines, working_days: v.working_days }
}
const blockIfPending = (ctx: Ctx, run: E.PayrollRun) => {
  const p = pendingBrief(ctx, 'payroll_finalise', run.id)
  if (p) err(409, 'CHANGE_PENDING', `Finalisation of ${monthName(run.month)} is waiting for ${p.checker_names.join(' or ') || 'a checker'}. Withdraw it in Change approvals to recalculate.`)
}

export function register(r: Router) {
  r.get('/payroll', ({ ctx }) => {
    requireAction(ctx, 'payroll.run', 'Payroll is for the admin only.')
    const lines = rows(ctx, 'payroll_lines')
    return rows(ctx, 'payroll_runs')
      .sort((a, b) => b.month.localeCompare(a.month))
      .map<PayrollListItem>((run) => {
        const ls = lines.filter((l) => l.run_id === run.id)
        return { ...run, people: ls.length, net_paise: ls.reduce((s, l) => s + l.net_paise, 0), ...({ finalise_pending: !!pendingBrief(ctx, 'payroll_finalise', run.id) } as object) }
      })
  })

  r.post('/payroll/run', ({ ctx, body }) => {
    requireAction(ctx, 'payroll.run', 'Payroll is for the admin only.')
    const month = String(body.month ?? '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) err(422, 'VALIDATION', 'Pick a month.', 'month')
    if (month > monthOf(ctx.today)) err(422, 'VALIDATION', 'You can’t run payroll for a future month.', 'month')
    const existing = rows(ctx, 'payroll_runs').find((x) => x.month === month)
    if (existing?.status === 'final') err(409, 'PAY_FINAL', `Payroll for ${monthName(month)} is final and can’t be run again.`, 'month')
    if (existing) {
      blockIfPending(ctx, existing)
      writeLines(ctx, existing)
      update(ctx, 'payroll_runs', existing.id, { warnings: existing.warnings })
      warn(ctx, 'PAY_EXISTS', `A draft for ${monthName(month)} already existed, so it was recalculated.`)
      logActivity(ctx, 'payroll_run', existing.id, 'recomputed', `Recalculated payroll for ${monthName(month)}`)
      return runView(ctx, existing)
    }
    const run = insert(ctx, 'payroll_runs', { month, status: 'draft', finalised_by: null, finalised_at: null, warnings: [] } as never) as E.PayrollRun
    writeLines(ctx, run)
    logActivity(ctx, 'payroll_run', run.id, 'created', `Ran payroll for ${monthName(month)}`)
    return runView(ctx, run)
  })

  r.get('/payroll/:id', ({ ctx, params }) => {
    requireAction(ctx, 'payroll.run', 'Payroll is for the admin only.')
    return runView(ctx, find(ctx, 'payroll_runs', params.id, 'Payroll run'))
  })

  r.post('/payroll/:id/recompute', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'payroll.run', 'Payroll is for the admin only.')
    const run = find(ctx, 'payroll_runs', params.id, 'Payroll run')
    if (run.status === 'final') err(409, 'PAY_FINAL', 'This payroll run is final. Its lines are frozen.')
    if (ifMatch !== undefined && ifMatch !== run.version) err(409, 'STALE', 'This run changed in another tab. Reload to see the latest version.')
    blockIfPending(ctx, run)
    writeLines(ctx, run)
    update(ctx, 'payroll_runs', run.id, { warnings: run.warnings })
    logActivity(ctx, 'payroll_run', run.id, 'recomputed', `Recalculated payroll for ${monthName(run.month)}`)
    return runView(ctx, run)
  })

  // Finalise (lock) a run. With maker-checker on for payroll finalisation, whoever prepares payroll
  // requests it and a second person holding “Finalise payroll” approves; otherwise it needs that permission.
  r.post('/payroll/:id/finalise', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'payroll.run', 'Payroll is for the admin only.')
    const run = find(ctx, 'payroll_runs', params.id, 'Payroll run')
    if (run.status === 'final') err(409, 'PAY_FINAL', 'This payroll run is already final.')
    if (ifMatch !== undefined && ifMatch !== run.version) err(409, 'STALE', 'This run changed in another tab. Reload to see the latest version.')
    const mc = needsChecker(ctx, 'payroll_finalise')
    if (!mc) requireAction(ctx, 'payroll.finalise', 'Finalising payroll needs “Finalise payroll”. Ask someone who has it.')
    blockIfPending(ctx, run)
    // Recompute one last time so the frozen lines reflect approvals made since the draft
    writeLines(ctx, run)
    const cur = update(ctx, 'payroll_runs', run.id, { warnings: run.warnings })
    const v = runView(ctx, cur)
    const people = v.lines.length
    return propose<PayrollRunView>(ctx, {
      entity: 'payroll_finalise', entity_id: run.id, action: 'execute', required_permission: 'payroll.finalise', base_version: cur.version,
      summary: `Finalise ${monthName(run.month)} payroll — ${people} people, net ${fmtMoney(v.totals.net)}`,
      before: { Status: 'Draft', People: people, 'Net pay': fmtMoney(v.totals.net), Deductions: fmtMoney(v.totals.deduction), 'Variable pay': fmtMoney(v.totals.variable), Warnings: run.warnings.length },
      after: { Status: 'Final (locked)', People: people, 'Net pay': fmtMoney(v.totals.net), Deductions: fmtMoney(v.totals.deduction), 'Variable pay': fmtMoney(v.totals.variable), Warnings: run.warnings.length },
      payload: { run_id: run.id, net_paise: v.totals.net },
    })
  })
}

/** One Salaries expense row per month, dated the 1st (the payroll date `payrollForMonth` reads). */
function bookPayrollCost(ctx: Ctx, month: string, amount: number) {
  const first = `${month}-01`
  const desc = `Payroll ${monthName(month)} (final)`
  const existing = rows(ctx, 'ledger_entries').filter((e) => e.kind === 'expense' && e.category === 'Salaries' && !e.recurring && e.date.slice(0, 7) === month)
  if (existing.length) {
    update(ctx, 'ledger_entries', existing[0].id, { amount_paise: amount, description: desc, date: first, status: 'paid' })
    for (const e of existing.slice(1)) update(ctx, 'ledger_entries', e.id, { amount_paise: 0, description: `${e.description} (replaced by final payroll)` })
  } else {
    insert(ctx, 'ledger_entries', { kind: 'expense', category: 'Salaries', description: desc, amount_paise: amount, date: first, recurring: false, until_on: null, status: 'paid', project_id: null, milestone_id: null, invoice_id: null, stream: null, locked: false } as never)
  }
}

registerApplier('payroll_finalise', (ctx, cs) => {
  const run = find(ctx, 'payroll_runs', String(cs.payload.run_id), 'Payroll run')
  if (run.status === 'final') err(409, 'PAY_FINAL', 'This payroll run is already final.')
  assertBaseVersion(cs, run.version)
  // A checked finalisation freezes exactly the lines the maker submitted (no silent recompute).
  const out = update(ctx, 'payroll_runs', run.id, { status: 'final', finalised_by: ctx.user.id, finalised_at: nowISO() })
  const v = runView(ctx, out)
  logActivity(ctx, 'payroll_run', run.id, 'finalised', `Finalised payroll for ${monthName(run.month)} — net ${fmtMoney(v.totals.net)}${cs.id !== 'cs_direct' ? ` (prepared by ${userName(ctx, cs.maker_id)}, approved by ${ctx.user.name})` : ''}`)
  // v7 wiring: the finalised payroll is the month's salary cost. Book it as the month's Salaries ledger row
  // (replacing the planned/estimated row) so the P&L, CEO dashboard and runway use what was actually paid.
  bookPayrollCost(ctx, run.month, v.totals.net)
  // v7 documents: one payslip per employee from the Payslip template (idempotent per run + employee).
  try {
    const r = generatePayslips(ctx, run.id)
    if (r.created) warn(ctx, 'PAYSLIPS_ISSUED', `${r.created} payslip${r.created === 1 ? '' : 's'} issued to employees under Documents.`)
  } catch (e) {
    warn(ctx, 'PAYSLIPS_FAILED', `Payroll is final, but payslips were not issued: ${(e as Error).message} Generate them from the payroll page.`)
  }
  void fmtDate
  return { result: v, result_id: run.id }
})
