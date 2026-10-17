// Shared renderers for a ReportResult: chart (all ChartKinds), table with totals, "how this was
// computed" chips, and the ExportTable builder. Used by the builder, viewer, library and AI answers.
import { useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { ArrowDownRight, ArrowUpRight, Calendar, Database, Filter, Layers, Sigma, SortDesc } from '@/ui/icons'
import type { ReportSpec } from '@/types/reports'
import type { ReportColumnX, ReportResultX } from '@/reports/engine'
import { describeSpec } from '@/reports/engine'
import { fmtCell } from '@/reports/narrative'
import type { ExportColType, ExportTable } from '@/reports/export'
import { BarChart, DonutChart, LineChart, SERIES, fmtValue, type SeriesDef, type ValueFormat } from '@/ui'
import { cn } from '@/lib/utils'
import { fmtPct } from '@/domain/money'

export const fmtOf = (c: Pick<ReportColumnX, 'type' | 'unit'> | undefined): ValueFormat => (c?.type === 'money' ? 'money' : c?.type === 'percent' ? 'percent' : c?.unit === 'hours' ? 'hours' : 'number')

const MAX_CATS = 24

/** Pivot a 2-dimension result (x = dim0, series = dim1) for the first measure. */
function pivot(res: ReportResultX) {
  const dims = res.columns.filter((c) => c.role === 'dimension')
  const m = res.columns.find((c) => c.role === 'measure')!
  const [dx, ds] = dims
  const xs: string[] = []
  const ss: string[] = []
  const map = new Map<string, Record<string, unknown>>()
  for (const r of res.rows) {
    const x = String(r[dx.key])
    const s = String(r[ds.key])
    if (!map.has(x)) {
      map.set(x, { __x: x })
      xs.push(x)
    }
    if (!ss.includes(s)) ss.push(s)
    map.get(x)![s] = r[m.key]
  }
  // keep series order by total desc, cap at 7 (rest folded into "Other")
  const tot = new Map(ss.map((s) => [s, xs.reduce((a, x) => a + (Number(map.get(x)![s]) || 0), 0)]))
  const sorted = [...ss].sort((a, b) => (tot.get(b) ?? 0) - (tot.get(a) ?? 0))
  const keep = sorted.slice(0, 7)
  const rest = sorted.slice(7)
  const data = xs.map((x) => {
    const row = map.get(x)!
    const out: Record<string, unknown> = { __x: x }
    keep.forEach((s, i) => (out[`s${i}`] = Number(row[s]) || 0))
    if (rest.length) out.__other = rest.reduce((a, s) => a + (Number(row[s]) || 0), 0)
    return out
  })
  const series: SeriesDef[] = keep.map((s, i) => ({ key: `s${i}`, label: s }))
  if (rest.length) series.push({ key: '__other', label: 'Other' })
  return { data, series, format: fmtOf(m), m }
}

export function ReportChart({ res, height = 280, chartRef, compact }: { res: ReportResultX; height?: number; chartRef?: RefObject<HTMLDivElement>; compact?: boolean }) {
  const kind = res.spec.chart
  const measures = res.columns.filter((c) => c.role === 'measure')
  const dims = res.columns.filter((c) => c.role === 'dimension')
  const inner = useMemo((): ReactNode => {
    if (!res.rows.length && kind !== 'kpi') return <div className="grid h-full place-items-center text-[13px] text-ink-3">No data for this period.</div>
    if (kind === 'kpi' || (!dims.length && measures.length)) return <KpiTiles res={res} compact={compact} />
    if (!measures.length || kind === 'table') return null
    const m = measures[0]
    const fmt = fmtOf(m)
    if (dims.length === 2) {
      const p = pivot(res)
      if (kind === 'line' || kind === 'area') return <LineChart data={p.data} x="__x" series={p.series} height={height} format={p.format} area={kind === 'area'} />
      return <BarChart data={p.data} x="__x" series={p.series} height={height} format={p.format} stacked={kind === 'stacked'} horizontal={kind === 'hbar'} />
    }
    const d = dims[0]
    const rows = res.rows.slice(0, d.grain ? 400 : MAX_CATS)
    if (kind === 'pie') {
      const pos = rows.filter((r) => typeof r[m.key] === 'number' && (r[m.key] as number) > 0)
      const top = pos.slice(0, 7)
      const other = pos.slice(7).reduce((a, r) => a + (r[m.key] as number), 0)
      const data = [...top.map((r, i) => ({ name: String(r[d.key]), value: r[m.key] as number, color: SERIES[i % SERIES.length] })), ...(other > 0 ? [{ name: 'Other', value: other, color: 'var(--ink-3)' }] : [])]
      const total = data.reduce((a, x) => a + x.value, 0)
      return (
        <DonutChart
          data={data}
          height={compact ? 150 : Math.min(240, height)}
          format={fmt}
          center={
            <div>
              <div className="tnum text-[15px] font-semibold tracking-tight">{fmtValue(total, fmt, true)}</div>
              <div className="text-[11px] text-ink-3">total</div>
            </div>
          }
        />
      )
    }
    // several measures of the same format → multi-series; otherwise first measure only
    const same = measures.filter((x) => fmtOf(x) === fmt).slice(0, 4)
    const series: SeriesDef[] = same.map((x) => ({ key: x.key, label: x.label }))
    const data = rows.map((r) => ({ ...r, __x: String(r[d.key]) }))
    if (kind === 'line' || kind === 'area') return <LineChart data={data} x="__x" series={series} height={height} format={fmt} area={kind === 'area'} />
    const horizontal = kind === 'hbar'
    const h = horizontal ? Math.max(height, Math.min(560, rows.length * (series.length > 1 ? 34 : 28) + 40)) : height
    return <BarChart data={data} x="__x" series={series} height={h} format={fmt} horizontal={horizontal} stacked={kind === 'stacked'} />
  }, [res, kind, height, compact, dims, measures])
  if (inner === null) return null
  return (
    <div ref={chartRef} className="min-w-0">
      {inner}
    </div>
  )
}

function KpiTiles({ res, compact }: { res: ReportResultX; compact?: boolean }) {
  const ms = res.columns.filter((c) => c.role === 'measure')
  return (
    <div className={cn('grid gap-3', ms.length === 1 ? 'grid-cols-1' : ms.length === 2 ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-4')}>
      {ms.map((m) => {
        const v = res.totals[m.key]
        const prev = res.totalsPrev?.[m.key]
        const ch = typeof v === 'number' && typeof prev === 'number' && prev ? (v - prev) / Math.abs(prev) : null
        return (
          <div key={m.key} className={cn('min-w-0 rounded-lg border border-line bg-surface p-4', compact && 'p-3')}>
            <div className="text-[12.5px] leading-snug text-ink-3">{m.label}</div>
            <div className={cn('tnum mt-2 truncate whitespace-nowrap font-semibold tracking-[-0.01em]', compact ? 'text-[20px]' : 'text-[22px]')}>{fmtCell(v, m)}</div>
            {res.totalsPrev && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
                {ch !== null ? (
                  <span className={cn('tnum inline-flex items-center font-medium', ch >= 0 ? 'text-success-text' : 'text-danger-text')}>
                    {ch >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
                    {fmtPct(Math.abs(ch))}
                  </span>
                ) : null}
                <span>
                  vs {fmtCell(prev ?? null, m)} {res.previousLabel ? `in ${res.previousLabel}` : ''}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Data table with right-aligned numbers and a totals row. */
export function ReportTable({ res, maxRows, dense, className }: { res: ReportResultX; maxRows?: number; dense?: boolean; className?: string }) {
  const cols = res.columns
  const rows = maxRows ? res.rows.slice(0, maxRows) : res.rows
  const num = (c: ReportColumnX) => c.type === 'money' || c.type === 'number' || c.type === 'percent'
  const hasTotals = cols.some((c) => res.totals[c.key] !== undefined && res.totals[c.key] !== null)
  const totalApplies = (c: ReportColumnX) => res.totals[c.key] !== undefined && res.totals[c.key] !== null
  if (!rows.length) return <div className="px-4 py-10 text-center text-[13px] text-ink-3">No rows match. Widen the period or remove a filter.</div>
  return (
    <div className={cn('overflow-x-auto scroll-thin', className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-[1]">
          <tr className="border-b border-line bg-surface-2">
            {cols.map((c) => (
              <th key={c.key} className={cn('h-9 whitespace-nowrap px-3 text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3 first:pl-4 last:pr-4', num(c) ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0 hover:bg-surface-2/50">
              {cols.map((c, j) => {
                const v = r[c.key]
                const chg = c.role === 'compare' && c.type === 'percent' && typeof v === 'number'
                return (
                  <td key={c.key} className={cn('whitespace-nowrap px-3 first:pl-4 last:pr-4', dense ? 'py-1.5' : 'py-2.5', num(c) ? 'tnum text-right' : 'max-w-[320px] truncate', j === 0 && 'font-medium', chg && ((v as number) >= 0 ? 'text-success-text' : 'text-danger-text'))} title={typeof v === 'string' ? v : undefined}>
                    {chg ? `${(v as number) >= 0 ? '+' : '−'}${fmtPct(Math.abs(v as number))}` : fmtCell(v, c)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-t border-line-strong font-semibold">
              {cols.map((c, j) => (
                <td key={c.key} className={cn('whitespace-nowrap px-3 py-2.5 first:pl-4 last:pr-4', num(c) && 'tnum text-right')}>
                  {j === 0 ? (res.rowCount > rows.length ? `Total (${res.rowCount} rows)` : 'Total') : totalApplies(c) ? fmtCell(res.totals[c.key], c) : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {maxRows && res.rows.length > maxRows && <div className="border-t border-line px-4 py-2 text-[12px] text-ink-3">Showing {maxRows} of {res.rows.length} rows. Open the report for everything.</div>}
    </div>
  )
}

/** Readable chips for a spec: dataset, measures, groupings, filters, period, sort. */
export function SpecChips({ spec, className }: { spec: ReportSpec; className?: string }) {
  const d = describeSpec(spec)
  const chip = (icon: ReactNode, label: string, value: string, key: string) => (
    <span key={key} className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-line bg-surface px-2 py-1 text-[12px] text-ink-2">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="truncate font-medium text-ink">{value}</span>
    </span>
  )
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {chip(<Database />, 'Data', d.dataset, 'ds')}
      {d.measures.map((m, i) => chip(<Sigma />, 'Measure', m, 'm' + i))}
      {!d.measures.length && chip(<Sigma />, 'Rows', 'Listing', 'm')}
      {d.dimensions.map((m, i) => chip(<Layers />, 'Group by', m, 'd' + i))}
      {d.filters.map((m, i) => chip(<Filter />, 'Filter', m, 'f' + i))}
      {chip(<Calendar />, 'Period', d.period, 'p')}
      {d.sort && chip(<SortDesc />, 'Sort', d.sort, 's')}
      {spec.compare === 'previous_period' && chip(<Calendar />, 'Compare', 'Previous period', 'c')}
    </div>
  )
}

const CATEGORY: Record<string, string> = {
  ledger: 'Finance report', invoices: 'Finance report', payroll: 'Payroll report',
  projects: 'Delivery report', milestones: 'Delivery report', tasks: 'Delivery report', hours: 'Delivery report', allocations: 'Resourcing report',
  deals: 'Sales report', deal_activities: 'Sales report', people: 'People report', ops: 'Operations report',
}

const exportType = (c: ReportColumnX): ExportColType => (c.type === 'money' ? 'money' : c.type === 'percent' ? 'percent' : c.type === 'date' ? 'date' : c.unit === 'hours' ? 'hours' : c.type === 'number' ? 'number' : 'string')

/** Builds the corporate export for a result. KPIs = measure totals (with previous period). */
export function toExportTable(res: ReportResultX, opts: { title?: string; subtitle?: string; chartEl?: HTMLElement | null; notes?: string[] } = {}): ExportTable {
  const measures = res.columns.filter((c) => c.role === 'measure')
  const kpis = measures.slice(0, 4).map((m) => {
    const v = res.totals[m.key]
    const prev = res.totalsPrev?.[m.key]
    const ch = typeof v === 'number' && typeof prev === 'number' && prev ? (v - prev) / Math.abs(prev) : null
    return { label: m.label, value: fmtCell(v, m) + (ch !== null ? `  (${ch >= 0 ? '+' : '−'}${fmtPct(Math.abs(ch))})` : '') }
  })
  const rows = res.rows.map((r) => Object.fromEntries(res.columns.map((c) => [c.key, typeof r[c.key] === 'boolean' ? (r[c.key] ? 'Yes' : 'No') : r[c.key]])))
  const totals: Record<string, number | null> = {}
  for (const c of res.columns) if (res.totals[c.key] !== undefined) totals[c.key] = res.totals[c.key]
  const svg = opts.chartEl?.querySelector('svg.recharts-surface') as SVGSVGElement | null
  return {
    title: opts.title ?? res.spec.title,
    subtitle: opts.subtitle ?? res.periodLabel,
    columns: res.columns.map((c) => ({ key: c.key, label: c.label, type: exportType(c) })),
    rows,
    totals,
    kpis,
    notes: [...(opts.notes ?? []), ...res.warnings],
    chartSvg: res.spec.chart !== 'table' && res.spec.chart !== 'kpi' ? svg : null,
    legend: legendFor(res),
    category: CATEGORY[res.spec.dataset] ?? 'Management report',
  }
}

function legendFor(res: ReportResultX): { label: string; color: string }[] | undefined {
  const dims = res.columns.filter((c) => c.role === 'dimension')
  const ms = res.columns.filter((c) => c.role === 'measure')
  if (!ms.length || !dims.length) return undefined
  if (res.spec.chart === 'pie' && dims.length === 1) {
    const pos = res.rows.filter((r) => typeof r[ms[0].key] === 'number' && (r[ms[0].key] as number) > 0)
    return [...pos.slice(0, 7).map((r, i) => ({ label: String(r[dims[0].key]), color: SERIES[i % SERIES.length] })), ...(pos.length > 7 ? [{ label: 'Other', color: 'var(--ink-3)' }] : [])]
  }
  if (dims.length === 1 && ms.length > 1) return ms.slice(0, 4).map((m, i) => ({ label: m.label, color: SERIES[i] }))
  return undefined
}

/** Tiny SVG preview for library cards (no axes). */
export function MiniChart({ preview, kind }: { preview: { labels: string[]; values: number[]; kind: string; value?: number | null; format: string } | null; kind: string }) {
  if (!preview) return <div className="grid h-full place-items-center text-[12px] text-ink-3">Preview unavailable</div>
  const fmt = (preview.format as ValueFormat) ?? 'number'
  if (preview.kind === 'kpi' || preview.kind === 'table' || !preview.values.length)
    return (
      <div className="flex h-full flex-col justify-end">
        <div className="tnum text-[22px] font-semibold tracking-[-0.01em]">{preview.kind === 'table' ? preview.value ?? 0 : fmtValue(preview.value ?? 0, fmt, true)}</div>
        <div className="text-[12px] text-ink-3">{preview.kind === 'table' ? 'rows' : 'total'}</div>
      </div>
    )
  const vals = preview.values.map((v) => Math.max(0, v))
  const max = Math.max(...vals, 1)
  const W = 240
  const H = 72
  if (kind === 'line' || kind === 'area') {
    const pts = vals.map((v, i) => [vals.length === 1 ? W / 2 : (i / (vals.length - 1)) * (W - 4) + 2, H - 4 - (v / max) * (H - 10)])
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
                <path d={d} fill="none" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'pie') {
    const tot = vals.reduce((a, b) => a + b, 0) || 1
    let acc = 0
    const r = 30
    const C = 2 * Math.PI * r
    return (
      <div className="flex h-full items-center gap-3">
        <svg viewBox="0 0 80 80" className="size-[72px] shrink-0 -rotate-90" aria-hidden>
          {vals.slice(0, 7).map((v, i) => {
            const len = (v / tot) * C
            const el = <circle key={i} cx="40" cy="40" r={r} fill="none" stroke={SERIES[i % SERIES.length]} strokeWidth="14" strokeDasharray={`${Math.max(0, len - 1)} ${C}`} strokeDashoffset={-acc} />
            acc += len
            return el
          })}
        </svg>
        <ul className="min-w-0 space-y-0.5 text-[11.5px] text-ink-2">
          {preview.labels.slice(0, 3).map((l, i) => (
            <li key={l} className="flex items-center gap-1.5 truncate">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: SERIES[i] }} />
              <span className="truncate">{l}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const n = Math.min(12, vals.length)
  if (kind === 'hbar') {
    const top = vals.slice(0, 4)
    return (
      <div className="flex h-full flex-col justify-center gap-1.5">
        {top.map((v, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span className="w-16 shrink-0 truncate text-ink-3">{preview.labels[i]}</span>
            <span className="h-2 rounded-sm bg-brand" style={{ width: `${Math.max(4, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    )
  }
  const bw = W / n
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
      {vals.slice(0, n).map((v, i) => {
        const h = Math.max(2, (v / max) * (H - 6))
        return <rect key={i} x={i * bw + bw * 0.18} y={H - h} width={bw * 0.64} height={h} rx="1" fill="var(--brand)" />
      })}
    </svg>
  )
}

export function useChartRef() {
  return useRef<HTMLDivElement>(null)
}
