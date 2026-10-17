// Builder pieces: dataset picker, field list, chips with popover editors (measure, dimension,
// filter) and the properties panel. Pure UI over a ReportSpec; the page owns state.
import { useMemo, useState, type ReactNode } from 'react'
import { AreaChart, BarChart3, BarChartHorizontal, Calendar, CircleDot, Hash, IndianRupee, LineChart, List, Percent, PieChart, Plus, Rows3, Search, Sigma, Table2, ToggleLeft, Type, X, Layers, Gauge } from '@/ui/icons'
import type { Agg, ChartKind, Dimension, Filter, FilterOp, Measure, PeriodPreset, ReportSpec, TimeGrain } from '@/types/reports'
import type { DatasetDefX, FieldDefX } from '@/reports/datasets'
import { AGG_LABEL, CHART_LABEL, GRAIN_LABEL, OP_LABEL, PRESET_LABEL, aggsFor, fieldOf, opsFor } from '@/reports/datasets'
import { measureKey, measureLabel } from '@/reports/engine'
import { Button, Checkbox, Field, IconButton, Input, MoneyInput, Popover, Segmented, Select, Switch } from '@/ui'
import { cn } from '@/lib/utils'
import { fmtMoney } from '@/domain/money'

export const TYPE_ICON: Record<string, ReactNode> = {
  string: <Type />, enum: <CircleDot />, number: <Hash />, money: <IndianRupee />, percent: <Percent />, date: <Calendar />, boolean: <ToggleLeft />,
}
export const CHART_ICON: Record<ChartKind, ReactNode> = {
  table: <Table2 />, bar: <BarChart3 />, hbar: <BarChartHorizontal />, line: <LineChart />, area: <AreaChart />, pie: <PieChart />, stacked: <Layers />, kpi: <Gauge />,
}
const DS_ICON: Record<string, ReactNode> = {}

export const isNumeric = (f: FieldDefX) => f.type === 'number' || f.type === 'money' || f.type === 'percent'
export const isGroupable = (f: FieldDefX) => f.type === 'date' || f.type === 'enum' || f.type === 'boolean' || !!f.groupable

export function emptySpec(ds: DatasetDefX): ReportSpec {
  const money = ds.fields.find((f) => f.type === 'money')
  const hours = ds.fields.find((f) => f.unit === 'hours')
  const m = money ?? hours
  const dim = ds.dateField ? { field: ds.dateField, grain: 'month' as TimeGrain } : ds.fields.find((f) => f.type === 'enum') ? { field: ds.fields.find((f) => f.type === 'enum')!.key } : null
  return {
    title: ds.label,
    dataset: ds.id,
    measures: m ? [{ field: m.key, agg: 'sum' }] : [{ field: '*', agg: 'count' }],
    dimensions: dim ? [dim] : [],
    filters: [],
    period: ds.dateField ? { preset: ds.actuals ? 'last_12_months' : 'all' } : undefined,
    chart: dim && 'grain' in dim ? 'bar' : 'hbar',
    compare: 'none',
  }
}

/* ---------------- dataset picker ---------------- */
export function DatasetPicker({ datasets, value, onPick, compact }: { datasets: DatasetDefX[]; value?: string; onPick: (d: DatasetDefX) => void; compact?: boolean }) {
  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-1' : 'sm:grid-cols-2 xl:grid-cols-3')}>
      {datasets.map((d) => (
        <button
          key={d.id}
          onClick={() => onPick(d)}
          className={cn('flex min-w-0 items-start gap-3 rounded-lg border p-3 text-left transition', value === d.id ? 'border-brand bg-brand-soft/60' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/60')}
        >
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium text-ink">{d.label}</span>
            <span className="line-clamp-2 text-[12px] leading-snug text-ink-3">{d.description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/* ---------------- field list ---------------- */
export function FieldList({ ds, spec, onAddMeasure, onAddDimension, onAddFilter, onToggleColumn, listing }: { ds: DatasetDefX; spec: ReportSpec; onAddMeasure: (m: Measure) => void; onAddDimension: (d: Dimension) => void; onAddFilter: (f: Filter) => void; onToggleColumn: (k: string) => void; listing: boolean }) {
  const [q, setQ] = useState('')
  const fields = useMemo(() => ds.fields.filter((f) => !q || `${f.label} ${f.key} ${(f.aliases ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())), [ds, q])
  const nums = fields.filter(isNumeric)
  const dims = fields.filter((f) => !isNumeric(f))
  const used = new Set([...spec.measures.map((m) => m.field), ...spec.dimensions.map((d) => d.field), ...(spec.columns ?? [])])
  const Row = ({ f, primary }: { f: FieldDefX; primary: 'measure' | 'dimension' }) => (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
      <span className="text-ink-3 [&>svg]:size-3.5">{TYPE_ICON[f.type]}</span>
      <button
        className={cn('min-w-0 flex-1 truncate text-left text-[13px]', used.has(f.key) ? 'font-semibold text-brand-text' : 'text-ink-2')}
        title={f.description ?? f.label}
        onClick={() => (listing ? onToggleColumn(f.key) : primary === 'measure' ? onAddMeasure({ field: f.key, agg: aggsFor(f.type)[0] }) : onAddDimension(f.type === 'date' ? { field: f.key, grain: 'month' } : { field: f.key }))}
      >
        {f.label}
        {f.grant && <span className="ml-1 text-[10.5px] font-medium text-accent-text">{f.grant === 'margins' ? 'margin' : 'salary'}</span>}
      </button>
      <span className="flex shrink-0 items-center opacity-100 md:opacity-0 md:group-hover:opacity-100">
        {!listing && isNumeric(f) && (
          <IconButton size="xs" label={`Sum ${f.label}`} onClick={() => onAddMeasure({ field: f.key, agg: aggsFor(f.type)[0] })}>
            <Sigma className="size-3.5" />
          </IconButton>
        )}
        {!listing && isGroupable(f) && (
          <IconButton size="xs" label={`Group by ${f.label}`} onClick={() => onAddDimension(f.type === 'date' ? { field: f.key, grain: 'month' } : { field: f.key })}>
            <Layers className="size-3.5" />
          </IconButton>
        )}
        {listing && (
          <IconButton size="xs" label={used.has(f.key) ? `Remove column ${f.label}` : `Add column ${f.label}`} onClick={() => onToggleColumn(f.key)}>
            {used.has(f.key) ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
          </IconButton>
        )}
        <IconButton size="xs" label={`Filter on ${f.label}`} onClick={() => onAddFilter(defaultFilter(f))}>
          <FilterIcon />
        </IconButton>
      </span>
    </li>
  )
  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a field" aria-label="Find a field" className="h-8 w-full rounded-md border border-line bg-surface pl-8 pr-2 text-[13px] outline-none focus:border-brand" />
      </div>
      {!listing && (
        <button onClick={() => onAddMeasure({ field: '*', agg: 'count' })} className="mb-2 flex items-center gap-2 rounded-md border border-dashed border-line-strong px-2 py-1.5 text-left text-[13px] text-ink-2 hover:border-brand hover:text-brand-text">
          <Hash className="size-3.5" /> Count of {ds.noun}
        </button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mb-1 px-2 text-[12px] font-medium text-ink-3">{listing ? 'Numbers' : 'Measures'}</div>
        <ul className="mb-3">{nums.map((f) => <Row key={f.key} f={f} primary="measure" />)}</ul>
        <div className="mb-1 px-2 text-[12px] font-medium text-ink-3">{listing ? 'Details' : 'Dimensions'}</div>
        <ul>{dims.map((f) => <Row key={f.key} f={f} primary="dimension" />)}</ul>
        {!fields.length && <p className="px-2 py-4 text-[12.5px] text-ink-3">No field matches “{q}”.</p>}
      </div>
    </div>
  )
}
function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      <path d="M2.5 3.5h11l-4.2 5v3.8l-2.6 1.2V8.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

export function defaultFilter(f: FieldDefX): Filter {
  if (f.type === 'boolean') return { field: f.key, op: 'eq', value: true }
  if (f.type === 'enum') return { field: f.key, op: 'in', value: f.options?.[0] ? [f.options[0].value] : [] }
  if (f.type === 'date') return { field: f.key, op: 'gte', value: new Date().toISOString().slice(0, 10) }
  if (isNumeric(f)) return { field: f.key, op: 'gt', value: 0 }
  return { field: f.key, op: 'contains', value: '' }
}

/* ---------------- chips ---------------- */
function Chip({ children, onRemove, tone = 'neutral', open, onOpenChange, editor, label }: { children: ReactNode; onRemove: () => void; tone?: 'measure' | 'dimension' | 'filter' | 'neutral'; open?: boolean; onOpenChange?: (o: boolean) => void; editor: ReactNode; label: string }) {
  const t = { measure: 'border-brand/30 bg-brand-soft/70 text-brand-text', dimension: 'border-accent/35 bg-accent-soft/70 text-accent-text', filter: 'border-info/25 bg-info-soft text-info-text', neutral: 'border-line bg-surface text-ink-2' }[tone]
  return (
    <span className={cn('inline-flex h-8 max-w-full items-center rounded-md border text-[12.5px] font-medium', t)}>
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        className="w-[300px]"
        trigger={
          <button className="min-w-0 truncate py-1 pl-3 pr-1.5" aria-label={`Edit ${label}`}>
            {children}
          </button>
        }
      >
        {editor}
      </Popover>
      <button onClick={onRemove} aria-label={`Remove ${label}`} className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm opacity-70 hover:bg-black/5 hover:opacity-100">
        <X className="size-3.5" />
      </button>
    </span>
  )
}

export function MeasureChip({ ds, m, onChange, onRemove }: { ds: DatasetDefX; m: Measure; onChange: (m: Measure) => void; onRemove: () => void }) {
  const f = m.field === '*' ? null : fieldOf(ds, m.field)
  const aggs: Agg[] = f ? aggsFor(f.type) : ['count']
  return (
    <Chip
      tone="measure"
      label={measureLabel(m, ds)}
      onRemove={onRemove}
      editor={
        <div className="space-y-3">
          <div className="text-[13px] font-semibold">{f?.label ?? `Count of ${ds.noun}`}</div>
          {f && (
            <Field label="Aggregate">
              <Segmented size="sm" value={m.agg} onChange={(agg) => onChange({ ...m, agg, label: undefined })} options={aggs.map((a) => ({ value: a, label: AGG_LABEL[a] }))} />
            </Field>
          )}
          <Field label="Label" hint="Optional. Shown in the chart and table.">
            <Input value={m.label ?? ''} placeholder={measureLabel({ ...m, label: undefined }, ds)} onChange={(e) => onChange({ ...m, label: e.target.value || undefined })} />
          </Field>
        </div>
      }
    >
      <Sigma className="mr-1 inline size-3.5" />
      {measureLabel(m, ds)}
    </Chip>
  )
}

export function DimensionChip({ ds, d, onChange, onRemove }: { ds: DatasetDefX; d: Dimension; onChange: (d: Dimension) => void; onRemove: () => void }) {
  const f = fieldOf(ds, d.field)
  return (
    <Chip
      tone="dimension"
      label={f?.label ?? d.field}
      onRemove={onRemove}
      editor={
        <div className="space-y-3">
          <div className="text-[13px] font-semibold">Group by {f?.label}</div>
          {f?.type === 'date' ? (
            <Field label="Time grain">
              <Segmented size="sm" value={d.grain ?? 'month'} onChange={(grain) => onChange({ ...d, grain })} options={(['day', 'week', 'month', 'quarter', 'fy'] as TimeGrain[]).map((g) => ({ value: g, label: GRAIN_LABEL[g] === 'Financial year' ? 'FY' : GRAIN_LABEL[g] }))} />
            </Field>
          ) : (
            <p className="text-[12.5px] text-ink-3">One row (or bar) per {f?.label.toLowerCase()}.</p>
          )}
        </div>
      }
    >
      <Layers className="mr-1 inline size-3.5" />
      {f?.label ?? d.field}
      {d.grain ? ` · ${GRAIN_LABEL[d.grain] === 'Financial year' ? 'FY' : GRAIN_LABEL[d.grain].toLowerCase()}` : ''}
    </Chip>
  )
}

export function filterText(ds: DatasetDefX, f: Filter): string {
  const fd = fieldOf(ds, f.field)
  const lab = fd?.label ?? f.field
  if (f.op === 'is_empty' || f.op === 'not_empty') return `${lab} ${OP_LABEL[f.op]}`
  const one = (v: unknown) => (fd?.type === 'enum' ? fd.options?.find((o) => o.value === v)?.label ?? String(v) : fd?.type === 'money' && typeof v === 'number' ? fmtMoney(v) : fd?.type === 'percent' && typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : fd?.type === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? ''))
  if (fd?.type === 'boolean') return f.value ? lab : `Not ${lab.toLowerCase()}`
  const v = Array.isArray(f.value) ? (f.op === 'between' ? f.value.map(one).join(' – ') : f.value.length > 2 ? `${f.value.length} values` : f.value.map(one).join(', ')) : one(f.value)
  return `${lab} ${OP_LABEL[f.op]} ${v || '…'}`
}

export function FilterEditor({ ds, f, onChange }: { ds: DatasetDefX; f: Filter; onChange: (f: Filter) => void }) {
  const fd = fieldOf(ds, f.field)
  const ops = fd ? opsFor(fd.type) : (['eq'] as FilterOp[])
  const setOp = (op: FilterOp) => {
    let value = f.value
    if (op === 'in' || op === 'nin') value = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value as string]
    else if (op === 'between') value = Array.isArray(value) ? value.slice(0, 2) : [value as string, value as string]
    else if (Array.isArray(value)) value = value[0] ?? null
    onChange({ ...f, op, value })
  }
  const numInput = (v: unknown, set: (x: number | null) => void) =>
    fd?.type === 'money' ? (
      <MoneyInput value={typeof v === 'number' ? v : 0} onChange={(p) => set(p)} />
    ) : fd?.type === 'percent' ? (
      <Input type="number" suffix="%" value={typeof v === 'number' ? Math.round(v * 1000) / 10 : ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value) / 100)} />
    ) : (
      <Input type="number" value={typeof v === 'number' ? v : ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} />
    )
  const one = (v: unknown, set: (x: string | number | null) => void) =>
    fd?.type === 'date' ? <Input type="date" value={typeof v === 'string' ? v : ''} onChange={(e) => set(e.target.value)} /> : fd && isNumeric(fd) ? numInput(v, set) : fd?.type === 'enum' ? <Select value={String(v ?? '')} onChange={(e) => set(e.target.value)} options={fd.options ?? []} placeholder="Choose…" /> : <Input value={String(v ?? '')} onChange={(e) => set(e.target.value)} placeholder="Text" />
  return (
    <div className="space-y-3">
      <div className="text-[13px] font-semibold">{fd?.label ?? f.field}</div>
      {fd?.type === 'boolean' ? (
        <Segmented size="sm" value={f.value ? 'yes' : 'no'} onChange={(v) => onChange({ ...f, op: 'eq', value: v === 'yes' })} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
      ) : (
        <>
          <Select value={f.op} onChange={(e) => setOp(e.target.value as FilterOp)} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))} aria-label="Condition" />
          {f.op === 'is_empty' || f.op === 'not_empty' ? null : (f.op === 'in' || f.op === 'nin') && fd?.type === 'enum' ? (
            <div className="max-h-[220px] space-y-1 overflow-y-auto scroll-thin">
              {(fd.options ?? []).map((o) => {
                const list = Array.isArray(f.value) ? (f.value as string[]) : []
                return <Checkbox key={o.value} checked={list.includes(o.value)} onChange={(v) => onChange({ ...f, value: v ? [...list, o.value] : list.filter((x) => x !== o.value) })} label={o.label} />
              })}
            </div>
          ) : f.op === 'in' || f.op === 'nin' ? (
            <Input value={Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')} onChange={(e) => onChange({ ...f, value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="Comma-separated values" />
          ) : f.op === 'between' ? (
            <div className="grid grid-cols-2 gap-2">
              {one(Array.isArray(f.value) ? f.value[0] : null, (x) => onChange({ ...f, value: [x as string | number, Array.isArray(f.value) ? (f.value[1] as string | number) : (x as string | number)] }))}
              {one(Array.isArray(f.value) ? f.value[1] : null, (x) => onChange({ ...f, value: [Array.isArray(f.value) ? (f.value[0] as string | number) : (x as string | number), x as string | number] }))}
            </div>
          ) : (
            one(f.value, (x) => onChange({ ...f, value: x }))
          )}
        </>
      )}
    </div>
  )
}

export function FilterChip({ ds, f, onChange, onRemove, defaultOpen }: { ds: DatasetDefX; f: Filter; onChange: (f: Filter) => void; onRemove: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <Chip tone="filter" open={open} onOpenChange={setOpen} label={filterText(ds, f)} onRemove={onRemove} editor={<FilterEditor ds={ds} f={f} onChange={onChange} />}>
      {filterText(ds, f)}
    </Chip>
  )
}

export function AddFilterButton({ ds, onAdd }: { ds: DatasetDefX; onAdd: (f: Filter) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const list = ds.fields.filter((f) => !q || f.label.toLowerCase().includes(q.toLowerCase()))
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[260px] p-2"
      trigger={
        <button className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-line-strong px-3 text-[12.5px] font-medium text-ink-3 hover:border-brand hover:text-brand-text">
          <Plus className="size-3.5" /> Filter
        </button>
      }
    >
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter on…" className="mb-1.5 h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px] outline-none focus:border-brand" />
      <ul className="max-h-[260px] overflow-y-auto scroll-thin">
        {list.map((f) => (
          <li key={f.key}>
            <button
              onClick={() => {
                onAdd(defaultFilter(f))
                setOpen(false)
                setQ('')
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2"
            >
              <span className="text-ink-3 [&>svg]:size-3.5">{TYPE_ICON[f.type]}</span>
              {f.label}
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  )
}

/* ---------------- properties ---------------- */
export function ChartPicker({ value, onChange, disabled }: { value: ChartKind; onChange: (c: ChartKind) => void; disabled?: ChartKind[] }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {(Object.keys(CHART_LABEL) as ChartKind[]).map((k) => (
        <button
          key={k}
          disabled={disabled?.includes(k)}
          onClick={() => onChange(k)}
          aria-pressed={value === k}
          title={CHART_LABEL[k]}
          className={cn('flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-35', value === k ? 'border-brand bg-brand-soft text-brand-text' : 'border-line text-ink-2 hover:border-line-strong')}
        >
          <span className="[&>svg]:size-[18px]">{CHART_ICON[k]}</span>
          <span className="truncate">{CHART_LABEL[k].replace('Horizontal bar', 'H-bar').replace('Stacked bar', 'Stacked')}</span>
        </button>
      ))}
    </div>
  )
}

export function PeriodEditor({ ds, spec, onChange }: { ds: DatasetDefX; spec: ReportSpec; onChange: (p: ReportSpec['period']) => void }) {
  const custom = !!(spec.period?.from || spec.period?.to)
  const dateFields = ds.fields.filter((f) => f.type === 'date')
  if (!ds.dateField && !dateFields.length) return <p className="text-[12.5px] text-ink-3">This dataset has no dates, so it always shows everything.</p>
  return (
    <div className="space-y-2.5">
      <Select
        aria-label="Period"
        value={custom ? 'custom' : spec.period?.preset ?? 'all'}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'custom') onChange({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), field: spec.period?.field })
          else onChange({ preset: v as PeriodPreset, field: spec.period?.field })
        }}
        options={[...Object.entries(PRESET_LABEL).map(([k, v]) => ({ value: k, label: v })), { value: 'custom', label: 'Custom dates…' }]}
      />
      {custom && (
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" aria-label="From" value={spec.period?.from ?? ''} onChange={(e) => onChange({ ...spec.period, from: e.target.value || undefined })} />
          <Input type="date" aria-label="To" value={spec.period?.to ?? ''} onChange={(e) => onChange({ ...spec.period, to: e.target.value || undefined })} />
        </div>
      )}
      {dateFields.length > 1 && (
        <Field label="Date used for the period">
          <Select value={spec.period?.field ?? ds.dateField ?? ''} onChange={(e) => onChange({ ...(spec.period ?? { preset: 'all' }), field: e.target.value || undefined })} options={dateFields.map((f) => ({ value: f.key, label: f.label }))} />
        </Field>
      )}
    </div>
  )
}

export function SortEditor({ ds, spec, onChange }: { ds: DatasetDefX; spec: ReportSpec; onChange: (p: Pick<ReportSpec, 'sort' | 'limit'>) => void }) {
  const listing = !spec.measures.length && !spec.dimensions.length
  const options = listing
    ? (spec.columns ?? ds.defaultColumns).map((k) => ({ value: k, label: fieldOf(ds, k)?.label ?? k }))
    : [...spec.measures.map((m) => ({ value: measureKey(m), label: measureLabel(m, ds) })), ...spec.dimensions.map((d) => ({ value: d.field, label: fieldOf(ds, d.field)?.label ?? d.field }))]
  const s = spec.sort?.[0]
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Select aria-label="Sort by" value={s?.field ?? ''} placeholder="Default order" onChange={(e) => onChange({ sort: e.target.value ? [{ field: e.target.value, dir: s?.dir ?? 'desc' }] : undefined, limit: spec.limit })} options={options} />
        <Segmented size="sm" value={s?.dir ?? 'desc'} onChange={(dir) => s && onChange({ sort: [{ field: s.field, dir }], limit: spec.limit })} options={[{ value: 'desc', label: '↓' }, { value: 'asc', label: '↑' }]} />
      </div>
      <Field label="Show top" hint="Totals still include every row.">
        <Select aria-label="Limit" value={String(spec.limit ?? '')} onChange={(e) => onChange({ sort: spec.sort, limit: e.target.value ? Number(e.target.value) : undefined })} options={[{ value: '', label: 'All rows' }, ...[5, 10, 20, 50, 100].map((n) => ({ value: String(n), label: `Top ${n}` }))]} />
      </Field>
    </div>
  )
}

export function ModeSwitch({ listing, onChange }: { listing: boolean; onChange: (listing: boolean) => void }) {
  return (
    <Segmented
      size="sm"
      value={listing ? 'list' : 'summary'}
      onChange={(v) => onChange(v === 'list')}
      options={[
        { value: 'summary', label: <span className="inline-flex items-center gap-1"><Sigma className="size-3.5" /> Summary</span> },
        { value: 'list', label: <span className="inline-flex items-center gap-1"><List className="size-3.5" /> List rows</span> },
      ]}
    />
  )
}

export function CompareSwitch({ spec, onChange }: { spec: ReportSpec; onChange: (v: boolean) => void }) {
  const can = !!spec.measures.length && !!(spec.period?.preset && spec.period.preset !== 'all')
  return <Switch checked={spec.compare === 'previous_period'} disabled={!can} onChange={onChange} label="Compare with previous period" description={can ? 'Adds the previous period and % change.' : 'Pick a period preset and at least one measure.'} />
}

export { Button }
