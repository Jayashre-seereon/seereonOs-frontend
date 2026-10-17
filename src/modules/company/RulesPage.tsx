// /rules — the board's rulebook (Feature Guide §17, screenshot 035): non-negotiable working rules, how the
// weekly score is built, how the schedule forecast works, the consequences of breaking a rule, and every KPI
// definition. Numbers ("9 hours", "2 working days", "20% variable") come from this company's live settings
// and the scorecard's own weights, so the page never drifts from what the board computes.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTenant } from '@/api/core'
import { useScoreRules } from '@/api/dashboards'
import { useSession } from '@/stores/session'
import { Card, EmptyState, PageHeader, SearchInput, Skeleton } from '@/ui'
import { cn } from '@/lib/utils'
import type { TenantSettings } from '@/types/entities'

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th']
const list = (a: string[]) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

interface Item { id: string; title: string; body: ReactNode; text: string }
interface Section { id: string; title: string; intro?: string; kind: 'list' | 'table' | 'score'; items: Item[] }

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
const it = (title: string, body: string, id?: string): Item => ({ id: id ?? slug(title), title, body, text: `${title} ${body}` })

function buildSections(st: TenantSettings, score: ReturnType<typeof useScoreRules>['data']): Section[] {
  const minH = st['calendar.min_hours_per_day']
  const sla = st['approval.sla_working_days']
  const unlock = st['timesheet.unlock_max_days']
  const variable = st['pay.variable_default_pct']
  const thr = st['pay.variable_threshold_pct']
  const alert = st['projects.effort_ratio_alert']
  const floor = st['projects.margin_floor_pct']
  const stale = st['sales.stale_deal_days']
  const prod = st['team.default_productive_hours'] ?? 6
  const emptyMs = st['projects.empty_milestone_days']
  const offs = (st['calendar.weekly_off'] ?? [0]).map((d) => DAY[d])
  const sat = st['calendar.saturday_rule'] === 'all_off' ? 'every Saturday is off' : st['calendar.saturday_rule'] === 'all_on' ? 'every Saturday is a working day' : `the ${list((st['calendar.saturday_off_weeks'] ?? []).map((n) => ORD[n] ?? `${n}th`))} Saturdays are off`
  const breaks = st['calendar.breaks_count'] ? 'Lunch and tea breaks count toward it.' : 'Lunch and tea breaks do not count toward it.'
  const lockOn = st['timesheet.weekly_lock']
  const deduct = st['pay.deduct_unapproved_days']
  const green = score?.thresholds.green ?? 90
  const amber = score?.thresholds.amber ?? 75
  const delivery = Object.entries(score?.weights ?? {}).filter(([, w]) => w.kind === 'delivery' || w.kind === 'all' || w.kind === 'managers')

  const rules: Item[] = [
    it('One owner per task', 'Every task has exactly one accountable owner, and optionally a backup who covers it while the owner is on leave. On leave days the task shows in the backup’s Covering list and they can log time on it.'),
    it('No proof, no progress', `The end-of-day update says what you finished${st['daily.proof_required'] ? ', with a proof link (a commit, a document or a screenshot)' : ''}, and any blocker. Work without proof does not count as progress. Friday demo records whether you showed working software that week.`),
    it('Log time every working day', `Each working day needs at least ${minH} hours on the timesheet, against tasks or activities. ${breaks} Short days are highlighted.`),
    it('Timesheet weekly lock', lockOn ? `Submit the week by its end. An unsubmitted week locks when it ends; only your manager or the CEO can unlock it, for up to ${plural(unlock, 'day')}, after you request it with a reason.` : 'Submit the week by its end. Weekly locking is switched off for this company.'),
    it('Approvals within the deadline', `Every submitted week goes to the person’s manager (their reports-to), who has ${plural(sla, 'working day')} to approve or reject it. Rejecting needs a reason. The top person’s weeks are approved automatically.`),
    it('Nothing enters the plan without an approved change request', 'Anything the client adds after signing is a change request with effort and value. Only an approved change request adds value to the contract and tasks to the WBS; this protects the margin.'),
    it('Dependencies come first', 'A task cannot start while a task it depends on is still open. The board names the blocking task and its owner, so the conversation goes to the right person.'),
    it('Leave goes through the timesheet', 'Record leave with the leave row in Timesheet & log (or HR records it in Team & settings › Leave). A full-day leave marks you as away for planning; half days are allowed. Optional holidays are taken as leave.'),
    it('Milestones and numbers', `Milestones are numbered M1, M2… and tasks inside M2 are 2.1, 2.2…; numbers never change and are never reused. An invoiced milestone cannot be deleted; a milestone with no tasks for ${plural(emptyMs, 'day')} is removed automatically unless it has been invoiced.`),
    it('Allocation needs a milestone and dates', 'Each resource row in Projects & WBS › Costing names a person, the milestone (M1, M2, shown by code), the % of their time and a from and to date, so cost always lands on a milestone and a period.'),
    it('Reasons for status changes', 'Moving a project to On hold, NPA or Closed asks for a reason, and every change is kept in the project’s status history. Moving a deal to Lost asks for a reason too.'),
    it('Estimates are checked', `New estimates are compared with the owner’s history. Anything running above ×${alert.toFixed(1)} effort ratio is flagged; projects below a ${floor}% projected margin are flagged to the CEO.`),
    it('Deals stay alive', `Every deal is traceable from first contact to cash. A deal with no activity for ${plural(stale, 'day')} is flagged as stale.`),
  ]

  const scoreItems: Item[] = delivery.map(([k, w]) => ({ id: `score-${k}`, title: `${w.label} · ${w.weight}%`, body: `${w.rule}${w.kind === 'managers' ? ' Applies to managers.' : ''}`, text: `${w.label} ${w.rule}` }))
  const salesOps = Object.entries(score?.weights ?? {}).filter(([, w]) => w.kind === 'sales' || w.kind === 'ops')
  scoreItems.push(
    { id: 'score-sales', title: 'Sales and operations', body: `Sales people are scored on ${list(salesOps.filter(([, w]) => w.kind === 'sales').map(([, w]) => `${w.label.toLowerCase()} (${w.weight}%)`))}; operations on ${list(salesOps.filter(([, w]) => w.kind === 'ops').map(([, w]) => `${w.label.toLowerCase()} (${w.weight}%)`))}; both also on updates and timesheet.`, text: 'sales operations activities follow-ups leads duties' },
    { id: 'score-bands', title: 'Bands', body: `The score is the weighted average of the components that apply to the person in that week; a component with nothing to measure is left out and the rest re-weighted. ${green}+ is green, ${amber}–${green - 1} amber, below ${amber} red. In the running week only finished days count.`, text: 'green amber red weighted average bands' },
  )

  const forecast: Item[] = [
    it('P50 and P80 dates', 'Each person’s open tasks are re-run in order with their own history: P50 uses their typical (median) effort ratio, P80 a bad-but-realistic one (80th percentile). Fewer than 3 closed tasks falls back to the team’s ratio.', 'forecast-p50-p80'),
    it('Chance on time', 'The plan is re-run six times, from each person’s best 20% to their worst 10% of tasks. Chance on time is the share of those runs that land by the target date.'),
    it('Capacity', `Forecasts assume each person works ${prod} productive hours of task work a day (the team default, set per person in Team & settings › Team), on working days only, skipping their leave.`),
    it('Critical path and float', 'The critical path is the longest chain of dependent tasks to the project end: any delay on it delays the whole project (Projects & WBS › Schedule). A critical task is the task that sets its milestone’s deadline, plus every task before it in a dependency chain with no float. Float is how many working days a task can slip before it moves its milestone; critical tasks have none.'),
    it('At current pace', 'Velocity-based forecast: the hours actually logged on the project in the last 20 working days, projected over the hours left.'),
    it('Forecast to breach', 'An open task whose P50 finish passes its target end, before it is actually late. Breached tasks are open tasks already past their target end.'),
  ]

  const consequences: Item[] = [
    it('Red two weeks running', `A person whose weekly score is below ${amber} two weeks in a row is flagged on the Weekly scorecard: a 1:1 with their manager is due.`),
    it('Approval lapses', `Each week decided after ${plural(sla, 'working day')}, or still waiting past the deadline, counts against the manager’s approval KPI. Approvals made by a delegate count toward the delegate.`),
    it('Locked weeks', `${lockOn ? 'An unsubmitted week locks when it ends. ' : ''}Unsubmitted or unapproved weeks are flagged before payroll${deduct ? ', and unapproved days are deducted from pay: monthly base ÷ working days × (unapproved days + leave-without-pay days)' : '; this company does not deduct unapproved days from pay'}.`),
    it('Sales variable', `Variable pay (${variable}% of CTC by default) is paid only when ${thr}% of the month’s target is met. Below it, only the base is paid.`),
    it('Slips', 'Tasks forecast to breach and tasks already breached (overdue tasks) show on the Dashboard and as flags on the owner’s Weekly scorecard. Flagging a slip before the due date counts toward the early-warning score.'),
    it('Overdue duties', 'An overdue recurring duty reminds its owner every day and lowers the duties-on-time rate on the Dashboard’s Operations view.'),
  ]

  // Guide §17 order first (On-time delivery, Effort ratio, SPI, Margin, Markup, Cost per hour, Win rate, Approval KPI, P50/P80), then the rest.
  const kpi: Item[] = [
    it('On-time delivery', 'Share of tasks finished on or before their due date: completed tasks finished on or before the target end ÷ completed tasks.'),
    it('Effort ratio', `Actual hours ÷ estimated hours; above 1.0 means it took longer than planned. 1.3 means the work took 30% longer; ×0.80 means estimates are padded. Shown per task, milestone and project; above ×${alert.toFixed(1)} is flagged.`),
    it('SPI', 'Schedule performance: work done ÷ work planned by today (earned hours ÷ planned hours to date); below 1.0 means behind, above 1.0 means ahead of plan.'),
    it('Margin', 'Profit ÷ revenue (price), i.e. (price − cost) ÷ price. Decisions use margin.'),
    it('Markup', '(Price − cost) ÷ cost, i.e. profit ÷ cost (a 50% markup is a 33% margin). Cost = cost per hour × paid hours of every resource, plus maintenance; additional costs and contingency are added on top. Positive is profit, negative is loss.'),
    it('Margin vs markup', 'They are not the same number. Margin = profit ÷ price; markup = profit ÷ cost. If a job costs ₹1,00,000 and you charge ₹1,50,000, the markup is 50% but the margin is 33%. The board shows both side by side; decisions use margin.'),
    it('Cost per hour', `Monthly CTC ÷ (working days in the month × minimum hours per day, ${minH}). Example: ₹60,000 ÷ (22 × 9) = ₹303 per hour.`, 'cost-per-hour'),
    it('Win rate', 'Deals won ÷ (won + lost).'),
    it('Approval KPI', `Approvals made on time; late or missed approvals count against the manager. A manager has ${plural(sla, 'working day')} to decide; approvals made by a delegate count toward the delegate.`),
    it('P50 / P80 date', 'The date a task or milestone has an even (P50) or 80% (P80) chance of finishing by: the forecast re-run with each person’s typical (median) and worst-realistic (80th percentile) effort ratio from their closed tasks. Chance on time is the share of six such runs that finish by the target.', 'p50-p80'),
    it('Sales variable', `Paid only in a month where the salesperson’s closed deals reach ${thr}% of their target (default target = their monthly CTC; variable = ${variable}% of CTC).`),
    it('Task statuses', 'New, Selected for development, In development, Unit testing, Functional testing, UAT, Waiting for feedback, On hold, Blocked, Completed. Moving to a testing stage raises progress to at least 60% (unit), 75% (functional) or 90% (UAT).'),
    it('Critical task', 'The task that sets its milestone’s deadline (the latest planned end in the milestone), plus every task before it in a dependency chain with no float. Float is how many working days a task can slip before it moves its milestone.'),
    it('Working days', `Every day except the weekly off (${list(offs)}) and the Saturday rule (${sat}) set in Team & settings › Working hours and calendar, minus company holidays. Optional holidays are taken as leave.`),
    it('Resource allocation', 'Each resource is allocated to a milestone (M1, M2, shown by code) with a % of their time and a required start and end date. The same person can have several rows, one per milestone.'),
    it('Resource cost', `Cost per hour × allocation % × ${minH} minimum hours × working days between the resource’s start and end dates, each month at that month’s cost per hour.`),
    it('Milestone deadline', 'Always the target end date of the milestone’s last task. It moves only when a task’s target date moves.'),
    it('% complete', 'Earned hours ÷ total estimated hours. Earned = estimate × progress %.', 'percent-complete'),
    it('CPI', 'Effort performance: estimated ÷ actual hours on completed tasks. Below 1.0 means tasks cost more effort than planned.'),
    it('Schedule variance', 'Working days between planned end and forecast end. Positive means late.'),
    it('Utilisation', `Forecast hours due in the next 10 working days ÷ capacity (productive hours a day × working days, minus leave). Over 100% means double-booked.`),
    it('Timesheet', 'Hours logged this week ÷ available hours (capacity minus holidays and leave). Leave rows count toward the target; a full-day leave row marks the day as leave.'),
    it('Scope growth', 'Approved change-request hours ÷ baseline effort.'),
    it('Baseline variance', 'Working days between a milestone’s baseline deadline and its current deadline.'),
    it('Planned margin', '(Contract value − planned cost from allocation and estimates, incl. contingency) ÷ contract value. Answers: what did we expect to make?'),
    it('Projected margin', '(Contract value − (actual cost so far + cost of what is left)) ÷ contract value. A resource allocated up to a milestone’s deadline stays on until the milestone’s forecast or actual end: a late milestone adds cost, an early one saves it. Answers: where are we heading?'),
    it('Actual margin', '(Invoiced amount − cost of approved hours only) ÷ invoiced amount. Answers: what have we really made?'),
    it('Gross margin', '(Contract value − forecast cost at completion) ÷ contract value. Margin is on revenue; markup is on cost.'),
    it('Performance trend', 'Weekly average of on-time delivery and timesheet discipline over 12 weeks; direction compares the latest six weeks with the six before.'),
    it('Net margin', '(Revenue billed − payroll − other costs) ÷ revenue billed, for the period. Only what is dated up to today counts; payroll for a month is the booked salaries, else the monthly CTC of everyone employed that month.'),
    it('DSO', 'Days sales outstanding: receivables ÷ average daily billing over the last 90 days.'),
    it('Runway', 'Cash balance ÷ (monthly burn − recurring monthly income).'),
    it('Weighted pipeline', 'Each open deal’s value × its stage’s chance of closing, summed.'),
    it('Weekly score', `Weighted average of the score components that apply to the person (see “How the weekly score is built”). ${green}+ green, ${amber}–${green - 1} amber, below ${amber} red.`),
    it('Effort accuracy', 'How close actual hours came to the estimate on tasks closed in the week: 100 − |1 − effort ratio| × 100 (×1.00 scores 100; ×1.25 or ×0.75 scores 75).'),
    it('Average lateness', 'Average working days late across completed tasks that finished after their target end. Open tasks already past their target end are counted as overdue tasks.'),
    it('Overdue tasks', 'Open tasks already past their target end date (breached).'),
    it('Duties on time', 'Recurring duties marked done on or before their due date ÷ duties due in the last 90 days (overdue ones count as missed).'),
  ].map((x) => ({ ...x, id: `kpi-${x.id}` }))

  return [
    { id: 'rules', title: 'Working rules', intro: 'The non-negotiable rules everyone works by.', kind: 'list', items: rules },
    { id: 'score', title: 'How the weekly score is built', intro: 'Each person gets one score a week from the components below, with these weights.', kind: 'score', items: scoreItems },
    { id: 'forecast', title: 'How the schedule forecast works', intro: 'Insights looks ahead instead of back. This is how forecast dates are made.', kind: 'list', items: forecast },
    { id: 'consequences', title: 'Consequences', intro: 'What happens when a rule is broken.', kind: 'list', items: consequences },
    { id: 'kpis', title: 'KPI definitions', intro: 'Every number on the board, defined. When the board and a spreadsheet disagree, these definitions decide which is right.', kind: 'table', items: kpi },
  ]
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-accent-soft px-0.5 text-ink">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

export default function RulesPage() {
  const tq = useTenant()
  const { tenant } = useSession()
  const score = useScoreRules()
  const [q, setQ] = useState('')
  const settings = (tq.data?.settings ?? tenant?.settings) as TenantSettings | undefined
  const sections = useMemo(() => (settings ? buildSections(settings, score.data) : []), [settings, score.data])
  const needle = q.trim().toLowerCase()
  const shown = sections.map((s) => ({ ...s, items: needle ? s.items.filter((i) => i.text.toLowerCase().includes(needle)) : s.items })).filter((s) => s.items.length)
  const { hash } = useLocation()
  const ready = sections.length > 0
  useEffect(() => {
    if (!ready || !hash) return
    const el = document.getElementById(decodeURIComponent(hash.slice(1)))
    if (!el) return
    const t = window.setTimeout(() => {
      el.scrollIntoView({ block: 'start' })
      el.classList.add('bg-brand-soft/40')
      window.setTimeout(() => el.classList.remove('bg-brand-soft/40'), 1600)
    }, 60)
    return () => window.clearTimeout(t)
  }, [hash, ready])

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Rules" subtitle="The board’s rulebook: the working rules, how the weekly score is built, how the schedule forecast works, the consequences of breaking a rule, and the KPI definitions." />
      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
        <aside className="mb-4 lg:mb-0">
          <div className="space-y-3 lg:sticky lg:top-24">
            <SearchInput value={q} onChange={setQ} placeholder="Search rules and KPIs" />
            <nav aria-label="Sections" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 no-scrollbar lg:mx-0 lg:flex-col lg:gap-0.5 lg:px-0">
              {sections.map((s) => (
                <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border border-line px-3 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink lg:h-auto lg:min-h-8 lg:whitespace-normal lg:border-0 lg:px-2.5 lg:py-1.5">
                  {s.title}
                </a>
              ))}
            </nav>
            <p className="hidden text-[12px] leading-relaxed text-ink-3 lg:block">
              Values come from this company’s settings in <Link to="/settings" className="font-medium text-brand-text hover:underline">Team &amp; settings</Link>.
            </p>
          </div>
        </aside>
        <div className="min-w-0 space-y-5">
          {!settings ? (
            <Card><Skeleton className="h-64 w-full" /></Card>
          ) : !shown.length ? (
            <Card><EmptyState compact title="Nothing matches" body={`No rule or KPI mentions “${q}”. Try another word.`} /></Card>
          ) : (
            shown.map((s) => (
              <section key={s.id} id={s.id} className="scroll-mt-24 rounded-lg border border-line bg-surface">
                <header className="px-4 pb-2 pt-4 md:px-5">
                  <h2 className="text-[15px] font-semibold">{s.title}</h2>
                  {s.intro && <p className="mt-0.5 text-[12.5px] text-ink-3">{s.intro}</p>}
                </header>
                {s.kind === 'table' || s.kind === 'score' ? (
                  <dl className="divide-y divide-line border-t border-line">
                    {s.items.map((i) => (
                      <div key={i.id} id={i.id} className="scroll-mt-24 px-4 py-3 md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-4 md:px-5">
                        <dt className="text-[13.5px] font-semibold text-ink">{highlight(i.title, needle)}</dt>
                        <dd className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2 md:mt-0">{typeof i.body === 'string' ? highlight(i.body, needle) : i.body}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <ol className="divide-y divide-line border-t border-line">
                    {s.items.map((i, n) => (
                      <li key={i.id} id={`${s.id}-${i.id}`} className="flex gap-3 px-4 py-3 md:px-5">
                        <span className={cn('tnum mt-px w-5 shrink-0 text-[12.5px] font-semibold text-ink-3')}>{n + 1}</span>
                        <div className="min-w-0">
                          <div className="text-[13.5px] font-semibold text-ink">{highlight(i.title, needle)}</div>
                          <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">{typeof i.body === 'string' ? highlight(i.body, needle) : i.body}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
