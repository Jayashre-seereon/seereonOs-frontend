// /reports/new and /reports/:id/edit — Custom Report Builder.
// Desktop: 3 panes (fields · canvas with live chart + table · properties).
// Phone: stepper Data → Fields → Filters → Visual with a live preview at the end of each step.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BarChart3, Check, Database, Info, Loader2, Save, Sparkles, Table2 } from '@/ui/icons'
import type { Dimension, Filter, Measure, ReportSpec } from '@/types/reports'
import { reportsApi, useDatasets, useSavedReport } from '@/api/reports'
import { useApi } from '@/api/query'
import { useUI } from '@/stores/ui'
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Segmented, SkeletonRows, useCan, useReadOnly } from '@/ui'
import { ExportMenu } from '@/reports/ExportMenu'
import { sanitizeSpec, type ReportResultX } from '@/reports/engine'
import type { DatasetDefX } from '@/reports/datasets'
import { cn } from '@/lib/utils'
import { ReportChart, ReportTable, SpecChips, toExportTable } from './components/ReportVisual'
import { SaveReportDialog } from './components/SaveReportDialog'
import { AddFilterButton, ChartPicker, CompareSwitch, DatasetPicker, DimensionChip, FieldList, FilterChip, MeasureChip, ModeSwitch, PeriodEditor, SortEditor, emptySpec } from './components/builderParts'

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

const STEPS = ['Data', 'Fields', 'Filters', 'Visual'] as const

export default function ReportBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const loc = useLocation()
  const nav = useNavigate()
  const c = useCan()
  const readOnly = useReadOnly()
  const openAI = useUI((s) => s.openAI)
  const datasets = useDatasets()
  const existing = useSavedReport(id)
  const [spec, setSpec] = useState<ReportSpec | null>(null)
  const [newFilter, setNewFilter] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [step, setStep] = useState(0)
  const [dirty, setDirty] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)

  // initialise from saved report, from router state (AI "Open in builder"), or empty
  useEffect(() => {
    if (spec || !datasets.data) return
    const fromState = (loc.state as { spec?: ReportSpec } | null)?.spec
    if (id) {
      if (existing.data) setSpec(existing.data.spec)
    } else if (fromState) {
      const ds = datasets.data.find((d) => d.id === fromState.dataset)
      if (ds) setSpec(sanitizeSpec(fromState as never, ds).spec)
      setStep(1)
    }
  }, [id, existing.data, datasets.data, loc.state, spec])

  const ds: DatasetDefX | undefined = useMemo(() => datasets.data?.find((d) => d.id === spec?.dataset), [datasets.data, spec?.dataset])
  const listing = !!spec && !spec.measures.length && !spec.dimensions.length
  const debounced = useDebounced(spec, 350)
  const preview = useApi(['reports', 'preview', debounced], () => reportsApi.run(debounced!), { enabled: !!debounced && (!!debounced.measures.length || !!debounced.dimensions.length || !!debounced.columns?.length), placeholderData: (p) => p, retry: false, staleTime: 5_000 })

  const upd = (p: Partial<ReportSpec>) => {
    setDirty(true)
    setSpec((s) => (s ? { ...s, ...p } : s))
  }
  const pickDataset = (d: DatasetDefX) => {
    setDirty(true)
    setSpec({ ...emptySpec(d), title: spec?.title && spec.dataset === d.id ? spec.title : d.label })
    setStep(1)
  }
  const addMeasure = (m: Measure) => spec && !spec.measures.some((x) => x.field === m.field && x.agg === m.agg) && upd({ measures: [...spec.measures, m], chart: spec.chart === 'table' && spec.dimensions.length ? 'bar' : spec.chart })
  const addDimension = (d: Dimension) => {
    if (!spec || spec.dimensions.some((x) => x.field === d.field)) return
    const dims = [...spec.dimensions, d].slice(-2)
    upd({ dimensions: dims, measures: spec.measures.length ? spec.measures : [{ field: '*', agg: 'count' }], chart: dims.length === 2 ? 'stacked' : d.grain ? 'bar' : spec.chart === 'kpi' || spec.chart === 'table' ? 'hbar' : spec.chart })
  }
  const addFilter = (f: Filter) => {
    if (!spec) return
    upd({ filters: [...spec.filters, f] })
    setNewFilter(spec.filters.length)
  }
  const toggleColumn = (k: string) => {
    if (!spec || !ds) return
    const cols = spec.columns?.length ? spec.columns : ds.defaultColumns
    upd({ columns: cols.includes(k) ? cols.filter((x) => x !== k) : [...cols, k] })
  }
  const setListing = (on: boolean) => {
    if (!spec || !ds) return
    if (on) upd({ measures: [], dimensions: [], columns: spec.columns?.length ? spec.columns : ds.defaultColumns, chart: 'table', compare: 'none' })
    else setSpec({ ...emptySpec(ds), title: spec.title, filters: spec.filters, period: spec.period })
  }

  if (!c('reports.build')) return <ErrorState error={{ code: 'FORBIDDEN', message: 'Your role can’t build reports.' }} />
  if (datasets.isLoading || (id && existing.isLoading)) return <SkeletonRows rows={8} />
  if (datasets.error) return <ErrorState error={datasets.error} onRetry={() => datasets.refetch()} />
  if (id && (existing.error || !existing.data)) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />
  if (id && existing.data && !existing.data.can_edit)
    return <ErrorState error={{ code: 'FORBIDDEN', message: 'Only the owner or an admin can edit this report. Duplicate it from the report page to make your own copy.' }} />

  const res = preview.data as ReportResultX | undefined
  const chartable = !!res && res.spec.chart !== 'table' && res.columns.some((x) => x.role === 'measure')
  const hasDims = !!spec?.dimensions.length
  const disabledCharts = !spec ? [] : listing ? (['bar', 'hbar', 'line', 'area', 'pie', 'stacked', 'kpi'] as const).slice() : !hasDims ? (['bar', 'hbar', 'line', 'area', 'pie', 'stacked'] as const).slice() : spec.dimensions.length === 2 ? (['pie', 'kpi'] as const).slice() : (['kpi'] as const).slice()

  const Preview = ({ height = 300 }: { height?: number }) =>
    !spec ? null : preview.error ? (
      <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
    ) : !res ? (
      <div className="grid h-[240px] place-items-center text-[13px] text-ink-3">
        <Loader2 className="size-5 animate-spin" />
      </div>
    ) : (
      <div className="space-y-4">
        {res.warnings.length > 0 && <div className="rounded-md bg-warning-soft px-3 py-2 text-[12.5px] text-warning-text">{res.warnings.join(' ')}</div>}
        {!listing && !hasDims && res.columns.some((x) => x.role === 'measure') && <ReportChart res={res} chartRef={chartRef} />}
        {!listing && hasDims && chartable && view === 'chart' && <ReportChart res={res} height={height} chartRef={chartRef} />}
        {(listing || hasDims) && (
          <div className="-mx-4 max-h-[420px] overflow-auto border-y border-line scroll-thin md:-mx-5">
            <ReportTable res={res} maxRows={100} dense />
          </div>
        )}
      </div>
    )

  const header = (
    <PageHeader
      back={{ to: id ? `/reports/${id}` : '/reports', label: id ? 'Back to report' : 'Reports' }}
      title={id ? 'Edit report' : 'New report'}
      subtitle={ds ? `${ds.label} · ${ds.description}` : 'Pick the data you want to report on, then choose what to total and how to group it.'}
      actions={
        <>
          {c('ai.use') && (
            <Button size="sm" variant="subtle" icon={<Sparkles className="size-3.5" />} onClick={() => openAI()} className="hidden md:inline-flex">
              Build with AI
            </Button>
          )}
          {res && <ExportMenu table={() => toExportTable(res, { chartEl: chartRef.current })} filename={spec?.title} />}
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!spec || readOnly} onClick={() => setSaveOpen(true)}>
            {id ? 'Save' : 'Save report'}
          </Button>
        </>
      }
    />
  )

  /* ---------------- no dataset yet ---------------- */
  if (!spec || !ds)
    return (
      <div>
        {header}
        <Card>
          <div className="mb-3">
            <h2 className="text-[14px] font-semibold">Choose data</h2>
          </div>
          {(datasets.data ?? []).length ? <DatasetPicker datasets={datasets.data!} onPick={pickDataset} /> : <EmptyState compact title="No data available for your role" />}
        </Card>
      </div>
    )

  const title = (
    <Input value={spec.title} onChange={(e) => upd({ title: e.target.value })} aria-label="Report title" className="h-10 border-transparent bg-transparent px-0 text-[16px] font-semibold shadow-none focus:border-transparent focus:ring-0" placeholder="Report title" />
  )
  const chips = (
    <div className="space-y-2.5">
      {!listing && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-3">Measures</span>
            {spec.measures.map((m, i) => (
              <MeasureChip key={`${m.field}-${m.agg}-${i}`} ds={ds} m={m} onChange={(x) => upd({ measures: spec.measures.map((y, j) => (j === i ? x : y)) })} onRemove={() => upd({ measures: spec.measures.filter((_, j) => j !== i) })} />
            ))}
            {!spec.measures.length && <span className="text-[12.5px] text-ink-3">Add a number from the field list (Σ).</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-3">Group by</span>
            {spec.dimensions.map((d, i) => (
              <DimensionChip key={d.field} ds={ds} d={d} onChange={(x) => upd({ dimensions: spec.dimensions.map((y, j) => (j === i ? x : y)) })} onRemove={() => upd({ dimensions: spec.dimensions.filter((_, j) => j !== i) })} />
            ))}
            {!spec.dimensions.length && <span className="text-[12.5px] text-ink-3">No grouping — one total.</span>}
          </div>
        </>
      )}
      {listing && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-3">Columns</span>
          <span className="text-[12.5px] text-ink-2">{(spec.columns ?? ds.defaultColumns).length} columns · add or remove them from the field list</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-3">Filters</span>
        {spec.filters.map((f, i) => (
          <FilterChip key={i} ds={ds} f={f} defaultOpen={newFilter === i} onChange={(x) => upd({ filters: spec.filters.map((y, j) => (j === i ? x : y)) })} onRemove={() => upd({ filters: spec.filters.filter((_, j) => j !== i) })} />
        ))}
        <AddFilterButton ds={ds} onAdd={addFilter} />
      </div>
    </div>
  )
  const props = (
    <div className="space-y-5">
      <Field label="Visual">
        <ChartPicker value={spec.chart} onChange={(chart) => upd({ chart })} disabled={[...disabledCharts]} />
      </Field>
      <Field label="Period">
        <PeriodEditor ds={ds} spec={spec} onChange={(period) => upd({ period })} />
      </Field>
      <CompareSwitch spec={spec} onChange={(v) => upd({ compare: v ? 'previous_period' : 'none' })} />
      <Field label="Sort">
        <SortEditor ds={ds} spec={spec} onChange={(p) => upd(p)} />
      </Field>
      <Field label="Subtitle" hint="Optional line under the title in exports.">
        <Input value={spec.subtitle ?? ''} onChange={(e) => upd({ subtitle: e.target.value || undefined })} />
      </Field>
    </div>
  )
  const canvasHead = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ModeSwitch listing={listing} onChange={setListing} />
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        {preview.isFetching && <Loader2 className="size-3.5 animate-spin" />}
        {res && (
          <span>
            {res.periodLabel} · {res.rowCount} {res.rowCount === 1 ? 'row' : 'rows'}
          </span>
        )}
        {chartable && hasDims && (
          <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'chart', label: <BarChart3 className="size-3.5" aria-label="Chart" /> }, { value: 'table', label: <Table2 className="size-3.5" aria-label="Table" /> }]} />
        )}
      </div>
    </div>
  )

  return (
    <div>
      {header}

      {/* ---------------- desktop: 3 panes ---------------- */}
      <div className="hidden gap-4 lg:grid lg:grid-cols-[250px_minmax(0,1fr)_280px] xl:grid-cols-[270px_minmax(0,1fr)_300px]">
        <Card className="sticky top-24 flex h-[calc(100dvh-140px)] flex-col" pad={false}>
          <div className="border-b border-line p-3">
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-3">Data</div>
            <select value={ds.id} onChange={(e) => pickDataset(datasets.data!.find((d) => d.id === e.target.value)!)} aria-label="Dataset" className="h-9 w-full rounded-md border border-line-strong/80 bg-surface px-2 text-[13.5px] font-medium outline-none focus:border-brand">
              {datasets.data!.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <FieldList ds={ds} spec={spec} listing={listing} onAddMeasure={addMeasure} onAddDimension={addDimension} onAddFilter={addFilter} onToggleColumn={toggleColumn} />
          </div>
        </Card>
        <div className="min-w-0 space-y-4">
          <Card>
            {title}
            <div className="mt-2">{chips}</div>
          </Card>
          <Card>
            {canvasHead}
            <div className="mt-4">
              <Preview />
            </div>
          </Card>
          <details className="group rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-ink-2">
              Definition
            </summary>
            <SpecChips spec={spec} className="mt-2.5" />
          </details>
        </div>
        <Card className="sticky top-24 h-fit max-h-[calc(100dvh-140px)] overflow-y-auto scroll-thin">
          <div className="mb-3 text-[14px] font-semibold text-ink">Properties</div>
          {props}
        </Card>
      </div>

      {/* ---------------- phone / tablet: stepper ---------------- */}
      <div className="lg:hidden">
        <ol className="mb-4 grid grid-cols-4 gap-1.5" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button onClick={() => setStep(i)} className={cn('flex w-full min-w-0 flex-col items-center gap-1 rounded-md py-1.5 text-[12px] font-medium', i === step ? 'text-brand-text' : i < step ? 'text-ink-2' : 'text-ink-3')} aria-current={i === step ? 'step' : undefined}>
                <span className={cn('grid size-7 place-items-center rounded-full text-[12px]', i === step ? 'bg-brand text-brand-ink' : i < step ? 'bg-brand-soft text-brand-text' : 'bg-surface-2 text-ink-3')}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
                {s}
              </button>
            </li>
          ))}
        </ol>
        <Card className="mb-4">
          {step === 0 && <DatasetPicker datasets={datasets.data!} value={ds.id} onPick={pickDataset} compact />}
          {step === 1 && (
            <div className="space-y-4">
              {title}
              <ModeSwitch listing={listing} onChange={setListing} />
              {chips}
              <div className="max-h-[48dvh] overflow-hidden rounded-lg border border-line p-2">
                <FieldList ds={ds} spec={spec} listing={listing} onAddMeasure={addMeasure} onAddDimension={addDimension} onAddFilter={(f) => (addFilter(f), setStep(2))} onToggleColumn={toggleColumn} />
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <Field label="Period">
                <PeriodEditor ds={ds} spec={spec} onChange={(period) => upd({ period })} />
              </Field>
              <div>
                <div className="mb-2 text-[13px] font-medium text-ink-2">Filters</div>
                <div className="flex flex-wrap gap-1.5">
                  {spec.filters.map((f, i) => (
                    <FilterChip key={i} ds={ds} f={f} defaultOpen={newFilter === i} onChange={(x) => upd({ filters: spec.filters.map((y, j) => (j === i ? x : y)) })} onRemove={() => upd({ filters: spec.filters.filter((_, j) => j !== i) })} />
                  ))}
                  <AddFilterButton ds={ds} onAdd={addFilter} />
                </div>
              </div>
              <CompareSwitch spec={spec} onChange={(v) => upd({ compare: v ? 'previous_period' : 'none' })} />
            </div>
          )}
          {step === 3 && (
            <div className="space-y-5">
              <Field label="Visual">
                <ChartPicker value={spec.chart} onChange={(chart) => upd({ chart })} disabled={[...disabledCharts]} />
              </Field>
              <Field label="Sort">
                <SortEditor ds={ds} spec={spec} onChange={(p) => upd(p)} />
              </Field>
            </div>
          )}
        </Card>
        {step > 0 && (
          <Card className="mb-4">
            <div className="mb-3">{canvasHead}</div>
            <Preview height={240} />
          </Card>
        )}
        <div className="sticky bottom-[calc(66px+env(safe-area-inset-bottom))] z-10 flex gap-2 rounded-lg border border-line bg-surface p-2 shadow-md">
          <Button className="flex-1" icon={<ArrowLeft className="size-4" />} disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
          {step < 3 ? (
            <Button className="flex-1" variant="primary" iconRight={<ArrowRight className="size-4" />} onClick={() => setStep((s) => s + 1)}>
              {STEPS[step + 1]}
            </Button>
          ) : (
            <Button className="flex-1" variant="primary" icon={<Save className="size-4" />} disabled={readOnly} onClick={() => setSaveOpen(true)}>
              Save report
            </Button>
          )}
        </div>
      </div>

      <SaveReportDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        spec={spec}
        existing={id ? existing.data : null}
        source={(loc.state as { spec?: ReportSpec } | null)?.spec ? 'ai' : 'builder'}
        onSaved={() => setDirty(false)}
      />
      {dirty && <span className="sr-only">Unsaved changes</span>}
    </div>
  )
}

