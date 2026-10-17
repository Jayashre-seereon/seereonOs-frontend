// Budgets: FY budget by category (expense) and stream (revenue), monthly phasing, copy last FY,
// budget vs actual (ledger actuals + approved-but-unpaid claims and bills) and unbudgeted spend.
import { useMemo, useState } from 'react'
import { BarChart3, Copy, Plus, Table2 } from '@/ui/icons'
import {
  Badge, Button, Callout, Card, CardHeader, ChartTable, BarChart, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Money, MoneyInput, PageHeader, PeoplePicker, Segmented,
  Select, SkeletonCards, SkeletonRows, StatCard, Switch, Tabs, Textarea, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { useMut } from '@/api/query'
import { announce, guarded, isPending } from '@/api/changes'
import { PendingNote } from '@/modules/workflows/ApprovalRoute'
import { SPEND_INVALIDATE, spendApi, useBudgets, useSpendMeta, type BudgetLine, type BudgetStatement, type UnbudgetedItem } from '@/api/spend'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportTable } from '@/reports/export'
import { fmtDate, fyLabel, parseISO } from '@/domain/calendar'
import { fmtMoney, fmtMoneyCompact, fmtPct } from '@/domain/money'
import { STREAM } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { FyPicker, KpiRow, Meta, pct, useFieldErrors } from './components'

const mLabel = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'short' })
const mLong = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

type Tab = 'statement' | 'unbudgeted' | 'phasing'

export default function BudgetsPage() {
  const meta = useSpendMeta()
  const current = meta.data?.fy_start_year ?? new Date().getFullYear()
  const [fySel, setFy] = useState<number | null>(null)
  const fy = fySel ?? current
  const q = useBudgets(fy)
  const d = q.data
  const readOnly = useReadOnly()
  const [tab, setTab] = useState<Tab>('statement')
  const [edit, setEdit] = useState<BudgetLine | { kind: 'expense' | 'revenue' } | null>(null)
  const [copying, setCopying] = useState(false)
  const [chartView, setChartView] = useState<'chart' | 'table'>('chart')
  const [monthSel, setMonthSel] = useState<number | null>(null)
  const mi = monthSel ?? (d ? Math.max(0, Math.min(11, d.current_month_index)) : 0)

  const chartData = useMemo(() => (d ? d.monthly.map((m) => ({ month: mLabel(m.month), Budget: m.budget, Actual: m.actual })) : []), [d])

  const exportStatement = (): ExportTable => {
    const s = d!
    const line = (l: BudgetLine) => ({
      line: `  ${l.label}`, mb: l.monthly_budget[mi], ma: l.monthly_actual[mi] + l.monthly_committed[mi], yb: l.ytd_budget, ya: l.ytd_actual,
      var: l.ytd_variance, varp: l.ytd_variance_pct, fyb: l.budget_total,
    })
    return {
      title: 'Budget vs actual', subtitle: `${s.fy_label} · month ${mLong(s.months[mi])} · YTD`, orientation: 'landscape', category: 'Budget report',
      columns: [
        { key: 'line', label: 'Line', type: 'string' }, { key: 'mb', label: `${mLabel(s.months[mi])} budget`, type: 'money' }, { key: 'ma', label: `${mLabel(s.months[mi])} actual`, type: 'money' },
        { key: 'yb', label: 'YTD budget', type: 'money' }, { key: 'ya', label: 'YTD actual', type: 'money' }, { key: 'var', label: 'Variance', type: 'money' }, { key: 'varp', label: 'Var %', type: 'percent' }, { key: 'fyb', label: 'FY budget', type: 'money' },
      ],
      rows: [
        { line: 'EXPENSES' }, ...s.expense.map(line), { line: 'Total expenses', yb: s.totals.expense_ytd_budget, ya: s.totals.expense_ytd_actual, var: s.totals.expense_ytd_budget - s.totals.expense_ytd_actual, fyb: s.totals.expense_budget },
        { line: 'REVENUE' }, ...s.revenue.map(line), { line: 'Total revenue', yb: s.totals.revenue_ytd_budget, ya: s.totals.revenue_ytd_actual, var: s.totals.revenue_ytd_actual - s.totals.revenue_ytd_budget, fyb: s.totals.revenue_budget },
      ],
      kpis: [
        { label: 'YTD spend', value: fmtMoneyCompact(s.totals.expense_ytd_actual) }, { label: 'YTD budget', value: fmtMoneyCompact(s.totals.expense_ytd_budget) },
        { label: 'Unbudgeted spend', value: fmtMoneyCompact(s.totals.unbudgeted) }, { label: 'Lines over budget', value: String(s.totals.over_lines) },
      ],
      notes: ['Actuals are paid ledger expenses plus approved-but-unpaid expense claims and vendor bills (committed).', 'Expense variance: positive = under budget. Revenue variance: positive = ahead of target.'],
    }
  }
  const exportUnbudgeted = (): ExportTable => ({
    title: 'Unbudgeted and additional spend', subtitle: d!.fy_label, orientation: 'landscape', category: 'Budget report',
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'category', label: 'Category', type: 'string' }, { key: 'description', label: 'Description', type: 'string' }, { key: 'reason', label: 'Why', type: 'string' },
      { key: 'approved', label: 'Approved by', type: 'string' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'excess', label: 'Beyond budget', type: 'money' },
    ],
    rows: d!.unbudgeted.map((u) => ({ date: u.date, category: u.category, description: u.description + (u.justification ? ` — ${u.justification}` : ''), reason: u.reason === 'no_budget' ? 'No budget' : 'Over budget', approved: u.approved_by_name, amount: u.amount, excess: u.excess })),
    totals: { excess: d!.totals.unbudgeted },
  })

  return (
    <div>
      <PageHeader
        title="Budgets"
        subtitle="What we planned to spend and earn, against what actually happened — and every rupee spent outside the plan."
        actions={
          <>
            <FyPicker value={fy} onChange={(v) => { setFy(v); setMonthSel(null) }} current={current} />
            <ExportMenu table={d ? (tab === 'unbudgeted' ? exportUnbudgeted : exportStatement) : null} filename={`budget-${fyLabel(fy)}`} />
            {!readOnly && (
              <Button icon={<Copy className="size-4" />} onClick={() => setCopying(true)}>Copy {fyLabel(fy - 1)}</Button>
            )}
          </>
        }
      />
      {q.isLoading ? (
        <><SkeletonCards n={4} /><Card className="mt-4"><SkeletonRows rows={5} /></Card></>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {!d.has_budgets && (
            <Callout tone="info" className="mb-4" title={`No budget for ${d.fy_label} yet`} action={!readOnly && d.prev_fy_has_budgets ? <Button size="sm" variant="primary" onClick={() => setCopying(true)}>Copy {fyLabel(fy - 1)}</Button> : undefined}>
              {d.prev_fy_has_budgets ? `Start from last year’s budget with a growth percentage, then adjust lines.` : 'Add budget lines for each expense category and revenue stream.'}
            </Callout>
          )}
          <KpiRow>
            <StatCard
              label="Spend this FY to date"
              value={fmtMoneyCompact(d.totals.expense_ytd_actual)}
              tone={d.totals.expense_ytd_actual > d.totals.expense_ytd_budget ? 'danger' : undefined}
              sub={`of ${fmtMoneyCompact(d.totals.expense_ytd_budget)} budget · ${pct(d.totals.expense_ytd_budget ? (d.totals.expense_ytd_actual - d.totals.expense_ytd_budget) / d.totals.expense_ytd_budget : null)}`}
            />
            <StatCard label="Unbudgeted spend" value={fmtMoneyCompact(d.totals.unbudgeted)} tone={d.totals.unbudgeted ? 'warning' : undefined} sub="Beyond or outside the plan" onClick={() => setTab('unbudgeted')} />
            <StatCard label="Lines over budget" value={d.totals.over_lines} tone={d.totals.over_lines ? 'danger' : 'success'} sub={`${fmtMoneyCompact(d.totals.expense_committed)} committed, unpaid`} />
            <StatCard
              label="Revenue to date"
              value={fmtMoneyCompact(d.totals.revenue_ytd_actual)}
              tone={d.totals.revenue_ytd_actual < d.totals.revenue_ytd_budget ? 'warning' : 'success'}
              sub={`target ${fmtMoneyCompact(d.totals.revenue_ytd_budget)} · ${pct(d.totals.revenue_ytd_budget ? (d.totals.revenue_ytd_actual - d.totals.revenue_ytd_budget) / d.totals.revenue_ytd_budget : null)}`}
            />
          </KpiRow>

          <Card className="mt-4">
            <CardHeader
              title="Spend by month"
              subtitle={`${d.fy_label} · budget vs actual + committed`}
              action={
                <div className="flex gap-1">
                  <IconButton label="Chart" size="sm" variant={chartView === 'chart' ? 'secondary' : 'ghost'} onClick={() => setChartView('chart')}><BarChart3 className="size-4" /></IconButton>
                  <IconButton label="Table" size="sm" variant={chartView === 'table' ? 'secondary' : 'ghost'} onClick={() => setChartView('table')}><Table2 className="size-4" /></IconButton>
                </div>
              }
            />
            {chartView === 'chart' ? (
              <BarChart data={chartData} x="month" series={[{ key: 'Budget', label: 'Budget' }, { key: 'Actual', label: 'Actual' }]} format="money" height={240} />
            ) : (
              <ChartTable data={chartData} x="month" xLabel="Month" series={[{ key: 'Budget', label: 'Budget' }, { key: 'Actual', label: 'Actual' }]} format="money" />
            )}
          </Card>

          <Tabs
            className="mt-6"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'statement', label: 'Budget vs actual' },
              { value: 'unbudgeted', label: 'Unbudgeted spend', count: d.unbudgeted.filter((u) => u.counted).length || undefined },
              { value: 'phasing', label: 'Monthly phasing' },
            ]}
          />
          {tab === 'statement' && <Statement d={d} mi={mi} setMi={setMonthSel} />}
          {tab === 'unbudgeted' && <Unbudgeted d={d} />}
          {tab === 'phasing' && <Phasing d={d} readOnly={readOnly} onEdit={setEdit} />}
        </>
      )}
      {edit && d && <BudgetDialog fy={fy} d={d} line={'id' in edit ? edit : null} kind={edit.kind} onClose={() => setEdit(null)} />}
      {copying && <CopyDialog fy={fy} onClose={() => setCopying(false)} />}
    </div>
  )
}

/* ---------------- statement ---------------- */
function Statement({ d, mi, setMi }: { d: BudgetStatement; mi: number; setMi: (i: number) => void }) {
  const section = (title: string, lines: BudgetLine[], kind: 'expense' | 'revenue') => {
    const tot = {
      mb: lines.reduce((a, l) => a + l.monthly_budget[mi], 0), ma: lines.reduce((a, l) => a + l.monthly_actual[mi] + l.monthly_committed[mi], 0),
      yb: lines.reduce((a, l) => a + l.ytd_budget, 0), ya: lines.reduce((a, l) => a + l.ytd_actual, 0), fy: lines.reduce((a, l) => a + l.budget_total, 0),
    }
    const tv = kind === 'expense' ? tot.yb - tot.ya : tot.ya - tot.yb
    return (
      <>
        <tr className="border-b border-line bg-surface-2/70"><td colSpan={8} className="px-4 py-2 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-3">{title}</td></tr>
        {lines.map((l) => {
          const ma = l.monthly_actual[mi] + l.monthly_committed[mi]
          const mOver = kind === 'expense' ? ma > l.monthly_budget[mi] : ma < l.monthly_budget[mi]
          return (
            <tr key={l.category} className={cn('border-b border-line', l.over && kind === 'expense' && 'bg-danger-soft/40')}>
              <td className="py-2.5 pl-4 pr-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-ink">{l.label}</span>
                  {!l.has_budget && <Badge tone="warning" size="sm">No budget</Badge>}
                </div>
              </td>
              <td className="px-3 text-right"><Money value={l.monthly_budget[mi]} muted={!l.monthly_budget[mi]} /></td>
              <td className={cn('px-3 text-right', mOver && kind === 'expense' && 'text-danger-text')}><Money value={ma} muted={!ma} /></td>
              <td className="hidden px-3 text-right md:table-cell"><Money value={l.ytd_budget} /></td>
              <td className="hidden px-3 text-right md:table-cell"><Money value={l.ytd_actual} /></td>
              <td className={cn('px-3 text-right font-medium', l.over ? 'text-danger-text' : 'text-success-text')}><Money value={l.ytd_variance} sign /></td>
              <td className={cn('hidden px-3 text-right lg:table-cell', l.over ? 'text-danger-text' : 'text-ink-2')}><span className="tnum whitespace-nowrap">{pct(l.ytd_variance_pct)}</span></td>
              <td className="hidden py-2.5 pl-3 pr-4 text-right xl:table-cell"><Money value={l.budget_total} muted /></td>
            </tr>
          )
        })}
        <tr className="border-b border-line-strong font-semibold">
          <td className="py-2.5 pl-4 pr-3">Total {title.toLowerCase()}</td>
          <td className="px-3 text-right"><Money value={tot.mb} /></td>
          <td className="px-3 text-right"><Money value={tot.ma} /></td>
          <td className="hidden px-3 text-right md:table-cell"><Money value={tot.yb} /></td>
          <td className="hidden px-3 text-right md:table-cell"><Money value={tot.ya} /></td>
          <td className={cn('px-3 text-right', tv < 0 ? 'text-danger-text' : 'text-success-text')}><Money value={tv} sign /></td>
          <td className="hidden px-3 text-right lg:table-cell"><span className="tnum">{pct(tot.yb ? tv / tot.yb : null)}</span></td>
          <td className="hidden py-2.5 pl-3 pr-4 text-right xl:table-cell"><Money value={tot.fy} /></td>
        </tr>
      </>
    )
  }
  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Select aria-label="Month" value={String(mi)} onChange={(e) => setMi(Number(e.target.value))} options={d.months.map((m, i) => ({ value: String(i), label: mLong(m) }))} className="w-full sm:w-52" />
        <p className="text-[12.5px] text-ink-3">Variance: expenses + = under budget · revenue + = ahead of target. YTD to {mLong(d.months[Math.max(0, Math.min(11, d.current_month_index))])}.</p>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                <th className="h-10 pl-4 pr-3 text-left font-semibold">Line</th>
                <th className="px-3 text-right font-semibold">{mLabel(d.months[mi])} budget</th>
                <th className="px-3 text-right font-semibold">{mLabel(d.months[mi])} actual</th>
                <th className="hidden px-3 text-right font-semibold md:table-cell">YTD budget</th>
                <th className="hidden px-3 text-right font-semibold md:table-cell">YTD actual</th>
                <th className="px-3 text-right font-semibold">YTD var.</th>
                <th className="hidden px-3 text-right font-semibold lg:table-cell">Var %</th>
                <th className="hidden pl-3 pr-4 text-right font-semibold xl:table-cell">FY budget</th>
              </tr>
            </thead>
            <tbody>
              {section('Expenses', d.expense, 'expense')}
              {section('Revenue', d.revenue, 'revenue')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ---------------- unbudgeted ---------------- */
function Unbudgeted({ d }: { d: BudgetStatement }) {
  const [show, setShow] = useState<'all' | 'no_budget' | 'over_budget'>('all')
  const rows = d.unbudgeted.filter((u) => show === 'all' || u.reason === show)
  const SRC: Record<UnbudgetedItem['source'], string> = { ledger: 'Ledger', expense: 'Expense claim', bill: 'Vendor bill', po: 'Purchase order' }
  const cols: Column<UnbudgetedItem>[] = [
    { key: 'date', header: 'Date', width: '92px', sortValue: (u) => u.date, cell: (u) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(u.date)}</span> },
    {
      key: 'desc', header: 'Spend', sortValue: (u) => u.description,
      cell: (u) => (
        <div className="min-w-0 max-w-[460px]">
          <div className="truncate text-ink">{u.description}</div>
          <div className="truncate text-[12px] text-ink-3">{u.category} · {SRC[u.source]}{u.state === 'committed' ? ' · approved, unpaid' : u.state === 'commitment' ? ' · approved commitment' : ''}{u.justification ? ` · “${u.justification}”` : ''}</div>
        </div>
      ),
    },
    { key: 'why', header: 'Why flagged', sortValue: (u) => u.reason, cell: (u) => <Badge tone={u.reason === 'no_budget' ? 'danger' : 'warning'} size="sm">{u.reason === 'no_budget' ? 'No budget' : 'Over budget'}</Badge> },
    { key: 'by', header: 'Approved by', hideBelow: 'lg', sortValue: (u) => u.approved_by_name, cell: (u) => <span className="text-ink-2">{u.approved_by_name}</span> },
    { key: 'amount', header: 'Amount', align: 'right', hideBelow: 'md', sortValue: (u) => u.amount, cell: (u) => <Money value={u.amount} muted /> },
    { key: 'excess', header: 'Beyond budget', align: 'right', sortValue: (u) => u.excess, cell: (u) => <Money value={u.excess} className={cn('font-medium', u.counted ? 'text-danger-text' : 'text-ink-2')} /> },
  ]
  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Segmented size="sm" value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'over_budget', label: 'Over budget' }, { value: 'no_budget', label: 'No budget' }]} />
        <p className="text-[12.5px] text-ink-3">Spend in each month beyond that month’s budget, or in categories with no budget. Approved POs are shown for context and not added to the total.</p>
      </div>
      <DataTable
        rows={rows}
        columns={cols}
        rowKey={(u) => u.key}
        initialSort={{ key: 'date', dir: 'desc' }}
        dense
        empty={<EmptyState title="Everything is within budget" body="No spend beyond the plan this year." compact />}
        footer={rows.length ? (
          <tr>
            <td className="py-2.5 pl-4 pr-3" colSpan={2}>Total beyond budget (excluding POs)</td>
            <td />
            <td className="hidden lg:table-cell" />
            <td className="hidden md:table-cell" />
            <td className="py-2.5 pl-3 pr-4 text-right"><Money value={rows.filter((u) => u.counted).reduce((a, u) => a + u.excess, 0)} className="text-danger-text" /></td>
          </tr>
        ) : undefined}
        mobileCard={(u) => (
          <div>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 break-words text-[14px] font-medium leading-snug">{u.description}</div>
                <Meta>{fmtDate(u.date)} · {u.category}</Meta>
                <Meta>Approved by {u.approved_by_name}</Meta>
              </div>
              <Money value={u.excess} className={cn('shrink-0 text-[14px] font-semibold', u.counted && 'text-danger-text')} />
            </div>
            <div className="mt-2"><Badge tone={u.reason === 'no_budget' ? 'danger' : 'warning'} size="sm">{u.reason === 'no_budget' ? 'No budget' : 'Over budget'}</Badge></div>
          </div>
        )}
      />
    </div>
  )
}

/* ---------------- phasing ---------------- */
function Phasing({ d, readOnly, onEdit }: { d: BudgetStatement; readOnly: boolean; onEdit: (l: BudgetLine | { kind: 'expense' | 'revenue' }) => void }) {
  const block = (title: string, lines: BudgetLine[], kind: 'expense' | 'revenue') => (
    <Card pad={false} className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {!readOnly && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onEdit({ kind })}>Add line</Button>}
      </div>
      {/* desktop: 12-month grid */}
      <div className="hidden overflow-x-auto scroll-thin md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
              <th className="sticky left-0 z-[1] h-9 bg-surface pl-4 pr-3 text-left font-semibold">Category</th>
              {d.months.map((m) => <th key={m} className="px-2 text-right font-semibold">{mLabel(m)}</th>)}
              <th className="pl-2 pr-4 text-right font-semibold">FY total</th>
            </tr>
          </thead>
          <tbody>
            {lines.filter((l) => l.has_budget).map((l) => (
              <tr key={l.category} onClick={readOnly ? undefined : () => onEdit(l)} className={cn('border-b border-line last:border-0', !readOnly && 'cursor-pointer hover:bg-surface-2/70')}>
                <td className="sticky left-0 z-[1] max-w-[200px] truncate bg-surface py-2.5 pl-4 pr-3 text-ink">{l.label}</td>
                {l.monthly_budget.map((v, i) => <td key={i} className="px-2 text-right"><span className={cn('tnum whitespace-nowrap', !v && 'text-ink-3')}>{v ? fmtMoneyCompact(v) : '—'}</span></td>)}
                <td className="pl-2 pr-4 text-right font-medium"><Money value={l.budget_total} compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* phone: list */}
      <ul className="divide-y divide-line md:hidden">
        {lines.filter((l) => l.has_budget).map((l) => (
          <li key={l.category}>
            <button type="button" disabled={readOnly} onClick={() => onEdit(l)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{l.label}</span>
                <span className="block truncate text-[12.5px] text-ink-3">{fmtMoneyCompact(Math.round(l.budget_total / 12))} a month on average</span>
              </span>
              <Money value={l.budget_total} compact className="font-semibold" />
            </button>
          </li>
        ))}
      </ul>
      {!lines.some((l) => l.has_budget) && <EmptyState title="No lines yet" body={kind === 'expense' ? 'Add a budget for salaries, rent, tools, travel…' : 'Set a revenue target per stream.'} compact />}
    </Card>
  )
  return (
    <div className="space-y-4">
      {block('Expense budgets', d.expense, 'expense')}
      {block('Revenue targets', d.revenue, 'revenue')}
    </div>
  )
}

/* ---------------- dialogs ---------------- */
function BudgetDialog({ fy, d, line, kind, onClose }: { fy: number; d: BudgetStatement; line: BudgetLine | null; kind: 'expense' | 'revenue'; onClose: () => void }) {
  const meta = useSpendMeta()
  const { confirm } = useConfirm()
  const [category, setCategory] = useState(line?.category ?? '')
  const [monthly, setMonthly] = useState<number[]>(line?.has_budget ? [...line.monthly_budget] : Array(12).fill(0))
  const [owner, setOwner] = useState<string | null>(line?.owner_id ?? null)
  const [notes, setNotes] = useState(line?.notes ?? '')
  const [annual, setAnnual] = useState(0)
  const fe = useFieldErrors()
  // Budgets can be maker-checked (entity `budget`): responses are applied or pending.
  const save = useMut(() => guarded('PUT', '/budgets', { fy_start_year: fy, kind, category, owner_id: owner, monthly_paise: monthly, notes }, line?.version ?? undefined), { invalidate: [...SPEND_INVALIDATE, ['changes']], onSuccess: (r) => { announce(r, 'Budget saved'); onClose() }, onError: (e) => fe.take(e) })
  const del = useMut(() => guarded('DELETE', `/budgets/${line!.id!}`, undefined, line!.version ?? undefined), { invalidate: [...SPEND_INVALIDATE, ['changes']], onSuccess: (r) => { announce(r, 'Budget line removed'); onClose() } })
  const taken = new Set((kind === 'expense' ? d.expense : d.revenue).filter((l) => l.has_budget).map((l) => l.category.toLowerCase()))
  const options = kind === 'expense'
    ? (meta.data?.budget_categories ?? []).filter((c) => !taken.has(c.toLowerCase()) || c === line?.category).map((c) => ({ value: c, label: c }))
    : Object.entries(STREAM).filter(([k]) => !taken.has(k) || k === line?.category).map(([value, label]) => ({ value, label }))
  // phasing helper — splits an annual figure into 12 equal months (rounded to the rupee, remainder in March)
  const spread = (total: number) => {
    const each = Math.floor(total / 12 / 100) * 100
    setMonthly(Array.from({ length: 12 }, (_, i) => (i === 11 ? total - each * 11 : each)))
  }
  const total = monthly.reduce((a, b) => a + b, 0)
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={line?.has_budget ? `${line.label} · ${d.fy_label}` : `New ${kind} budget · ${d.fy_label}`}
      description={kind === 'expense' ? 'Phase the budget by month so overspend shows in the month it happens.' : 'Monthly revenue target for this stream.'}
      footer={
        <>
          {line?.id && <Button variant="outline-danger" disabled={!!line.pending_change} onClick={async () => (await confirm({ title: `Remove the ${line.label} budget?`, body: 'Its spend will show as unbudgeted.', confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(undefined)} className="sm:mr-auto">Remove line</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!!line?.pending_change}>Save budget</Button>
        </>
      }
    >
      {line?.pending_change && <PendingNote p={line.pending_change} what="A change to this budget is" className="mb-4" />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={kind === 'expense' ? 'Category' : 'Revenue stream'} required error={fe.errors.category}>
          {line?.has_budget ? <Input value={line.label} disabled /> : <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Choose…" options={options} invalid={!!fe.errors.category} />}
        </Field>
        <Field label="Owner">
          <PeoplePicker value={owner} onChange={setOwner} clearable placeholder="Who watches this line" />
        </Field>
      </div>
      <div className="mt-4 flex flex-col gap-2 rounded-md border border-line bg-surface-2/50 p-3 sm:flex-row sm:items-end">
        <Field label="Annual amount" className="flex-1">
          <MoneyInput value={annual} onChange={setAnnual} />
        </Field>
        <Button onClick={() => spread(annual)} disabled={!annual}>Spread evenly</Button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {d.months.map((m, i) => (
          <Field key={m} label={mLong(m)}>
            <MoneyInput value={monthly[i]} onChange={(v) => setMonthly((x) => x.map((y, j) => (j === i ? v : y)))} />
          </Field>
        ))}
      </div>
      {fe.errors.monthly_paise && <p className="mt-2 text-[12.5px] font-medium text-danger-text">{fe.errors.monthly_paise}</p>}
      <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3 text-[13.5px]">
        <span className="text-ink-2">FY total</span>
        <span className="tnum font-semibold">{fmtMoney(total)}</span>
      </div>
      {line && line.fy_actual > 0 && <p className="mt-1 text-[12.5px] text-ink-3">Actual so far this FY: {fmtMoney(line.fy_actual)} ({fmtPct(total ? line.fy_actual / total : null)} of budget)</p>}
      <Field label="Notes" className="mt-4">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Assumptions behind this number" />
      </Field>
    </Dialog>
  )
}

function CopyDialog({ fy, onClose }: { fy: number; onClose: () => void }) {
  const [growth, setGrowth] = useState('10')
  const [overwrite, setOverwrite] = useState(false)
  const copy = useMut(() => guarded<{ created: number; replaced: number; skipped: number }>('POST', '/budgets/copy', { from_fy: fy - 1, to_fy: fy, growth_pct: Number(growth || 0), overwrite }), {
    invalidate: [...SPEND_INVALIDATE, ['changes']],
    onSuccess: (r) => {
      announce(r, isPending(r) ? '' : `${r.result.created} lines added${r.result.replaced ? `, ${r.result.replaced} replaced` : ''}${r.result.skipped ? `, ${r.result.skipped} kept` : ''}`)
      onClose()
    },
  })
  return (
    <Dialog open size="sm" onOpenChange={(o) => !o && onClose()} title={`Copy ${fyLabel(fy - 1)} to ${fyLabel(fy)}`} description="Every line and its monthly phasing is copied, scaled by the growth you set." footer={<Button variant="primary" onClick={() => copy.mutate(undefined)} loading={copy.isPending}>Copy budget</Button>}>
      <div className="space-y-4">
        <Field label="Growth" hint="Use a negative number to cut, e.g. −5.">
          <Input type="number" value={growth} onChange={(e) => setGrowth(e.target.value)} suffix="%" className="tnum" />
        </Field>
        <Switch checked={overwrite} onChange={setOverwrite} label="Replace lines that already exist" description={`Off keeps the ${fyLabel(fy)} lines you have already set.`} />
      </div>
    </Dialog>
  )
}
