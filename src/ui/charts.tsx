// Themed Recharts wrappers. Series colours come from the tenant palette tokens (--c1..--c7),
// assigned in fixed order by entity. Axes and grid stay recessive; text uses ink tokens.
import type { ReactNode } from 'react'
import {
  Area, AreaChart as RArea, Bar, BarChart as RBar, CartesianGrid, Cell, Legend, Line, LineChart as RLine, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fmtMoney, fmtMoneyCompact, fmtNum, fmtPct } from '@/domain/money'

export const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)']
/** Colour for series i of n: a lone series wears the brand colour; several use the validated categorical order. */
export const seriesColor = (i: number, n: number, override?: string) => override ?? (n === 1 ? 'var(--brand)' : SERIES[i % SERIES.length])
export type ValueFormat = 'money' | 'number' | 'percent' | 'hours'

export function fmtValue(v: unknown, f: ValueFormat = 'number', compact = false): string {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '—'
  if (f === 'money') return compact ? fmtMoneyCompact(n) : fmtMoney(n)
  if (f === 'percent') return fmtPct(n)
  if (f === 'hours') return `${fmtNum(n, 1)}h`
  return compact && Math.abs(n) >= 1000 ? new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmtNum(n, 2)
}

const axis = { stroke: 'var(--line-strong)', tick: { fill: 'var(--ink-3)', fontSize: 11.5 }, tickLine: false, axisLine: false }

export interface SeriesDef {
  key: string
  label: string
  color?: string
  format?: ValueFormat
  stack?: string
}

function ChartTooltip({ active, payload, label, format, labelFormatter }: { active?: boolean; payload?: { dataKey: string; name: string; value: number; color: string; payload: Record<string, unknown> }[]; label?: string; format: ValueFormat; labelFormatter?: (l: string) => string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-[160px] rounded-lg border border-line bg-elevated px-3 py-2.5 shadow-lg">
      <div className="mb-1.5 text-[12px] font-semibold text-ink-2">{labelFormatter ? labelFormatter(String(label)) : label}</div>
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.dataKey} className="flex items-center justify-between gap-4 text-[12.5px]">
            <span className="flex items-center gap-1.5 text-ink-2">
              <span className="size-2 rounded-[3px]" style={{ background: p.color }} />
              {p.name}
            </span>
            <span className="tnum font-semibold text-ink">{fmtValue(p.value, format)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function legendFmt(v: string) {
  return <span className="text-[12px] font-medium text-ink-2">{v}</span>
}

export function BarChart({ data, x, series, height = 260, format = 'number', horizontal, stacked, labelFormatter, showLegend }: { data: Record<string, unknown>[]; x: string; series: SeriesDef[]; height?: number; format?: ValueFormat; horizontal?: boolean; stacked?: boolean; labelFormatter?: (l: string) => string; showLegend?: boolean }) {
  const legend = showLegend ?? series.length > 1
  return (
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <RBar data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, bottom: 0, left: horizontal ? 8 : -8 }} barCategoryGap={horizontal ? '22%' : '28%'} barGap={2}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={!!horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" {...axis} allowDecimals={format !== 'number'} tickFormatter={(v) => fmtValue(v, format, true)} />
              <YAxis type="category" dataKey={x} {...axis} width={120} tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 17) + '…' : v)} />
            </>
          ) : (
            <>
              <XAxis dataKey={x} {...axis} tickFormatter={labelFormatter} interval="preserveStartEnd" minTickGap={8} />
              <YAxis {...axis} width={56} allowDecimals={format !== 'number'} tickFormatter={(v) => fmtValue(v, format, true)} />
            </>
          )}
          <Tooltip cursor={{ fill: 'var(--surface-2)', opacity: 0.7 }} content={<ChartTooltip format={format} labelFormatter={labelFormatter} />} />
          {legend && <Legend iconType="circle" iconSize={8} wrapperStyle={{ paddingTop: 8 }} formatter={legendFmt} />}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={seriesColor(i, series.length, s.color)}
              stackId={stacked ? 'a' : s.stack}
              radius={stacked ? (i === series.length - 1 ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0) : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              stroke="var(--surface)"
              strokeWidth={stacked ? 1 : 0}
              maxBarSize={horizontal ? 22 : 40}
              isAnimationActive={false}
            />
          ))}
        </RBar>
      </ResponsiveContainer>
    </div>
  )
}

export function LineChart({ data, x, series, height = 260, format = 'number', area, labelFormatter, showLegend }: { data: Record<string, unknown>[]; x: string; series: SeriesDef[]; height?: number; format?: ValueFormat; area?: boolean; labelFormatter?: (l: string) => string; showLegend?: boolean }) {
  const legend = showLegend ?? series.length > 1
  const Chart = area ? RArea : RLine
  return (
    <div style={{ height }} className="w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={seriesColor(i, series.length, s.color)} stopOpacity={0.22} />
                <stop offset="100%" stopColor={seriesColor(i, series.length, s.color)} stopOpacity={0.01} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey={x} {...axis} tickFormatter={labelFormatter} interval="preserveStartEnd" minTickGap={12} />
          <YAxis {...axis} width={56} allowDecimals={format !== 'number'} tickFormatter={(v) => fmtValue(v, format, true)} />
          <Tooltip cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }} content={<ChartTooltip format={format} labelFormatter={labelFormatter} />} />
          {legend && <Legend iconType="circle" iconSize={8} wrapperStyle={{ paddingTop: 8 }} formatter={legendFmt} />}
          {series.map((s, i) =>
            area ? (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={seriesColor(i, series.length, s.color)} strokeWidth={2} fill={`url(#g-${s.key})`} isAnimationActive={false} dot={false} activeDot={{ r: 4.5, stroke: 'var(--surface)', strokeWidth: 2 }} />
            ) : (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={seriesColor(i, series.length, s.color)} strokeWidth={2} isAnimationActive={false} dot={false} activeDot={{ r: 4.5, stroke: 'var(--surface)', strokeWidth: 2 }} />
            ),
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  )
}

export function DonutChart({ data, height = 220, format = 'number', center }: { data: { name: string; value: number; color?: string }[]; height?: number; format?: ValueFormat; center?: ReactNode }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
      <div className="relative shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={({ active, payload }) => (active && payload?.length ? <div className="rounded-lg border border-line bg-elevated px-3 py-2 text-[12.5px] shadow-lg"><span className="font-semibold">{payload[0].name}</span> · <span className="tnum">{fmtValue(payload[0].value, format)}</span> <span className="text-ink-3">({fmtPct((payload[0].value as number) / (total || 1))})</span></div> : null)} />
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="96%" paddingAngle={data.length > 1 ? 1.5 : 0} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={d.name} fill={d.color ?? SERIES[i % SERIES.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {center && <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">{center}</div>}
      </div>
      <ul className="min-w-[200px] flex-1 space-y-1.5">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: d.color ?? SERIES[i % SERIES.length] }} />
              <span className="truncate">{d.name}</span>
            </span>
            <span className="tnum shrink-0 font-semibold text-ink">
              {fmtValue(d.value, format, true)} <span className="font-medium text-ink-3">{fmtPct(d.value / (total || 1), 0)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Accessible table fallback for any chart (CMP-21). */
export function ChartTable({ data, x, series, format = 'number', xLabel }: { data: Record<string, unknown>[]; x: string; series: SeriesDef[]; format?: ValueFormat; xLabel?: string }) {
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-ink-3">
            <th className="py-2 pr-3 font-semibold">{xLabel ?? ''}</th>
            {series.map((s) => (
              <th key={s.key} className="py-2 pl-3 text-right font-semibold">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="py-2 pr-3 font-medium">{String(d[x])}</td>
              {series.map((s) => (
                <td key={s.key} className="tnum py-2 pl-3 text-right">
                  {fmtValue(d[s.key], s.format ?? format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
