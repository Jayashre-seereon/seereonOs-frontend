// Projects list (Feature Guide §3, checklist G3.01–G3.05): status chips with counts, health + inline status dropdown,
// delivery columns (model, progress, planned / forecast end, next milestone, contract, projected margin) and an inline
// expandable summary per project. Phones get stacked cards.
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, FolderKanban, Plus } from '@/ui/icons'
import type { ProjectStatus, ProjectType } from '@/types/entities'
import { costingApi, projectsApi, type ProjectListItem, type ProjectListQuery } from '@/api/projects'
import { useApi } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { BILLING_MODEL, HEALTH, PROJECT_STATUS, PROJECT_TYPE } from '@/domain/labels'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtPct } from '@/domain/money'
import { debounce, cn } from '@/lib/utils'
import { Badge, Button, Callout, Can, Card, EmptyState, ErrorState, FilterChips, PageHeader, PersonName, Progress, SearchInput, Select, SkeletonRows, StatusBadge, useCan, useReadOnly } from '@/ui'
import { TONE_TEXT } from '@/ui/data'
import { ProjectFormDialog } from './components/ProjectFormDialog'
import { marginTone, MsStateBadge, PROJECT_STATUS_MEANING, PROJECT_STATUS_ORDER, ProjectStatusMenu, StatusMeaningsPopover, useProjectStatusChange } from './components/shared'

const SORTS: { value: NonNullable<ProjectListQuery['sort']>; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'health', label: 'Health' },
  { value: 'end', label: 'End date' },
  { value: 'progress', label: 'Progress' },
  { value: 'name', label: 'Name' },
]
// Compact header + cells so all eleven columns (incl. Projected margin) fit without scrolling at ≥1280 px.
const TH = 'px-1.5 min-[1400px]:px-2 py-2.5 text-left align-bottom leading-tight text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3'
const TD = 'px-1.5 min-[1400px]:px-2 py-3'

export default function ProjectsPage() {
  const can = useCan()
  const readOnly = useReadOnly()
  const [status, setStatus] = useState<ProjectStatus | 'all'>('all')
  const [q, setQ] = useState('')
  const [qd, setQd] = useState('')
  const [type, setType] = useState<ProjectType | ''>('')
  const [sort, setSort] = useState<NonNullable<ProjectListQuery['sort']>>('priority')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const debounced = useMemo(() => debounce((v: string) => setQd(v), 220), [])
  const query = useApi(['projects', { status, q: qd, type, sort }], () => projectsApi.list({ status, q: qd, type, sort }), { placeholderData: (p) => p })
  const d = query.data
  const counts = d?.counts
  const items = d?.items ?? []
  const anyMargin = items.some((x) => (x.row?.projected_margin ?? x.metrics.projected_margin) !== null)
  const anyContract = items.some((x) => x.row?.contract_incl_crs !== null && x.row?.contract_incl_crs !== undefined)
  const toggle = (id: string) => setOpen((x) => (x === id ? null : id))
  const openCount = counts ? (counts.initiated ?? 0) + (counts.active ?? 0) + (counts.on_hold ?? 0) + (counts.npa ?? 0) : 0
  const doneCount = counts ? (counts.completed ?? 0) + (counts.closed ?? 0) : 0
  const filtered = !!(qd || type || status !== 'all')
  const clear = () => {
    setStatus('all')
    setType('')
    setQ('')
    setQd('')
  }

  return (
    <div>
      <PageHeader
        title="Projects & WBS"
        subtitle={counts ? `${openCount} open, ${doneCount} completed or closed. Click a project to expand it.` : 'Delivery, milestones and money in one place.'}
        actions={
          <Can action="projects.create">
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={readOnly} onClick={() => setCreating(true)} className="max-md:w-full">
              Create project
            </Button>
          </Can>
        }
      />
      <div className="mb-3 flex flex-col gap-1.5 md:flex-row md:flex-wrap md:items-center md:gap-2">
        <FilterChips
          className="min-w-0"
          value={status}
          onChange={(v) => {
            setStatus(v)
            setOpen(null)
          }}
          options={[{ value: 'all' as const, label: 'All', count: counts?.all }, ...PROJECT_STATUS_ORDER.map((s) => ({ value: s, label: PROJECT_STATUS[s].label, count: counts?.[s] ?? 0 }))]}
        />
        <div className="-ml-2 md:ml-0"><StatusMeaningsPopover /></div>
      </div>
      {status !== 'all' && <p className="-mt-1 mb-3 text-[12.5px] text-ink-3"><span className="font-medium text-ink-2">{PROJECT_STATUS[status].label}:</span> {PROJECT_STATUS_MEANING[status]}.</p>}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:items-center">
        <SearchInput
          className="col-span-2 sm:w-[280px]"
          value={q}
          onChange={(v) => {
            setQ(v)
            debounced(v)
          }}
          placeholder="Search name, client or code"
        />
        <Select aria-label="Project type" value={type} onChange={(e) => setType(e.target.value as ProjectType | '')} placeholder="All types" options={(Object.keys(PROJECT_TYPE) as ProjectType[]).map((k) => ({ value: k, label: PROJECT_TYPE[k] }))} className="sm:ml-auto sm:w-[150px]" />
        <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} options={SORTS.map((s) => ({ value: s.value, label: `Sort: ${s.label}` }))} className="sm:w-[170px]" />
      </div>
      {!query.isLoading && !query.error && items.some((x) => x.status === 'npa') && status === 'all' && (
        <Callout tone="danger" className="mb-3">
          {items.filter((x) => x.status === 'npa').length} project(s) marked NPA. Review collections.
        </Callout>
      )}
      {query.isLoading ? (
        <Card><SkeletonRows rows={5} /></Card>
      ) : query.error ? (
        <Card><ErrorState error={query.error} onRetry={() => query.refetch()} /></Card>
      ) : !items.length ? (
        <Card>
          {filtered ? (
            <EmptyState icon={<AlertTriangle />} title="No projects match" body="Try another status, type or search." action={<Button size="sm" onClick={clear}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon={<FolderKanban />}
              title="No projects yet"
              body={can('projects.create') ? 'Create your first project with its milestones and costing plan.' : 'Projects you work on will appear here.'}
              action={can('projects.create') && !readOnly ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Create project</Button> : undefined}
            />
          )}
        </Card>
      ) : (
        <>
          {/* tablet & desktop: table (scrolls inside its card) */}
          <Card pad={false} className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[900px] text-[13px]">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <th className="w-8 py-2.5 pl-2" aria-label="Expand" />
                    <th className={TH}>Project</th>
                    <th className={TH}>PM</th>
                    <th className={TH}>Model</th>
                    <th className={TH}>Status /<br />health</th>
                    <th className={TH}>Progress</th>
                    <th className={TH}>Planned<br />end</th>
                    <th className={TH}>Forecast<br />end</th>
                    <th className={TH}>Next<br />milestone</th>
                    {anyContract && <th className={cn(TH, 'text-right')}>Contract</th>}
                    {anyMargin && <th className={cn(TH, 'pr-3 text-right')}>Projected<br />margin</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <Fragment key={p.id}>
                      <tr onClick={() => toggle(p.id)} className={cn('cursor-pointer border-b border-line align-top transition-colors hover:bg-surface-2/50', open === p.id && 'bg-surface-2/50')} aria-expanded={open === p.id}>
                        <td className="py-3 pl-2">
                          <button type="button" aria-label={open === p.id ? `Collapse ${p.name}` : `Expand ${p.name}`} className="grid size-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={(e) => { e.stopPropagation(); toggle(p.id) }}>
                            {open === p.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </td>
                        <td className={cn(TD, 'min-w-[136px] max-w-[210px]')}>
                          <div className="line-clamp-2 font-medium leading-snug text-ink" title={p.name}>{p.name}</div>
                          <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-3" title={`${p.code} · ${p.client}, P${p.priority}`}><span className="tnum">{p.code}</span> · {p.client}, P{p.priority}</div>
                        </td>
                        <td className={cn(TD, 'max-w-[104px] leading-snug')}><PmName id={p.pm_id} /></td>
                        <td className={cn(TD, 'max-w-[92px] leading-snug')}>
                          <div>{BILLING_MODEL[p.billing_model]}</div>
                          <div className="text-[12px] text-ink-3">{PROJECT_TYPE[p.type]}</div>
                        </td>
                        <td className={TD} onClick={(e) => e.stopPropagation()}><StatusCell p={p} readOnly={readOnly} /></td>
                        <td className={TD}><ProgressCell p={p} /></td>
                        <td className={cn(TD, 'tnum max-w-[76px]')}>{fmtDate(p.end_on)}</td>
                        <td className={cn(TD, 'max-w-[84px]')}><ForecastCell p={p} /></td>
                        <td className={cn(TD, 'min-w-[96px] max-w-[132px]')}><NextMs p={p} /></td>
                        {anyContract && <td className={cn(TD, 'tnum whitespace-nowrap text-right')}>{p.row?.contract_incl_crs !== null && p.row?.contract_incl_crs !== undefined ? fmtMoney(p.row.contract_incl_crs) : '—'}</td>}
                        {anyMargin && <td className={cn(TD, 'whitespace-nowrap pr-3 text-right')}><MarginValue v={p.row?.projected_margin ?? p.metrics.projected_margin} /></td>}
                      </tr>
                      {open === p.id && (
                        <tr className="border-b border-line bg-surface-2/30">
                          <td colSpan={9 + (anyContract ? 1 : 0) + (anyMargin ? 1 : 0)} className="px-4 py-4">
                            <ExpandedSummary p={p} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {/* phones: stacked cards */}
          <ul className="space-y-2.5 md:hidden">
            {items.map((p) => (
              <li key={p.id} className="rounded-lg border border-line bg-surface">
                <button type="button" className="block w-full px-4 pt-3.5 text-left" onClick={() => toggle(p.id)} aria-expanded={open === p.id}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14.5px] font-semibold leading-snug text-ink">{p.name}</div>
                      <div className="mt-0.5 text-[12.5px] text-ink-3"><span className="tnum">{p.code}</span> · {p.client}, P{p.priority}</div>
                    </div>
                    <span className="mt-0.5 shrink-0 text-ink-3">{open === p.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
                  </div>
                  <div className="mt-2.5"><ProgressCell p={p} /></div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[12.5px]">
                    <Def label="PM"><PmName id={p.pm_id} /></Def>
                    <Def label="Model">{BILLING_MODEL[p.billing_model]} · {PROJECT_TYPE[p.type]}</Def>
                    <Def label="Planned end"><span className="tnum">{fmtDate(p.end_on)}</span></Def>
                    <Def label="Forecast end"><ForecastCell p={p} inline /></Def>
                    <Def label="Next milestone" wide><NextMs p={p} inline /></Def>
                    {p.row?.contract_incl_crs !== null && p.row?.contract_incl_crs !== undefined && <Def label="Contract"><span className="tnum">{fmtMoney(p.row.contract_incl_crs)}</span></Def>}
                    {anyMargin && (p.row?.projected_margin ?? p.metrics.projected_margin) !== null && <Def label="Projected margin"><MarginValue v={p.row?.projected_margin ?? p.metrics.projected_margin} /></Def>}
                  </dl>
                </button>
                <div className="mt-3 border-t border-line px-4 py-3">
                  <StatusCell p={p} readOnly={readOnly} row />
                </div>
                {open === p.id && (
                  <div className="border-t border-line bg-surface-2/30 px-4 py-4">
                    <ExpandedSummary p={p} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function Def({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-ink-3">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-ink">{children}</dd>
    </div>
  )
}
function PmName({ id }: { id: string | null }) {
  const people = usePeopleMap()
  const pm = people.get(id)
  return pm ? <span>{pm.name}</span> : <span className="text-ink-3">—</span>
}

function StatusCell({ p, readOnly, row }: { p: ProjectListItem; readOnly: boolean; row?: boolean }) {
  const { change, pending } = useProjectStatusChange()
  const showHealth = !['completed', 'closed'].includes(p.status)
  const disabled = !p.can_edit || readOnly || pending
  return (
    <div className={cn('flex gap-1.5', row ? 'flex-row items-center justify-between' : 'flex-col items-start')}>
      {showHealth && <StatusBadge map={HEALTH} value={p.metrics.health} size="sm" />}
      <ProjectStatusMenu
        p={p}
        disabled={disabled}
        title={!p.can_edit ? `${PROJECT_STATUS[p.status].label}: ${PROJECT_STATUS_MEANING[p.status]}. Only the project manager or an admin can change the status.` : `${PROJECT_STATUS[p.status].label}: ${PROJECT_STATUS_MEANING[p.status]}. On hold, NPA and Closed ask for a reason.`}
        onChange={(s) => change(p, s)}
        inBox={!disabled}
      >
        <span className={cn('inline-flex h-7 items-center whitespace-nowrap rounded-md border border-line-strong bg-surface pl-2 text-[12.5px] text-ink', disabled ? 'pr-2' : 'pr-7', row ? 'min-w-[120px]' : 'min-w-[80px]', disabled && 'opacity-70')}>
          {PROJECT_STATUS[p.status].label}
        </span>
      </ProjectStatusMenu>
    </div>
  )
}

function ProgressCell({ p }: { p: ProjectListItem }) {
  const pct = p.row?.pct_complete ?? p.metrics.progress
  const tone = p.metrics.health === 'off_track' ? 'danger' : p.metrics.health === 'at_risk' ? 'warning' : 'brand'
  return (
    <div className="min-w-[78px] max-w-[96px]">
      <Progress value={pct} tone={tone} />
      <div className="tnum mt-1 text-[12px] leading-snug text-ink-2">
        {fmtPct(pct, 0)}, {p.row ? `${p.row.tasks_done}/${p.row.tasks_total} tasks` : `${p.metrics.open_tasks} open`}
      </div>
    </div>
  )
}

function ForecastCell({ p, inline }: { p: ProjectListItem; inline?: boolean }) {
  const f = p.row?.forecast_end
  const s = p.row?.slip_days ?? null
  if (!f) return <span className="text-ink-3">—</span>
  const late = s !== null && s > 0
  const note = s === null ? null : s > 0 ? `+${s}d late` : s < 0 ? `${-s}d early` : 'on time'
  return (
    <span className={cn(inline ? 'inline-flex flex-wrap items-baseline gap-x-1.5' : 'block')}>
      <span className={cn('tnum block', inline && 'inline whitespace-nowrap', late && 'font-semibold text-danger-text')}>{fmtDate(f)}</span>
      {note && <span className={cn('tnum block whitespace-nowrap text-[12px]', late ? 'font-medium text-danger-text' : 'text-ink-3', inline && 'inline')}>{note}</span>}
    </span>
  )
}

function NextMs({ p, inline }: { p: ProjectListItem; inline?: boolean }) {
  const m = p.metrics.next_milestone
  if (!m) return <span className="text-ink-3">No open milestone</span>
  return (
    <div className="min-w-0">
      <div className="tnum whitespace-nowrap">M{m.no} {fmtDate(m.planned_end)}</div>
      <div className={cn('text-[12px] leading-snug text-ink-3', inline ? 'truncate' : 'line-clamp-2')} title={m.name}>{m.name}</div>
    </div>
  )
}

function MarginValue({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-ink-3">—</span>
  return <span className={cn('tnum font-semibold', TONE_TEXT[marginTone(v)])}>{fmtPct(v)}</span>
}

/* ---------------- inline expanded summary (G3.05) ---------------- */
function ExpandedSummary({ p }: { p: ProjectListItem }) {
  const nav = useNavigate()
  const q = useApi(['project', p.id, 'summary'], () => costingApi.summary(p.id))
  const people = usePeopleMap()
  if (q.isLoading) return <SkeletonRows rows={3} />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const s = q.data
  return (
    <div className="grid gap-5 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-6">
        <h4 className="mb-2 text-[13px] font-semibold">Milestones</h4>
        {!s.milestones.length ? (
          <p className="text-[13px] text-ink-3">No milestones yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {s.milestones.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 basis-[160px]">
                  <span className="tnum font-semibold text-ink-3">{m.code}</span> {m.name}
                </span>
                <span className="tnum whitespace-nowrap text-[12px] text-ink-3">
                  {fmtDate(m.deadline)}
                  {m.end && m.end !== m.deadline ? <span className={cn(m.end > m.deadline ? 'text-danger-text' : 'text-success-text')}> → {fmtDate(m.end)} {m.end_kind}</span> : null}
                </span>
                <MsStateBadge state={m.state} size="sm" />
                {m.billing_amount_paise !== null && (
                  <span className="tnum whitespace-nowrap text-[12px]">
                    {m.billing_amount_paise ? fmtMoney(m.billing_amount_paise) : 'No billing'}
                    {m.billing_amount_paise > 0 && <Badge size="sm" tone={m.billing_status === 'paid' ? 'success' : m.billing_status === 'invoiced' ? 'info' : 'neutral'} className="ml-1.5">{m.billing_status === 'paid' ? 'Paid' : m.billing_status === 'invoiced' ? 'Invoiced' : 'Not due'}</Badge>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 space-y-4 lg:col-span-6">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
          <Def label="Project manager">{s.pm_id ? <PersonName id={s.pm_id} size={20} /> : '—'}</Def>
          <Def label="Start"><span className="tnum">{fmtDate(s.start_on)}</span></Def>
          <Def label="Planned end"><span className="tnum">{fmtDate(s.end_on)}</span></Def>
          <Def label="Forecast end"><span className={cn('tnum', s.forecast_end && s.forecast_end > s.end_on && 'font-medium text-danger-text')}>{fmtDate(s.forecast_end)}</span></Def>
        </dl>
        <div>
          <h4 className="mb-1.5 text-[13px] font-semibold">Open tasks <span className="tnum font-normal text-ink-3">({s.open_count})</span></h4>
          {!s.open_tasks.length ? (
            <p className="text-[13px] text-ink-3">Nothing open.</p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {s.open_tasks.map((t) => (
                <li key={t.id} className="flex min-w-0 items-baseline gap-2">
                  <span className="tnum w-8 shrink-0 text-ink-3">{t.wbs}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">{people.get(t.owner_id)?.name.split(' ')[0] ?? '—'}</span>
                  <span className={cn('tnum shrink-0 whitespace-nowrap text-[12px]', t.overdue ? 'font-medium text-danger-text' : 'text-ink-3')}>{fmtDate(t.due_on)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-1.5 text-[13px] font-semibold">Critical risks</h4>
          {!s.risks.length ? (
            <p className="text-[13px] text-ink-3">No breach risks on the schedule.</p>
          ) : (
            <ul className="space-y-1.5 text-[13px]">
              {s.risks.map((r) => (
                <li key={r.id} className="flex min-w-0 items-start gap-2">
                  <AlertTriangle className={cn('mt-0.5 size-4 shrink-0', r.critical ? 'text-danger-text' : 'text-warning-text')} />
                  <span className="min-w-0">
                    <span className="tnum text-ink-3">{r.wbs}</span> {r.title}
                    <span className="block text-[12px] text-ink-3">{r.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon={<ExternalLink className="size-4" />} onClick={() => nav(`/projects/${p.id}`)}>
            Open project
          </Button>
          <Button size="sm" onClick={() => nav(`/projects/${p.id}/client-view`)}>
            Client view
          </Button>
        </div>
      </div>
    </div>
  )
}
