// CEO view of profit margins across all projects (Feature Guide §6, checklist G6.10/G6.11): the same planned / projected /
// actual numbers as each project's Costing & margin tab, one row per project. Visible only with margins.view. `ProfitMarginsCard` is the compact card for
// the CEO dashboard; `MarginsTable` and `marginsExport` are shared with the full /finance/margins page.
import { useNavigate } from 'react-router-dom'
import { costingApi, type PortfolioMargins, type PortfolioMarginRow } from '@/api/projects'
import { useApi } from '@/api/query'
import { PROJECT_TYPE } from '@/domain/labels'
import { commercialShort } from '@/domain/costing'
import { fmtMoney, fmtMoneyCompact, fmtPct } from '@/domain/money'
import type { ExportTable } from '@/reports/export'
import { cn } from '@/lib/utils'
import { Badge, Card, CardHeader, EmptyState, ErrorState, SkeletonRows, useCan } from '@/ui'
import { TONE_TEXT } from '@/ui/data'

export function useMargins(scope: PortfolioMargins['scope'] = 'active', enabled = true) {
  return useApi(['margins', scope], () => costingApi.margins(scope), { enabled })
}

const marginClass = (v: number | null, floor: number) => (v === null ? 'text-ink-3' : v < 0 || v < floor / 100 ? TONE_TEXT.danger : TONE_TEXT.success)
const scopeWord = (s: PortfolioMargins['scope']) => (s === 'active' ? 'active' : s === 'open' ? 'open' : '')

export function MarginKpis({ d, size = 'md' }: { d: PortfolioMargins; size?: 'md' | 'lg' }) {
  const k = d.kpis
  const items = [
    { label: `Contract value, ${k.projects} ${scopeWord(d.scope)} project${k.projects === 1 ? '' : 's'}`.replace('  ', ' '), value: fmtMoney(k.contract_value), cls: 'text-ink' },
    { label: 'Projected gross profit', value: fmtMoney(k.projected_profit), cls: k.projected_profit < 0 ? TONE_TEXT.danger : TONE_TEXT.success },
    { label: 'Projected gross margin', value: fmtPct(k.projected_margin), cls: marginClass(k.projected_margin, d.floor_pct) },
    { label: `Actual margin (invoiced ${fmtMoney(k.invoiced ?? 0)} vs approved hours)`, value: fmtPct(k.actual_margin), cls: marginClass(k.actual_margin, d.floor_pct) },
  ]
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <div className={cn('tnum whitespace-nowrap font-semibold leading-tight tracking-[-0.01em]', size === 'lg' ? 'text-[24px]' : 'text-[20px] md:text-[22px]', i.cls)}>{i.value}</div>
          <div className="mt-1 text-[12.5px] leading-snug text-ink-3">{i.label}</div>
        </div>
      ))}
    </div>
  )
}

const sub = (r: PortfolioMarginRow) => `${commercialShort(r.billing_model)}, ${PROJECT_TYPE[r.type].toLowerCase()}, ${fmtPct(r.pct_complete, 0)} done`

export function MarginsTable({ d }: { d: PortfolioMargins }) {
  const nav = useNavigate()
  const open = (r: PortfolioMarginRow) => nav(`/projects/${r.project_id}/costing`)
  const delta = (r: PortfolioMarginRow) =>
    r.margin_delta_pts === null ? null : (
      <span className={cn('tnum block text-[12px] font-medium', r.margin_delta_pts >= 0 ? 'text-success-text' : 'text-danger-text')}>
        {r.margin_delta_pts >= 0 ? '+' : '−'}{Math.abs(r.margin_delta_pts).toFixed(1)} pts
      </span>
    )
  if (!d.rows.length) return <EmptyState compact title="No projects in this view" body="Projects with a contract value appear here with their planned, projected and actual margins." />
  const TH = 'whitespace-nowrap px-2.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3'
  return (
    <>
      <div className="-mx-4 hidden overflow-x-auto px-4 scroll-thin md:-mx-5 md:block md:px-5">
        <table className="w-full min-w-[920px] text-[13.5px]">
          <thead className="bg-surface-2/60">
            <tr>
              <th className={cn(TH, 'text-left')}>Project</th>
              <th className={cn(TH, 'text-right')}>Contract</th>
              <th className={cn(TH, 'text-right')}>Planned margin</th>
              <th className={cn(TH, 'text-right')}>Projected margin</th>
              <th className={cn(TH, 'text-right')}>Actual margin</th>
              <th className={cn(TH, 'text-right')}>Projected profit</th>
              <th className={cn(TH, 'text-right')}>Cost to date</th>
              <th className={cn(TH, 'text-right')}>Projected cost</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.project_id} onClick={() => open(r)} className="cursor-pointer border-b border-line align-top last:border-0 hover:bg-surface-2/50">
                <td className="min-w-[180px] px-3 py-2.5">
                  <div className="font-medium text-ink">{r.name}</div>
                  <div className="text-[12px] text-ink-3">{sub(r)}</div>
                </td>
                <td className="tnum whitespace-nowrap px-2.5 py-2.5 text-right">{fmtMoney(r.contract)}</td>
                <td className="tnum whitespace-nowrap px-2.5 py-2.5 text-right">{fmtPct(r.planned_margin)}</td>
                <td className="whitespace-nowrap px-2.5 py-2.5 text-right">
                  <span className={cn('tnum font-semibold', marginClass(r.projected_margin, d.floor_pct))}>{fmtPct(r.projected_margin)}</span>
                  {delta(r)}
                </td>
                <td className="tnum whitespace-nowrap px-2.5 py-2.5 text-right">
                  {fmtPct(r.actual_margin)}
                  <span className="block text-[12px] text-ink-3">{r.invoiced ? `${fmtMoneyCompact(r.invoiced)} invoiced` : 'nothing invoiced'}</span>
                </td>
                <td className={cn('tnum whitespace-nowrap px-2.5 py-2.5 text-right font-semibold', r.projected_profit < 0 ? 'text-danger-text' : 'text-success-text')}>{fmtMoney(r.projected_profit)}</td>
                <td className="tnum whitespace-nowrap px-2.5 py-2.5 text-right">{fmtMoney(r.cost_to_date)}</td>
                <td className="tnum whitespace-nowrap px-2.5 py-2.5 text-right">{fmtMoney(r.projected_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line md:hidden">
        {d.rows.map((r) => (
          <li key={r.project_id}>
            <button type="button" onClick={() => open(r)} className="block w-full py-3 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium leading-snug text-ink">{r.name}</div>
                  <div className="text-[12px] text-ink-3">{sub(r)}</div>
                </div>
                <div className="shrink-0 text-right">
                  <span className={cn('tnum text-[15px] font-semibold', marginClass(r.projected_margin, d.floor_pct))}>{fmtPct(r.projected_margin)}</span>
                  {delta(r)}
                </div>
              </div>
              <dl className="tnum mt-2 grid grid-cols-3 gap-2 text-[12px]">
                <div className="min-w-0"><dt className="text-ink-3">Contract</dt><dd className="truncate">{fmtMoney(r.contract)}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Planned</dt><dd>{fmtPct(r.planned_margin)}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Actual</dt><dd>{fmtPct(r.actual_margin)}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Profit</dt><dd className="truncate">{fmtMoney(r.projected_profit)}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Cost to date</dt><dd className="truncate">{fmtMoney(r.cost_to_date)}</dd></div>
                <div className="min-w-0"><dt className="text-ink-3">Proj. cost</dt><dd className="truncate">{fmtMoney(r.projected_cost)}</dd></div>
              </dl>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">Planned = contract value vs allocation and estimates; projected = contract incl. approved CRs vs actual so far + what’s left (±pts against planned); actual = invoiced amount vs approved hours only. Tap a project to drill into its costing, resources and milestones.</p>
    </>
  )
}

/** Export table for ExportMenu (PDF / Excel / CSV). */
export function marginsExport(d: PortfolioMargins): ExportTable {
  return {
    title: 'Profit margins',
    subtitle: d.scope === 'active' ? 'Active projects' : d.scope === 'open' ? 'Open projects' : 'All projects',
    category: 'Finance report',
    orientation: 'landscape',
    columns: [
      { key: 'project', label: 'Project', type: 'string' },
      { key: 'model', label: 'Model', type: 'string' },
      { key: 'done', label: '% done', type: 'percent' },
      { key: 'contract', label: 'Contract', type: 'money' },
      { key: 'planned', label: 'Planned margin', type: 'percent' },
      { key: 'projected', label: 'Projected margin', type: 'percent' },
      { key: 'delta', label: 'Change (pts)', type: 'number' },
      { key: 'actual', label: 'Actual margin', type: 'percent' },
      { key: 'invoiced', label: 'Invoiced', type: 'money' },
      { key: 'profit', label: 'Projected profit', type: 'money' },
      { key: 'ctd', label: 'Cost to date', type: 'money' },
      { key: 'pcost', label: 'Projected cost', type: 'money' },
    ],
    rows: d.rows.map((r) => ({
      project: `${r.code} ${r.name}`, model: `${commercialShort(r.billing_model)} ${PROJECT_TYPE[r.type]}`, done: r.pct_complete, contract: r.contract, planned: r.planned_margin, projected: r.projected_margin,
      delta: r.margin_delta_pts, actual: r.actual_margin, invoiced: r.invoiced ?? 0, profit: r.projected_profit, ctd: r.cost_to_date, pcost: r.projected_cost,
    })),
    totals: { contract: d.kpis.contract_value, profit: d.kpis.projected_profit, ctd: d.kpis.cost_to_date, pcost: d.rows.reduce((s, r) => s + r.projected_cost, 0) },
    kpis: [
      { label: 'Contract value', value: fmtMoney(d.kpis.contract_value) },
      { label: 'Projected gross profit', value: fmtMoney(d.kpis.projected_profit) },
      { label: 'Projected gross margin', value: fmtPct(d.kpis.projected_margin) },
      { label: 'Actual margin', value: fmtPct(d.kpis.actual_margin) },
    ],
    notes: [
      'Planned: revenue = contract value; cost = allocation and estimates (plus the saved costing extras). What did we expect to make?',
      'Projected: revenue = contract value incl. approved CRs; cost = actual so far + what is left. Where are we heading?',
      'Actual: revenue = invoiced amount; cost = approved hours only. What have we really made?',
      'Cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day). Margin = profit ÷ price; markup = profit ÷ cost.',
    ],
  }
}

/** Compact card for the CEO dashboard (workstream D places it). Hidden for people without margins.view. */
export function ProfitMarginsCard({ scope = 'active', className }: { scope?: PortfolioMargins['scope']; className?: string }) {
  const can = useCan()
  const allowed = can('margins.view')
  const q = useMargins(scope, allowed)
  if (!allowed) return null
  return (
    <Card className={className}>
      <CardHeader title={<span className="inline-flex flex-wrap items-center gap-2">Profit margins <Badge size="sm">CEO and margins permission</Badge></span>} subtitle="CEO view of profit margins across all projects." />
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="mb-4 border-b border-line pb-4">
            <MarginKpis d={q.data} />
          </div>
          <MarginsTable d={q.data} />
        </>
      )}
    </Card>
  )
}
