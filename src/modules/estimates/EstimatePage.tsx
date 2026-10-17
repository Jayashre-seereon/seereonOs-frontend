// v7 PROJECT COST CALCULATOR — one estimate (also /projects/cost-calculator/new). Header facts, milestones
// ("name | amount", the create form's parser), resources by milestone (named people or role placeholders with an
// assumed CTC), the Feature Guide calculator for additional costs / maintenance / contingency / markup ⇄ price,
// live totals, cost and cash by milestone, scenarios, revisions, PDFs and conversion into a project.
// Every number comes from the server (POST /estimates/preview while editing, GET /estimates/:id when saved).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, BarChart3, EyeOff, Columns3, Copy, Download, FileText, GitBranch, MoreHorizontal, Rocket, Save, Share2, Table2, Trash2, Trophy, Undo2, XCircle } from '@/ui/icons'
import type { BillingModel, ProjectType, RevenueStream } from '@/types/entities'
import type { Tone } from '@/domain/labels'
import { ApiError } from '@/api/http'
import { useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { estimatesApi, ESTIMATES_INVALIDATE, useEstimate, useEstimateOptions, type EstimateDetail, type EstimatePreview } from '@/api/estimates'
import { BILLING_MODEL, DEAL_STAGE, PROJECT_STATUS, PROJECT_TYPE, STREAM } from '@/domain/labels'
import { COMMERCIAL_MODELS } from '@/domain/costing'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { useSession } from '@/stores/session'
import { cn } from '@/lib/utils'
import {
  Badge, BarChart, Button, Callout, Card, CardHeader, ChartTable, Combobox, ErrorState, Field, IconButton, Input, Menu, PageHeader, Segmented, Select, Skeleton, SkeletonRows, StatusBadge, Textarea, TONE_TEXT,
  toast, useConfirm, useReadOnly,
} from '@/ui'
import { CalendarLine, CostingEditor } from '@/modules/projects/costing/CostingEditor'
import { ResourceRows } from './ResourceRows'
import { ConvertDialog } from './ConvertDialog'
import { ESTIMATE_STATUS, marginTone } from './labels'
import { blankDraft, calcInput, draftFromDetail, milestonesOf, saveInput, useEstimatePreview, type EstDraft } from './estimateDraft'
import { exportClientQuote, exportInternalCosting } from './exportPdf'

const DEFAULT_STREAM: Record<string, RevenueStream> = { product: 'products', service: 'services', saas: 'saas', ams: 'ams' }

export default function EstimatePage() {
  const { id = 'new' } = useParams()
  const isNew = id === 'new'
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const q = useEstimate(isNew ? undefined : id)
  const opts = useEstimateOptions()
  const [draft, setDraft] = useState<EstDraft | null>(isNew ? blankDraft() : null)
  const [dirty, setDirty] = useState(isNew)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // load the saved estimate into the draft (until the user edits); once per saved version so a save doesn't flash
  // the previous version back while the refetch is in flight
  const loaded = useRef('')
  useEffect(() => {
    if (isNew || !q.data || dirty) return
    const v = `${q.data.estimate.id}:${q.data.estimate.version}`
    if (loaded.current === v) return
    loaded.current = v
    setDraft(draftFromDetail(q.data))
  }, [isNew, q.data, dirty])
  useEffect(() => {
    if (isNew) {
      setDraft(blankDraft())
      setDirty(true)
      setErrors({})
    } else setDirty(false)
  }, [isNew, id])
  // /new?deal=… pre-fills from the pipeline deal (Deal page → "Estimate cost")
  const dealParam = sp.get('deal')
  useEffect(() => {
    if (!isNew || !dealParam || !opts.data) return
    const deal = opts.data.deals.find((x) => x.id === dealParam)
    if (deal) setDraft((d) => (d && !d.deal_id ? { ...d, deal_id: deal.id, client: deal.client, client_id: null, name: d.name || deal.title, costing: { ...d.costing, price_paise: deal.value_paise, price_mode: 'price' } } : d))
  }, [isNew, dealParam, opts.data])

  const input = useMemo(() => (draft && dirty ? calcInput(draft) : null), [draft, dirty])
  const live = useEstimatePreview(input, dirty)
  const pv: EstimatePreview | undefined = dirty ? live.data ?? q.data?.preview : q.data?.preview

  if (!isNew && q.isLoading) return <LoadingPage />
  if (!isNew && (q.error || !q.data)) {
    return (
      <div>
        <PageHeader title="Estimate" back={{ to: '/projects/cost-calculator', label: 'Cost calculator' }} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    )
  }
  if (!draft) return <LoadingPage />
  return (
    <Editor
      key={id}
      id={id}
      isNew={isNew}
      d={q.data ?? null}
      draft={draft}
      setDraft={(x) => {
        setDraft(x)
        setDirty(true)
        setErrors({})
      }}
      onSaved={(v) => {
        loaded.current = v
      }}
      discard={() => {
        if (q.data) {
          setDraft(draftFromDetail(q.data))
          setDirty(false)
          setErrors({})
        } else nav('/projects/cost-calculator')
      }}
      dirty={dirty}
      setDirty={setDirty}
      errors={errors}
      setErrors={setErrors}
      pv={pv}
      loading={live.isFetching}
      opts={opts.data}
    />
  )
}

function LoadingPage() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-1/2" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={6} /></div>
        <div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={4} /></div>
      </div>
    </div>
  )
}

function Editor({
  id, isNew, d, draft, setDraft, onSaved, discard, dirty, setDirty, errors, setErrors, pv, loading, opts,
}: {
  id: string
  isNew: boolean
  d: EstimateDetail | null
  draft: EstDraft
  setDraft: (d: EstDraft) => void
  onSaved: (versionKey: string) => void
  discard: () => void
  dirty: boolean
  setDirty: (v: boolean) => void
  errors: Record<string, string>
  setErrors: (e: Record<string, string>) => void
  pv: EstimatePreview | undefined
  loading: boolean
  opts: ReturnType<typeof useEstimateOptions>['data']
}) {
  const nav = useNavigate()
  const readOnlyRole = useReadOnly()
  const people = usePeopleMap()
  const { tenant } = useSession()
  const { confirm, askReason } = useConfirm()
  const [converting, setConverting] = useState(false)
  const [chart, setChart] = useState<'chart' | 'table'>('table')
  const e = d?.estimate
  const locked = !!e && e.status === 'converted'
  const hidden = !!d?.costing_hidden || !!pv?.costing_hidden
  const readOnly = readOnlyRole || locked || hidden
  const set = <K extends keyof EstDraft>(k: K, v: EstDraft[K]) => setDraft({ ...draft, [k]: v })
  const { parsed } = milestonesOf(draft)

  const onErr = (x: ApiError) => {
    if (x.field) setErrors({ [x.field.startsWith('milestones') ? 'milestones' : x.field]: x.message })
  }
  const save = useMut(() => (isNew ? estimatesApi.create(saveInput(draft)) : estimatesApi.save(id, saveInput(draft), e!.version)), {
    invalidate: [...ESTIMATES_INVALIDATE, ['estimate-preview']],
    success: (r) => (isNew ? `${r.number} saved` : `Saved version ${r.version}`),
    onSuccess: (r) => {
      onSaved(`${r.id}:${r.version}`)
      setDirty(false)
      setErrors({})
      if (isNew) nav(`/projects/cost-calculator/${r.id}`, { replace: true })
    },
    onError: onErr,
  })
  const status = useMut((v: { to: 'draft' | 'shared' | 'won' | 'lost'; reason?: string }) => estimatesApi.setStatus(id, v.to, e!.version, v.reason), {
    invalidate: ESTIMATES_INVALIDATE,
    success: (_r, v) => ({ draft: 'Reopened as a draft', shared: 'Marked as shared', won: 'Marked as won', lost: 'Marked as lost' })[v.to],
  })
  const dup = useMut((asScenario: boolean) => estimatesApi.duplicate(id, asScenario), {
    invalidate: ESTIMATES_INVALIDATE,
    success: (r) => `${r.number} created`,
    onSuccess: (r) => nav(`/projects/cost-calculator/${r.id}`),
  })
  const del = useMut(() => estimatesApi.remove(id, e!.version), { invalidate: ESTIMATES_INVALIDATE, success: 'Estimate deleted', onSuccess: () => nav('/projects/cost-calculator') })

  const validateLocal = () => {
    const x: Record<string, string> = {}
    if (!draft.name.trim()) x.name = 'Give the estimate a name.'
    if (!draft.client.trim() && !draft.deal_id && !draft.client_id) x.client = 'Who is it for? Type the client or prospect.'
    if (!draft.start_on) x.start_on = 'Pick the planned start date.'
    if (!draft.end_on) x.end_on = 'Pick the planned end date.'
    if (draft.start_on && draft.end_on && draft.end_on < draft.start_on) x.end_on = 'The planned end is before the start date.'
    if (parsed.errors.length) x.milestones = parsed.errors[0]
    setErrors(x)
    return !Object.keys(x).length
  }
  const doSave = () => validateLocal() && save.mutate(undefined)
  const markLost = async () => {
    const reason = await askReason({ title: `Mark ${e?.number} as lost?`, label: 'Why was it lost?', placeholder: 'e.g. Budget moved to next year', confirmLabel: 'Mark lost', minLength: 3, tone: 'danger' })
    if (reason) status.mutate({ to: 'lost', reason })
  }
  const remove = async () => {
    const ok = await confirm({ title: `Delete ${e?.number}?`, body: `“${e?.name}” and its revision history are removed. This cannot be undone.`, confirmLabel: 'Delete estimate', tone: 'danger' })
    if (ok) del.mutate(undefined)
  }
  const exportPdf = async (kind: 'internal' | 'quote') => {
    if (!d || !pv) return
    const r = kind === 'internal' ? await exportInternalCosting(d, pv, people) : await exportClientQuote(d, pv, tenant?.name ?? 'SeereonOS')
    if (r === 'saved') toast.success(kind === 'internal' ? 'Internal costing PDF downloaded' : 'Client quote PDF downloaded')
    else if (r === 'failed') toast.error('Could not create the PDF. Try again.')
  }
  const pickDeal = (dealId: string | null) => {
    const deal = opts?.deals.find((x) => x.id === dealId)
    if (!deal) return setDraft({ ...draft, deal_id: null })
    setDraft({ ...draft, deal_id: deal.id, client: deal.client, client_id: null, name: draft.name || deal.title, costing: { ...draft.costing, price_paise: deal.value_paise, price_mode: 'price' } })
  }

  const t = pv?.totals
  const saved = !isNew && !dirty
  const needSave = isNew ? 'Save the estimate first' : dirty ? 'Save your changes first' : undefined
  const st = e?.status
  const statusItems = !e
    ? []
    : [
        { label: 'Mark as shared', icon: <Share2 />, disabled: readOnly || !saved || st !== 'draft', hint: st !== 'draft' ? undefined : needSave, onSelect: () => status.mutate({ to: 'shared' }) },
        { label: 'Mark as won', icon: <Trophy />, disabled: readOnly || !saved || !(st === 'draft' || st === 'shared'), hint: needSave, onSelect: () => status.mutate({ to: 'won' }) },
        { label: 'Mark as lost', icon: <XCircle />, danger: true, disabled: readOnly || !saved || !(st === 'draft' || st === 'shared' || st === 'won'), hint: needSave, onSelect: () => void markLost() },
        { label: 'Reopen as draft', icon: <Undo2 />, disabled: readOnly || !saved || !(st === 'shared' || st === 'won' || st === 'lost'), onSelect: () => status.mutate({ to: 'draft' }) },
      ]
  const moreItems = [
    ...statusItems,
    ...(e
      ? [
          { label: 'Duplicate', icon: <Copy />, separator: true, disabled: readOnlyRole || !saved || hidden, hint: hidden ? 'Needs salary access' : needSave, onSelect: () => dup.mutate(false) },
          { label: 'Duplicate as scenario', icon: <GitBranch />, disabled: readOnlyRole || !saved || hidden, hint: hidden ? 'Needs salary access' : needSave, onSelect: () => dup.mutate(true) },
          ...(d && d.scenarios.length > 1 ? [{ label: 'Compare scenarios', icon: <Columns3 />, onSelect: () => nav(`/projects/cost-calculator?compare=${d.scenarios.slice(0, 3).map((x) => x.id).join(',')}`) }] : []),
          { label: 'Delete', icon: <Trash2 />, danger: true, disabled: readOnlyRole || st !== 'draft', hint: st !== 'draft' ? 'Drafts only' : undefined, onSelect: () => void remove() },
        ]
      : []),
  ]

  return (
    <div className="pb-24 lg:pb-0">
      <PageHeader
        back={{ to: '/projects/cost-calculator', label: 'Cost calculator' }}
        eyebrow={e ? <span className="tnum">{e.number} · {e.client}</span> : 'New estimate'}
        title={draft.name.trim() || (e ? e.name : 'New estimate')}
        meta={
          e ? (
            <>
              <StatusBadge map={ESTIMATE_STATUS} value={e.status} />
              {e.scenario_label && <Badge>{e.scenario_label}</Badge>}
              <span className="tnum text-[12.5px] text-ink-3">Version {e.version} · saved {fmtDateTime(e.updated_at)}</span>
              {dirty && <Badge tone="warning">Unsaved changes</Badge>}
            </>
          ) : undefined
        }
        actions={
          <>
            {e && (
              <Menu
                label="Export PDF"
                trigger={
                  <Button icon={<Download className="size-4" />} disabled={!saved || !pv} title={needSave} className="flex-1 md:flex-none">
                    Export PDF
                  </Button>
                }
                items={[
                  { label: 'Internal costing sheet', icon: <FileText />, disabled: hidden, hint: hidden ? 'Needs salary access' : 'Cost, margin, markup', onSelect: () => void exportPdf('internal') },
                  { label: 'Client quote', icon: <FileText />, hint: 'Price and milestones only', onSelect: () => void exportPdf('quote') },
                ]}
              />
            )}
            {e && d?.can_convert && (
              <Button icon={<Rocket className="size-4" />} disabled={readOnlyRole || !saved} title={needSave} onClick={() => setConverting(true)} className="flex-1 md:flex-none">
                Convert to project
              </Button>
            )}
            {!readOnly && (
              <Button variant="primary" icon={<Save className="size-4" />} loading={save.isPending} disabled={!dirty} onClick={doSave} className="flex-1 md:flex-none">
                {isNew ? 'Save estimate' : 'Save'}
              </Button>
            )}
            {e && (
              <Menu
                label="More actions"
                trigger={
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                }
                items={moreItems}
              />
            )}
          </>
        }
      />

      {hidden && (
        <Callout tone="info" className="mb-4" icon={<EyeOff />} title="Costing hidden — includes named people’s salaries">
          You can see the price, milestones and plan, and download the client quote. Cost, profit, margin and the cash view need salary access, so this estimate is read-only for you.
        </Callout>
      )}
      {locked && d?.project && (
        <Callout tone="info" className="mb-4" title={`Converted into ${d.project.code} ${d.project.name}`}>
          The estimate is kept read-only as the record of what was quoted. Change the plan on the project’s{' '}
          <Link className="font-medium text-brand-text hover:underline" to={`/projects/${d.project.id}/costing`}>Costing & margin tab</Link>, or duplicate this estimate.
        </Callout>
      )}
      {Object.keys(errors).length > 0 && (
        <Callout tone="danger" className="mb-4" icon={<AlertTriangle />}>
          {Object.values(errors).filter(Boolean)[0]}
        </Callout>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* ---------------- details ---------------- */}
          <Card>
            <CardHeader title="Details" subtitle="Who it is for, when, and how it will be billed." />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
              <Field label="Estimate name" required error={errors.name} className="sm:col-span-2 lg:col-span-6">
                <Input value={draft.name} disabled={readOnly} invalid={!!errors.name} placeholder="e.g. Kalinga Public School — EduReon rollout" onChange={(ev) => set('name', ev.target.value)} />
              </Field>
              <Field label="Client or prospect" required error={errors.client} className="sm:col-span-2 lg:col-span-3">
                <Input value={draft.client} disabled={readOnly} invalid={!!errors.client} placeholder="Company name" onChange={(ev) => setDraft({ ...draft, client: ev.target.value, client_id: null })} />
              </Field>
              <Field label="Or pick from clients" className="sm:col-span-2 lg:col-span-3">
                <Combobox
                  value={draft.client_id}
                  disabled={readOnly}
                  clearable
                  placeholder="Choose a client"
                  searchPlaceholder="Search clients"
                  options={(opts?.clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  onChange={(v) => setDraft({ ...draft, client_id: v, client: v ? opts?.clients.find((c) => c.id === v)?.name ?? draft.client : draft.client })}
                />
              </Field>
              <Field
                label="Pipeline deal"
                className="sm:col-span-2 lg:col-span-6"
                hint={opts && !opts.deals.length ? 'No deals you can see. You can still estimate without one.' : 'Optional. Picking a deal fills in the client and uses the deal value as the price.'}
              >
                <Combobox
                  value={draft.deal_id}
                  disabled={readOnly}
                  clearable
                  placeholder="No deal linked"
                  searchPlaceholder="Search deals"
                  options={[
                    ...(opts?.deals ?? []).map((x) => ({ value: x.id, label: x.title, hint: `${x.client} · ${DEAL_STAGE[x.stage].label} · ${fmtMoney(x.value_paise)}` })),
                    ...(d?.deal && !(opts?.deals ?? []).some((x) => x.id === d.deal!.id) ? [{ value: d.deal.id, label: d.deal.title, hint: d.deal.client }] : []),
                  ]}
                  onChange={pickDeal}
                />
              </Field>
              <Field label="Project type" className="sm:col-span-2 lg:col-span-3">
                <Segmented block value={draft.type as ProjectType} onChange={(v) => !readOnly && setDraft({ ...draft, type: v, stream: draft.stream ?? null })} options={(Object.keys(PROJECT_TYPE) as ProjectType[]).map((k) => ({ value: k, label: PROJECT_TYPE[k] }))} />
              </Field>
              <Field label="Commercial model" className="lg:col-span-3" hint={draft.billing_model === 'tm' ? 'Time & material: the price is the estimated billing.' : undefined}>
                <Select value={draft.billing_model} disabled={readOnly} onChange={(ev) => set('billing_model', ev.target.value as BillingModel)} options={COMMERCIAL_MODELS.map((m) => ({ value: m.value, label: BILLING_MODEL[m.value] }))} />
              </Field>
              <Field label="Revenue stream" className="lg:col-span-2" hint="Used when it becomes a project.">
                <Select value={draft.stream ?? DEFAULT_STREAM[draft.type] ?? 'services'} disabled={readOnly} onChange={(ev) => set('stream', ev.target.value)} options={(Object.keys(STREAM) as RevenueStream[]).map((k) => ({ value: k, label: STREAM[k] }))} />
              </Field>
              <Field label="Start" required error={errors.start_on} className="lg:col-span-2">
                <Input type="date" value={draft.start_on} disabled={readOnly} invalid={!!errors.start_on} onChange={(ev) => set('start_on', ev.target.value)} />
              </Field>
              <Field label="Planned end" required error={errors.end_on} className="lg:col-span-2">
                <Input type="date" value={draft.end_on} min={draft.start_on} disabled={readOnly} invalid={!!errors.end_on} onChange={(ev) => set('end_on', ev.target.value)} />
              </Field>
              <CalendarLine className="sm:col-span-2 lg:col-span-6" preview={pv} manDays={t ? { total: t.man_days, rows: t.resource_rows } : null} />
              <Field label="Scope" className="sm:col-span-2 lg:col-span-6" hint="Printed on the client quote.">
                <Textarea rows={2} value={draft.description} disabled={readOnly} placeholder="Scope in a sentence or two." onChange={(ev) => set('description', ev.target.value)} />
              </Field>
            </div>
          </Card>

          {/* ---------------- milestones ---------------- */}
          <Card>
            <CardHeader title="Milestones" subtitle="One per line in delivery order, with an optional billing amount after a “|”. Dates are spread across the estimate by billing share." />
            <Field label="Milestones, one per line" error={errors.milestones}>
              <Textarea
                aria-label="Milestones, one per line"
                rows={4}
                value={draft.msText}
                disabled={readOnly}
                invalid={!!errors.milestones || parsed.errors.length > 0}
                placeholder={'Requirements sign-off | 150000\nCore modules | 300000\nUAT sign-off | 200000'}
                onChange={(ev) => set('msText', ev.target.value)}
                className="tnum"
              />
            </Field>
            {parsed.items.length > 0 && (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {parsed.items.map((it) => {
                  const m = !it.error ? pv?.milestones.find((x) => x.code === it.code) : undefined
                  return (
                    <li key={it.line} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]">
                      <span className={cn('tnum w-8 shrink-0 font-semibold', it.error ? 'text-danger-text' : 'text-ink-3')}>{it.code || `L${it.line}`}</span>
                      {it.error ? (
                        <span className="min-w-0 flex-1 text-danger-text">{it.error}</span>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 basis-[140px] truncate">{it.name}</span>
                          {m && <span className="tnum whitespace-nowrap text-[12px] text-ink-3">{fmtDate(m.planned_start)} – {fmtDate(m.planned_end)}</span>}
                          <span className="tnum whitespace-nowrap font-medium">{it.amount_paise ? fmtMoney(it.amount_paise) : <span className="font-normal text-ink-3">No billing</span>}</span>
                        </>
                      )}
                    </li>
                  )
                })}
                {pv && pv.billing_total > 0 && (
                  <li className="flex flex-wrap items-baseline justify-between gap-x-3 bg-surface-2/60 px-3 py-2 text-[12.5px]">
                    <span className="text-ink-3">
                      {pv.milestones.length} milestone{pv.milestones.length === 1 ? '' : 's'}
                      {pv.unscheduled_billing > 0 ? ` · ${fmtMoney(pv.unscheduled_billing)} of the price billed on completion` : ''}
                    </span>
                    <span className="tnum font-semibold">{fmtMoney(pv.billing_total)}</span>
                  </li>
                )}
              </ul>
            )}
          </Card>

          {/* ---------------- resources ---------------- */}
          <Card>
            <CardHeader title="Resources by milestone" />
            <ResourceRows rows={draft.rows} onChange={(rows) => set('rows', rows)} preview={pv} errors={errors} readOnly={readOnly} canName={!!opts?.can_see_rates} />
          </Card>

          {/* ---------------- costs & pricing (the Feature Guide calculator) ---------------- */}
          <Card>
            <CardHeader title="Costs and pricing" subtitle="Additional costs, maintenance / support, contingency, and markup ⇄ price — the same calculator as the create-project form." />
            <CostingEditor draft={draft.costing} onChange={(c) => set('costing', c)} preview={pv} errors={errors} readOnly={readOnly} loading={loading} hideResources hideTotals />
          </Card>

          {/* ---------------- cost and cash by milestone ---------------- */}
          <Card>
            <CardHeader
              title="Cost and cash by milestone"
              subtitle="Billing against cost per milestone. Additional costs land on the first milestone, maintenance on the last, contingency in proportion to cost."
              action={
                <Segmented
                  size="sm"
                  value={chart}
                  onChange={setChart}
                  options={[
                    { value: 'table', label: <span className="inline-flex items-center gap-1"><Table2 className="size-3.5" />Table</span> },
                    { value: 'chart', label: <span className="inline-flex items-center gap-1"><BarChart3 className="size-3.5" />Chart</span> },
                  ]}
                />
              }
            />
            {!pv || !pv.by_milestone.length ? (
              <p className="text-[13px] text-ink-3">Add milestones to see cost and billing per milestone.</p>
            ) : chart === 'chart' ? (
              <>
                <BarChart data={pv.by_milestone.map((m) => ({ ms: m.code, billing: m.billing, cost: m.total_cost }))} x="ms" format="money" series={[{ key: 'billing', label: 'Billing' }, { key: 'cost', label: 'Cost' }]} height={240} />
                <ChartTableHidden pv={pv} />
              </>
            ) : (
              <CashTable pv={pv} />
            )}
          </Card>

          <Card>
            <CardHeader title="Internal notes" subtitle="Assumptions and risks. Not printed on the client quote." />
            <Textarea rows={3} value={draft.notes} disabled={readOnly} placeholder="e.g. Flutter developer is an assumed hire at market CTC." onChange={(ev) => set('notes', ev.target.value)} />
          </Card>
        </div>

        {/* ---------------- right rail ---------------- */}
        <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
          <TotalsCard pv={pv} loading={loading} />
          {e && <LinksCard d={d!} />}
          {d && d.scenarios.length > 1 && <ScenariosCard d={d} />}
          {e && (e.revisions?.length ?? 0) > 0 && <RevisionsCard d={d!} />}
        </aside>
      </div>

      {!readOnly && dirty && (
        <div className="fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-30 flex gap-2 border-t border-line bg-surface px-4 py-2.5 lg:hidden">
          <Button className="flex-1" onClick={discard}>
            Discard
          </Button>
          <Button className="flex-1" variant="primary" loading={save.isPending} onClick={doSave}>
            Save
          </Button>
        </div>
      )}
      {!readOnly && dirty && !isNew && (
        <div className="mt-4 hidden justify-end gap-2 lg:flex">
          <Button onClick={discard}>Discard changes</Button>
          <Button variant="primary" loading={save.isPending} onClick={doSave}>
            Save
          </Button>
        </div>
      )}
      {d && pv && converting && <ConvertDialog open={converting} onOpenChange={setConverting} d={d} pv={pv} />}
    </div>
  )
}

function ChartTableHidden({ pv }: { pv: EstimatePreview }) {
  return (
    <div className="sr-only">
      <ChartTable data={pv.by_milestone.map((m) => ({ ms: m.code, billing: m.billing, cost: m.total_cost }))} x="ms" xLabel="Milestone" format="money" series={[{ key: 'billing', label: 'Billing' }, { key: 'cost', label: 'Cost' }]} />
    </div>
  )
}

function CashTable({ pv }: { pv: EstimatePreview }) {
  const H = 'h-9 whitespace-nowrap px-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3'
  const hid = pv.costing_hidden
  const tot0 = pv.by_milestone.reduce((s, m) => ({ billing: s.billing + m.billing, people: s.people + (m.people_cost ?? 0), other: s.other + (m.other_cost ?? 0), cost: s.cost + (m.total_cost ?? 0), md: s.md + m.man_days }), { billing: 0, people: 0, other: 0, cost: 0, md: 0 })
  const tot = { ...tot0, people: hid ? null : tot0.people, other: hid ? null : tot0.other, cost: hid ? null : tot0.cost }
  return (
    <div className="-mx-1 overflow-x-auto scroll-thin">
      <table className="w-full min-w-[720px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line bg-surface-2/60">
            <th className={cn(H, 'text-left')}>Milestone</th>
            <th className={cn(H, 'text-right')}>Man-days</th>
            <th className={cn(H, 'text-right')}>Billing</th>
            <th className={cn(H, 'text-right')}>People</th>
            <th className={cn(H, 'text-right')}>Other</th>
            <th className={cn(H, 'text-right')}>Total cost</th>
            <th className={cn(H, 'text-right')}>Net</th>
            <th className={cn(H, 'text-right')}>Cash position</th>
          </tr>
        </thead>
        <tbody>
          {pv.by_milestone.map((m) => (
            <tr key={m.code} className="border-b border-line">
              <td className="px-3 py-2">
                <div className="max-w-[260px] truncate"><span className="tnum font-semibold text-ink-3">{m.code}</span> {m.name}</div>
                <div className="tnum text-[12px] text-ink-3">{fmtDate(m.start)} – {fmtDate(m.end)}</div>
              </td>
              <td className="tnum px-3 py-2 text-right text-ink-2">{fmtNum(m.man_days, 1)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2 text-right">{fmtMoney(m.billing)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2 text-right text-ink-2">{fmtMoney(m.people_cost)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2 text-right text-ink-2">{fmtMoney(m.other_cost)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2 text-right">{fmtMoney(m.total_cost)}</td>
              <td className={cn('tnum whitespace-nowrap px-3 py-2 text-right font-medium', (m.net ?? 0) < 0 ? 'text-danger-text' : 'text-ink')}>{fmtMoney(m.net)}</td>
              <td className={cn('tnum whitespace-nowrap px-3 py-2 text-right font-medium', m.cumulative_net === null ? 'text-ink-3' : m.cumulative_net < 0 ? 'text-danger-text' : 'text-success-text')}>{fmtMoney(m.cumulative_net)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-strong bg-surface-2/60 font-semibold">
            <td className="px-3 py-2">Total</td>
            <td className="tnum px-3 py-2 text-right">{fmtNum(tot.md, 1)}</td>
            <td className="tnum whitespace-nowrap px-3 py-2 text-right">{fmtMoney(tot.billing)}</td>
            <td className="tnum whitespace-nowrap px-3 py-2 text-right">{fmtMoney(tot.people)}</td>
            <td className="tnum whitespace-nowrap px-3 py-2 text-right">{fmtMoney(tot.other)}</td>
            <td className="tnum whitespace-nowrap px-3 py-2 text-right">{fmtMoney(tot.cost)}</td>
            <td className={cn('tnum whitespace-nowrap px-3 py-2 text-right', tot.cost !== null && tot.billing - tot.cost < 0 && 'text-danger-text')}>{fmtMoney(tot.cost === null ? null : tot.billing - tot.cost)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      {pv.by_milestone.some((m) => (m.cumulative_net ?? 0) < 0) && (
        <p className="mt-2 px-1 text-[12.5px] text-warning-text">Cash goes negative before the last milestone — consider an advance or front-loading billing.</p>
      )}
    </div>
  )
}

function TotalsCard({ pv, loading }: { pv: EstimatePreview | undefined; loading: boolean }) {
  const t = pv?.totals
  return (
    <Card className={cn('transition-opacity', loading && 'opacity-70')}>
      <CardHeader title="Totals" subtitle="Live from the server as you type." />
      {!t ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Kpi label="Price" value={fmtMoney(t.price)} strong />
            <Kpi label="Total cost" value={fmtMoney(t.total_cost)} />
            <Kpi label="Profit" value={fmtMoney(t.profit)} tone={(t.profit ?? 0) < 0 ? 'danger' : undefined} />
            <Kpi label={`Contingency (${pv!.contingency_pct}%)`} value={fmtMoney(t.contingency)} />
            <Kpi label="Planned margin" sub="profit ÷ price" value={fmtPct(t.margin)} tone={marginTone(t.margin, pv!.floor_pct)} />
            <Kpi label="Markup" sub="profit ÷ cost" value={fmtPct(t.markup)} />
            <Kpi label="Man-days" value={fmtNum(t.man_days, 1)} />
            <Kpi label="Working days" value={fmtNum(pv!.summary?.working_days ?? 0)} />
          </div>
          <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-[12.5px]">
            <Line k="People" v={fmtMoney(t.resources)} />
            <Line k="Additional costs" v={fmtMoney(t.additional)} />
            <Line k="Maintenance / support" v={fmtMoney(t.maintenance)} />
            <Line k="Contingency" v={fmtMoney(t.contingency)} />
            <Line k="Total cost" v={fmtMoney(t.total_cost)} strong />
          </dl>
          {pv!.below_floor && (
            <Callout tone="danger" icon={<AlertTriangle />} className="mt-3">
              Planned margin {fmtPct(t.margin)} is below the {pv!.floor_pct}% floor. Raise the price or markup, or trim resources.
            </Callout>
          )}
          {pv!.warnings.filter((w) => !w.includes('floor')).map((w) => (
            <p key={w} className="mt-2 text-[12.5px] leading-snug text-warning-text">{w}</p>
          ))}
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            Cost per hour = monthly CTC ÷ (working days in the month × {pv!.min_hours ?? 9} minimum hours). A row costs working days × % × cost per day, month by month. Role placeholders use the CTC you type.
          </p>
        </>
      )}
    </Card>
  )
}

function LinksCard({ d }: { d: EstimateDetail }) {
  const people = usePeopleMap()
  const e = d.estimate
  return (
    <Card>
      <CardHeader title="Status and links" />
      <dl className="space-y-2 text-[13px]">
        <Line k="Owner" v={people.get(e.owner_id)?.name ?? '—'} />
        {e.shared_on && <Line k="Shared on" v={fmtDate(e.shared_on)} />}
        {e.decided_on && e.status !== 'draft' && e.status !== 'shared' && <Line k={e.status === 'lost' ? 'Lost on' : 'Won on'} v={fmtDate(e.decided_on)} />}
        {e.lost_reason && <Line k="Reason" v={e.lost_reason} />}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-3">Deal</dt>
          <dd className="min-w-0 text-right">
            {d.deal ? (
              <Link to={`/sales/${d.deal.id}`} className="font-medium text-brand-text hover:underline">
                {d.deal.title}
              </Link>
            ) : (
              <span className="text-ink-3">None</span>
            )}
            {d.deal && <span className="block text-[12px] text-ink-3">{DEAL_STAGE[d.deal.stage].label} · {fmtMoney(d.deal.value_paise)}</span>}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-3">Project</dt>
          <dd className="min-w-0 text-right">
            {d.project ? (
              <>
                <Link to={`/projects/${d.project.id}`} className="font-medium text-brand-text hover:underline">
                  {d.project.code} {d.project.name}
                </Link>
                <span className="block text-[12px] text-ink-3">{PROJECT_STATUS[d.project.status].label}{e.converted_on ? ` · converted ${fmtDate(e.converted_on)}` : ''}</span>
              </>
            ) : (
              <span className="text-ink-3">{d.can_convert ? 'Not converted yet' : 'Not converted'}</span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  )
}

function ScenariosCard({ d }: { d: EstimateDetail }) {
  const nav = useNavigate()
  const ids = d.scenarios.slice(0, 3).map((x) => x.id)
  return (
    <Card>
      <CardHeader
        title="Scenarios"
        subtitle={`${d.scenarios.length} versions of this estimate`}
        action={
          <Button size="sm" icon={<Columns3 className="size-4" />} onClick={() => nav(`/projects/cost-calculator?compare=${ids.join(',')}`)}>
            Compare
          </Button>
        }
      />
      <ul className="divide-y divide-line">
        {d.scenarios.map((s) => (
          <li key={s.id}>
            <Link to={`/projects/cost-calculator/${s.id}`} className={cn('flex items-center justify-between gap-3 py-2 text-[13px] hover:text-brand-text', s.id === d.estimate.id && 'font-semibold')}>
              <span className="min-w-0 truncate">{s.scenario_label ?? s.number}{s.id === d.estimate.id ? ' (this one)' : ''}</span>
              <span className="tnum shrink-0 whitespace-nowrap text-right">
                {fmtMoney(s.price)} <span className={cn('ml-1 text-[12px]', TONE_TEXT[marginTone(s.margin, d.preview.floor_pct)])}>{fmtPct(s.margin)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function RevisionsCard({ d }: { d: EstimateDetail }) {
  const people = usePeopleMap()
  const list = [...(d.estimate.revisions ?? [])].reverse().slice(0, 8)
  return (
    <Card>
      <CardHeader title="Revisions" subtitle="Each save keeps the numbers of that version." />
      <ol className="space-y-2.5">
        {list.map((r) => (
          <li key={r.version} className="text-[12.5px] leading-snug">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">v{r.version} · {r.note}</span>
              <span className="tnum shrink-0 whitespace-nowrap">{fmtMoney(r.price_paise)}</span>
            </div>
            <div className="tnum text-ink-3">
              {fmtDateTime(r.at)} · {people.get(r.by)?.name ?? '—'} · cost {fmtMoney(r.total_cost_paise)}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function Kpi({ label, value, sub, tone, strong }: { label: string; value: string; sub?: string; tone?: Tone; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] leading-tight text-ink-3">{label}</div>
      <div className={cn('tnum mt-1 whitespace-nowrap font-semibold leading-tight', strong ? 'text-[18px]' : 'text-[15px]', tone && tone !== 'neutral' ? TONE_TEXT[tone] : 'text-ink')}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  )
}
function Line({ k, v, strong }: { k: ReactNode; v: ReactNode; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', strong && 'font-semibold')}>
      <dt className={strong ? 'text-ink' : 'text-ink-3'}>{k}</dt>
      <dd className="tnum min-w-0 text-right">{v}</dd>
    </div>
  )
}
