// Costing & margin analysis on the project "Costing & margin" tab (Feature Guide §6, checklist G6.01–G6.11): the three
// margins (planned / projected / actual) with margin and markup side by side, margin vs markup, what moved the margin,
// milestone variance, resources allocated vs logged (hours), effort ratio per project / milestone / task, and cost per
// hour. Formatting only — the server computes every figure.
import type { ReactNode } from 'react'
import type { CostingAnalysis, EffortTaskRow } from '@/api/projects'
import { usePeopleMap } from '@/api/core'
import { fmtDate, parseISO } from '@/domain/calendar'
import { fmtHours, fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Card, CardHeader, EmptyState, PersonName } from '@/ui'
import { TONE_TEXT } from '@/ui/data'
import { marginTone } from '../components/shared'

export const TH = 'whitespace-nowrap py-2.5 px-3 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3'
export const TD = 'px-3 py-2.5'
/** Effort ratio as the guide writes it: 1.0 on estimate, 1.3 = 30% longer. */
export const ratio = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2))
const ratioCls = (v: number | null | undefined, alert: number) => (v === null || v === undefined ? 'text-ink-3' : v > alert ? 'font-semibold text-danger-text' : 'text-ink')
const monthName = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
const Scroll = ({ children }: { children: ReactNode }) => <div className="-mx-4 overflow-x-auto px-4 scroll-thin md:-mx-5 md:px-5">{children}</div>
const Note = ({ children, className }: { children: ReactNode; className?: string }) => <p className={cn('mt-3 text-[12.5px] leading-relaxed text-ink-3', className)}>{children}</p>

/* ---------------- (a) Costing and margin: planned | projected | actual ---------------- */
export function CostingMarginCard({ a }: { a: CostingAnalysis }) {
  const ab = a.actual_basis
  const pb = a.projected_basis
  const cols = [
    { key: 'planned', label: 'Planned', c: a.planned, rev: 'Contract value', cost: 'Allocation and estimates' },
    { key: 'projected', label: 'Projected', c: a.projected, rev: a.approved_crs ? `Contract value incl. CRs ${fmtMoney(a.approved_crs)}` : 'Contract value', cost: pb ? `Actual so far ${fmtMoney(pb.cost_so_far)} + what’s left ${fmtMoney(a.projected.cost - pb.cost_so_far)}` : 'Actual so far + what’s left' },
    { key: 'actual', label: 'Actual', c: a.actual, rev: ab ? `Invoiced amount (${ab.invoices} invoice${ab.invoices === 1 ? '' : 's'})` : 'Invoiced amount', cost: ab ? `Approved hours only (${fmtHours(ab.approved_hours)})` : 'Approved hours only' },
  ]
  const row = (label: ReactNode, f: (c: (typeof cols)[number]) => ReactNode, strong?: boolean) => (
    <tr className="border-b border-line align-top last:border-0">
      <td className={cn(TD, 'whitespace-nowrap', strong && 'font-semibold')}>{label}</td>
      {cols.map((c) => (
        <td key={c.key} className={cn(TD, 'tnum text-right', strong && 'font-semibold')}>{f(c)}</td>
      ))}
    </tr>
  )
  const sub = (t: string) => <span className="mt-0.5 block whitespace-normal text-[12px] font-normal leading-snug text-ink-3">{t}</span>
  return (
    <Card>
      <CardHeader title={<span className="inline-flex flex-wrap items-center gap-2">Costing and margin <Badge size="sm">Margins permission</Badge></span>} subtitle={a.description} />
      <Scroll>
        <table className="w-full min-w-[600px] text-[13.5px]">
          <thead className="bg-surface-2/60">
            <tr>
              <th className={cn(TH, 'w-[110px] text-left')} />
              {cols.map((c) => (
                <th key={c.key} className={cn(TH, 'text-right')}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('Revenue', (c) => (
              <>
                <span className="whitespace-nowrap">{fmtMoney(c.c.revenue)}</span>
                {sub(c.rev)}
              </>
            ))}
            {row('Cost', (c) => (
              <>
                <span className="whitespace-nowrap">{fmtMoney(c.c.cost)}</span>
                {sub(c.cost)}
              </>
            ))}
            {row('Profit', (c) => <span className={cn('whitespace-nowrap', c.c.profit < 0 && 'text-danger-text')}>{fmtMoney(c.c.profit)}</span>, true)}
            {row('Margin', (c) => <span className={cn('whitespace-nowrap font-semibold', c.key === 'planned' ? 'text-ink' : TONE_TEXT[marginTone(c.c.margin, a.floor_pct)])}>{fmtPct(c.c.margin)}</span>)}
            {row(<span>Markup</span>, (c) => <span className="whitespace-nowrap text-ink-2">{fmtPct(c.c.markup)}</span>)}
          </tbody>
        </table>
      </Scroll>
      {ab && (
        <Note>
          Actual = invoiced {fmtMoney(ab.invoiced)} of the {fmtMoney(ab.contract)} contract against {fmtHours(ab.approved_hours)} of approved hours ({fmtMoney(ab.approved_cost)}).
          {ab.pending_hours > 0 && <> {fmtHours(ab.pending_hours)} ({fmtMoney(ab.pending_cost)}) are logged but not approved yet, so they are not in actual.</>}
          {ab.additional_excluded > 0 && <> Planned extras ({fmtMoney(ab.additional_excluded)} additional and support costs) are not in actual, which uses approved hours only.</>}
          {ab.next_billing && <> Billing follows milestones, so actual margin moves with each invoice: {ab.next_billing.code} ({fmtMoney(ab.next_billing.amount)}) is due {fmtDate(ab.next_billing.due)}.</>}
          {' '}Earned value at {fmtPct(a.pct_complete, 0)} complete is {fmtMoney(ab.earned_value)} (for reference).
        </Note>
      )}
      <ThreeMarginsLegend />
    </Card>
  )
}

/** The guide's "Three margins" table, reproduced under the numbers. */
export function ThreeMarginsLegend() {
  const rows = [
    ['Planned', 'Contract value', 'Allocation and estimates', 'What did we expect to make?'],
    ['Projected', 'Contract value', 'Actual so far + what’s left', 'Where are we heading?'],
    ['Actual', 'Invoiced amount', 'Approved hours only', 'What have we really made?'],
  ]
  return (
    <div className="mt-4 rounded-md border border-line">
      <div className="border-b border-line bg-surface-2/60 px-3 py-2 text-[12px] font-semibold text-ink-2">Three margins</div>
      <Scroll>
        <table className="w-full min-w-[520px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line">
              {['Margin', 'Revenue used', 'Cost used', 'Answers'].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[0]} className="border-b border-line last:border-0">
                {r.map((c, i) => (
                  <td key={i} className={cn('px-3 py-1.5', i === 0 ? 'font-medium text-ink' : 'text-ink-2')}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </div>
  )
}

/* ---------------- (b) Margin vs markup ---------------- */
export function MarginVsMarkupCard({ a }: { a: CostingAnalysis }) {
  return (
    <Card>
      <CardHeader title="Margin vs markup" subtitle="They are not the same number." />
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="text-[13.5px] leading-relaxed text-ink-2">
          <p>
            <span className="font-medium text-ink">Margin = profit ÷ price</span>; <span className="font-medium text-ink">markup = profit ÷ cost</span>.
          </p>
          <p className="mt-1.5">If a job costs ₹1,00,000 and you charge ₹1,50,000, the markup is 50% but the margin is 33%.</p>
          <p className="mt-1.5">The board shows both side by side; <span className="font-medium text-ink">decisions use margin</span> (floor {a.floor_pct}%).</p>
        </div>
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line text-[12.5px]">
          {[
            ['', 'Margin', 'Markup'],
            ['Planned', fmtPct(a.planned.margin), fmtPct(a.planned.markup)],
            ['Projected', fmtPct(a.projected.margin), fmtPct(a.projected.markup)],
            ['Actual', fmtPct(a.actual.margin), fmtPct(a.actual.markup)],
          ].map((r, i) =>
            r.map((c, j) => (
              <div key={`${i}-${j}`} className={cn('tnum bg-surface px-3 py-1.5', i === 0 && 'bg-surface-2/60 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3', j > 0 && 'text-right', j === 1 && i > 0 && 'font-semibold text-ink', j === 0 && i > 0 && 'text-ink-2')}>
                {c}
              </div>
            )),
          )}
        </div>
      </div>
    </Card>
  )
}

/* ---------------- (c) What moved the margin ---------------- */
export function WhatMovedCard({ a }: { a: CostingAnalysis }) {
  return (
    <Card>
      <CardHeader title="What moved the margin" subtitle="Explains the gap between planned and projected profit." />
      <ul className="text-[13.5px]">
        {a.bridge.map((b) => {
          const total = b.key === 'planned' || b.key === 'projected'
          return (
            <li key={b.key} className={cn('flex items-baseline justify-between gap-4 py-1.5', b.key === 'projected' && 'mt-1 border-t border-line pt-2.5', total && 'font-semibold')}>
              <span className="min-w-0">{b.label}</span>
              <span className={cn('tnum shrink-0 whitespace-nowrap', !total && b.amount > 0 && 'text-success-text', !total && b.amount < 0 && 'text-danger-text', total && b.amount < 0 && 'text-danger-text')}>
                {total ? fmtMoney(b.amount) : b.amount === 0 ? fmtMoney(0) : fmtMoney(b.amount, { sign: true })}
              </span>
            </li>
          )
        })}
      </ul>
      <Note className="mt-2">
        Projected margin {fmtPct(a.projected.margin)} vs planned {fmtPct(a.planned.margin)}
        {a.projected.margin !== null && a.planned.margin !== null && <> ({(a.projected.margin - a.planned.margin) * 100 >= 0 ? '+' : '−'}{Math.abs((a.projected.margin - a.planned.margin) * 100).toFixed(1)} pts)</>}.
        {a.contingency_held > 0 && <> Contingency of {fmtMoney(a.contingency_held)} is still held as cost. If it isn’t needed, projected profit rises to {fmtMoney(a.profit_if_released)} at close.</>}
      </Note>
    </Card>
  )
}

/* ---------------- (d) Milestone variance ---------------- */
export function MilestoneVarianceCard({ a }: { a: CostingAnalysis }) {
  return (
    <Card>
      <CardHeader title="Milestone variance" subtitle="Each milestone’s planned cost against its forecast (cost so far + what’s left), with the slip in working days." />
      {!a.milestones.length ? (
        <EmptyState compact title="No milestones yet" />
      ) : (
        <Scroll>
          <table className="w-full min-w-[900px] text-[13.5px]">
            <thead className="bg-surface-2/60">
              <tr>
                <th className={cn(TH, 'text-left')}>Milestone</th>
                <th className={cn(TH, 'text-left')}>Deadline</th>
                <th className={cn(TH, 'text-left')}>Forecast or actual</th>
                <th className={cn(TH, 'text-right')}>Slip</th>
                <th className={cn(TH, 'text-right')}>Planned cost</th>
                <th className={cn(TH, 'text-right')}>Projected cost</th>
                <th className={cn(TH, 'text-right')}>Change</th>
              </tr>
            </thead>
            <tbody>
              {a.milestones.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className={cn(TD, 'max-w-[320px]')}>
                    <span className="tnum font-semibold text-ink-3">{m.code}</span> {m.name}
                    {m.done && <Badge size="sm" className="ml-1.5">Done</Badge>}
                    {m.allocated === false && <span className="block text-[11.5px] text-ink-3">No allocation: planned from task estimates</span>}
                  </td>
                  <td className={cn(TD, 'tnum whitespace-nowrap')}>{fmtDate(m.deadline)}</td>
                  <td className={cn(TD, 'tnum whitespace-nowrap')}>
                    {fmtDate(m.end)} <span className="text-[12px] text-ink-3">{m.end_kind === 'deadline' ? 'no forecast yet' : m.end_kind}</span>
                  </td>
                  <td className={cn(TD, 'tnum whitespace-nowrap text-right font-semibold', m.slip_days > 0 ? 'text-danger-text' : m.slip_days < 0 ? 'text-success-text' : 'text-ink-3')}>
                    {m.slip_days > 0 ? `+${m.slip_days}d late` : m.slip_days < 0 ? `${-m.slip_days}d early` : 'on time'}
                  </td>
                  <td className={cn(TD, 'tnum whitespace-nowrap text-right')}>{fmtMoney(m.planned_cost)}</td>
                  <td className={cn(TD, 'tnum whitespace-nowrap text-right')}>
                    {fmtMoney(m.projected_cost)}
                    {m.spent_to_date !== undefined && m.spent_to_date !== null && <span className="block text-[11.5px] text-ink-3">{fmtMoney(m.spent_to_date)} so far</span>}
                  </td>
                  <td className={cn(TD, 'tnum whitespace-nowrap text-right font-semibold', (m.change ?? 0) > 0 ? 'text-danger-text' : (m.change ?? 0) < 0 ? 'text-success-text' : 'text-ink-3')}>
                    {m.change ? fmtMoney(m.change, { sign: true }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      <Note>
        Slip is in working days. A person allocated up to a milestone’s deadline stays on until it actually closes, so a late milestone adds cost and an early one saves it. Forecast = cost of hours logged so far + what’s left (the remaining allocation, or the remaining estimate when that is larger).
      </Note>
    </Card>
  )
}

/* ---------------- (e) Resources: allocated vs logged (hours) ---------------- */
export function ResourcesUseCard({ a }: { a: CostingAnalysis }) {
  const showCost = a.resources.some((r) => r.planned_cost !== null)
  const mh = a.rate?.min_hours ?? 9
  return (
    <Card>
      <CardHeader title="Resources: allocated vs logged" subtitle="Each person’s planned hours against the hours they actually logged on this project." />
      {!a.resources.length ? (
        <EmptyState compact title="No one allocated or logging yet" />
      ) : (
        <Scroll>
          <table className="w-full min-w-[720px] text-[13.5px]">
            <thead className="bg-surface-2/60">
              <tr>
                <th className={cn(TH, 'text-left')}>Resource</th>
                <th className={cn(TH, 'text-right')}>Planned hours</th>
                <th className={cn(TH, 'text-right')}>Planned to date</th>
                <th className={cn(TH, 'text-right')}>Logged hours</th>
                <th className={cn(TH, 'text-right')}>Allocation used</th>
                <th className={cn(TH, 'text-right')}>Man-days</th>
                {showCost && <th className={cn(TH, 'text-right')}>Planned cost</th>}
              </tr>
            </thead>
            <tbody>
              {a.resources.map((r) => (
                <tr key={r.user_id} className="border-b border-line last:border-0">
                  <td className={cn(TD, 'max-w-[220px]')}><PersonName id={r.user_id} size={22} className="max-w-full" /></td>
                  <td className={cn(TD, 'tnum text-right')}>{fmtNum(r.allocated_hours ?? 0, 1)}</td>
                  <td className={cn(TD, 'tnum text-right')}>{fmtNum(r.allocated_hours_to_date ?? 0, 1)}</td>
                  <td className={cn(TD, 'tnum text-right')}>
                    {fmtNum(r.logged_hours_to_date ?? r.logged_hours, 1)}
                    {r.approved_hours !== undefined && <span className="block text-[11.5px] text-ink-3">{fmtNum(r.approved_hours, 1)} approved</span>}
                  </td>
                  <td className={cn(TD, 'tnum whitespace-nowrap text-right font-semibold')}>
                    {r.unplanned ? <span className="text-warning-text">unplanned</span> : r.used === null ? <span className="font-normal text-ink-3">—</span> : <span className={cn(r.used < 0.8 || r.used > 1.2 ? 'text-danger-text' : 'text-ink')}>{fmtPct(r.used, 0)}</span>}
                  </td>
                  <td className={cn(TD, 'tnum whitespace-nowrap text-right text-ink-2')}>
                    {fmtNum(r.allocated_man_days, 1)}
                    <span className="block text-[11.5px] text-ink-3">{fmtNum(r.logged_days, 1)} logged</span>
                  </td>
                  {showCost && <td className={cn(TD, 'tnum whitespace-nowrap text-right')}>{fmtMoney(r.planned_cost)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      <Note>
        Planned hours = working days × allocation % × {mh} hours (the minimum day). Allocation used = logged hours ÷ planned hours to date. Below 80% (red) means paid time on this project isn’t showing up as logged work: either timesheets are incomplete or the allocation is too generous; above 120% means more time went in than planned. “Unplanned” means hours were logged without an allocation. Man-days = hours ÷ {mh}.
      </Note>
    </Card>
  )
}

/* ---------------- (f) Effort ratio: project, milestone, task ---------------- */
export function EffortCard({ a }: { a: CostingAnalysis }) {
  const people = usePeopleMap()
  const e = a.effort
  const alert = e.alert
  const tasks = e.tasks
  const msRows = a.milestones
  const TaskRow = ({ t }: { t: EffortTaskRow }) => (
    <tr className={cn('border-b border-line last:border-0', (t.ratio ?? 0) > alert && 'bg-danger-soft/40')}>
      <td className={cn(TD, 'max-w-[340px]')}>
        <span className="tnum text-ink-3">{t.wbs}</span> <span className="text-ink">{t.title}</span>
        <span className="block text-[11.5px] text-ink-3">{people.get(t.owner_id)?.name ?? 'Unassigned'}{t.done ? ' · done' : ` · in progress, ${t.progress ?? 0}% (so far)`}</span>
      </td>
      <td className={cn(TD, 'tnum whitespace-nowrap text-ink-2')}>{t.milestone_code ?? '—'}</td>
      <td className={cn(TD, 'tnum whitespace-nowrap text-right')}>{fmtNum(t.est_hours, 1)}</td>
      <td className={cn(TD, 'tnum whitespace-nowrap text-right')}>{fmtNum(t.actual_hours, 1)}</td>
      <td className={cn(TD, 'tnum whitespace-nowrap text-right', ratioCls(t.ratio, alert))}>
        {ratio(t.ratio)}
        {(t.ratio ?? 0) > alert && <Badge size="sm" tone="danger" className="ml-1.5">Over {alert.toFixed(1)}</Badge>}
      </td>
    </tr>
  )
  return (
    <Card>
      <CardHeader
        title="Effort ratio"
        subtitle={<>Effort ratio = actual hours ÷ estimated hours. 1.0 means on estimate; 1.3 means the work took 30% longer than planned. Shown per task, milestone and project; anything above {alert.toFixed(1)} is flagged.</>}
      />
      <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
        <div className="bg-surface px-3 py-2.5">
          <div className="text-[12px] text-ink-3">Project</div>
          <div className={cn('tnum mt-0.5 text-[20px] font-semibold leading-tight', ratioCls(e.project, alert))}>{ratio(e.project)}</div>
          <div className="text-[11.5px] text-ink-3">on finished tasks</div>
        </div>
        <div className="bg-surface px-3 py-2.5">
          <div className="text-[12px] text-ink-3">Flagged tasks</div>
          <div className={cn('tnum mt-0.5 text-[20px] font-semibold leading-tight', e.flagged ? 'text-danger-text' : 'text-ink')}>{e.flagged}</div>
          <div className="text-[11.5px] text-ink-3">above {alert.toFixed(1)}</div>
        </div>
        <div className="bg-surface px-3 py-2.5">
          <div className="text-[12px] text-ink-3">Estimated</div>
          <div className="tnum mt-0.5 text-[20px] font-semibold leading-tight text-ink">{fmtNum(e.est_hours ?? 0)}h</div>
          <div className="text-[11.5px] text-ink-3">all tasks</div>
        </div>
        <div className="bg-surface px-3 py-2.5">
          <div className="text-[12px] text-ink-3">Actual</div>
          <div className="tnum mt-0.5 text-[20px] font-semibold leading-tight text-ink">{fmtNum(e.actual_hours ?? 0, 1)}h</div>
          <div className="text-[11.5px] text-ink-3">logged so far</div>
        </div>
      </div>
      <h3 className="mb-1.5 text-[13px] font-semibold text-ink">Per milestone</h3>
      <Scroll>
        <table className="mb-4 w-full min-w-[480px] text-[13px]">
          <thead className="bg-surface-2/60">
            <tr>
              <th className={cn(TH, 'text-left')}>Milestone</th>
              <th className={cn(TH, 'text-right')}>Est h</th>
              <th className={cn(TH, 'text-right')}>Actual h</th>
              <th className={cn(TH, 'text-right')}>Ratio</th>
            </tr>
          </thead>
          <tbody>
            {msRows.map((m) => (
              <tr key={m.id} className="border-b border-line last:border-0">
                <td className={cn(TD, 'max-w-[320px] py-2')}><span className="tnum font-semibold text-ink-3">{m.code}</span> {m.name}</td>
                <td className={cn(TD, 'tnum py-2 text-right')}>{fmtNum(m.est_hours, 1)}</td>
                <td className={cn(TD, 'tnum py-2 text-right')}>{fmtNum(m.actual_hours, 1)}</td>
                <td className={cn(TD, 'tnum whitespace-nowrap py-2 text-right', ratioCls(m.effort_ratio, alert))}>
                  {m.effort_ratio === null ? <span className="text-[12px] font-normal text-ink-3">no finished task yet</span> : ratio(m.effort_ratio)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      <h3 className="mb-1.5 text-[13px] font-semibold text-ink">Per task</h3>
      {!tasks.length ? (
        <EmptyState compact title="No logged work yet" body="Ratios appear once hours are logged against estimated tasks." />
      ) : (
        <Scroll>
          <table className="w-full min-w-[620px] text-[13px]">
            <thead className="bg-surface-2/60">
              <tr>
                <th className={cn(TH, 'text-left')}>Task</th>
                <th className={cn(TH, 'text-left')}>Milestone</th>
                <th className={cn(TH, 'text-right')}>Est h</th>
                <th className={cn(TH, 'text-right')}>Actual h</th>
                <th className={cn(TH, 'text-right')}>Ratio</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <TaskRow key={t.id} t={t} />
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
      <Note>
        A finished task’s ratio is final. An open task shows its ratio so far (hours logged ÷ estimate). Milestone and project ratios use finished tasks. The alert level ({alert.toFixed(1)}) is set in Company &amp; rules.
      </Note>
    </Card>
  )
}

/* ---------------- Cost per hour (guide formula with live numbers) ---------------- */
export function CostPerHourNote({ a }: { a: CostingAnalysis }) {
  const r = a.rate
  if (!r) return null
  const people = r.people
  return (
    <div className="rounded-md bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
      <div>
        <span className="font-semibold text-ink">Cost per hour = monthly salary (CTC) ÷ (working days in the month × minimum hours per day).</span> Example: ₹60,000 ÷ (22 × 9) = ₹{fmtNum(Math.round(r.example.per_hour / 100))} per hour.
      </div>
      <div className="mt-1">
        This company, {monthName(r.month)}: <span className="tnum font-medium text-ink">{r.working_days}</span> working days × <span className="tnum font-medium text-ink">{r.min_hours}</span> minimum hours ={' '}
        <span className="tnum font-medium text-ink">{r.working_days * r.min_hours}</span> paid hours. An allocation row costs its hours (working days × % × {r.min_hours}) at the rate of each month it covers.
      </div>
      {people.length > 0 && (
        <div className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2 xl:grid-cols-3">
          {people.map((p) => (
            <div key={p.user_id} className="tnum flex min-w-0 items-center justify-between gap-2">
              <PersonName id={p.user_id} size={18} className="min-w-0" />
              <span className="shrink-0 whitespace-nowrap">
                <span className="text-ink-3">{fmtMoney(p.monthly_ctc)} ÷ {r.working_days * r.min_hours} =</span> <span className="font-medium text-ink">{fmtMoney(p.cost_per_hour)}/h</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
