// UI-29 Sales performance: per-person metrics, cost vs closed, target vs achieved, funnel, 30-day activity heat.
import { useMemo, useState } from 'react'
import { BarChart3, Download, Table2 } from '@/ui/icons'
import {
  Badge, BarChart, Card, CardHeader, ChartTable, DataTable, EmptyState, ErrorState, IconButton, Money, PageHeader, PeriodSwitch, Progress, Segmented, Select, SkeletonCards, SkeletonRows, StatCard, Tooltip, useCan, type Column,
} from '@/ui'
import { useSalesPerformance, type PersonPerformance, type SalesPerformance } from '@/api/sales'
import { useSalesPeriod } from './components'
import { fmtMoney } from '@/domain/money'
import { periodRange, fmtDate } from '@/domain/calendar'
import { fmtMoneyCompact, fmtNum, fmtPct } from '@/domain/money'
import { ACTIVITY_TYPE } from '@/domain/labels'
import { useTenant } from '@/api/core'
import { exportTable } from '@/reports/export'
import { cn } from '@/lib/utils'
import type { ActivityType } from '@/types/entities'

export default function SalesPerformancePage() {
  const [period, setPeriod] = useSalesPeriod()
  const fy = useTenant().data?.settings['company.fy_start_month'] ?? 4
  const r = periodRange(period.kind, period.anchor, fy)
  const q = useSalesPerformance(r.from, r.to)
  const can = useCan()
  const isAdmin = can('sales.performance_all')
  const d = q.data

  const doExport = () => {
    if (!d) return
    exportTable(
      {
        title: 'Sales performance',
        subtitle: r.label,
        orientation: 'landscape',
        columns: [
          { key: 'name', label: 'Salesperson', type: 'string' }, { key: 'activities', label: 'Activities', type: 'number' }, { key: 'calls', label: 'Calls', type: 'number' }, { key: 'meetings', label: 'Meetings', type: 'number' }, { key: 'demos', label: 'Demos', type: 'number' },
          { key: 'proposals', label: 'Proposals', type: 'number' }, { key: 'new_leads', label: 'New leads', type: 'number' }, { key: 'won_count', label: 'Won', type: 'number' }, { key: 'won_value', label: 'Won value', type: 'money' }, { key: 'lost_count', label: 'Lost', type: 'number' },
          { key: 'win_rate', label: 'Win rate', type: 'percent' }, { key: 'avg_deal', label: 'Avg deal', type: 'money' }, { key: 'cycle_days', label: 'Cycle days', type: 'number' }, { key: 'open_value', label: 'Open pipeline', type: 'money' }, { key: 'stale', label: 'Stale', type: 'number' },
        ],
        rows: d.people.map((p) => ({ ...p })),
        totals: { won_value: d.team.won_value, open_value: d.team.open_value },
      },
      'pdf',
    )
  }

  return (
    <div>
      <PageHeader
        title="Sales performance"
        subtitle={isAdmin ? 'Activity, conversion and cost of sales for the team.' : 'Your activity, conversion and pipeline.'}
        actions={
          <>
            <PeriodSwitch value={period} onChange={setPeriod} fyStartMonth={fy} />
            <IconButton label="Export PDF" variant="secondary" onClick={doExport} disabled={!d}>
              <Download className="size-4" />
            </IconButton>
          </>
        }
      />
      {q.isLoading ? (
        <>
          <SkeletonCards n={4} />
          <div className="mt-4 rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={4} /></div>
        </>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Won" value={fmtMoneyCompact(d.team.won_value)} sub={`${d.team.won_count} deals · ${r.label}`} tone={d.team.won_count ? 'success' : undefined} />
            <StatCard label="Win rate" value={fmtPct(d.team.win_rate, 0)} sub={`${d.team.won_count} won · ${d.team.lost_count} lost`} />
            <StatCard label="Activities" value={fmtNum(d.team.activities)} sub={`${d.team.calls} calls · ${d.team.demos} demos`} />
            <StatCard
              label="Target achieved"
              value={fmtPct(d.team.achievement, 0)}
              sub={d.team.target ? `of ${fmtMoneyCompact(d.team.target)} target` : 'No sales targets set'}
              tone={d.team.achievement === null ? undefined : d.team.achievement >= 1 ? 'success' : d.team.achievement >= 0.5 ? 'warning' : 'danger'}
            />
          </div>

          {isAdmin ? <TeamTable people={d.people} label={r.label} /> : d.people[0] ? <MyCard p={d.people[0]} /> : null}

          <LastSix d={d} />

          {d.can_see_cost && <CostVsClosed d={d} />}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] [&>*]:min-w-0">
            <Funnel d={d} />
            <Heat d={d} />
          </div>
        </div>
      )}
    </div>
  )
}

function winTone(v: number | null) {
  return v === null ? 'text-ink-3' : v >= 0.3 ? 'text-success-text' : v >= 0.2 ? 'text-warning-text' : 'text-danger-text'
}

function TeamTable({ people, label }: { people: PersonPerformance[]; label: string }) {
  const n = (v: number) => <span className="tnum">{v}</span>
  const cols: Column<PersonPerformance>[] = [
    { key: 'name', header: 'Salesperson', sortValue: (p) => p.name, cell: (p) => <span className="whitespace-nowrap font-medium text-ink">{p.name}</span> },
    { key: 'acts', header: 'Activities', align: 'right', sortValue: (p) => p.activities, cell: (p) => n(p.activities) },
    { key: 'calls', header: 'Calls', align: 'right', sortValue: (p) => p.calls, cell: (p) => n(p.calls) },
    { key: 'meetings', header: 'Meetings', align: 'right', sortValue: (p) => p.meetings, cell: (p) => n(p.meetings) },
    { key: 'demos', header: 'Demos', align: 'right', sortValue: (p) => p.demos, cell: (p) => n(p.demos) },
    { key: 'proposals', header: 'Proposals', align: 'right', sortValue: (p) => p.proposals, cell: (p) => n(p.proposals) },
    { key: 'leads', header: 'New leads', align: 'right', sortValue: (p) => p.new_leads, cell: (p) => n(p.new_leads) },
    { key: 'won', header: 'Won', align: 'right', sortValue: (p) => p.won_value, cell: (p) => <div className="text-right"><div className="tnum font-medium text-ink">{p.won_count}</div><div className="tnum whitespace-nowrap text-[11.5px] text-ink-3">{fmtMoney(p.won_value)}</div></div> },
    { key: 'lost', header: 'Lost', align: 'right', sortValue: (p) => p.lost_count, cell: (p) => n(p.lost_count) },
    { key: 'win', header: 'Win rate', align: 'right', sortValue: (p) => p.win_rate ?? -1, cell: (p) => <span className={cn('tnum', winTone(p.win_rate))}>{p.win_rate === null ? '—' : fmtPct(p.win_rate, 0)}</span> },
    { key: 'avg', header: 'Avg deal', align: 'right', sortValue: (p) => p.avg_deal ?? 0, cell: (p) => (p.avg_deal === null ? <span className="text-ink-3">—</span> : <Money value={p.avg_deal} />) },
    { key: 'cycle', header: 'Sales cycle', align: 'right', sortValue: (p) => p.cycle_days ?? 0, cell: (p) => <span className="tnum text-ink-2">{p.cycle_days === null ? '—' : `${p.cycle_days}d`}</span> },
    { key: 'open', header: 'Open pipeline', align: 'right', sortValue: (p) => p.open_value, cell: (p) => <Money value={p.open_value} /> },
    { key: 'stale', header: 'Stale', align: 'right', sortValue: (p) => p.stale, cell: (p) => <span className={cn('tnum', p.stale ? 'text-warning-text' : 'text-ink-3')}>{p.stale}</span> },
  ]
  return (
    <section>
      <h2 className="text-[14px] font-semibold text-ink">Salesperson performance, {label}</h2>
      <p className="mb-2.5 mt-0.5 text-[12.5px] text-ink-3">Uses the same Month / Quarter / Year choice as Compensation. Activity counts come from the activities logged on each deal.</p>
      <div className="[&_table]:min-w-[1080px]">
        <DataTable
          rows={people}
          columns={cols}
          rowKey={(p) => p.user_id}
          dense
          initialSort={{ key: 'won', dir: 'desc' }}
          empty={<EmptyState title="No sales people yet" body="Invite someone with the Sales role to see their numbers." compact />}
          mobileCard={(p) => <PersonMini p={p} />}
        />
      </div>
    </section>
  )
}

function PersonMini({ p }: { p: PersonPerformance }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{p.name}</span>
        <span className="tnum shrink-0 text-[14px] font-semibold">{fmtMoneyCompact(p.won_value)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-4 gap-2 border-t border-line pt-2">
        {[['Activities', p.activities], ['Calls', p.calls], ['Meetings', p.meetings], ['Demos', p.demos], ['Proposals', p.proposals], ['New leads', p.new_leads], ['Won', p.won_count], ['Lost', p.lost_count]].map(([l, v]) => (
          <div key={l as string} className="min-w-0">
            <dt className="text-[11.5px] text-ink-3">{l}</dt>
            <dd className="tnum text-[14px] font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 text-[12px] text-ink-3">
        <span>Win rate <span className={cn('tnum font-medium', winTone(p.win_rate))}>{fmtPct(p.win_rate, 0)}</span></span>
        <span>Avg deal <span className="tnum font-medium text-ink">{fmtMoneyCompact(p.avg_deal)}</span></span>
        <span>Cycle <span className="tnum font-medium text-ink">{p.cycle_days === null ? '—' : `${p.cycle_days}d`}</span></span>
        <span>Pipeline <span className="tnum font-medium text-ink">{fmtMoneyCompact(p.open_value)}</span></span>
      </div>
    </div>
  )
}

function MyCard({ p }: { p: PersonPerformance }) {
  const items: [string, string][] = [
    ['Activities', String(p.activities)], ['Calls', String(p.calls)], ['WhatsApp', String(p.whatsapp)], ['Meetings', String(p.meetings)], ['Demos', String(p.demos)], ['Proposals', String(p.proposals)], ['Follow-ups', String(p.follow_ups)], ['New leads', String(p.new_leads)],
    ['Won', `${p.won_count} · ${fmtMoneyCompact(p.won_value)}`], ['Lost', String(p.lost_count)], ['Avg deal', fmtMoneyCompact(p.avg_deal)], ['Cycle', p.cycle_days === null ? '—' : `${p.cycle_days} days`],
    ['Open pipeline', `${fmtMoneyCompact(p.open_value)} (${p.open_count})`], ['Weighted', fmtMoneyCompact(p.weighted_value)],
  ]
  return (
    <Card>
      <CardHeader title="My numbers" subtitle={p.stale ? `${p.stale} deals have gone quiet — log an activity on them.` : 'All open deals have recent activity.'} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map(([l, v]) => (
          <div key={l} className="min-w-0">
            <dt className="text-[12px] text-ink-3">{l}</dt>
            <dd className="tnum mt-0.5 text-[14px] font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {p.achievement !== null && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-[12.5px]"><span className="text-ink-3">Target achieved</span><span className="tnum font-semibold">{fmtPct(p.achievement, 0)}</span></div>
          <Progress value={p.achievement} tone={p.achievement >= 1 ? 'success' : p.achievement >= 0.5 ? 'warning' : 'danger'} />
        </div>
      )}
    </Card>
  )
}

function ChartToggle({ v, set }: { v: 'chart' | 'table'; set: (v: 'chart' | 'table') => void }) {
  return (
    <Segmented
      size="sm"
      value={v}
      onChange={set}
      options={[
        { value: 'chart', label: <BarChart3 className="size-3.5" aria-label="Chart" /> },
        { value: 'table', label: <Table2 className="size-3.5" aria-label="Table" /> },
      ]}
    />
  )
}

function CostVsClosed({ d }: { d: SalesPerformance }) {
  const [v, setV] = useState<'chart' | 'table'>('chart')
  const cost = d.cost_vs_closed.reduce((s, m) => s + m.cost, 0)
  const closed = d.cost_vs_closed.reduce((s, m) => s + m.closed, 0)
  const ratio = cost ? closed / cost : null
  const series = [
    { key: 'cost', label: 'Sales cost', format: 'money' as const },
    { key: 'closed', label: 'Deals closed', format: 'money' as const },
  ]
  return (
    <Card className="min-w-0">
      <CardHeader
        title="Sales cost vs deals closed"
        subtitle={<>Cost = base + variable earned. Closed ÷ cost <span className={cn('tnum font-medium', ratio === null ? '' : ratio >= 1 ? 'text-success-text' : ratio >= 0.5 ? 'text-warning-text' : 'text-danger-text')}>{ratio === null ? '—' : `${fmtNum(ratio, 1)}×`}</span></>}
        action={<ChartToggle v={v} set={setV} />}
      />
      {v === 'chart' ? (
        <BarChart data={d.cost_vs_closed as unknown as Record<string, unknown>[]} x="label" series={series} format="money" height={240} />
      ) : (
        <ChartTable data={d.cost_vs_closed.map((m) => ({ ...m, ratio: m.ratio ?? NaN }))} x="label" xLabel="Month" series={[...series, { key: 'ratio', label: 'Ratio', format: 'number' }]} format="money" />
      )}
    </Card>
  )
}

function LastSix({ d }: { d: SalesPerformance }) {
  const [who, setWho] = useState(d.last_six[0]?.user_id ?? '')
  const p = d.last_six.find((x) => x.user_id === who) ?? d.last_six[0]
  if (!p) return null
  const max = Math.max(1, ...p.months.map((m) => m.closed))
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-4 md:px-5">
        <h2 className="text-[14px] font-semibold text-ink">Last 6 months:</h2>
        {d.last_six.length > 1 ? (
          <Select aria-label="Salesperson" value={p.user_id} onChange={(e) => setWho(e.target.value)} options={d.last_six.map((x) => ({ value: x.user_id, label: x.name }))} className="w-48" />
        ) : (
          <span className="text-[14px] font-semibold text-ink">{p.name}</span>
        )}
        {!p.can_see_pay && <span className="text-[12px] text-ink-3 sm:ml-auto">Target and variable pay are visible to the person and to salary viewers only.</span>}
      </div>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[640px] text-[13.5px]">
          <thead>
            <tr className="border-y border-line bg-surface-2 text-left text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
              <th className="py-2 pl-4 pr-3 font-medium md:pl-5">Month</th>
              <th className="px-3 py-2 text-right font-medium">Activities</th>
              <th className="px-3 py-2 text-right font-medium">New leads</th>
              <th className="w-[30%] px-3 py-2 font-medium">Deals closed</th>
              <th className="px-3 py-2 text-right font-medium">Target</th>
              <th className="px-3 py-2 text-right font-medium">Achieved</th>
              <th className="py-2 pl-3 pr-4 text-right font-medium md:pr-5">Variable earned</th>
            </tr>
          </thead>
          <tbody>
            {p.months.map((m) => (
              <tr key={m.month} className="border-b border-line last:border-0">
                <td className="whitespace-nowrap py-2.5 pl-4 pr-3 md:pl-5">{m.label}</td>
                <td className="tnum px-3 py-2.5 text-right">{m.activities}</td>
                <td className="tnum px-3 py-2.5 text-right">{m.new_leads}</td>
                <td className="px-3 py-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-success" style={{ width: `${(m.closed / max) * 100}%` }} />
                  </div>
                  <div className="tnum mt-1 text-[12px] text-ink-2">{fmtMoney(m.closed)}</div>
                </td>
                <td className="tnum whitespace-nowrap px-3 py-2.5 text-right">{m.target === null ? <span className="text-ink-3">Hidden</span> : fmtMoney(m.target)}</td>
                <td className="px-3 py-2.5 text-right">
                  {m.achievement === null ? <Badge tone="neutral" size="sm">—</Badge> : <Badge tone={m.hit ? 'success' : 'danger'} size="sm">{fmtPct(m.achievement, 0)}</Badge>}
                </td>
                <td className={cn('tnum whitespace-nowrap py-2.5 pl-3 pr-4 text-right md:pr-5', m.variable_earned ? 'font-medium text-success-text' : 'text-ink-3')}>{m.variable_earned === null ? 'Hidden' : fmtMoney(m.variable_earned)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Funnel({ d }: { d: SalesPerformance }) {
  const max = Math.max(1, ...d.funnel.map((f) => f.reached))
  return (
    <Card className="min-w-0">
      <CardHeader title="Stage conversion" subtitle="Deals that reached each stage, and the share that moved on from the stage before." />
      <table className="w-full table-fixed text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
            <th className="w-[34%] py-1.5 pr-2 font-medium">Stage</th>
            <th className="py-1.5 pr-2 font-medium"><span className="sr-only">Share</span></th>
            <th className="w-[44px] py-1.5 pr-2 text-right font-medium">Deals</th>
            <th className="w-[60px] py-1.5 pr-2 text-right font-medium">Value</th>
            <th className="w-[46px] py-1.5 text-right font-medium">Conv.</th>
          </tr>
        </thead>
        <tbody>
          {d.funnel.map((f) => (
            <tr key={f.stage} className="border-b border-line last:border-0">
              <td className="truncate py-2 pr-2 text-ink">{f.label}</td>
              <td className="py-2 pr-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className={cn('h-full rounded-full', f.stage === 'won' ? 'bg-success' : 'bg-brand')} style={{ width: `${Math.max(2, (f.reached / max) * 100)}%` }} />
                </div>
              </td>
              <td className="tnum py-2 pr-2 text-right text-ink">{f.reached}</td>
              <td className="tnum whitespace-nowrap py-2 pr-2 text-right text-ink-2">{fmtMoneyCompact(f.value)}</td>
              <td className={cn('tnum py-2 text-right', f.conversion === null ? 'text-ink-3' : f.conversion >= 0.6 ? 'text-success-text' : f.conversion >= 0.35 ? 'text-warning-text' : 'text-danger-text')}>{f.conversion === null ? '—' : fmtPct(f.conversion, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function Heat({ d }: { d: SalesPerformance }) {
  const types = Object.keys(ACTIVITY_TYPE) as ActivityType[]
  const max = useMemo(() => Math.max(1, ...d.activity_heat.flatMap((x) => types.map((t) => x.counts[t]))), [d, types])
  const total = d.activity_heat.reduce((s, x) => s + x.total, 0)
  return (
    <Card className="min-w-0">
      <CardHeader title="Activity, last 30 days" subtitle={`${total} activities logged`} />
      <div className="overflow-x-auto scroll-thin">
        <div className="min-w-[520px]">
          {types.map((t) => (
            <div key={t} className="flex items-center gap-2 py-[2px]">
              <span className="w-[74px] shrink-0 text-[12px] text-ink-2">{ACTIVITY_TYPE[t]}</span>
              <div className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${d.activity_heat.length}, minmax(0,1fr))` }}>
                {d.activity_heat.map((x) => {
                  const n = x.counts[t]
                  return (
                    <Tooltip key={x.date} content={`${fmtDate(x.date)} · ${n} ${ACTIVITY_TYPE[t].toLowerCase()}${n === 1 ? '' : 's'}`}>
                      <span className="block aspect-square rounded-[3px]" style={{ background: n ? `color-mix(in oklab, var(--brand) ${20 + 80 * (n / max)}%, var(--surface-2))` : 'var(--surface-2)' }} />
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="mt-1.5 flex justify-between pl-[82px] text-[11px] text-ink-3">
            <span>{fmtDate(d.activity_heat[0]?.date)}</span>
            <span>Today</span>
          </div>
        </div>
      </div>
    </Card>
  )
}
