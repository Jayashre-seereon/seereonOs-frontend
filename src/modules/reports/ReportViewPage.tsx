// /reports/:id — viewer: title, period override, compare, KPIs, chart, table with totals,
// "Explain with AI", ExportMenu, and actions (edit, duplicate, pin, share).
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BarChart3, Copy, Info, Loader2, MoreHorizontal, Pencil, Pin, PinOff, Share2, Sparkles, Table2, Trash2, Users } from '@/ui/icons'
import { useMutation } from '@tanstack/react-query'
import { reportsApi, useSavedReport } from '@/api/reports'
import { useApi, useMut } from '@/api/query'
import type { PeriodPreset } from '@/types/reports'
import { Badge, Button, Callout, Card, ErrorState, IconButton, Menu, PageHeader, Segmented, Select, SkeletonRows, Switch, useCan, useConfirm, useReadOnly } from '@/ui'
import { ExportMenu } from '@/reports/ExportMenu'
import { explainResult } from '@/reports/ai'
import { PRESET_LABEL } from '@/reports/datasets'
import { fmtDateTime } from '@/domain/calendar'
import { ReportChart, ReportTable, SpecChips, toExportTable } from './components/ReportVisual'
import { SourceBadge } from './components/Conversation'

export default function ReportViewPage() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const c = useCan()
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const rep = useSavedReport(id)
  const [preset, setPreset] = useState<PeriodPreset | ''>('')
  const [compare, setCompare] = useState<boolean | null>(null)
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [how, setHow] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  const effCompare = compare ?? rep.data?.spec.compare === 'previous_period'
  const run = useApi(['reports', 'run', id, preset, effCompare], () => reportsApi.runSaved(id!, { ...(preset ? { period: { preset } } : {}), compare: effCompare ? 'previous_period' : 'none' }), { enabled: !!rep.data, placeholderData: (p) => p })
  const [explain, setExplain] = useState<{ text: string; source: 'llm' | 'rules' } | null>(null)
  const ai = useMutation({
    mutationFn: async () => {
      setExplain({ text: '', source: 'rules' })
      return explainResult(run.data!, { onText: (t) => setExplain((e) => ({ text: t, source: e?.source ?? 'rules' })) })
    },
    onSuccess: (r) => setExplain(r),
    onError: () => setExplain({ text: 'The explanation couldn’t be generated. The figures above are unaffected.', source: 'rules' }),
  })
  useEffect(() => setExplain(null), [preset, effCompare])

  const pin = useMut(() => reportsApi.pin(id!, !rep.data?.pinned), { invalidate: [['reports']], success: rep.data?.pinned ? 'Unpinned' : 'Pinned' })
  const share = useMut(() => reportsApi.share(id!, !rep.data?.shared), { invalidate: [['reports']], success: rep.data?.shared ? 'No longer shared' : 'Shared with the team' })
  const dup = useMut(() => reportsApi.duplicate(id!), { invalidate: [['reports']], success: 'Copy created', onSuccess: (x) => nav(`/reports/${x.id}/edit`) })
  const del = useMut(() => reportsApi.remove(id!, rep.data?.version), { invalidate: [['reports']], success: 'Report deleted', onSuccess: () => nav('/reports') })

  if (rep.isLoading) return <SkeletonRows rows={8} />
  if (rep.error || !rep.data) return <ErrorState error={rep.error} onRetry={() => rep.refetch()} />
  const r = rep.data
  const res = run.data
  const hasDims = !!res?.columns.some((x) => x.role === 'dimension')
  const hasMeasures = !!res?.columns.some((x) => x.role === 'measure')
  const chartable = hasMeasures && hasDims && r.spec.chart !== 'table'
  const canEdit = r.can_edit && c('reports.build')
  const dsDate = !!r.spec.dataset

  return (
    <div>
      <PageHeader
        back={{ to: '/reports', label: 'Reports' }}
        title={r.name}
        subtitle={r.description || undefined}
        meta={
          <>
            <Badge size="sm" tone="neutral">{r.source === 'system' ? 'Template' : r.source === 'ai' ? 'Saved from AI' : 'Custom report'}</Badge>
            <span className="text-[12.5px] text-ink-3">{r.dataset_label} · by {r.owner_name}</span>
            {r.shared && r.source !== 'system' && (
              <span className="text-[12.5px] text-ink-3">· Shared</span>
            )}
          </>
        }
        actions={
          <>
            {c('ai.use') && (
              <Button size="sm" icon={ai.isPending ? <Loader2 className="size-3.5 animate-spin" /> : undefined} disabled={!res || ai.isPending} onClick={() => ai.mutate()}>
                Explain with AI
              </Button>
            )}
            <ExportMenu table={res ? () => toExportTable(res, { title: r.name, chartEl: chartRef.current, notes: r.description ? [r.description] : [] }) : null} filename={r.name} />
            {canEdit && (
              <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => nav(`/reports/${r.id}/edit`)} disabled={readOnly}>
                Edit
              </Button>
            )}
            <Menu
              label="More actions"
              trigger={
                <IconButton size="sm" label="More actions" variant="secondary">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              }
              items={[
                ...(c('reports.build') ? [{ label: 'Duplicate', icon: <Copy />, onSelect: () => dup.mutate(undefined), disabled: readOnly }] : []),
                ...(r.can_edit ? [{ label: r.pinned ? 'Unpin' : 'Pin to top', icon: r.pinned ? <PinOff /> : <Pin />, onSelect: () => pin.mutate(undefined), disabled: readOnly }] : []),
                ...(r.can_edit && r.source !== 'system' ? [{ label: r.shared ? 'Stop sharing' : 'Share with team', icon: <Share2 />, onSelect: () => share.mutate(undefined), disabled: readOnly }] : []),
                ...(r.can_edit ? [{ separator: true, label: '' }, { label: 'Delete', icon: <Trash2 />, danger: true, disabled: readOnly, onSelect: async () => (await confirm({ title: `Delete “${r.name}”?`, body: 'This can’t be undone.', confirmLabel: 'Delete report', tone: 'danger' })) && del.mutate(undefined) }] : []),
              ]}
            />
          </>
        }
      />

      {/* toolbar */}
      <div className="sticky top-14 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-line bg-bg px-4 py-2.5 md:mx-0 md:rounded-lg md:border md:bg-surface md:px-3 lg:top-16">
        {dsDate && (
          <Select
            className="w-full sm:w-[220px]"
            aria-label="Period"
            value={preset}
            onChange={(e) => setPreset(e.target.value as PeriodPreset | '')}
            options={[{ value: '', label: `Saved period${r.spec.period?.preset ? ` · ${PRESET_LABEL[r.spec.period.preset]}` : r.spec.period?.from ? ' · custom dates' : ' · all time'}` }, ...Object.entries(PRESET_LABEL).map(([k, v]) => ({ value: k, label: v }))]}
          />
        )}
        {hasMeasures && (
          <div className="rounded-md border border-line px-2.5 py-1">
            <Switch checked={effCompare} onChange={(v) => setCompare(v)} label="Compare with previous period" />
          </div>
        )}
        <span className="flex-1" />
        {res && (
          <span className="min-w-0 text-[12px] text-ink-3">
            {res.periodLabel} · {res.rowCount} {res.rowCount === 1 ? 'row' : 'rows'} · run {fmtDateTime(res.generatedAt)}
            {run.isFetching && <Loader2 className="ml-1.5 inline size-3 animate-spin" />}
          </span>
        )}
      </div>

      {run.error ? (
        <ErrorState error={run.error} onRetry={() => run.refetch()} />
      ) : !res ? (
        <SkeletonRows rows={8} />
      ) : (
        <div className="space-y-4">
          {explain && (
            <Callout tone="info" title={<span className="inline-flex items-center gap-2">What this shows <SourceBadge source={explain.source} /></span>}>
              {explain.text ? <span className="whitespace-pre-line">{explain.text}</span> : <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Reading the figures…</span>}
            </Callout>
          )}
          {res.warnings.length > 0 && (
            <Callout tone="warning" title="Heads up">
              {res.warnings.join(' ')}
            </Callout>
          )}
          {hasMeasures && hasDims && <ReportChart res={{ ...res, spec: { ...res.spec, chart: 'kpi' } }} />}
          {hasMeasures && !hasDims && <ReportChart res={res} chartRef={chartRef} />}
          {chartable && (
            <Card pad={false}>
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 md:px-5">
                <h2 className="min-w-0 truncate text-[14px] font-semibold">{res.spec.title}</h2>
                <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
              </div>
              <div className="p-4 md:p-5">{view === 'chart' ? <ReportChart res={res} height={340} chartRef={chartRef} /> : <ReportTable res={res} className="-m-4 md:-m-5" />}</div>
            </Card>
          )}
          {(hasDims || !hasMeasures) && (
            <Card pad={false} className="overflow-hidden">
              <div className="border-b border-line px-4 py-2.5 md:px-5">
                <h2 className="text-[14px] font-semibold">Data</h2>
              </div>
              <div className="max-h-[70vh] overflow-auto scroll-thin">
                <ReportTable res={res} />
              </div>
            </Card>
          )}
          <div>
            <Button size="xs" variant="ghost" icon={<Info className="size-3.5" />} onClick={() => setHow((h) => !h)}>
              {how ? 'Hide definition' : 'How this is computed'}
            </Button>
            {how && <SpecChips spec={res.spec} className="mt-2" />}
          </div>
        </div>
      )}
    </div>
  )
}
