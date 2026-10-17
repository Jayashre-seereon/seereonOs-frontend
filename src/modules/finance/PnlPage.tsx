// Profit & loss for a period, 12-month billed/collected/cost, stream mix, cash runway, revenue ahead.
import { useState, type ReactNode } from 'react'
import { BarChart3, Download, Table2 } from '@/ui/icons'
import {
  Card, CardHeader, ChartTable, ErrorState, LineChart, Menu, Button, PageHeader, PeriodSwitch, Segmented, SkeletonCards, SkeletonRows, StatCard, Delta, Callout, usePeriod, type PeriodValue,
} from '@/ui'
import { usePnl, type PnlLine, type PnlResult } from '@/api/finance'
import { useTenant } from '@/api/core'
import { addMonths, fmtDate, monthOf, monthRange, periodRange, todayISO } from '@/domain/calendar'
import { change, fmtMoney, fmtMoneyCompact, fmtNum, fmtPct } from '@/domain/money'
import { exportTable } from '@/reports/export'
import { cn } from '@/lib/utils'

type Mode = 'period' | 'last6' | 'last12'

export default function PnlPage() {
  const fy = useTenant().data?.settings['company.fy_start_month'] ?? 4
  const [mode, setMode] = useState<Mode>('last6')
  const [period, setPeriod] = usePeriod('quarter')
  const range = (() => {
    if (mode === 'period') return periodRange(period.kind, period.anchor, fy)
    const n = mode === 'last6' ? 6 : 12
    const end = monthRange(monthOf(todayISO())).to
    const from = addMonths(monthRange(monthOf(todayISO())).from, -(n - 1))
    return { from, to: end, label: `Last ${n} months` }
  })()
  const q = usePnl(range.from, range.to)
  const d = q.data

  const doExport = (format: 'pdf' | 'xlsx') => {
    if (!d) return
    const rows: Record<string, string | number | null>[] = []
    rows.push({ line: 'INCOME', amount: null, prev: null })
    for (const l of d.income.by_category) rows.push({ line: `  ${l.label}`, amount: l.amount, prev: l.prev })
    rows.push({ line: 'Total income', amount: d.income.total, prev: d.income.prev_total })
    rows.push({ line: 'EXPENSES', amount: null, prev: null })
    for (const l of d.expense.by_category) rows.push({ line: `  ${l.label}`, amount: l.amount, prev: l.prev })
    rows.push({ line: 'Total expenses', amount: d.expense.total, prev: d.expense.prev_total })
    rows.push({ line: 'Gross profit', amount: d.gross_profit, prev: null })
    rows.push({ line: 'Net profit', amount: d.net_profit, prev: d.prev_net_profit })
    exportTable(
      {
        title: 'Profit & loss',
        subtitle: `${range.label} · ${fmtDate(d.from, 'long')} – ${fmtDate(d.to, 'long')}`,
        columns: [{ key: 'line', label: 'Line', type: 'string' }, { key: 'amount', label: 'This period', type: 'money' }, { key: 'prev', label: 'Previous period', type: 'money' }],
        rows,
        kpis: [
          { label: 'Income', value: fmtMoneyCompact(d.income.total) }, { label: 'Net profit', value: fmtMoneyCompact(d.net_profit) }, { label: 'Net margin', value: fmtPct(d.net_margin) },
          { label: 'Runway', value: d.cash.cash_positive ? 'Cash positive' : `${fmtNum(d.cash.runway_months, 1)} months` },
        ],
        notes: ['Income is billed (invoice date); recurring ledger rows are expanded month by month.'],
      },
      format,
    )
  }

  return (
    <div>
      <PageHeader
        title="Profit & loss"
        subtitle="Monthly P&L for the last six months first, then the statement for any period, cash runway and revenue ahead. Only what is dated up to today counts."
        actions={
          <Menu label="Export" trigger={<Button icon={<Download className="size-4" />} disabled={!d}>Export</Button>} items={[{ label: 'PDF', onSelect: () => doExport('pdf') }, { label: 'Excel', onSelect: () => doExport('xlsx') }]} />
        }
      />
      {q.isLoading ? (
        <>
          <SkeletonCards n={4} />
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={5} /></div>
            <div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={5} /></div>
          </div>
        </>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4">
          {/* G13.01 — the guide's first P&L screen: Monthly P&L, last 6 months */}
          <SixMonths d={d} />

          <div className="flex flex-col gap-2.5 pt-2 sm:flex-row sm:flex-wrap sm:items-center">
            <h2 className="mr-1 text-[15px] font-semibold">Statement</h2>
            <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'last6', label: 'Last 6 months' }, { value: 'last12', label: 'Last 12 months' }, { value: 'period', label: 'Period' }]} />
            {mode === 'period' && <PeriodSwitch value={period} onChange={(v: PeriodValue) => setPeriod(v)} fyStartMonth={fy} />}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Income" value={fmtMoneyCompact(d.income.total)} delta={change(d.income.total, d.income.prev_total)} sub="vs previous" />
            <StatCard label="Expenses" value={fmtMoneyCompact(d.expense.total)} delta={change(d.expense.total, d.expense.prev_total)} invertDelta sub="vs previous" />
            <StatCard label="Net profit" value={fmtMoneyCompact(d.net_profit)} tone={d.net_profit >= 0 ? 'success' : 'danger'} sub={<>Net margin <span className="tnum font-medium text-ink-2">{fmtPct(d.net_margin)}</span></>} />
            <StatCard label="Collected" value={fmtMoneyCompact(d.collected)} sub={d.income.total ? `${fmtPct(d.collected / d.income.total, 0)} of billed` : 'In this period'} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 [&>*]:min-w-0">
            <div className="lg:col-span-2"><Statement d={d} label={range.label} /></div>
            <div className="space-y-4">
              <Runway d={d} />
              <RevenueAhead d={d} />
              <StreamMix d={d} label={range.label} />
            </div>
          </div>

          <TwelveMonths d={d} />
        </div>
      )}
    </div>
  )
}

/** Accounting format: whole rupees, negatives in parentheses. */
function acct(p: number | null | undefined) {
  if (p === null || p === undefined) return '—'
  const s = fmtMoney(Math.abs(p))
  return p < 0 ? `(${s})` : s
}

type Row = { label: ReactNode; amount: number; prev?: number | null; hint?: ReactNode }
function Line({ l, kind = 'item', costLine }: { l: Row; kind?: 'item' | 'subtotal' | 'total'; costLine?: boolean }) {
  const ch = l.prev !== undefined && l.prev !== null ? change(l.amount, l.prev) : undefined
  const strong = kind !== 'item'
  const rule = kind === 'subtotal' ? 'border-t border-line-strong' : kind === 'total' ? 'border-t border-line-strong border-b-[3px] border-b-line-strong border-double' : ''
  const amt = (v: number | null | undefined, muted?: boolean) => (
    <td className={cn('tnum whitespace-nowrap px-3 py-2 text-right', rule, strong ? 'font-semibold text-ink' : muted ? 'text-ink-3' : 'text-ink', v !== null && v !== undefined && v < 0 && 'text-danger-text')}>{acct(v)}</td>
  )
  return (
    <tr className={cn(!strong && 'hover:bg-surface-2/60')}>
      <td className={cn('py-2 pr-3 text-[13.5px]', kind === 'item' ? 'pl-8 text-ink-2' : 'pl-4 text-ink', strong && 'font-semibold', rule)}>
        {l.label}
        {l.hint && <span className="ml-1.5 font-normal text-ink-3">{l.hint}</span>}
      </td>
      {amt(l.amount)}
      <td className={cn('hidden tnum whitespace-nowrap px-3 py-2 text-right text-ink-3 sm:table-cell', rule, strong && 'font-medium')}>{l.prev === undefined ? '' : acct(l.prev)}</td>
      <td className={cn('hidden whitespace-nowrap py-2 pl-3 pr-4 text-right md:table-cell', rule)}>{ch !== undefined ? <Delta value={ch} invert={costLine} /> : null}</td>
    </tr>
  )
}

function Statement({ d, label }: { d: PnlResult; label: string }) {
  const section = (title: string) => (
    <tr>
      <td colSpan={4} className="pb-1 pl-4 pt-4 text-[13px] font-semibold text-ink">{title}</td>
    </tr>
  )
  const lines = (ls: PnlLine[], cost?: boolean) => ls.map((l) => <Line key={l.key} l={{ label: l.label, amount: l.amount, prev: l.prev }} costLine={cost} />)
  const empty = (t: string) => <tr><td colSpan={4} className="py-2 pl-8 text-[13px] text-ink-3">{t}</td></tr>
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="px-4 pt-4 md:px-5 md:pt-5">
        <CardHeader title="Profit and loss statement" subtitle={`${label} · ${fmtDate(d.from)} – ${fmtDate(d.as_of < d.to ? d.as_of : d.to)}${d.as_of < d.to ? ' (to date)' : ''} · compared with ${fmtDate(d.prev_from)} – ${fmtDate(d.prev_to)}`} className="mb-3" />
      </div>
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[300px] text-[13.5px]">
          <thead>
            <tr className="border-y border-line bg-surface-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
              <th className="py-2 pl-4 pr-3 text-left font-medium">Particulars</th>
              <th className="px-3 py-2 text-right font-medium">This period</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Previous</th>
              <th className="hidden py-2 pl-3 pr-4 text-right font-medium md:table-cell">Change</th>
            </tr>
          </thead>
          <tbody>
            {section('Income')}
            {d.income.by_category.length ? lines(d.income.by_category) : empty('No income')}
            <Line l={{ label: 'Total income', amount: d.income.total, prev: d.income.prev_total }} kind="subtotal" />
            {section('Expenses')}
            {d.expense.by_category.length ? lines(d.expense.by_category, true) : empty('No expenses')}
            <Line l={{ label: 'Total expenses', amount: d.expense.total, prev: d.expense.prev_total }} kind="subtotal" costLine />
            {section('Profit')}
            <Line l={{ label: 'Gross profit', hint: `after salaries & delivery · ${fmtPct(d.gross_margin)}`, amount: d.gross_profit }} />
            <Line l={{ label: 'Net profit', hint: fmtPct(d.net_margin), amount: d.net_profit, prev: d.prev_net_profit }} kind="total" />
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-[12px] text-ink-3 md:px-5">Amounts in ₹. Negative figures are shown in parentheses. Income is recognised on invoice date; nothing dated after today is counted. Salaries are the month’s booked payroll (else the CTCs of everyone employed), the same figure as the Dashboard.</p>
    </Card>
  )
}

function Runway({ d }: { d: PnlResult }) {
  const c = d.cash
  const tone = c.cash_positive ? 'success' : c.runway_months === null ? 'neutral' : c.runway_months < 6 ? 'danger' : c.runway_months < 12 ? 'warning' : 'success'
  const bar = c.cash_positive ? 1 : Math.min(1, (c.runway_months ?? 0) / 24)
  return (
    <Card>
      <CardHeader title="Cash runway" subtitle="Cash on hand ÷ net monthly burn (last 3 months’ average)." />
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className={cn('tnum text-[22px] font-semibold leading-tight', tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : 'text-success-text')}>
            {c.cash_positive ? 'Cash positive' : `${fmtNum(c.runway_months, 1)} months`}
          </div>
          <div className="mt-1 text-[12.5px] text-ink-3">{c.cash_positive ? 'Money in covers money out.' : `At today’s burn the cash lasts until about ${fmtDate(addMonths(todayISO(), Math.floor(c.runway_months ?? 0)))}.`}</div>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cn('h-full rounded-full', tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-success')} style={{ width: `${bar * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3"><span>0</span><span>6</span><span>12</span><span>24 months</span></div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line pt-3 text-[13px]">
        <div className="min-w-0"><dt className="text-[12px] text-ink-3">Cash balance</dt><dd className="tnum font-medium">{fmtMoney(c.balance)}</dd></div>
        <div className="min-w-0"><dt className="text-[12px] text-ink-3">Opening cash</dt><dd className="tnum font-medium">{fmtMoney(c.opening)}</dd></div>
        <div className="min-w-0"><dt className="text-[12px] text-ink-3">Monthly burn</dt><dd className="tnum font-medium">{fmtMoney(c.monthly_burn)}</dd></div>
        <div className="min-w-0"><dt className="text-[12px] text-ink-3">Cash in / month</dt><dd className="tnum font-medium">{fmtMoney(c.recurring_income)}</dd></div>
      </dl>
      {c.balance < 0 && <Callout tone="danger" className="mt-3">The computed cash balance is negative. Check the opening cash in Settings → Company → Finance.</Callout>}
    </Card>
  )
}

function RevenueAhead({ d }: { d: PnlResult }) {
  const r = d.revenue_ahead
  const max = Math.max(1, r.uninvoiced, r.weighted_pipeline)
  const bars: [string, number, string][] = [
    ['Billable in 30 days', r.in_30, 'bg-brand'],
    ['Billable in 60 days', r.in_60, 'bg-brand'],
    ['Billable in 90 days', r.in_90, 'bg-brand'],
    ['All uninvoiced milestones', r.uninvoiced, 'bg-ink-3'],
    ['Weighted sales pipeline', r.weighted_pipeline, 'bg-ink-3'],
  ]
  return (
    <Card>
      <CardHeader title="Revenue ahead" subtitle={`${fmtMoneyCompact(r.total)} = ${r.uninvoiced_count} uninvoiced milestones + weighted pipeline`} />
      <ul className="space-y-2.5">
        {bars.map(([l, v, c]) => (
          <li key={l}>
            <div className="mb-1 flex justify-between gap-3 text-[12.5px]"><span className="min-w-0 truncate text-ink-2">{l}</span><span className="tnum shrink-0 font-medium">{fmtMoneyCompact(v)}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className={cn('h-full rounded-full', c)} style={{ width: `${(v / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function StreamMix({ d, label }: { d: PnlResult; label: string }) {
  const rows = d.income.by_stream.filter((l) => l.amount > 0)
  const total = d.income.total || 1
  return (
    <Card>
      <CardHeader title="Revenue by stream" subtitle={label} />
      {!rows.length ? (
        <p className="py-4 text-[13px] text-ink-3">No income in this period.</p>
      ) : (
        <table className="w-full table-fixed text-[13px]">
          <tbody>
            {rows.map((l) => (
              <tr key={l.key} className="border-b border-line last:border-0">
                <td className="truncate py-2 pr-2 text-ink-2">{l.label}</td>
                <td className="tnum w-[88px] whitespace-nowrap py-2 text-right text-ink">{fmtMoneyCompact(l.amount)}</td>
                <td className="tnum w-[48px] py-2 text-right text-ink-3">{Math.round((l.amount / total) * 100)}%</td>
              </tr>
            ))}
            <tr className="border-t border-line-strong">
              <td className="py-2 pr-2 font-semibold text-ink">Total</td>
              <td className="tnum whitespace-nowrap py-2 text-right font-semibold">{fmtMoneyCompact(d.income.total)}</td>
              <td className="tnum py-2 text-right text-ink-3">100%</td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  )
}

function TwelveMonths({ d }: { d: PnlResult }) {
  const [v, setV] = useState<'chart' | 'table'>('chart')
  const series = [
    { key: 'billed', label: 'Billed', format: 'money' as const },
    { key: 'collected', label: 'Collected', format: 'money' as const },
    { key: 'cost', label: 'Cost', format: 'money' as const },
  ]
  return (
    <Card>
      <CardHeader
        title="Billed vs collected vs cost"
        subtitle={`12 months to ${d.months[d.months.length - 1]?.label ?? ''} · no future months; this month is to date`}
        action={<Segmented size="sm" value={v} onChange={setV} options={[{ value: 'chart', label: <BarChart3 className="size-3.5" aria-label="Chart" /> }, { value: 'table', label: <Table2 className="size-3.5" aria-label="Table" /> }]} />}
      />
      {v === 'chart' ? (
        <LineChart data={d.months as unknown as Record<string, unknown>[]} x="label" series={series} format="money" height={260} />
      ) : (
        <ChartTable data={d.months as unknown as Record<string, unknown>[]} x="label" xLabel="Month" series={[...series, { key: 'payroll', label: 'Payroll', format: 'money' }, { key: 'other_costs', label: 'Other costs', format: 'money' }, { key: 'net', label: 'Net', format: 'money' }]} format="money" />
      )}
    </Card>
  )
}

/** G13.01 Monthly P&L, last 6 months: billed, collected, payroll, other costs, net = billed − costs (this month to date). */
function SixMonths({ d }: { d: PnlResult }) {
  const rows = d.monthly
  const tot = rows.reduce((a, m) => ({ billed: a.billed + m.billed, collected: a.collected + m.collected, payroll: a.payroll + m.payroll, other: a.other + m.other_costs, net: a.net + m.net }), { billed: 0, collected: 0, payroll: 0, other: 0, net: 0 })
  const money = (v: number, strong?: boolean, net?: boolean) => (
    <td className={cn('tnum whitespace-nowrap px-3 py-2.5 text-right', strong && 'font-semibold', net && (v >= 0 ? 'text-success-text' : 'text-danger-text'))}>{net ? acct(v) : fmtMoney(v)}</td>
  )
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="px-4 pt-4 md:px-5 md:pt-5">
        <CardHeader title="Monthly P&L, last 6 months" subtitle="What was billed, what was collected, payroll cost, other costs, and net (billed minus costs). Updates as invoices, payments and expenses are recorded." className="mb-3" />
      </div>
      <div className="hidden overflow-x-auto scroll-thin sm:block">
        <table className="w-full min-w-[640px] text-[13.5px]">
          <thead>
            <tr className="border-y border-line bg-surface-2 text-left text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
              <th className="py-2 pl-4 pr-3 font-medium md:pl-5">Month</th>
              <th className="px-3 py-2 text-right font-medium">Billed</th>
              <th className="px-3 py-2 text-right font-medium">Collected</th>
              <th className="px-3 py-2 text-right font-medium">Payroll</th>
              <th className="px-3 py-2 text-right font-medium">Other costs</th>
              <th className="py-2 pl-3 pr-4 text-right font-medium md:pr-5">Net (billed − costs)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.month} className="border-b border-line">
                <td className="whitespace-nowrap py-2.5 pl-4 pr-3 md:pl-5">
                  {m.label}
                  {m.to_date && <span className="ml-1.5 text-[11.5px] text-ink-3">to date</span>}
                </td>
                {money(m.billed)}
                {money(m.collected)}
                {money(m.payroll)}
                {money(m.other_costs)}
                <td className={cn('tnum whitespace-nowrap py-2.5 pl-3 pr-4 text-right font-semibold md:pr-5', m.net >= 0 ? 'text-success-text' : 'text-danger-text')}>{acct(m.net)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface-2/60">
              <td className="py-2.5 pl-4 pr-3 font-semibold md:pl-5">6 months</td>
              {money(tot.billed, true)}
              {money(tot.collected, true)}
              {money(tot.payroll, true)}
              {money(tot.other, true)}
              <td className={cn('tnum whitespace-nowrap py-2.5 pl-3 pr-4 text-right font-semibold md:pr-5', tot.net >= 0 ? 'text-success-text' : 'text-danger-text')}>{acct(tot.net)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ul className="divide-y divide-line border-t border-line sm:hidden">
        {rows.map((m) => (
          <li key={m.month} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-ink">
                {m.label}
                {m.to_date && <span className="ml-1.5 text-[11.5px] font-normal text-ink-3">to date</span>}
              </span>
              <span className={cn('tnum whitespace-nowrap text-[14px] font-semibold', m.net >= 0 ? 'text-success-text' : 'text-danger-text')}>{acct(m.net)}</span>
            </div>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
              {([['Billed', m.billed], ['Collected', m.collected], ['Payroll', m.payroll], ['Other costs', m.other_costs]] as [string, number][]).map(([l, v]) => (
                <div key={l} className="flex min-w-0 justify-between gap-2">
                  <dt className="text-ink-3">{l}</dt>
                  <dd className="tnum whitespace-nowrap text-ink">{fmtMoney(v)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-3 text-[12px] text-ink-3 md:px-5">
        Payroll is the month’s booked salaries, else the current CTCs of everyone employed that month (the same basis as the Dashboard). Other costs are ledger expenses other than salaries (rent, tools, marketing…). Billed counts milestone invoices and ledger income on their dates, up to today.
      </p>
    </Card>
  )
}
