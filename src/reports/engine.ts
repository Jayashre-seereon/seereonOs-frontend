// Report engine: executes a ReportSpec over flat dataset rows.
// Runs on the "server" (the mock route builds tenant-scoped rows and calls runSpec). Pure and
// deterministic — the AI never computes numbers; it only chooses a spec that this engine runs.
import type { Agg, Dimension, Filter, Measure, PeriodPreset, ReportColumn, ReportResult, ReportSpec, TimeGrain } from '@/types/reports'
import { addDays, addMonths, diffDays, fyLabel, fyRange, fyStartYear, monthRange, monthOf, parseISO, quarterOf, weekStart } from '@/domain/calendar'
import { AGG_LABEL, DATASET_MAP, ENUM_LABELS, GRAIN_LABEL, PRESET_LABEL, fieldOf, type DatasetDefX, type FieldDefX } from './datasets'

export type Cell = string | number | boolean | null
export type DataRow = Record<string, Cell>

export interface ReportColumnX extends ReportColumn {
  unit?: 'hours' | 'days'
  role?: 'dimension' | 'measure' | 'field' | 'compare'
  grain?: TimeGrain
}
export interface ReportResultX extends ReportResult {
  columns: ReportColumnX[]
  /** Totals for the previous period (same keys as totals) when compare is on. */
  totalsPrev?: Record<string, number | null>
  previousLabel?: string
  range?: { from: string; to: string } | null
}

/* ---------------- periods ---------------- */
export interface Range {
  from: string
  to: string
  label: string
  capped: boolean
}
export function presetRange(preset: PeriodPreset, today: string, fyStart = 4, capToday = false): Range | null {
  const cap = (r: { from: string; to: string; label: string }): Range => (capToday && r.to > today ? { ...r, to: today, capped: true } : { ...r, capped: false })
  const fy = fyStartYear(today, fyStart)
  switch (preset) {
    case 'this_month': {
      const r = monthRange(monthOf(today))
      return cap({ ...r, label: monthName(today) })
    }
    case 'last_month': {
      const d = addMonths(`${monthOf(today)}-01`, -1)
      return cap({ ...monthRange(monthOf(d)), label: monthName(d) })
    }
    case 'this_quarter': {
      const q = quarterOf(today, fyStart)
      return cap({ from: q.from, to: q.to, label: q.label })
    }
    case 'last_quarter': {
      const q = quarterOf(addDays(quarterOf(today, fyStart).from, -1), fyStart)
      return cap({ from: q.from, to: q.to, label: q.label })
    }
    case 'this_fy':
      return cap({ ...fyRange(fy, fyStart), label: fyLabel(fy) })
    case 'last_fy':
      return cap({ ...fyRange(fy - 1, fyStart), label: fyLabel(fy - 1) })
    case 'ytd':
      return { from: fyRange(fy, fyStart).from, to: today, label: `${fyLabel(fy)} to date`, capped: true }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today, label: 'Last 30 days', capped: false }
    case 'last_90_days':
      return { from: addDays(today, -89), to: today, label: 'Last 90 days', capped: false }
    case 'last_6_months': {
      const from = addMonths(`${monthOf(today)}-01`, -5)
      return cap({ from, to: monthRange(monthOf(today)).to, label: 'Last 6 months' })
    }
    case 'last_12_months': {
      const from = addMonths(`${monthOf(today)}-01`, -11)
      return cap({ from, to: monthRange(monthOf(today)).to, label: 'Last 12 months' })
    }
    case 'all':
    default:
      return null
  }
}
/** Previous comparable period: same length immediately before (calendar periods shift by their unit). */
export function previousRange(preset: PeriodPreset | undefined, cur: Range, fyStart = 4): Range {
  const shiftMonths = preset === 'this_month' || preset === 'last_month' ? 1 : preset === 'this_quarter' || preset === 'last_quarter' ? 3 : preset === 'this_fy' || preset === 'last_fy' || preset === 'ytd' ? 12 : preset === 'last_6_months' ? 6 : preset === 'last_12_months' ? 12 : 0
  if (shiftMonths) {
    const from = addMonths(cur.from, -shiftMonths)
    const to = addMonths(cur.to, -shiftMonths)
    const label = preset === 'this_month' || preset === 'last_month' ? monthName(from) : preset === 'this_quarter' || preset === 'last_quarter' ? quarterOf(from, fyStart).label : preset === 'this_fy' || preset === 'last_fy' || preset === 'ytd' ? fyLabel(fyStartYear(from, fyStart)) : `Previous ${shiftMonths} months`
    return { from, to, label: cur.capped ? `${label} (same days)` : label, capped: cur.capped }
  }
  const len = diffDays(cur.to, cur.from) + 1
  return { from: addDays(cur.from, -len), to: addDays(cur.from, -1), label: `Previous ${len} days`, capped: false }
}
export function monthName(d: string) {
  return parseISO(d).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}
function fmtD(d: string) {
  return parseISO(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/* ---------------- time buckets ---------------- */
export function bucketOf(date: string, grain: TimeGrain, fyStart = 4): { key: string; label: string } {
  switch (grain) {
    case 'day':
      return { key: date, label: fmtD(date) }
    case 'week': {
      const w = weekStart(date)
      return { key: w, label: 'Wk ' + parseISO(w).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }
    }
    case 'month':
      return { key: monthOf(date), label: monthName(date) }
    case 'quarter': {
      const q = quarterOf(date, fyStart)
      return { key: q.from, label: q.label }
    }
    case 'fy': {
      const y = fyStartYear(date, fyStart)
      return { key: String(y), label: fyLabel(y) }
    }
  }
}
function bucketsBetween(from: string, to: string, grain: TimeGrain, fyStart: number) {
  const out: { key: string; label: string }[] = []
  const seen = new Set<string>()
  let d = from
  let guard = 0
  const step = grain === 'day' ? (x: string) => addDays(x, 1) : grain === 'week' ? (x: string) => addDays(x, 7) : grain === 'month' ? (x: string) => addMonths(x, 1) : grain === 'quarter' ? (x: string) => addMonths(x, 3) : (x: string) => addMonths(x, 12)
  if (grain === 'month' || grain === 'quarter' || grain === 'fy') d = `${monthOf(from)}-01`
  while (d <= to && guard++ < 800) {
    const b = bucketOf(d, grain, fyStart)
    if (!seen.has(b.key)) {
      seen.add(b.key)
      out.push(b)
    }
    d = step(d)
  }
  const last = bucketOf(to, grain, fyStart)
  if (!seen.has(last.key)) out.push(last)
  return out
}

/* ---------------- filters ---------------- */
function norm(v: unknown): unknown {
  if (typeof v === 'string') return v.toLowerCase()
  return v
}
export function matchFilter(row: DataRow, f: Filter, field: FieldDefX | undefined): boolean {
  const v = row[f.field]
  const t = field?.type
  const val = f.value
  const num = (x: unknown) => (typeof x === 'number' ? x : x === null || x === undefined || x === '' ? NaN : Number(x))
  const isEmpty = v === null || v === undefined || v === ''
  switch (f.op) {
    case 'is_empty':
      return isEmpty
    case 'not_empty':
      return !isEmpty
    case 'eq':
      if (t === 'boolean') return !!v === (val === true || val === 'true' || val === 1 || val === 'yes')
      if (t === 'number' || t === 'money' || t === 'percent') return num(v) === num(val)
      return norm(v) === norm(val)
    case 'neq':
      if (t === 'number' || t === 'money' || t === 'percent') return num(v) !== num(val)
      return norm(v) !== norm(val)
    case 'in':
    case 'nin': {
      const list = (Array.isArray(val) ? val : val === null || val === undefined ? [] : String(val).split(',')).map((x) => norm(typeof x === 'string' ? x.trim() : x))
      const hit = list.includes(norm(v))
      return f.op === 'in' ? hit : !hit
    }
    case 'contains':
      return String(v ?? '').toLowerCase().includes(String(val ?? '').toLowerCase())
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (isEmpty) return false
      if (t === 'date' || typeof v === 'string') {
        const a = String(v)
        const b = String(val ?? '')
        return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b
      }
      const a = num(v)
      const b = num(val)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b
    }
    case 'between': {
      if (isEmpty) return false
      const [lo, hi] = Array.isArray(val) ? val : String(val ?? '').split(',')
      if (t === 'date' || typeof v === 'string') return String(v) >= String(lo) && String(v) <= String(hi)
      return num(v) >= num(lo) && num(v) <= num(hi)
    }
  }
  return true
}

/* ---------------- measures ---------------- */
export function measureKey(m: Measure) {
  return m.agg === 'count' ? 'count' : `${m.agg}_${m.field}`
}
export function measureLabel(m: Measure, ds: DatasetDefX): string {
  if (m.label) return m.label
  if (m.agg === 'count') return `Number of ${ds.noun}`
  const f = fieldOf(ds, m.field)
  const fl = f?.label ?? m.field
  if (m.agg === 'sum') return fl
  if (m.agg === 'avg') return f?.key === 'win' ? 'Win rate' : `Average ${lc(fl)}`
  if (m.agg === 'count_distinct') return `Distinct ${lc(fl)}`
  return `${AGG_LABEL[m.agg]} ${lc(fl)}`
}
function lc(s: string) {
  return /^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1)
}
function measureType(m: Measure, ds: DatasetDefX): { type: ReportColumn['type']; unit?: 'hours' | 'days' } {
  if (m.agg === 'count' || m.agg === 'count_distinct') return { type: 'number' }
  const f = fieldOf(ds, m.field)
  if (!f) return { type: 'number' }
  if (f.type === 'date') return { type: 'date' }
  return { type: f.type === 'money' || f.type === 'percent' ? f.type : 'number', unit: f.unit }
}
export function aggregate(rows: DataRow[], m: Measure): number | null {
  if (m.agg === 'count') return rows.length
  const vals = rows.map((r) => r[m.field]).filter((v) => v !== null && v !== undefined && v !== '')
  if (m.agg === 'count_distinct') return new Set(vals.map(String)).size
  const nums = vals.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : Number(v))).filter((n) => Number.isFinite(n)) as number[]
  if (!nums.length) return m.agg === 'sum' ? 0 : null
  switch (m.agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
  }
  return null
}

/* ---------------- validation ---------------- */
const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max', 'count_distinct']
const GRAINS: TimeGrain[] = ['day', 'week', 'month', 'quarter', 'fy']
const CHARTS = ['table', 'bar', 'hbar', 'line', 'area', 'pie', 'stacked', 'kpi'] as const
const PRESETS = Object.keys(PRESET_LABEL) as PeriodPreset[]
const OPS = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'between', 'is_empty', 'not_empty'] as const

/**
 * Sanitises a spec against the viewer's dataset definition: unknown fields are dropped (with a
 * warning), aggregations are fixed to fit the field type, grains only stay on dates. Used on the
 * server before running and on the client to clean what an LLM proposed.
 */
export function sanitizeSpec(raw: Partial<ReportSpec> & Record<string, unknown>, ds: DatasetDefX): { spec: ReportSpec; warnings: string[] } {
  const warnings: string[] = []
  const has = (k: string) => !!fieldOf(ds, k)
  const measures: Measure[] = []
  for (const m of (Array.isArray(raw.measures) ? raw.measures : []) as Measure[]) {
    if (!m || typeof m !== 'object') continue
    let agg = (AGGS.includes(m.agg) ? m.agg : 'sum') as Agg
    if (m.field === '*' || agg === 'count') {
      measures.push({ field: '*', agg: 'count', ...(m.label ? { label: String(m.label) } : {}) })
      continue
    }
    const f = fieldOf(ds, m.field)
    if (!f) {
      warnings.push(`Left out “${m.field}”: it isn’t available in ${ds.label} for your role.`)
      continue
    }
    if (f.type === 'percent' && agg === 'sum') agg = 'avg'
    if ((f.type === 'string' || f.type === 'enum' || f.type === 'boolean') && agg !== 'count_distinct') {
      if (f.type === 'boolean') agg = 'sum'
      else agg = 'count_distinct'
    }
    if (f.type === 'date' && !['min', 'max', 'count_distinct'].includes(agg)) agg = 'max'
    measures.push({ field: f.key, agg, ...(m.label ? { label: String(m.label) } : {}) })
  }
  const dimensions: Dimension[] = []
  for (const d of (Array.isArray(raw.dimensions) ? raw.dimensions : []) as Dimension[]) {
    if (!d || typeof d !== 'object') continue
    const f = fieldOf(ds, d.field)
    if (!f) {
      warnings.push(`Can’t group by “${d.field}” in ${ds.label}.`)
      continue
    }
    if (dimensions.some((x) => x.field === f.key)) continue
    dimensions.push(f.type === 'date' ? { field: f.key, grain: GRAINS.includes(d.grain as TimeGrain) ? d.grain : 'month' } : { field: f.key })
  }
  if (dimensions.length > 2) {
    warnings.push('Only the first two groupings are used.')
    dimensions.length = 2
  }
  const filters: Filter[] = []
  for (const f of (Array.isArray(raw.filters) ? raw.filters : []) as Filter[]) {
    if (!f || typeof f !== 'object' || !has(f.field)) {
      if (f?.field) warnings.push(`Ignored a filter on “${f.field}”.`)
      continue
    }
    const op = (OPS as readonly string[]).includes(f.op) ? f.op : 'eq'
    let value = f.value
    const fd = fieldOf(ds, f.field)!
    if (fd.type === 'enum' && typeof value === 'string' && fd.options && !fd.options.some((o) => o.value === value)) {
      const hit = fd.options.find((o) => o.label.toLowerCase() === String(value).toLowerCase())
      if (hit) value = hit.value
    }
    if (fd.type === 'boolean' && typeof value !== 'boolean') value = value === 'true' || value === 1 || value === 'yes'
    filters.push({ field: fd.key, op, value: value ?? null })
  }
  const columns = Array.isArray(raw.columns) ? (raw.columns as string[]).filter(has) : undefined
  const period = raw.period && typeof raw.period === 'object' ? { ...(raw.period as ReportSpec['period']) } : undefined
  if (period) {
    if (period.preset && !PRESETS.includes(period.preset)) delete period.preset
    if (period.field && !has(period.field)) delete period.field
    if (period.from && !/^\d{4}-\d{2}-\d{2}$/.test(period.from)) delete period.from
    if (period.to && !/^\d{4}-\d{2}-\d{2}$/.test(period.to)) delete period.to
  }
  const validKeys = new Set([...measures.map(measureKey), ...dimensions.map((d) => d.field), ...(columns ?? ds.defaultColumns), ...ds.fields.map((f) => f.key)])
  const sort = Array.isArray(raw.sort) ? (raw.sort as ReportSpec['sort'])!.filter((s) => s && validKeys.has(s.field)).map((s) => ({ field: s.field, dir: s.dir === 'asc' ? ('asc' as const) : ('desc' as const) })) : undefined
  let chart = (CHARTS as readonly string[]).includes(raw.chart as string) ? (raw.chart as ReportSpec['chart']) : undefined
  if (!chart) chart = !measures.length ? 'table' : !dimensions.length ? 'kpi' : dimensions.some((d) => d.grain) ? 'line' : 'bar'
  if (!measures.length && chart !== 'table' && !dimensions.length) chart = 'table'
  const limit = typeof raw.limit === 'number' && raw.limit > 0 ? Math.min(500, Math.round(raw.limit)) : undefined
  const spec: ReportSpec = {
    title: String(raw.title || ds.label).slice(0, 120),
    ...(raw.subtitle ? { subtitle: String(raw.subtitle).slice(0, 200) } : {}),
    dataset: ds.id,
    measures,
    dimensions,
    ...(columns && columns.length ? { columns } : {}),
    filters,
    ...(period && (period.preset || period.from || period.to) ? { period } : {}),
    ...(sort && sort.length ? { sort } : {}),
    ...(limit ? { limit } : {}),
    chart,
    compare: raw.compare === 'previous_period' ? 'previous_period' : 'none',
    ...(raw.notes ? { notes: String(raw.notes).slice(0, 400) } : {}),
  }
  return { spec, warnings }
}

/* ---------------- run ---------------- */
export interface RunCtx {
  today: string
  fyStart: number
}

function applyPeriod(rows: DataRow[], field: string | null, range: { from: string; to: string } | null) {
  if (!range || !field) return rows
  return rows.filter((r) => {
    const v = r[field]
    return typeof v === 'string' && v.slice(0, 10) >= range.from && v.slice(0, 10) <= range.to
  })
}
function resolveRange(spec: ReportSpec, ds: DatasetDefX, rc: RunCtx): Range | null {
  const p = spec.period
  if (!p) return null
  if (p.from || p.to) {
    const from = p.from ?? '1900-01-01'
    const to = p.to ?? '2999-12-31'
    return { from, to, label: p.from && p.to ? `${fmtD(from)} – ${fmtD(to)}` : p.from ? `From ${fmtD(from)}` : `Up to ${fmtD(to)}`, capped: false }
  }
  if (!p.preset || p.preset === 'all') return null
  return presetRange(p.preset, rc.today, rc.fyStart, !!ds.actuals)
}

function displayOf(field: FieldDefX | undefined, v: Cell): Cell {
  if (v === null || v === undefined) return null
  if (field?.type === 'enum' && field.options) return field.options.find((o) => o.value === v)?.label ?? String(v)
  return v
}

export function runSpec(spec: ReportSpec, ds: DatasetDefX, allRows: DataRow[], rc: RunCtx, extraWarnings: string[] = []): ReportResultX {
  const warnings = [...extraWarnings]
  const dateField = spec.period?.field ?? ds.dateField
  const range = resolveRange(spec, ds, rc)
  const fieldsBy = new Map(ds.fields.map((f) => [f.key, f]))
  let base = allRows.filter((r) => spec.filters.every((f) => matchFilter(r, f, fieldsBy.get(f.field))))
  const inPeriod = applyPeriod(base, dateField, range)
  const compare = spec.compare === 'previous_period' && range && spec.period?.preset !== 'all'
  const prevRange = compare ? previousRange(spec.period?.preset, range!, rc.fyStart) : null
  const prevRows = prevRange ? applyPeriod(base, dateField, prevRange) : []
  base = inPeriod

  const periodLabel = range ? range.label + (range.capped && spec.period?.preset !== 'ytd' ? ' (to date)' : '') : spec.period?.preset === 'all' || !spec.period ? 'All time' : PRESET_LABEL[spec.period.preset ?? 'all']
  const generatedAt = new Date().toISOString()

  /* ----- listing ----- */
  if (!spec.measures.length && !spec.dimensions.length) {
    const cols = (spec.columns?.length ? spec.columns : ds.defaultColumns).filter((k) => fieldsBy.has(k))
    const columns: ReportColumnX[] = cols.map((k) => {
      const f = fieldsBy.get(k)!
      return { key: k, label: f.label, type: f.type, unit: f.unit, role: 'field' }
    })
    let rows = base.map((r) => Object.fromEntries(cols.map((k) => [k, displayOf(fieldsBy.get(k), r[k] ?? null)])) as DataRow)
    const raw = base
    const order = sortRows(rows, spec.sort?.length ? spec.sort : ds.dateField && cols.includes(ds.dateField) ? [{ field: ds.dateField, dir: 'desc' }] : [], raw)
    rows = order
    const rowCount = rows.length
    if (spec.limit) rows = rows.slice(0, spec.limit)
    const totals: Record<string, number | null> = {}
    for (const c of columns) if (c.type === 'money' || c.unit === 'hours') totals[c.key] = base.reduce((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0)
    return { spec, columns, rows, totals, rowCount, generatedAt, periodLabel, warnings, range: range ? { from: range.from, to: range.to } : null }
  }

  const measures = spec.measures.length ? spec.measures : [{ field: '*', agg: 'count' as const }]
  const mCols: ReportColumnX[] = measures.map((m) => ({ key: measureKey(m), label: measureLabel(m, ds), ...measureType(m, ds), role: 'measure' }))
  const dCols: ReportColumnX[] = spec.dimensions.map((d) => {
    const f = fieldsBy.get(d.field)!
    return { key: d.field, label: d.grain ? `${f.label} (${GRAIN_LABEL[d.grain].toLowerCase()})` : f.label, type: d.grain ? 'string' : f.type === 'enum' ? 'string' : f.type, role: 'dimension', grain: d.grain }
  })

  const keyOf = (r: DataRow) =>
    spec.dimensions.map((d) => {
      const v = r[d.field]
      if (d.grain) return typeof v === 'string' && v ? bucketOf(v.slice(0, 10), d.grain, rc.fyStart) : { key: '~', label: 'No date' }
      const f = fieldsBy.get(d.field)
      const lab = displayOf(f, v)
      return { key: v === null || v === undefined || v === '' ? '~' : String(v), label: lab === null || lab === '' ? '(none)' : typeof lab === 'boolean' ? (lab ? 'Yes' : 'No') : String(lab) }
    })

  const group = (rows: DataRow[]) => {
    const m = new Map<string, { parts: { key: string; label: string }[]; rows: DataRow[] }>()
    for (const r of rows) {
      const parts = keyOf(r)
      const k = parts.map((p) => p.key).join('\u0001')
      let g = m.get(k)
      if (!g) m.set(k, (g = { parts, rows: [] }))
      g.rows.push(r)
    }
    return m
  }
  const groups = group(base)
  // fill empty time buckets for a single time dimension within a bounded period
  const timeDim = spec.dimensions.find((d) => d.grain)
  if (timeDim && spec.dimensions.length === 1 && range && range.from > '1900' && range.to < '2999') {
    for (const b of bucketsBetween(range.from, range.to, timeDim.grain!, rc.fyStart)) if (!groups.has(b.key)) groups.set(b.key, { parts: [b], rows: [] })
  }

  let rows: (DataRow & { __k: string[] })[] = [...groups.values()].map((g) => {
    const row: DataRow & { __k: string[] } = { __k: g.parts.map((p) => p.key) } as DataRow & { __k: string[] }
    spec.dimensions.forEach((d, i) => (row[d.field] = g.parts[i].label))
    measures.forEach((m) => (row[measureKey(m)] = round(aggregate(g.rows, m))))
    return row
  })

  const cols: ReportColumnX[] = [...dCols, ...mCols]
  const totals: Record<string, number | null> = {}
  measures.forEach((m) => (totals[measureKey(m)] = round(aggregate(base, m))))
  let totalsPrev: Record<string, number | null> | undefined
  if (compare) {
    totalsPrev = {}
    measures.forEach((m) => (totalsPrev![measureKey(m)] = round(aggregate(prevRows, m))))
    if (!timeDim && spec.dimensions.length) {
      const pg = group(prevRows)
      for (const r of rows) {
        const g = pg.get(r.__k.join('\u0001'))
        for (const m of measures) {
          const k = measureKey(m)
          const prev = g ? round(aggregate(g.rows, m)) : m.agg === 'sum' || m.agg === 'count' ? 0 : null
          r[`${k}__prev`] = prev
          const cur = r[k] as number | null
          r[`${k}__chg`] = cur !== null && prev ? (cur - prev) / Math.abs(prev) : null
        }
      }
      for (const m of measures) {
        const mc = mCols.find((c) => c.key === measureKey(m))!
        cols.push({ key: `${mc.key}__prev`, label: `${mc.label}, ${prevRange!.label}`, type: mc.type, unit: mc.unit, role: 'compare' })
        cols.push({ key: `${mc.key}__chg`, label: 'Change', type: 'percent', role: 'compare' })
      }
    }
  }

  // sort: explicit; else time asc; else first measure desc
  const sorts = spec.sort?.length ? spec.sort : timeDim ? [] : [{ field: mCols[0].key, dir: 'desc' as const }]
  if (timeDim && !spec.sort?.length) {
    const ti = spec.dimensions.indexOf(timeDim)
    rows.sort((a, b) => (a.__k[ti] < b.__k[ti] ? -1 : a.__k[ti] > b.__k[ti] ? 1 : 0))
  } else rows = sortRows(rows, sorts, undefined, spec.dimensions) as typeof rows
  const rowCount = rows.length
  if (spec.limit) rows = rows.slice(0, spec.limit)
  if (spec.limit && rowCount > spec.limit) warnings.push(`Showing the top ${spec.limit} of ${rowCount} groups. Totals include all ${rowCount}.`)
  const out = rows.map((r) => {
    const x = { ...r } as DataRow & { __k?: string[] }
    delete x.__k
    return x as DataRow
  })
  return { spec, columns: cols, rows: out, totals, totalsPrev, previousLabel: prevRange?.label, rowCount, generatedAt, periodLabel, warnings, range: range ? { from: range.from, to: range.to } : null }
}

function round(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10000) / 10000
}

function sortRows<T extends DataRow>(rows: T[], sorts: { field: string; dir: 'asc' | 'desc' }[], raw?: DataRow[], dims?: Dimension[]): T[] {
  if (!sorts.length) return rows
  const idx = rows.map((r, i) => ({ r, raw: raw?.[i] ?? r }))
  idx.sort((a, b) => {
    for (const s of sorts) {
      const x = a.raw[s.field] ?? a.r[s.field]
      const y = b.raw[s.field] ?? b.r[s.field]
      if (x === y) continue
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      if (c) return s.dir === 'asc' ? c : -c
    }
    return 0
  })
  void dims
  return idx.map((x) => x.r)
}

/** Human description of a spec, for "Why this?" and templates. */
export function describeSpec(spec: ReportSpec): { dataset: string; measures: string[]; dimensions: string[]; filters: string[]; period: string; sort: string | null } {
  const ds = DATASET_MAP[spec.dataset]
  const f = (k: string) => (ds ? fieldOf(ds, k)?.label ?? k : k)
  const valueLabel = (field: string, v: unknown): string => {
    const fd = ds ? fieldOf(ds, field) : undefined
    const one = (x: unknown) => (fd?.type === 'enum' ? fd.options?.find((o) => o.value === x)?.label ?? String(x) : fd?.type === 'boolean' ? (x ? 'yes' : 'no') : fd?.type === 'money' && typeof x === 'number' ? `₹${new Intl.NumberFormat('en-IN').format(x / 100)}` : fd?.type === 'percent' && typeof x === 'number' ? `${Math.round(x * 100)}%` : String(x))
    return Array.isArray(v) ? v.map(one).join(', ') : one(v)
  }
  const OPW: Record<string, string> = { eq: 'is', neq: 'is not', in: 'is one of', nin: 'is not one of', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', between: 'between', is_empty: 'is empty', not_empty: 'is set' }
  return {
    dataset: ds?.label ?? spec.dataset,
    measures: spec.measures.map((m) => (ds ? measureLabel(m, ds) : m.field)),
    dimensions: spec.dimensions.map((d) => (d.grain ? `${GRAIN_LABEL[d.grain]}` : f(d.field))),
    filters: spec.filters.map((x) => (x.op === 'is_empty' || x.op === 'not_empty' ? `${f(x.field)} ${OPW[x.op]}` : fieldOf(ds, x.field)?.type === 'boolean' && x.op === 'eq' ? (x.value ? f(x.field) : `Not ${lc(f(x.field))}`) : `${f(x.field)} ${OPW[x.op]} ${valueLabel(x.field, x.value)}`)),
    period: spec.period?.from || spec.period?.to ? `${spec.period.from ?? '…'} → ${spec.period.to ?? '…'}` : PRESET_LABEL[spec.period?.preset ?? 'all'],
    sort: spec.sort?.length ? `${spec.sort[0].dir === 'desc' ? 'Highest' : 'Lowest'} ${lc(f(spec.sort[0].field.replace(/^(sum|avg|min|max|count_distinct)_/, '')))} first${spec.limit ? `, top ${spec.limit}` : ''}` : spec.limit ? `Top ${spec.limit}` : null,
  }
}

export { ENUM_LABELS }
