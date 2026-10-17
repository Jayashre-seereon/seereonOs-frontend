// CEO dashboard (Feature Guide §2, screenshots 000/002/003). Sub-tabs: Overview (revenue & earnings, delivery,
// milestones and cash), Projects (health + profit margins), Sales (pipeline), Finance (P&L + ledger highlights)
// and Operations (recurring duties + people & timesheets). Every figure comes from GET /dashboards/ceo.
import { lazy, Suspense, useMemo, useRef, useState, type ComponentType } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BarChart3, Table2 } from '@/ui/icons'
import { useCeoDashboard, type CeoDashboard } from '@/api/dashboards'
import { useSession } from '@/stores/session'
import { useUI, useWeek } from '@/stores/ui'
import { Avatar, Badge, BarChart, Button, ChartTable, Delta, ErrorState, Money, PeriodSwitch, Segmented, SkeletonCards, SkeletonRows, StatusBadge, usePeriod, useCan } from '@/ui'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportTable } from '@/reports/export'
import { fmtMoney, fmtMoneyCompact, fmtNum, fmtPct } from '@/domain/money'
import { fmtDate } from '@/domain/calendar'
import { DEAL_STAGE } from '@/domain/labels'
import { MILESTONE_STATE } from '@/reports/datasets'
import { cn } from '@/lib/utils'
import { Bars, ChangeText, ListEmpty, MetricGrid, Panel, ProjectHealthStrip, SeeAll } from '../kit'
import { TaskDeliveryPanel } from '@/modules/work/taskDelivery'
import PeopleSummaryPanel from '@/modules/hr/PeopleSummaryPanel'
import SpendSummaryPanel from '@/modules/spend/SpendSummaryPanel'
import SalesHome from './SalesHome'
import { DutiesPanel } from './OpsDuties'

export type CeoTab = 'overview' | 'projects' | 'sales' | 'finance' | 'operations'

/** Profit margins card from the finance module (workstream A), loaded when it exists. */
const marginsModule = import.meta.glob<Record<string, unknown>>('/src/modules/finance/MarginsPanel.tsx')
const ProfitMarginsCard = (() => {
  const load = marginsModule['/src/modules/finance/MarginsPanel.tsx']
  if (!load) return null
  return lazy(async () => {
    const m = await load()
    const C = (m.ProfitMarginsCard ?? m.default) as ComponentType | undefined
    return { default: C ?? (() => null) }
  })
})()

function exportPeriod(d: CeoDashboard): ExportTable {
  return {
    title: 'Revenue and earnings',
    subtitle: `${d.period.label} (compared with ${d.period.prev_label})`,
    columns: [
      { key: 'label', label: 'Period', type: 'string' },
      { key: 'billed', label: 'Revenue billed', type: 'money' },
      { key: 'collected', label: 'Collected', type: 'money' },
      { key: 'cost', label: 'Costs', type: 'money' },
      { key: 'net', label: 'Net earnings', type: 'money' },
      { key: 'margin', label: 'Net margin', type: 'percent' },
    ],
    rows: d.period_rows.filter((r) => r.kind === 'sub').map((r) => ({ label: r.label, billed: r.billed, collected: r.collected, cost: r.cost, net: r.net, margin: r.margin })),
    totals: (() => {
      const t = d.period_rows.find((r) => r.kind === 'total')!
      return { billed: t.billed, collected: t.collected, cost: t.cost, net: t.net, margin: t.margin }
    })(),
    notes: [FOOTNOTE],
  }
}
function exportFixed(d: CeoDashboard): ExportTable {
  return {
    title: 'Revenue and earnings',
    subtitle: 'This month, this quarter and this financial year',
    columns: [
      { key: 'label', label: 'Period', type: 'string' },
      { key: 'billed', label: 'Revenue billed', type: 'money' },
      { key: 'collected', label: 'Collected', type: 'money' },
      { key: 'cost', label: 'Costs', type: 'money' },
      { key: 'net', label: 'Net earnings', type: 'money' },
      { key: 'margin', label: 'Net margin', type: 'percent' },
      { key: 'change', label: 'Revenue change', type: 'percent' },
    ],
    rows: d.fixed_rows.map((r) => ({ label: r.label, billed: r.billed, collected: r.collected, cost: r.cost, net: r.net, margin: r.margin, change: r.change })),
    kpis: [
      { label: 'Revenue this month', value: fmtMoney(d.revenue.month.billed) },
      { label: 'Revenue this quarter', value: fmtMoney(d.revenue.quarter.billed) },
      { label: 'Revenue this financial year', value: fmtMoney(d.revenue.fy.billed) },
      { label: 'Net earnings this financial year', value: fmtMoney(d.revenue.fy.net) },
    ],
    notes: [FOOTNOTE],
  }
}
const FOOTNOTE = 'Revenue = invoices raised (milestones marked invoiced, plus consulting and other income in the ledger). Costs = payroll + overheads + expenses. Net earnings = revenue − costs.'

function TopNumber({ label, value, change, changeLabel, tone }: { label: string; value: number; change: number | null; changeLabel: string; tone?: 'success' | 'danger' }) {
  return (
    <div className="min-w-0">
      <div className={cn('tnum truncate whitespace-nowrap text-[22px] font-semibold leading-none tracking-[-0.01em] md:text-[26px]', tone === 'success' && 'text-success-text', tone === 'danger' && 'text-danger-text')} title={fmtMoney(value)}>
        {fmtMoney(value)}
      </div>
      <div className="mt-1.5 text-[12.5px] leading-snug text-ink-3">{label}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
        <Delta value={change} />
        <span className="min-w-0 truncate">{changeLabel}</span>
      </div>
    </div>
  )
}

/** Revenue and earnings (G2.01–G2.05, G2.08). */
function RevenueEarnings({ d }: { d: CeoDashboard }) {
  const [chartView, setChartView] = useState<'chart' | 'table'>('chart')
  const chartRef = useRef<HTMLDivElement>(null)
  const months = useMemo(() => d.months.map((m) => ({ ...m })), [d])
  const aheadMax = Math.max(1, d.ahead.in_90, d.ahead.weighted_pipeline)
  return (
    <Panel title="Revenue and earnings" action={<ExportMenu iconOnly variant="ghost" table={() => exportFixed(d)} filename="revenue-and-earnings" />}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
        <TopNumber label="Revenue this month" value={d.revenue.month.billed} change={d.revenue.month.change} changeLabel="vs last month" />
        <TopNumber label="Revenue this quarter" value={d.revenue.quarter.billed} change={d.revenue.quarter.change} changeLabel="vs last quarter" />
        <TopNumber label="Revenue this financial year" value={d.revenue.fy.billed} change={d.revenue.fy.change} changeLabel="vs same period last year" />
        <TopNumber label="Net earnings this financial year" value={d.revenue.fy.net} change={d.net_change} changeLabel="vs same period last year" tone={d.revenue.fy.net < 0 ? 'danger' : 'success'} />
      </div>

      {/* fixed period table */}
      <div className="-mx-4 mt-5 hidden overflow-x-auto scroll-thin md:-mx-5 md:block">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead>
            <tr className="border-y border-line bg-surface-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
              <th className="h-9 pl-5 text-left font-medium">Period</th>
              <th className="px-3 text-right font-medium">Revenue billed</th>
              <th className="px-3 text-right font-medium">Collected</th>
              <th className="px-3 text-right font-medium">Costs</th>
              <th className="px-3 text-right font-medium">Net earnings</th>
              <th className="px-3 text-right font-medium">Net margin</th>
              <th className="pr-5 text-right font-medium">Revenue change</th>
            </tr>
          </thead>
          <tbody>
            {d.fixed_rows.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-0">
                <td className="py-3 pl-5 font-medium">{r.label}</td>
                <td className="tnum whitespace-nowrap px-3 text-right font-semibold">{fmtMoney(r.billed)}</td>
                <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(r.collected)}</td>
                <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(r.cost)}</td>
                <td className={cn('tnum whitespace-nowrap px-3 text-right font-semibold', r.net < 0 ? 'text-danger-text' : 'text-success-text')}>{fmtMoney(r.net)}</td>
                <td className="tnum whitespace-nowrap px-3 text-right">{fmtPct(r.margin, 0)}</td>
                <td className="py-2 pr-5 text-right">
                  <ChangeText value={r.change} label={r.change_label} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-5 space-y-2.5 md:hidden">
        {d.fixed_rows.map((r) => (
          <li key={r.key} className="rounded-md border border-line p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-[13.5px] font-medium">{r.label}</span>
              <ChangeText value={r.change} label={r.change_label} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12.5px]">
              <div><dt className="text-ink-3">Billed</dt><dd className="tnum font-semibold">{fmtMoney(r.billed)}</dd></div>
              <div><dt className="text-ink-3">Collected</dt><dd className="tnum">{fmtMoney(r.collected)}</dd></div>
              <div><dt className="text-ink-3">Costs</dt><dd className="tnum">{fmtMoney(r.cost)}</dd></div>
              <div><dt className="text-ink-3">Net · margin</dt><dd className={cn('tnum font-semibold', r.net < 0 ? 'text-danger-text' : 'text-success-text')}>{fmtMoneyCompact(r.net)} · {fmtPct(r.margin, 0)}</dd></div>
            </dl>
          </li>
        ))}
      </ul>

      {/* 12-month chart */}
      <div className="mt-6 flex items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold">Monthly revenue, last 12 months</h3>
        <div className="flex items-center gap-1">
          <Segmented size="sm" value={chartView} onChange={setChartView} options={[{ value: 'chart', label: <BarChart3 className="size-3.5" aria-label="Chart" /> }, { value: 'table', label: <Table2 className="size-3.5" aria-label="Table" /> }]} />
          <ExportMenu
            iconOnly
            variant="ghost"
            table={() => ({
              title: 'Billed vs collected, last 12 months',
              subtitle: `${d.months[0]?.label} – ${d.months[d.months.length - 1]?.label}`,
              columns: [
                { key: 'label', label: 'Month', type: 'string' },
                { key: 'billed', label: 'Billed', type: 'money' },
                { key: 'collected', label: 'Collected', type: 'money' },
                { key: 'cost', label: 'Costs', type: 'money' },
                { key: 'net', label: 'Net', type: 'money' },
              ],
              rows: d.months,
              chartSvg: chartRef.current?.querySelector('svg.recharts-surface') as SVGSVGElement | null,
              legend: [{ label: 'Billed', color: 'var(--c1)' }, { label: 'Collected', color: 'var(--c2)' }],
            })}
          />
        </div>
      </div>
      {chartView === 'chart' ? (
        <div ref={chartRef} className="mt-2">
          <BarChart data={months} x="label" format="money" height={240} series={[{ key: 'billed', label: 'Billed' }, { key: 'collected', label: 'Collected' }]} />
        </div>
      ) : (
        <div className="mt-2 max-h-[300px] overflow-y-auto scroll-thin">
          <ChartTable data={months} x="label" xLabel="Month" format="money" series={[{ key: 'billed', label: 'Billed' }, { key: 'collected', label: 'Collected' }, { key: 'net', label: 'Net' }]} />
        </div>
      )}

      {/* streams + revenue ahead */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="min-w-0">
          <h3 className="mb-3 text-[13.5px] font-semibold">Where revenue came from, this financial year</h3>
          {d.stream_shares.length ? (
            <ul className="space-y-2.5">
              {d.stream_shares.map((s) => (
                <li key={s.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
                  <span className="min-w-0 truncate text-[13px] text-ink-2">{s.label}</span>
                  <span className="col-span-2 row-start-2 h-1.5 overflow-hidden rounded-sm bg-surface-2 sm:col-span-1 sm:row-start-auto">
                    <span className="block h-full rounded-sm bg-success" style={{ width: `${Math.max(1, s.share * 100)}%` }} />
                  </span>
                  <span className="tnum whitespace-nowrap text-right text-[13px] font-semibold">
                    {fmtMoney(s.value)} <span className="ml-1 text-[11.5px] font-medium text-ink-3">{fmtPct(s.share, 0)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No income booked in this financial year yet.</ListEmpty>
          )}
        </section>
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold">Revenue ahead</h3>
            <SeeAll to="/finance/invoices">Invoices</SeeAll>
          </div>
          <Bars
            format={(v) => fmtMoney(v)}
            max={aheadMax}
            items={[
              { label: 'Milestones billable in 30 days', value: d.ahead.in_30 },
              { label: 'In 60 days', value: d.ahead.in_60 },
              { label: 'In 90 days', value: d.ahead.in_90 },
              { label: 'Weighted sales pipeline', value: d.ahead.weighted_pipeline, tone: 'accent', sub: `of ${fmtMoneyCompact(d.ahead.open_pipeline)} open`, to: '/sales' },
            ]}
          />
        </section>
      </div>
      <p className="mt-5 text-[12px] leading-relaxed text-ink-3">{FOOTNOTE}</p>
    </Panel>
  )
}

/** Delivery KPIs (G2.06). */
function DeliveryCard({ d }: { d: CeoDashboard }) {
  const dl = d.delivery
  const k = d.kpis
  const t3 = (v: number | null, good = 0.95, ok = 0.85) => (v === null ? undefined : v >= good ? 'success' : v >= ok ? 'warning' : 'danger') as 'success' | 'warning' | 'danger' | undefined
  return (
    <Panel title="Delivery" action={<SeeAll to="/insights">Insights</SeeAll>}>
      <MetricGrid
        items={[
          // Feature Guide §2: milestones hit on time, SPI, average lateness and overdue tasks — then the extra KPIs
          { label: `Milestones hit on time (${dl.milestones_on_time_count} of ${dl.milestones_achieved})`, value: fmtPct(dl.milestones_on_time, 0), tone: t3(dl.milestones_on_time, 0.9, 0.75), hint: 'Achieved milestones whose last task finished on or before the baseline deadline.' },
          { label: 'Schedule performance index (SPI)', value: dl.spi === null ? '—' : dl.spi.toFixed(2), tone: t3(dl.spi), hint: 'Work done ÷ work planned by today, averaged over live projects. Above 1.0 means ahead of plan; below 1.0 means behind.' },
          { label: `Average lateness (${dl.late_tasks} late task${dl.late_tasks === 1 ? '' : 's'})`, value: dl.avg_lateness === null ? '—' : `${fmtNum(dl.avg_lateness, 1)} days`, tone: dl.avg_lateness === null ? 'success' : dl.avg_lateness > 3 ? 'danger' : 'warning', hint: 'Working days late, averaged over completed tasks that finished after their target end.', to: '/rules#kpi-average-lateness' },
          { label: 'Overdue tasks', value: dl.overdue_tasks, tone: dl.overdue_tasks ? 'danger' : 'success', hint: 'Open tasks on live projects already past their target end (breached).', to: '/insights/tasks_at_risk' },
          { label: 'On-time delivery, all completed tasks', value: fmtPct(k.on_time_tasks, 0), tone: t3(k.on_time_tasks, 0.9, 0.75), to: '/rules#kpi-on-time-delivery' },
          { label: 'Average effort performance (CPI)', value: k.cpi === null ? '—' : k.cpi.toFixed(2), tone: t3(k.cpi), hint: 'Estimated ÷ actual hours on completed tasks. Below 1.0 means tasks cost more effort than planned.' },
          { label: 'Utilisation, next 10 working days', value: fmtPct(dl.utilisation, 0), tone: dl.utilisation === null ? undefined : dl.utilisation > 1 ? 'danger' : dl.utilisation >= 0.6 ? 'success' : 'warning', to: '/home?view=pm' },
          { label: 'Active projects in red', value: `${k.red_projects} / ${k.active_projects}`, tone: k.red_projects ? 'danger' : 'success', to: '/projects' },
          { label: 'Tasks forecast to breach', value: k.forecast_breach, tone: k.forecast_breach ? 'warning' : 'success', to: '/insights/predictions' },
          { label: `Tasks done in last 4 weeks (previous 4: ${dl.done_prev_4w})`, value: dl.done_4w, tone: dl.done_4w >= dl.done_prev_4w ? 'success' : 'warning' },
        ]}
      />
      <p className="mt-4 text-[13px] text-ink-3">
        Team weekly score: <Link to="/scorecard" className="tnum font-semibold text-ink hover:underline">{k.team_score ?? '—'}</Link>
        <span className="ml-2">· {k.done_week} task{k.done_week === 1 ? '' : 's'} completed in the selected week</span>
      </p>
    </Panel>
  )
}

/** Milestones and cash (G2.07). */
function MilestonesCash({ d }: { d: CeoDashboard }) {
  const nav = useNavigate()
  const c = d.cash_ms
  return (
    <Panel title="Milestones and cash" flush>
      <div className="px-4 md:px-5">
        <MetricGrid
          items={[
            { label: `Milestones achieved on time (${c.achieved} achieved)`, value: fmtPct(c.on_time, 0), tone: c.on_time === null ? undefined : c.on_time >= 0.9 ? 'success' : c.on_time >= 0.75 ? 'warning' : 'danger' },
            { label: 'Achieved, not yet invoiced', value: fmtMoney(c.achieved_not_invoiced), tone: c.achieved_not_invoiced ? 'warning' : 'success', to: '/finance/invoices' },
            { label: 'Invoiced, awaiting payment', value: fmtMoney(c.invoiced_awaiting), tone: c.invoiced_awaiting ? 'warning' : 'success', to: '/finance/invoices' },
            { label: 'Billable in the next 30 days (forecast)', value: fmtMoney(c.billable_30) },
          ]}
        />
        <h3 className="mb-2 mt-5 text-[13.5px] font-semibold">Due in the next 30 days</h3>
      </div>
      {d.milestones_30.length ? (
        <>
          <div className="hidden overflow-x-auto scroll-thin md:block">
            <table className="w-full min-w-[640px] table-fixed text-[13px]">
              <colgroup>
                <col />
                <col className="w-[96px]" />
                <col className="w-[96px]" />
                <col className="w-[124px]" />
                <col className="w-[128px]" />
              </colgroup>
              <thead>
                <tr className="border-y border-line bg-surface-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
                  <th className="h-9 pl-5 text-left font-medium">Milestone</th>
                  <th className="px-3 text-right font-medium">Deadline</th>
                  <th className="px-3 text-right font-medium">Forecast</th>
                  <th className="px-3 text-left font-medium">Status</th>
                  <th className="pr-5 text-right font-medium">Billing</th>
                </tr>
              </thead>
              <tbody>
                {d.milestones_30.map((m) => (
                  <tr key={m.id} onClick={() => nav(`/projects/${m.project_id}/schedule`)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2/60">
                    <td className="min-w-0 py-2.5 pl-5">
                      <div className="truncate">
                        <span className="font-semibold">{m.project}</span> <span className="text-ink-2">{m.code}</span>
                      </div>
                      <div className="truncate text-[12px] text-ink-3">
                        {m.name}, {fmtPct(m.progress, 0)} done
                      </div>
                    </td>
                    <td className="tnum whitespace-nowrap px-3 text-right">{fmtDate(m.planned_end)}</td>
                    <td className={cn('tnum whitespace-nowrap px-3 text-right', m.forecast_late && 'font-semibold text-danger-text')}>{fmtDate(m.forecast)}</td>
                    <td className="px-3">
                      <StatusBadge map={MILESTONE_STATE as never} value={m.state as never} size="sm" />
                    </td>
                    <td className="tnum whitespace-nowrap pr-5 text-right">
                      <Money value={m.billing} />
                      {m.billing_status !== 'none' && <div className="text-[11px] text-ink-3">{m.billing_status === 'paid' ? 'Paid' : 'Invoiced'}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line border-t border-line md:hidden">
            {d.milestones_30.map((m) => (
              <li key={m.id}>
                <Link to={`/projects/${m.project_id}/schedule`} className="flex items-start gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">
                      {m.project} {m.code}
                    </span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {m.name}, {fmtPct(m.progress, 0)} done
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink-3">
                      Deadline <span className="tnum text-ink-2">{fmtDate(m.planned_end)}</span> · forecast <span className={cn('tnum', m.forecast_late ? 'font-semibold text-danger-text' : 'text-ink-2')}>{fmtDate(m.forecast)}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <Money value={m.billing} compact className="text-[13px] font-medium" />
                    <span className="block">
                      <StatusBadge map={MILESTONE_STATE as never} value={m.state as never} size="sm" />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ListEmpty>No milestones due in the next 30 days.</ListEmpty>
      )}
    </Panel>
  )
}

function Overview({ d }: { d: CeoDashboard }) {
  return (
    <div className="space-y-4 md:space-y-5">
      <RevenueEarnings d={d} />
      <DeliveryCard d={d} />
      <MilestonesCash d={d} />
    </div>
  )
}

function ProjectsTab({ d }: { d: CeoDashboard }) {
  return (
    <div className="space-y-4 md:space-y-5">
      <Panel title="Project health" subtitle={`${d.delivery.active_projects} live · ${d.delivery.at_risk_projects} need attention`} action={<SeeAll to="/projects">All projects</SeeAll>}>
        <ProjectHealthStrip projects={d.projects} showMargin={d.can_margins} />
      </Panel>
      {d.can_margins &&
        (ProfitMarginsCard ? (
          <Suspense fallback={<div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={4} /></div>}>
            <ProfitMarginsCard />
          </Suspense>
        ) : (
          <Panel title="Profit margins" subtitle="Planned, projected and actual margin for every project" action={<SeeAll to="/finance/margins">Open</SeeAll>}>
            <p className="text-[13px] text-ink-3">See the margins table for each project’s contract value, cost and margin.</p>
          </Panel>
        ))}
      <TaskDeliveryPanel variant="ceo" />
    </div>
  )
}

function SalesTab({ d }: { d: CeoDashboard }) {
  const c = useCan()
  return (
    <div className="space-y-4 md:space-y-5">
      {c('deals.edit_own') ? (
        <SalesHome />
      ) : (
        <Panel title="Pipeline" action={<SeeAll to="/sales">Pipeline</SeeAll>}>
          <MetricGrid items={[{ label: 'Open pipeline', value: fmtMoney(d.ahead.open_pipeline) }, { label: 'Weighted pipeline', value: fmtMoney(d.ahead.weighted_pipeline) }]} />
        </Panel>
      )}
      <Panel title="Stale deals" subtitle={`${d.stale.count} with no activity for ${d.stale.stale_days}+ days · ${fmtMoneyCompact(d.stale.value)}`} action={<SeeAll to="/insights/stale_deals" />} flush>
        {d.stale.deals.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {d.stale.deals.map((s) => (
              <li key={s.id}>
                <Link to={`/sales/${s.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{s.title}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {s.client} · {s.owner ?? '—'} · <span className="font-medium text-warning-text">{s.days_idle}d idle</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <Money value={s.value} compact className="text-[13px] font-medium" />
                    <span className="block">
                      <Badge size="sm" tone={DEAL_STAGE[s.stage].tone}>{DEAL_STAGE[s.stage].label}</Badge>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <ListEmpty>Every open deal has recent activity.</ListEmpty>
        )}
      </Panel>
    </div>
  )
}

function FinanceTab({ d, period, setPeriod, fyStart }: { d: CeoDashboard; period: ReturnType<typeof usePeriod>[0]; setPeriod: ReturnType<typeof usePeriod>[1]; fyStart: number }) {
  const openAI = useUI((s) => s.openAI)
  const runway = d.cash.runway_months
  const f = d.finance
  return (
    <div className="space-y-4 md:space-y-5">
      <div className="grid gap-4 xl:grid-cols-12">
        <Panel className="xl:col-span-7" title="Profit and loss, last 6 months" subtitle="Billed, collected, costs and net" action={<SeeAll to="/finance/pnl">Monthly P&L</SeeAll>} flush>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="border-y border-line bg-surface-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
                  <th className="h-9 pl-4 text-left font-medium md:pl-5">Month</th>
                  <th className="px-3 text-right font-medium">Billed</th>
                  <th className="px-3 text-right font-medium">Collected</th>
                  <th className="px-3 text-right font-medium">Costs</th>
                  <th className="pr-4 text-right font-medium md:pr-5">Net</th>
                </tr>
              </thead>
              <tbody>
                {f.pnl.map((m) => (
                  <tr key={m.key} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap py-2.5 pl-4 md:pl-5">{m.label}</td>
                    <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(m.billed)}</td>
                    <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(m.collected)}</td>
                    <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(m.cost)}</td>
                    <td className={cn('tnum whitespace-nowrap pr-4 text-right font-semibold md:pr-5', m.net < 0 ? 'text-danger-text' : 'text-success-text')}>{fmtMoney(m.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel className="xl:col-span-5" title="Cash runway" subtitle="Opening cash + received − paid" action={<SeeAll to="/finance/pnl">P&L</SeeAll>}>
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <div className="text-[12px] text-ink-3">Cash on hand</div>
              <div className={cn('tnum whitespace-nowrap text-[22px] font-semibold tracking-[-0.01em]', d.cash.balance < 0 && 'text-danger-text')}>{fmtMoney(d.cash.balance)}</div>
            </div>
            <Badge tone={d.cash.cash_positive ? 'success' : runway !== null && runway < 6 ? 'danger' : 'warning'}>{d.cash.cash_positive ? 'Cash positive' : runway === null ? '—' : `${runway.toFixed(1)} months runway`}</Badge>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
            <div className="min-w-0 rounded-md bg-surface-2/60 p-2.5">
              <dt className="text-ink-3">Monthly costs</dt>
              <dd className="tnum mt-0.5 truncate text-[14px] font-semibold">{fmtMoneyCompact(d.cash.monthly_burn)}</dd>
            </div>
            <div className="min-w-0 rounded-md bg-surface-2/60 p-2.5">
              <dt className="text-ink-3">Monthly cash in</dt>
              <dd className="tnum mt-0.5 truncate text-[14px] font-semibold">{fmtMoneyCompact(d.cash.recurring_income)}</dd>
            </div>
            <div className="min-w-0 rounded-md bg-surface-2/60 p-2.5">
              <dt className="text-ink-3">Net burn</dt>
              <dd className={cn('tnum mt-0.5 truncate text-[14px] font-semibold', d.cash.net_burn > 0 ? 'text-danger-text' : 'text-success-text')}>{fmtMoneyCompact(d.cash.net_burn)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[11.5px] text-ink-3">Averages of the last 3 full months. Runway = cash ÷ (monthly burn − recurring monthly income).</p>
        </Panel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Ledger highlights" subtitle={`This month: ${fmtMoneyCompact(f.month_income)} income · ${fmtMoneyCompact(f.month_expense)} expenses`} action={<SeeAll to="/finance/ledger">Ledger</SeeAll>} flush>
          <div className="border-t border-line px-4 pb-1 pt-3 text-[12px] font-medium text-ink-3 md:px-5">Recurring entries</div>
          {f.recurring.length ? (
            <ul className="divide-y divide-line">
              {f.recurring.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{e.description}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {e.category} · monthly{e.until_on ? ` until ${fmtDate(e.until_on)}` : ''}
                    </span>
                  </span>
                  <span className={cn('tnum shrink-0 whitespace-nowrap text-[13px] font-semibold', e.kind === 'income' ? 'text-success-text' : 'text-ink')}>
                    {e.kind === 'income' ? '+' : '−'}
                    {fmtMoney(e.amount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No recurring ledger entries.</ListEmpty>
          )}
          <div className="border-t border-line px-4 pb-1 pt-3 text-[12px] font-medium text-ink-3 md:px-5">Largest expenses this month</div>
          {f.top_expenses.length ? (
            <ul className="divide-y divide-line">
              {f.top_expenses.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{e.description}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {e.category} · {fmtDate(e.date)}
                    </span>
                  </span>
                  <span className="tnum shrink-0 whitespace-nowrap text-[13px] font-semibold">{fmtMoney(e.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No expenses booked this month.</ListEmpty>
          )}
        </Panel>
        <PeriodTable d={d} period={period} setPeriod={setPeriod} fyStart={fyStart} />
      </div>
      <SpendSummaryPanel />
      <p className="text-[11.5px] text-ink-3">
        {FOOTNOTE} <Button variant="link" size="xs" onClick={() => openAI('Net profit by month this FY')}>Ask AI for the monthly P&L</Button>
      </p>
    </div>
  )
}

/** Any period with its sub-periods, via the period switch (month by week, quarter or FY by month). */
function PeriodTable({ d, period, setPeriod, fyStart }: { d: CeoDashboard; period: ReturnType<typeof usePeriod>[0]; setPeriod: ReturnType<typeof usePeriod>[1]; fyStart: number }) {
  return (
    <Panel title="Revenue by period" subtitle={`${d.period.label} vs ${d.period.prev_label}`} flush action={<ExportMenu iconOnly variant="ghost" table={() => exportPeriod(d)} filename={`revenue-${d.period.label}`} />}>
      <div className="mb-3 px-4 md:px-5">
        <PeriodSwitch value={period} onChange={setPeriod} fyStartMonth={fyStart} />
      </div>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="border-y border-line bg-surface-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
              <th className="h-9 pl-4 text-left font-medium md:pl-5">Period</th>
              <th className="px-3 text-right font-medium">Billed</th>
              <th className="px-3 text-right font-medium">Collected</th>
              <th className="px-3 text-right font-medium">Costs</th>
              <th className="pr-4 text-right font-medium md:pr-5">Net</th>
            </tr>
          </thead>
          <tbody>
            {d.period_rows.map((r) => (
              <tr key={r.key} className={cn('border-b border-line last:border-0', r.kind === 'total' && 'font-semibold', r.kind === 'previous' && 'text-ink-3')}>
                <td className="whitespace-nowrap py-2.5 pl-4 md:pl-5">{r.kind === 'previous' ? `Previous · ${r.label}` : r.kind === 'total' ? `Total · ${r.label}` : r.label}</td>
                <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(r.billed)}</td>
                <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(r.collected)}</td>
                <td className="tnum whitespace-nowrap px-3 text-right">{fmtMoney(r.cost)}</td>
                <td className={cn('tnum whitespace-nowrap pr-4 text-right md:pr-5', r.net < 0 && 'text-danger-text')}>{fmtMoney(r.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function OperationsTab({ d }: { d: CeoDashboard }) {
  const c = useCan()
  return (
    <div className="space-y-4 md:space-y-5">
      {c('ops.manage') && <DutiesPanel limit={8} showLink />}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <div className="min-w-0"><PeopleSummaryPanel /></div>
        <Panel title="Timesheet approvals by manager" subtitle="Last 8 weeks · approval KPI = −(late + overdue)" action={<SeeAll to="/insights/approval_kpi">KPI</SeeAll>} flush>
          {d.approvals.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.approvals.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                  <Avatar name={a.name} hue={a.hue} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{a.name}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {a.pending} pending · {a.late} late · {a.on_time} on time
                    </span>
                  </span>
                  {a.overdue > 0 && <Badge tone="danger" size="sm">{a.overdue} overdue</Badge>}
                  <span className={cn('tnum w-9 shrink-0 text-right text-[14px] font-semibold', a.score === 0 ? 'text-success-text' : a.score >= -2 ? 'text-warning-text' : 'text-danger-text')}>{a.score}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No approvals in the last 8 weeks.</ListEmpty>
          )}
        </Panel>
      </div>
      <TaskDeliveryPanel variant="hr" />
    </div>
  )
}

export default function CeoHome({ tab = 'overview' }: { tab?: CeoTab }) {
  const [period, setPeriod] = usePeriod('quarter')
  const week = useWeek()
  const q = useCeoDashboard(period.kind, period.anchor, week)
  const { tenant } = useSession()
  const fyStart = tenant?.settings['company.fy_start_month'] ?? 4
  const d = q.data

  if (q.isLoading && !d)
    return (
      <div className="space-y-4">
        <SkeletonCards n={4} />
        <div className="rounded-lg border border-line bg-surface p-5">
          <SkeletonRows rows={6} />
        </div>
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <div className={cn('min-w-0', q.isFetching && 'opacity-[.985]')}>
      {tab === 'overview' && <Overview d={d} />}
      {tab === 'projects' && <ProjectsTab d={d} />}
      {tab === 'sales' && <SalesTab d={d} />}
      {tab === 'finance' && <FinanceTab d={d} period={period} setPeriod={setPeriod} fyStart={fyStart} />}
      {tab === 'operations' && <OperationsTab d={d} />}
    </div>
  )
}
