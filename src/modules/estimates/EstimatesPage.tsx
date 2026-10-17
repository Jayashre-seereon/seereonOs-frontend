// v7 PROJECT COST CALCULATOR — saved estimates for projects that don't exist yet (CEO point 4). The create-project
// form keeps its own calculator; this is the standalone one in the sidebar. Every number is computed on the server.
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Calculator, Columns3, Copy, GitBranch, MoreHorizontal, Plus, Trash2 } from '@/ui/icons'
import { useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { estimatesApi, ESTIMATES_INVALIDATE, useEstimates, type EstimateListItem } from '@/api/estimates'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import {
  Badge, Button, DataTable, EmptyState, FilterChips, IconButton, Menu, PageHeader, SearchInput, Select, StatCard, StatusBadge, TONE_TEXT, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { CompareSheet } from './CompareSheet'
import { ESTIMATE_STATUS, ESTIMATE_STATUS_ORDER, marginTone } from './labels'

export default function EstimatesPage() {
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const people = usePeopleMap()
  const { confirm } = useConfirm()
  const [sp, setSp] = useSearchParams()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string>('all')
  const [owner, setOwner] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const compareIds = (sp.get('compare') ?? '').split(',').filter(Boolean).slice(0, 3)
  const list = useEstimates({ q: q || undefined, status, owner_id: owner || undefined })
  const all = useEstimates({})
  const d = list.data
  const k = all.data?.kpis ?? d?.kpis
  const floor = k?.floor_pct ?? 25

  const dup = useMut((v: { id: string; scenario: boolean }) => estimatesApi.duplicate(v.id, v.scenario), {
    invalidate: ESTIMATES_INVALIDATE,
    success: (e) => `${e.number} created`,
    onSuccess: (e) => nav(`/projects/cost-calculator/${e.id}`),
  })
  const del = useMut((v: { id: string; version: number }) => estimatesApi.remove(v.id, v.version), {
    invalidate: ESTIMATES_INVALIDATE,
    success: 'Estimate deleted',
    onSuccess: (_r, v) => setSelected((s) => s.filter((x) => x !== v.id)),
  })
  const remove = async (x: EstimateListItem) => {
    const ok = await confirm({ title: `Delete ${x.number}?`, body: `“${x.name}” and its revision history are removed. This cannot be undone.`, confirmLabel: 'Delete estimate', tone: 'danger' })
    if (ok) del.mutate({ id: x.id, version: x.version })
  }
  const owners = useMemo(() => [...new Set((all.data?.items ?? []).map((x) => x.owner_id))].map((id) => ({ value: id, label: people.get(id)?.name ?? 'Unknown' })).sort((a, b) => a.label.localeCompare(b.label)), [all.data, people])

  const actions = (x: EstimateListItem) => (
    <Menu
      label={`Actions for ${x.number}`}
      trigger={
        <IconButton label={`Actions for ${x.number}`} size="sm" variant="ghost" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      }
      items={[
        { label: 'Open', onSelect: () => nav(`/projects/cost-calculator/${x.id}`) },
        { label: 'Duplicate', icon: <Copy />, disabled: readOnly, onSelect: () => dup.mutate({ id: x.id, scenario: false }) },
        { label: 'Duplicate as scenario', icon: <GitBranch />, disabled: readOnly, onSelect: () => dup.mutate({ id: x.id, scenario: true }) },
        { label: 'Delete', icon: <Trash2 />, danger: true, disabled: readOnly || x.status !== 'draft', hint: x.status !== 'draft' ? 'Drafts only' : undefined, onSelect: () => void remove(x) },
      ]}
    />
  )

  const cols: Column<EstimateListItem>[] = [
    {
      key: 'name', header: 'Estimate', sortValue: (x) => x.name.toLowerCase(),
      cell: (x) => (
        <div className="min-w-[220px] max-w-[340px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="tnum shrink-0 text-[12px] text-ink-3">{x.number}</span>
            <span className="truncate font-medium text-ink" title={x.name}>{x.name}</span>
          </div>
          <div className="truncate text-[12.5px] text-ink-3" title={x.client}>
            {x.client}
            {x.scenario_label && <Badge size="sm" className="ml-1.5">{x.scenario_label}</Badge>}
          </div>
        </div>
      ),
    },
    {
      key: 'link', header: 'Deal / project', hideBelow: 'xl',
      cell: (x) => (x.project ? <span className="whitespace-nowrap text-[12.5px]"><span className="tnum font-medium">{x.project.code}</span> project</span> : x.deal ? <span className="block max-w-[180px] truncate text-[12.5px] text-ink-2" title={x.deal.title}>{x.deal.title}</span> : <span className="text-ink-3">—</span>),
    },
    { key: 'dates', header: 'Dates', hideBelow: 'lg', sortValue: (x) => x.start_on, cell: (x) => <span className="tnum whitespace-nowrap text-[12.5px] text-ink-2">{fmtDate(x.start_on)} – {fmtDate(x.end_on)}</span> },
    { key: 'price', header: 'Price', align: 'right', sortValue: (x) => x.price, cell: (x) => <span className="tnum whitespace-nowrap font-medium">{fmtMoney(x.price)}</span> },
    { key: 'cost', header: 'Cost', align: 'right', hideBelow: 'lg', sortValue: (x) => x.total_cost, cell: (x) => <span className="tnum whitespace-nowrap text-ink-2">{fmtMoney(x.total_cost)}</span> },
    { key: 'margin', header: 'Margin', align: 'right', sortValue: (x) => x.margin ?? -9, cell: (x) => <span className={cn('tnum whitespace-nowrap font-semibold', TONE_TEXT[marginTone(x.margin, floor)])}>{fmtPct(x.margin)}</span> },
    { key: 'markup', header: 'Markup', align: 'right', hideBelow: 'xl', sortValue: (x) => x.markup ?? -9, cell: (x) => <span className="tnum whitespace-nowrap text-ink-2">{fmtPct(x.markup)}</span> },
    { key: 'status', header: 'Status', sortValue: (x) => ESTIMATE_STATUS_ORDER.indexOf(x.status), cell: (x) => <StatusBadge map={ESTIMATE_STATUS} value={x.status} size="sm" /> },
    { key: 'owner', header: 'Owner', hideBelow: 'xl', sortValue: (x) => people.get(x.owner_id)?.name ?? '', cell: (x) => <span className="whitespace-nowrap text-[12.5px]">{people.get(x.owner_id)?.name ?? '—'}</span> },
    { key: 'updated', header: 'Updated', hideBelow: 'lg', sortValue: (x) => x.updated_at, cell: (x) => <span className="tnum whitespace-nowrap text-[12.5px] text-ink-3">{fmtDate(x.updated_at.slice(0, 10))}</span> },
    { key: 'actions', header: '', width: '44px', cell: (x) => <div onClick={(e) => e.stopPropagation()}>{actions(x)}</div> },
  ]

  const tooMany = selected.length > 3
  return (
    <div>
      <PageHeader
        title="Project cost calculator"
        subtitle="Estimate cost, price and margin for projects you are planning or quoting. Convert an estimate into a project when it is won."
        actions={
          <>
            <Button icon={<Columns3 className="size-4" />} disabled={selected.length < 2 || tooMany} title={tooMany ? 'Compare up to three estimates' : selected.length < 2 ? 'Tick two or three estimates to compare' : undefined} onClick={() => setSp({ compare: selected.join(',') })} className="flex-1 md:flex-none">
              Compare{selected.length ? ` (${selected.length})` : ''}
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={readOnly} onClick={() => nav('/projects/cost-calculator/new')} className="flex-1 md:flex-none">
              New estimate
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Estimates in progress" value={k ? fmtNum(k.in_progress) : '—'} sub={k ? `${fmtMoney(k.in_progress_value)} draft and shared` : undefined} onClick={() => setStatus('draft')} />
        <StatCard label="Total quoted value" value={k ? fmtMoney(k.quoted_value) : '—'} sub={k ? `${k.quoted_count} shared, won or converted` : undefined} />
        <StatCard label="Average planned margin" value={k ? fmtPct(k.avg_margin) : '—'} tone={k ? marginTone(k.avg_margin, floor) : undefined} sub={k ? `${k.margin_basis} estimates${k.hidden ? ` · ${k.hidden} hidden` : ''} · floor ${floor}%` : undefined} />
        <StatCard label="Won or converted" value={k ? fmtNum(k.won_converted) : '—'} sub={k ? fmtMoney(k.won_value) : undefined} onClick={() => setStatus('won')} />
      </div>

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, client, deal or number" className="lg:max-w-[340px] lg:flex-1" />
        <FilterChips
          className="min-w-0 lg:flex-1"
          value={status}
          onChange={setStatus}
          options={[{ value: 'all', label: 'All', count: d?.counts.all }, ...ESTIMATE_STATUS_ORDER.map((s) => ({ value: s, label: ESTIMATE_STATUS[s].label, count: d?.counts[s] }))]}
        />
        <Select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} options={[{ value: '', label: 'All owners' }, ...owners]} className="lg:w-[180px]" />
      </div>
      {selected.length > 0 && (
        <p className={cn('mb-2 text-[12.5px]', tooMany ? 'font-medium text-danger-text' : 'text-ink-3')}>
          {selected.length} selected{tooMany ? ' — compare up to three at a time.' : selected.length === 1 ? ' — tick one or two more to compare.' : '.'}{' '}
          <button type="button" className="font-medium text-brand-text hover:underline" onClick={() => setSelected([])}>
            Clear
          </button>
        </p>
      )}

      <DataTable
        rows={d?.items}
        columns={cols}
        rowKey={(x) => x.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        onRowClick={(x) => nav(`/projects/cost-calculator/${x.id}`)}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        initialSort={{ key: 'updated', dir: 'desc' }}
        empty={
          <EmptyState
            icon={<Calculator />}
            title={q || status !== 'all' || owner ? 'No estimates match' : 'No estimates yet'}
            body={q || status !== 'all' || owner ? 'Clear the search or filters to see every estimate.' : 'Estimate cost, price and margin for a project before it exists — with people you have or roles you would hire.'}
            action={!readOnly && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/projects/cost-calculator/new')}>New estimate</Button>}
          />
        }
        mobileCard={(x) => (
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] text-ink-3"><span className="tnum">{x.number}</span> · {x.client}</div>
                <div className="font-medium leading-snug">{x.name}</div>
              </div>
              <div onClick={(e) => e.stopPropagation()}>{actions(x)}</div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
              <StatusBadge map={ESTIMATE_STATUS} value={x.status} size="sm" />
              <span className="tnum whitespace-nowrap font-medium">{fmtMoney(x.price)}</span>
              <span className={cn('tnum whitespace-nowrap font-semibold', TONE_TEXT[marginTone(x.margin, floor)])}>{fmtPct(x.margin)} margin</span>
              <span className="tnum whitespace-nowrap text-ink-3">{fmtDate(x.start_on)} – {fmtDate(x.end_on)}</span>
            </div>
          </div>
        )}
      />

      <CompareSheet ids={compareIds} open={compareIds.length >= 2} onOpenChange={(o) => !o && setSp({})} floorPct={floor} />
    </div>
  )
}
