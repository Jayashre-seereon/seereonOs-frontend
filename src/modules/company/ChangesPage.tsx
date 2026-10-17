// /changes — maker-checker: changes waiting for me, changes I proposed, and the decided history.
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Stamp } from '@/ui/icons'
import { useApi } from '@/api/query'
import { changesApi, type ChangeView } from '@/api/changes'
import { fmtDateTime } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { Avatar, Badge, Button, Callout, DataTable, EmptyState, ErrorState, FilterChips, PageHeader, Sheet, SkeletonRows, Tabs, useCan, type Column } from '@/ui'
import { ACTION_LABEL, CHANGE_STATUS, ChangeActions, ChangeBody, ageText } from '@/modules/workflows/ChangeDetail'

type Tab = 'check' | 'mine' | 'history'

export default function ChangesPage() {
  const can = useCan()
  const checker = can('makerchecker.check')
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>(checker ? 'check' : 'mine')
  const [entity, setEntity] = useState<string>('all')
  const openId = params.get('id')
  const setOpen = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('id', id)
    else p.delete('id')
    setParams(p, { replace: true })
  }

  const summary = useApi(['changes', 'summary'], changesApi.summary)
  const toCheck = useApi(['changes', 'list', 'check'], () => changesApi.list({ status: 'pending', scope: 'to_check' }), { enabled: checker })
  const mine = useApi(['changes', 'list', 'mine'], () => changesApi.list({ status: 'all', scope: 'mine' }))
  const history = useApi(['changes', 'list', 'history'], () => changesApi.list({ status: 'decided' }), { enabled: tab === 'history' })
  const q = tab === 'check' ? toCheck : tab === 'mine' ? mine : history
  const minePending = mine.data?.filter((c) => c.status === 'pending').length ?? summary.data?.mine_pending

  const entities = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>()
    for (const c of q.data ?? []) m.set(c.entity, { label: c.entity_label.replace(/ \(.*\)$/, ''), n: (m.get(c.entity)?.n ?? 0) + 1 })
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n)
  }, [q.data])
  const list = (q.data ?? []).filter((c) => entity === 'all' || c.entity === entity)
  const all = [...(toCheck.data ?? []), ...(mine.data ?? []), ...(history.data ?? [])]
  const listed = all.find((c) => c.id === openId) ?? null
  const detail = useApi(['changes', 'one', openId], () => changesApi.get(openId!), { enabled: !!openId })
  const open = detail.data ?? listed

  return (
    <div>
      <PageHeader title="Change approvals" subtitle="Sensitive changes take effect only after a second person approves them." />
      {summary.data && !summary.data.enabled && (
        <Callout
          tone="info"
          className="mb-4"
          title="Maker-checker is off"
          action={can('makerchecker.configure') ? <Link to="/setup/maker-checker"><Button size="sm">Open settings</Button></Link> : undefined}
        >
          Changes apply as soon as they are saved. Turn it on to require a second person for roles, salaries, workflows and other sensitive settings.
        </Callout>
      )}
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t)
          setEntity('all')
        }}
        tabs={[
          { value: 'check', label: 'To check', count: toCheck.data?.length ?? summary.data?.to_check, hidden: !checker },
          { value: 'mine', label: 'My changes', count: minePending || undefined },
          { value: 'history', label: 'History' },
        ]}
      />
      {entities.length > 1 && (
        <FilterChips className="mb-3" value={entity} onChange={setEntity} options={[{ value: 'all', label: 'All', count: q.data?.length }, ...entities.map(([k, v]) => ({ value: k, label: v.label, count: v.n }))]} />
      )}
      {q.isLoading ? (
        <SkeletonRows rows={5} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <ChangeTable rows={list} tab={tab} onOpen={(c) => setOpen(c.id)} />
      )}

      <Sheet
        open={!!openId}
        onOpenChange={(o) => !o && setOpen(null)}
        width={720}
        title={open?.summary ?? 'Change'}
        subtitle={open ? `${open.entity_label} · ${ACTION_LABEL[open.action].toLowerCase()} proposed by ${open.maker_name}` : undefined}
        footer={open && (open.can_check || open.can_withdraw) ? <ChangeActions c={open} onDone={() => setOpen(null)} block /> : undefined}
      >
        {open ? <ChangeBody c={open} /> : detail.error ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} /> : <SkeletonRows rows={4} />}
      </Sheet>
    </div>
  )
}

function ChangeTable({ rows, tab, onOpen }: { rows: ChangeView[]; tab: Tab; onOpen: (c: ChangeView) => void }) {
  const me = useSession((s) => s.user?.id)
  const cols: Column<ChangeView>[] = [
    {
      key: 'summary', header: 'Change', sortValue: (c) => c.summary,
      cell: (c) => (
        <div className="min-w-0 max-w-[560px]">
          <div className="line-clamp-2 text-[13.5px] font-medium text-ink">{c.summary}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{c.entity_label}</div>
        </div>
      ),
    },
    {
      key: 'maker', header: 'Proposed by', sortValue: (c) => c.maker_name, hideBelow: 'lg',
      cell: (c) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={c.maker_name} hue={c.maker_hue} size={24} />
          <span className="truncate text-ink-2">{c.maker_id === me ? 'You' : c.maker_name}</span>
        </span>
      ),
    },
    {
      key: 'age', header: tab === 'history' ? 'Proposed' : 'Waiting', sortValue: (c) => c.created_at,
      cell: (c) => <span className={cn('tnum whitespace-nowrap', c.status === 'pending' && c.overdue ? 'text-danger-text' : 'text-ink-2')}>{c.status === 'pending' ? ageText(c) : fmtDateTime(c.created_at)}</span>,
    },
    { key: 'perm', header: 'Checker needs', hideBelow: 'xl', cell: (c) => <span className="text-ink-2">{c.required_permission_label}</span> },
    {
      key: 'status', header: 'Status', sortValue: (c) => c.status,
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge size="sm" tone={CHANGE_STATUS[c.status].tone}>{CHANGE_STATUS[c.status].label}</Badge>
          {c.status === 'pending' && c.overdue && <Badge size="sm" tone="danger">Overdue</Badge>}
        </span>
      ),
    },
  ]
  if (tab !== 'check') cols.splice(4, 0, { key: 'checker', header: 'Checker', hideBelow: 'xl', cell: (c) => <span className="text-ink-2">{c.checker_name ?? '—'}</span> })
  const empty =
    tab === 'check' ? (
      <EmptyState icon={<Stamp />} title="Nothing waiting for you" body="Changes other people propose to roles, salaries, workflows, vendors and payroll appear here for you to approve or reject." compact />
    ) : tab === 'mine' ? (
      <EmptyState icon={<Stamp />} title="You haven’t proposed any changes" body="When you change something that needs a second person, it waits here until it is approved." compact />
    ) : (
      <EmptyState icon={<Stamp />} title="No decided changes yet" body="Approved, rejected, withdrawn and failed changes are kept here as an audit trail." compact />
    )
  return (
    <DataTable
      rows={rows}
      columns={cols}
      rowKey={(c) => c.id}
      onRowClick={onOpen}
      empty={empty}
      initialSort={tab === 'check' ? { key: 'age', dir: 'asc' } : { key: 'age', dir: 'desc' }}
      mobileCard={(c) => (
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[13.5px] font-medium text-ink">{c.summary}</div>
              <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{c.entity_label}</div>
            </div>
            <Badge size="sm" tone={CHANGE_STATUS[c.status].tone}>{CHANGE_STATUS[c.status].label}</Badge>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-[12.5px]">
            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
              <Avatar name={c.maker_name} hue={c.maker_hue} size={20} />
              <span className="truncate">{c.maker_id === me ? 'You' : c.maker_name}</span>
            </span>
            <span className={cn('tnum shrink-0 whitespace-nowrap', c.status === 'pending' && c.overdue ? 'text-danger-text' : 'text-ink-3')}>{c.status === 'pending' ? ageText(c) : fmtDateTime(c.created_at)}</span>
          </div>
        </div>
      )}
    />
  )
}
