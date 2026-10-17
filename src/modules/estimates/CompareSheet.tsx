// Side-by-side comparison of up to three estimates (scenarios): price, cost, profit, margin, markup, man-days.
// Numbers from GET /estimates/compare (server-computed with the same calculator as the editor).
import { Link } from 'react-router-dom'
import { estimatesApi, type EstimateCompareItem } from '@/api/estimates'
import { useApi } from '@/api/query'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, ErrorState, Sheet, SkeletonRows, StatusBadge, TONE_TEXT } from '@/ui'
import { ESTIMATE_STATUS, marginTone } from './labels'

type Row = { label: string; value: (x: EstimateCompareItem) => number | null; fmt: (v: number | null) => string; best?: 'max' | 'min'; strong?: boolean; tone?: boolean }

const ROWS: Row[] = [
  { label: 'Price', value: (x) => x.price, fmt: (v) => fmtMoney(v), strong: true },
  { label: 'Total cost', value: (x) => x.total_cost, fmt: (v) => fmtMoney(v), best: 'min' },
  { label: 'People cost', value: (x) => x.resources_cost, fmt: (v) => fmtMoney(v) },
  { label: 'Additional costs', value: (x) => x.additional, fmt: (v) => fmtMoney(v) },
  { label: 'Maintenance / support', value: (x) => x.maintenance, fmt: (v) => fmtMoney(v) },
  { label: 'Contingency', value: (x) => x.contingency, fmt: (v) => fmtMoney(v) },
  { label: 'Profit', value: (x) => x.profit, fmt: (v) => fmtMoney(v), best: 'max', strong: true },
  { label: 'Planned margin', value: (x) => x.margin, fmt: (v) => fmtPct(v), best: 'max', strong: true, tone: true },
  { label: 'Markup', value: (x) => x.markup, fmt: (v) => fmtPct(v) },
  { label: 'Man-days', value: (x) => x.man_days, fmt: (v) => fmtNum(v, 1), best: 'min' },
  { label: 'Working days', value: (x) => x.working_days, fmt: (v) => fmtNum(v) },
  { label: 'People and roles', value: (x) => x.people, fmt: (v) => fmtNum(v) },
  { label: 'Role placeholders', value: (x) => x.role_rows, fmt: (v) => fmtNum(v) },
  { label: 'Milestone billing', value: (x) => x.billing_total, fmt: (v) => fmtMoney(v) },
]

export function CompareSheet({ ids, open, onOpenChange, floorPct }: { ids: string[]; open: boolean; onOpenChange: (o: boolean) => void; floorPct: number }) {
  const q = useApi(['estimates', 'compare', ids.join(',')], () => estimatesApi.compare(ids), { enabled: open && ids.length >= 2 })
  const items = q.data ?? []
  const n = Math.max(2, ids.length)
  return (
    <Sheet open={open} onOpenChange={onOpenChange} width={n === 3 ? 980 : 760} title="Compare estimates" subtitle="Same calculator, side by side. The best value in a row is marked.">
      {q.isLoading ? (
        <SkeletonRows rows={8} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-surface-2/60 align-top">
                <th className="w-[160px] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Estimate</th>
                {items.map((x) => (
                  <th key={x.id} className="min-w-[150px] px-3 py-2.5 text-left font-normal">
                    <Link to={`/projects/cost-calculator/${x.id}`} onClick={() => onOpenChange(false)} className="block font-semibold leading-snug text-ink hover:underline">
                      {x.name}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="tnum text-[12px] text-ink-3">{x.number}</span>
                      <StatusBadge map={ESTIMATE_STATUS} value={x.status} size="sm" />
                      {x.scenario_label && <Badge size="sm">{x.scenario_label}</Badge>}
                    </div>
                    <div className="tnum mt-1 text-[12px] text-ink-3">{fmtDate(x.start_on)} – {fmtDate(x.end_on)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => {
                const vals = items.map((x) => r.value(x))
                const nums = vals.filter((v): v is number => v !== null)
                const best = r.best && nums.length > 1 && new Set(nums).size > 1 ? (r.best === 'max' ? Math.max(...nums) : Math.min(...nums)) : null
                return (
                  <tr key={r.label} className="border-b border-line last:border-0">
                    <th scope="row" className="px-3 py-2 text-left text-[12.5px] font-medium text-ink-2">{r.label}</th>
                    {items.map((x, i) => {
                      const v = vals[i]
                      return (
                        <td key={x.id} className={cn('tnum whitespace-nowrap px-3 py-2', r.strong ? 'font-semibold' : 'text-ink-2', r.tone && TONE_TEXT[marginTone(v, floorPct)])}>
                          {r.fmt(v)}
                          {best !== null && v === best && <Badge size="sm" tone="success" className="ml-1.5 align-middle">Best</Badge>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">Margin = profit ÷ price; markup = profit ÷ cost. Margins below the {floorPct}% floor are shown in red.</p>
    </Sheet>
  )
}
