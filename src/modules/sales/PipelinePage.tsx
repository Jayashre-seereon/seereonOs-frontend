// UI-27 Pipeline: summary strip, Kanban board (dnd-kit, touch-friendly) and list view.
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCorners, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { Columns3, List, MoreHorizontal, Plus, Download } from '@/ui/icons'
import {
  Avatar, Button, Card, CardHeader, DataTable, EmptyState, IconButton, Menu, Money, PageHeader, SearchInput, Segmented, Select, SkeletonCards, StatusBadge, ErrorState, Skeleton, Tooltip, useCan, useReadOnly, type Column,
} from '@/ui'
import { usePeopleMap, usePermissionHolders } from '@/api/core'
import { PRODUCTS, useDeals, useSalesSummary, type DealFilters, type DealView, type FunnelStage, type SalesSummary } from '@/api/sales'
import { DEAL_SOURCE, DEAL_STAGE } from '@/domain/labels'
import { fmtMoney, fmtMoneyCompact, fmtNum, fmtPct } from '@/domain/money'
import { fmtDate } from '@/domain/calendar'
import { storage } from '@/lib/storage'
import { useWeek } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { exportTable } from '@/reports/export'
import type { DealStage, DealSource } from '@/types/entities'
import { ALL_STAGES, CreateProjectDialog, DealFormDialog, StaleBadge, isClosedStage, useStageMover } from './components'

const VIEW_KEY = 'seereonos.sales.view'

export default function PipelinePage() {
  const nav = useNavigate()
  const can = useCan()
  const readOnly = useReadOnly()
  const isAdmin = can('deals.edit_all')
  const [view, setViewState] = useState<'board' | 'list'>(() => storage.get(VIEW_KEY, 'board'))
  const setView = (v: 'board' | 'list') => {
    setViewState(v)
    storage.set(VIEW_KEY, v)
  }
  const [owner, setOwner] = useState('')
  const [stage, setStage] = useState<DealStage | ''>('')
  const [source, setSource] = useState<DealSource | ''>('')
  const [product, setProduct] = useState('')
  const [q, setQ] = useState('')
  const filters: DealFilters = { owner_id: owner || undefined, source: source || undefined, product: product || undefined, q: q || undefined, stage: view === 'list' ? stage || undefined : undefined }
  const deals = useDeals(filters)
  const week = useWeek()
  const summary = useSalesSummary(owner || undefined, week)
  const { data: people } = usePeopleMap()
  const dealOwners = usePermissionHolders('deals.edit_own')
  const [newOpen, setNewOpen] = useState(false)
  const [projectFor, setProjectFor] = useState<DealView | null>(null)
  const mover = useStageMover({ onWon: (d) => isAdmin && !d.project_id && setProjectFor(d) })

  const ownerOptions = useMemo(() => [{ value: '', label: 'All owners' }, ...(people ?? []).filter((p) => p.status === 'active' && (dealOwners ? dealOwners.has(p.id) : p.role === 'sales' || p.role === 'admin')).map((p) => ({ value: p.id, label: p.name }))], [people, dealOwners])
  const s = summary.data
  const items = deals.data?.items
  const filtered = !!(owner || source || product || q || (view === 'list' && stage))

  const doExport = () => {
    if (!items) return
    exportTable(
      {
        title: 'Sales pipeline',
        subtitle: `${items.length} deals`,
        orientation: 'landscape',
        columns: [
          { key: 'title', label: 'Deal', type: 'string' }, { key: 'client', label: 'Client', type: 'string' }, { key: 'stage', label: 'Stage', type: 'string' }, { key: 'owner', label: 'Owner', type: 'string' },
          { key: 'product', label: 'Product', type: 'string' }, { key: 'source', label: 'Source', type: 'string' }, { key: 'one_time', label: 'One-time', type: 'money' }, { key: 'mrr', label: 'Recurring / month', type: 'money' }, { key: 'value', label: 'Deal value', type: 'money' }, { key: 'weighted', label: 'Weighted', type: 'money' },
          { key: 'close', label: 'Expected close', type: 'date' }, { key: 'days', label: 'Days in stage', type: 'number' },
        ],
        rows: items.map((d) => ({ title: d.title, client: d.client, stage: DEAL_STAGE[d.stage].label, owner: d.owner_name, product: d.product, source: DEAL_SOURCE[d.source], one_time: d.value_paise, mrr: d.mrr_paise, value: d.deal_value_paise, weighted: d.weighted_paise, close: d.expected_close, days: d.days_in_stage })),
        totals: { value: items.reduce((a, d) => a + d.deal_value_paise, 0), weighted: items.reduce((a, d) => a + d.weighted_paise, 0) },
      },
      'xlsx',
    )
  }

  return (
    <div>
      <PageHeader
        title="Pipeline"
        subtitle={s ? `${s.open_count} open ${s.open_count === 1 ? 'deal' : 'deals'} · ${fmtMoney(s.open_value)} in play` : 'Every open opportunity, by stage'}
        actions={
          <>
            <Button size="md" icon={<Download className="size-4" />} onClick={doExport} disabled={!items?.length} className="hidden md:inline-flex">
              Export
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)} disabled={readOnly} className="flex-1 md:flex-none">
              New lead
            </Button>
          </>
        }
      />

      {/* Pipeline KPIs (G11.02) + funnel (G11.03) */}
      {summary.isLoading ? (
        <SkeletonCards n={4} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : s ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] [&>*]:min-w-0">
          <PipelineKpis s={s} />
          <FunnelCard s={s} />
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="mt-5 flex flex-col gap-2.5 md:flex-row md:items-center">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'board', label: <span className="inline-flex items-center gap-1.5"><Columns3 className="size-3.5" />Board</span> },
            { value: 'list', label: <span className="inline-flex items-center gap-1.5"><List className="size-3.5" />List</span> },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Search deals, clients, contacts" className="md:w-64" />
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-1 md:justify-end">
          {can('deals.view_all') && <Select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} options={ownerOptions} className="md:w-40" />}
          {view === 'list' && <Select aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value as DealStage | '')} options={[{ value: '', label: 'All stages' }, ...ALL_STAGES.map((v) => ({ value: v, label: DEAL_STAGE[v].label }))]} className="md:w-36" />}
          <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as DealSource | '')} options={[{ value: '', label: 'All sources' }, ...Object.entries(DEAL_SOURCE).map(([value, label]) => ({ value, label }))]} className="md:w-36" />
          <Select aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)} options={[{ value: '', label: 'All products' }, ...PRODUCTS.map((p) => ({ value: p, label: p }))]} className="md:w-40" />
        </div>
      </div>

      <div className="mt-4">
        {deals.error ? (
          <ErrorState error={deals.error} onRetry={() => deals.refetch()} />
        ) : view === 'board' ? (
          deals.isLoading ? (
            <BoardSkeleton />
          ) : (
            <Board deals={items ?? []} onMove={mover.move} readOnly={readOnly} isAdmin={isAdmin} onOpen={(d) => nav(`/sales/${d.id}`)} emptyHint={filtered ? 'No deals match these filters.' : undefined} onNew={() => setNewOpen(true)} />
          )
        ) : (
          <DealList deals={items} loading={deals.isLoading} onOpen={(d) => nav(`/sales/${d.id}`)} filtered={filtered} onNew={() => setNewOpen(true)} />
        )}
      </div>

      <DealFormDialog open={newOpen} onOpenChange={setNewOpen} onSaved={(d) => nav(`/sales/${d.id}`)} />
      <CreateProjectDialog deal={projectFor} open={!!projectFor} onOpenChange={(o) => !o && setProjectFor(null)} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */
function Board({ deals, onMove, readOnly, isAdmin, onOpen, emptyHint, onNew }: { deals: DealView[]; onMove: (d: DealView, s: DealStage) => Promise<boolean>; readOnly: boolean; isAdmin: boolean; onOpen: (d: DealView) => void; emptyHint?: string; onNew: () => void }) {
  const [override, setOverride] = useState<Record<string, DealStage>>({})
  const [active, setActive] = useState<DealView | null>(null)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )
  const shown = deals.map((d) => (override[d.id] ? { ...d, stage: override[d.id] } : d))
  const byStage = useMemo(() => {
    const m = Object.fromEntries(ALL_STAGES.map((s) => [s, [] as DealView[]])) as Record<DealStage, DealView[]>
    for (const d of shown) m[d.stage].push(d)
    for (const s of ALL_STAGES) m[s].sort((a, b) => Number(b.stale) - Number(a.stale) || b.deal_value_paise - a.deal_value_paise)
    return m
  }, [shown])

  const move = async (d: DealView, to: DealStage) => {
    if (to === d.stage) return
    setOverride((o) => ({ ...o, [d.id]: to }))
    try {
      await onMove(d, to)
    } finally {
      setOverride((o) => {
        const n = { ...o }
        delete n[d.id]
        return n
      })
    }
  }
  const onStart = (e: DragStartEvent) => setActive(deals.find((d) => d.id === e.active.id) ?? null)
  const onEnd = (e: DragEndEvent) => {
    setActive(null)
    const d = deals.find((x) => x.id === e.active.id)
    const to = e.over?.id as DealStage | undefined
    if (d && to && to !== d.stage) move(d, to)
  }

  if (!deals.length && emptyHint) return <div className="rounded-lg border border-line bg-surface"><EmptyState title={emptyHint} body="Clear a filter or search to see more." compact /></div>
  if (!deals.length)
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState title="No deals yet" body="Add your first lead. It lands in the Lead column and you can drag it forward as it progresses." action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={onNew} disabled={readOnly}>New lead</Button>} />
      </div>
    )

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-3 scroll-thin md:mx-0 md:snap-none md:px-0">
        {ALL_STAGES.map((s) => (
          <Column key={s} stage={s} deals={byStage[s]} disabled={readOnly}>
            {byStage[s].map((d) => (
              <DealCard key={d.id} deal={d} disabled={readOnly || (isClosedStage(d.stage) && !isAdmin)} onOpen={() => onOpen(d)} onMove={(to) => move(d, to)} isAdmin={isAdmin} />
            ))}
          </Column>
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(.2,.9,.2,1)' }}>{active ? <CardBody deal={active} lifted /> : null}</DragOverlay>
    </DndContext>
  )
}

function Column({ stage, deals, children, disabled }: { stage: DealStage; deals: DealView[]; children: ReactNode; disabled?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled })
  const total = deals.reduce((s, d) => s + d.deal_value_paise, 0)
  const weighted = deals.reduce((s, d) => s + d.weighted_paise, 0)
  const open = stage !== 'won' && stage !== 'lost'
  return (
    <section ref={setNodeRef} aria-label={`${DEAL_STAGE[stage].label} column`} className={cn('flex w-[82vw] max-w-[300px] shrink-0 snap-start flex-col rounded-lg border bg-surface-2 transition-colors sm:w-[240px] lg:w-[214px]', isOver ? 'border-brand bg-brand-soft' : 'border-line')}>
      <header className="border-b border-line px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <h3 className="truncate text-[13px] font-semibold text-ink">{DEAL_STAGE[stage].label}</h3>
          <span className="tnum text-[12px] text-ink-3">{deals.length}</span>
          {open && <span className="tnum ml-auto shrink-0 text-[11.5px] text-ink-3">{Math.round(DEAL_STAGE[stage].chance * 100)}%</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-[12px] text-ink-3">
          <Money value={total} compact className="font-medium text-ink-2" />
          {open && total > 0 && <span className="truncate">· {fmtMoneyCompact(weighted)} weighted</span>}
        </div>
      </header>
      <div className="flex min-h-[112px] flex-1 flex-col gap-2 p-2">
        {children}
        {!deals.length && <div className={cn('grid flex-1 place-items-center rounded-md border border-dashed px-3 py-6 text-center text-[12.5px] text-ink-3', isOver ? 'border-brand' : 'border-line-strong')}>No deals</div>}
      </div>
    </section>
  )
}

function DealCard({ deal, disabled, onOpen, onMove, isAdmin }: { deal: DealView; disabled: boolean; onOpen: () => void; onMove: (s: DealStage) => void; isAdmin: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id, disabled })
  const closed = isClosedStage(deal.stage)
  const menu = ALL_STAGES.filter((s) => s !== deal.stage).map((s) => ({
    label: DEAL_STAGE[s].label,
    hint: `${Math.round(DEAL_STAGE[s].chance * 100)}%`,
    disabled: closed && !isAdmin,
    onSelect: () => onMove(s),
  }))
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable deal. Press Space to pick up, arrow keys to move, Space to drop. Enter opens it."
      className={cn('rounded-lg outline-none touch-manipulation focus-visible:ring-2 focus-visible:ring-brand/40', isDragging && 'opacity-30')}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') return onOpen()
        listeners?.onKeyDown?.(e)
      }}
    >
      <CardBody
        deal={deal}
        action={
          <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Menu
              label="Move to"
              trigger={
                <IconButton size="xs" label={`Move ${deal.title} to…`} disabled={disabled} className="-mr-1 -mt-1 text-ink-3">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              }
              items={[{ label: 'Move to…', disabled: true }, { separator: true, label: '' }, ...menu]}
            />
          </span>
        }
      />
    </div>
  )
}

function CardBody({ deal, action, lifted }: { deal: DealView; action?: ReactNode; lifted?: boolean }) {
  const { get } = usePeopleMap()
  const owner = get(deal.owner_id)
  return (
    <article className={cn('cursor-grab select-none rounded-md border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong active:cursor-grabbing', lifted && 'rotate-1 shadow-lg')}>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <h4 className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{deal.title}</h4>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{deal.client}</p>
        </div>
        {action}
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        <Money value={deal.deal_value_paise} compact className="text-[13.5px] font-semibold text-ink" />
        {deal.mrr_paise > 0 && <span className="tnum truncate text-[11.5px] text-ink-3">incl. {fmtMoneyCompact(deal.mrr_paise)}/mo</span>}
        <span className="ml-auto shrink-0" title={owner?.name}>
          {owner && <Avatar name={owner.name} hue={owner.avatar_hue} size={20} />}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
        <span className="tnum">{deal.days_in_stage}d in stage</span>
        {deal.stale && <StaleBadge days={deal.days_since_activity} />}
        {deal.stage === 'won' && deal.project && <span className="tnum">· {deal.project.code}</span>}
        {deal.stage === 'won' && !deal.project && <span className="text-warning-text">· No project yet</span>}
      </div>
      {!isClosedStage(deal.stage) && deal.next_step && (
        <div className={cn('mt-2 flex min-w-0 items-baseline gap-1.5 border-t border-line pt-1.5 text-[11.5px]', deal.next_step_overdue ? 'text-danger-text' : 'text-ink-2')}>
          <span className="min-w-0 flex-1 truncate">{deal.next_step}</span>
          {deal.next_step_on && <span className="tnum shrink-0">{fmtDate(deal.next_step_on)}</span>}
        </div>
      )}
      {deal.stage === 'lost' && deal.lost_reason && <p className="mt-1.5 line-clamp-2 text-[11.5px] text-ink-3">{deal.lost_reason}</p>}
    </article>
  )
}

function BoardSkeleton() {
  return (
    <div className="-mx-4 flex gap-3 overflow-hidden px-4 md:mx-0 md:px-0">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="w-[82vw] max-w-[300px] shrink-0 space-y-2 rounded-lg border border-line bg-surface-2 p-3 sm:w-[240px] lg:w-[214px]">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
          {Array.from({ length: 3 - (i % 2) }).map((_, j) => (
            <div key={j} className="space-y-2 rounded-lg border border-line bg-surface p-3">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */
function DealList({ deals, loading, onOpen, filtered, onNew }: { deals?: DealView[]; loading: boolean; onOpen: (d: DealView) => void; filtered: boolean; onNew: () => void }) {
  const cols: Column<DealView>[] = [
    {
      key: 'title', header: 'Deal', sortValue: (d) => d.title.toLowerCase(),
      cell: (d) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink">{d.title}</span>
            {d.stale && <StaleBadge days={d.days_since_activity} />}
          </div>
          <div className="truncate text-[12.5px] text-ink-3">{d.client}{d.contact ? ` · ${d.contact}` : ''}</div>
        </div>
      ),
    },
    { key: 'stage', header: 'Stage', sortValue: (d) => DEAL_STAGE[d.stage].order, cell: (d) => <StatusBadge map={DEAL_STAGE} value={d.stage} size="sm" /> },
    { key: 'owner', header: 'Owner', sortValue: (d) => d.owner_name, cell: (d) => <span className="text-ink-2">{d.owner_name}</span>, hideBelow: 'lg' },
    { key: 'product', header: 'Product', sortValue: (d) => d.product, cell: (d) => <span className="text-ink-2">{d.product}</span>, hideBelow: 'xl' },
    { key: 'source', header: 'Source', sortValue: (d) => d.source, cell: (d) => <span className="text-ink-2">{DEAL_SOURCE[d.source]}</span>, hideBelow: 'xl' },
    { key: 'value', header: 'Deal value', align: 'right', sortValue: (d) => d.deal_value_paise, cell: (d) => <div className="text-right"><Money value={d.deal_value_paise} className="font-semibold" />{d.mrr_paise > 0 && <div className="tnum whitespace-nowrap text-[11.5px] text-ink-3">{fmtMoneyCompact(d.value_paise)} + 12 × {fmtMoneyCompact(d.mrr_paise)}</div>}</div> },
    { key: 'weighted', header: 'Weighted', align: 'right', sortValue: (d) => d.weighted_paise, cell: (d) => <Money value={d.weighted_paise} muted />, hideBelow: 'lg' },
    { key: 'close', header: 'Close', sortValue: (d) => d.expected_close, cell: (d) => <span className={cn('tnum', !isClosedStage(d.stage) && d.expected_close < new Date().toISOString().slice(0, 10) ? 'text-danger-text' : 'text-ink-2')}>{fmtDate(d.won_on ?? d.lost_on ?? d.expected_close)}</span> },
    { key: 'age', header: 'In stage', align: 'right', sortValue: (d) => d.days_in_stage, cell: (d) => <span className="tnum text-ink-3">{d.days_in_stage}d</span>, hideBelow: 'lg' },
  ]
  return (
    <DataTable
      rows={deals}
      loading={loading}
      columns={cols}
      rowKey={(d) => d.id}
      onRowClick={onOpen}
      initialSort={{ key: 'value', dir: 'desc' }}
      empty={
        filtered ? (
          <EmptyState title="No deals match" body="Try another stage, owner or search." compact />
        ) : (
          <EmptyState title="No deals yet" body="Add your first lead to start the pipeline." action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={onNew}>New lead</Button>} />
        )
      }
      mobileCard={(d) => (
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium">{d.title}</div>
              <div className="truncate text-[12.5px] text-ink-3">{d.client} · {d.owner_name}</div>
            </div>
            <Money value={d.deal_value_paise} compact className="shrink-0 text-[14px] font-semibold" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge map={DEAL_STAGE} value={d.stage} size="sm" />
            {d.stale && <StaleBadge days={d.days_since_activity} />}
            <span className="tnum ml-auto whitespace-nowrap text-[12px] text-ink-3">Close {fmtDate(d.expected_close)}</span>
          </div>
        </div>
      )}
      footer={
        deals && deals.length > 1 ? (
          <tr>
            <td className="px-3 py-2.5 pl-4 text-[12.5px]">{deals.length} deals</td>
            <td />
            <td className="hidden lg:table-cell" />
            <td className="hidden xl:table-cell" />
            <td className="hidden xl:table-cell" />
            <td className="px-3 text-right"><Money value={deals.reduce((s, d) => s + d.deal_value_paise, 0)} /></td>
            <td className="hidden px-3 text-right lg:table-cell"><Money value={deals.reduce((s, d) => s + d.weighted_paise, 0)} /></td>
            <td />
            <td className="hidden lg:table-cell" />
          </tr>
        ) : undefined
      }
    />
  )
}

/* ------------------------------------------------------------------ */
/* KPIs and funnel                                                     */
/* ------------------------------------------------------------------ */
function Kpi({ value, label, tone, hint }: { value: ReactNode; label: ReactNode; tone?: 'success' | 'warning' | 'danger'; hint?: string }) {
  const body = (
    <div className="min-w-0">
      <div className={cn('tnum whitespace-nowrap text-[20px] font-semibold leading-tight', tone === 'success' ? 'text-success-text' : tone === 'warning' ? 'text-warning-text' : tone === 'danger' ? 'text-danger-text' : 'text-ink')}>{value}</div>
      <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{label}</div>
    </div>
  )
  return hint ? <Tooltip content={hint}>{body}</Tooltip> : body
}

function PipelineKpis({ s }: { s: SalesSummary }) {
  const wr = s.win_rate_180
  return (
    <Card>
      <CardHeader title="Pipeline" subtitle="Deal value = one-time + 12 × monthly recurring." />
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 2xl:grid-cols-4">
        <Kpi value={fmtMoney(s.open_value)} label={`Open pipeline, ${s.open_count} ${s.open_count === 1 ? 'deal' : 'deals'}`} />
        <Kpi value={fmtMoney(s.weighted_value)} label="Weighted pipeline" hint="Each open deal’s value × its stage’s chance of closing: Lead 10%, Qualified 20%, Demo 35%, Proposal 50%, Negotiation 70%." />
        <Kpi value={fmtMoney(s.won_quarter_value)} label={`Won in ${s.quarter_label} (${s.won_quarter_count})`} />
        <Kpi value={fmtMoney(s.forecast_quarter)} label={`Forecast to close in ${s.quarter_label}`} hint={`Weighted value of the ${s.forecast_quarter_count} open deals expected to close this quarter.`} />
        <Kpi value={fmtPct(wr, 0)} label="Win rate, last 180 days" tone={wr === null ? undefined : wr >= 0.5 ? 'success' : wr >= 0.25 ? 'warning' : 'danger'} hint={`Won ÷ (won + lost) for deals closed in the last 180 days: ${s.won_180} won, ${s.lost_180} lost.`} />
        <Kpi value={s.avg_deal === null ? '—' : fmtMoney(s.avg_deal)} label="Average deal size (won)" />
        <Kpi
          value={s.avg_cycle_days === null ? '—' : `${fmtNum(s.avg_cycle_days, 0)} days`}
          label={<>Average days to close{s.median_cycle_days !== null && <span className="block text-[12px]">Median {fmtNum(s.median_cycle_days, s.median_cycle_days % 1 ? 1 : 0)} days</span>}</>}
          hint="Days from lead created to won, averaged across won deals (the median is the middle value)."
        />
        <Kpi value={fmtMoney(s.recurring_won_monthly)} label="Recurring revenue won (per month)" />
        <Kpi value={s.new_leads_month} label="New leads this month" tone={s.new_leads_month ? undefined : 'warning'} />
        <Kpi value={s.activities_week} label="Sales activities this week" hint={`Week of ${fmtDate(s.week_from)} (header week).`} />
        <Kpi value={s.followups_overdue} label="Follow-ups overdue" tone={s.followups_overdue ? 'danger' : undefined} hint="Open deals whose next-step date has passed." />
        <Kpi value={s.stale_count} label={`Deals with no activity in ${s.stale_days} days`} tone={s.stale_count ? 'warning' : undefined} />
      </div>
    </Card>
  )
}

function FunnelCard({ s }: { s: SalesSummary }) {
  const max = Math.max(1, ...s.funnel.map((f) => f.value), s.lost.value)
  const row = (f: FunnelStage, tone: 'brand' | 'success' | 'danger') => (
    <li key={f.stage} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 sm:grid-cols-[104px_minmax(0,1fr)_auto]">
      <span className="truncate text-[13px] text-ink">{DEAL_STAGE[f.stage].label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={cn('h-full rounded-full', tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-brand')} style={{ width: `${f.value ? Math.max(2, (f.value / max) * 100) : 0}%` }} />
      </div>
      <span className="tnum col-start-2 whitespace-nowrap text-[12.5px] sm:col-start-auto sm:text-right">
        <span className="font-semibold text-ink">{fmtMoney(f.value)}</span> <span className="text-ink-3">{f.count} {f.count === 1 ? 'deal' : 'deals'}</span>
      </span>
    </li>
  )
  return (
    <Card>
      <CardHeader title="Funnel" subtitle="Value and number of deals in each stage now." />
      <ul className="space-y-2.5">{s.funnel.map((f) => row(f, f.stage === 'won' ? 'success' : 'brand'))}</ul>
      <ul className="mt-3 border-t border-line pt-3">{row(s.lost, 'danger')}</ul>
    </Card>
  )
}
