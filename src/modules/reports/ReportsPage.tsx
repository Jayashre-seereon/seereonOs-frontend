// /reports — library: Pinned, My reports, Shared, System templates as cards with mini chart
// previews; search; New report; Ask AI.
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Copy, FileBarChart, MoreHorizontal, Pencil, Pin, PinOff, Plus, Share2, Sparkles, Trash2, Users } from '@/ui/icons'
import { reportsApi, useSavedReports, type SavedReportView } from '@/api/reports'
import { useMut } from '@/api/query'
import { useSession } from '@/stores/session'
import { useUI } from '@/stores/ui'
import { Badge, Button, Card, EmptyState, ErrorState, FilterChips, IconButton, Menu, PageHeader, SearchInput, SkeletonCards, useCan, useConfirm, useReadOnly } from '@/ui'
import { relTime } from '@/domain/calendar'
import { CHART_LABEL } from '@/reports/datasets'
import { cn } from '@/lib/utils'
import { MiniChart } from './components/ReportVisual'

type Tab = 'all' | 'pinned' | 'mine' | 'shared' | 'system'

function ReportCard({ r }: { r: SavedReportView }) {
  const nav = useNavigate()
  const c = useCan()
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const pin = useMut(() => reportsApi.pin(r.id, !r.pinned), { invalidate: [['reports']], success: r.pinned ? 'Unpinned' : 'Pinned' })
  const share = useMut(() => reportsApi.share(r.id, !r.shared), { invalidate: [['reports']], success: r.shared ? 'No longer shared' : 'Shared with the team' })
  const dup = useMut(() => reportsApi.duplicate(r.id), { invalidate: [['reports']], success: 'Copy created', onSuccess: (x) => nav(`/reports/${x.id}/edit`) })
  const del = useMut(() => reportsApi.remove(r.id, r.version), { invalidate: [['reports']], success: 'Report deleted' })
  const items = [
    ...(r.can_edit && c('reports.build') ? [{ label: 'Edit', icon: <Pencil />, onSelect: () => nav(`/reports/${r.id}/edit`), disabled: readOnly }] : []),
    ...(c('reports.build') ? [{ label: 'Duplicate', icon: <Copy />, onSelect: () => dup.mutate(undefined), disabled: readOnly }] : []),
    ...(r.can_edit ? [{ label: r.pinned ? 'Unpin' : 'Pin to top', icon: r.pinned ? <PinOff /> : <Pin />, onSelect: () => pin.mutate(undefined), disabled: readOnly }] : []),
    ...(r.can_edit && r.source !== 'system' ? [{ label: r.shared ? 'Stop sharing' : 'Share with team', icon: <Share2 />, onSelect: () => share.mutate(undefined), disabled: readOnly }] : []),
    ...(r.can_edit
      ? [
          { separator: true, label: '' },
          {
            label: 'Delete',
            icon: <Trash2 />,
            danger: true,
            disabled: readOnly,
            onSelect: async () => (await confirm({ title: `Delete “${r.name}”?`, body: r.shared ? 'It’s shared — the team will lose it too. This can’t be undone.' : 'This can’t be undone.', confirmLabel: 'Delete report', tone: 'danger' })) && del.mutate(undefined),
          },
        ]
      : []),
  ]
  return (
    <article className="group relative flex min-w-0 flex-col rounded-lg border border-line bg-surface transition hover:border-line-strong">
      <Link to={`/reports/${r.id}`} className="absolute inset-0 z-0 rounded-lg" aria-label={`Open ${r.name}`} />
      <div className="pointer-events-none relative flex items-start gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold text-ink">{r.name}</h3>
          <p className="truncate text-[12.5px] text-ink-3">{r.description || r.dataset_label}</p>
        </div>
        <div className="pointer-events-auto relative z-[1] -mr-1.5 -mt-1 flex items-center">
          {r.pinned && <Pin className="mr-1 size-3.5 text-ink-3" aria-label="Pinned" />}
          {items.length > 0 && (
            <Menu
              label="Report actions"
              items={items}
              trigger={
                <IconButton size="sm" label="Report actions">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              }
            />
          )}
        </div>
      </div>
      <div className="pointer-events-none relative mx-4 my-3 h-[84px]">
        <MiniChart preview={r.preview} kind={r.spec.chart} />
      </div>
      <div className="pointer-events-none relative mt-auto flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-2.5 text-[11.5px] text-ink-3">
        <Badge size="sm" tone="neutral">{r.source === 'system' ? 'Template' : r.source === 'ai' ? 'AI' : 'Custom'}</Badge>
        <span>{CHART_LABEL[r.spec.chart]}</span>
        {r.shared && r.source !== 'system' && (
          <span>· Shared</span>
        )}
        {r.schedule !== 'none' && <span>· {r.schedule === 'weekly' ? 'Weekly' : 'Monthly'} email</span>}
        <span className="ml-auto min-w-0 truncate">
          {r.owner_name.split(' ')[0]} · {relTime(r.updated_at)}
        </span>
      </div>
    </article>
  )
}

export default function ReportsPage() {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const q = useSavedReports()
  const { user } = useSession()
  const c = useCan()
  const nav = useNavigate()
  const openAI = useUI((s) => s.openAI)
  const all = q.data ?? []
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return all.filter((r) => !s || `${r.name} ${r.description} ${r.dataset_label}`.toLowerCase().includes(s))
  }, [all, search])
  const groups = useMemo(() => {
    const mine = filtered.filter((r) => r.owner_id === user?.id && r.source !== 'system')
    return {
      pinned: filtered.filter((r) => r.pinned),
      mine,
      shared: filtered.filter((r) => r.owner_id !== user?.id && r.source !== 'system'),
      system: filtered.filter((r) => r.source === 'system'),
    }
  }, [filtered, user?.id])
  const sections: { key: Exclude<Tab, 'all'>; title: string; empty: string }[] = [
    { key: 'pinned', title: 'Pinned', empty: 'Pin reports you open often.' },
    { key: 'mine', title: 'My reports', empty: 'Reports you build or save from AI answers appear here.' },
    { key: 'shared', title: 'Shared with me', empty: 'Nothing shared with you yet.' },
    { key: 'system', title: 'System templates', empty: 'No templates for your role.' },
  ]
  const visible = tab === 'all' ? sections : sections.filter((s) => s.key === tab)

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Saved reports re-run on live data. Build your own, or ask in plain English."
        actions={
          <>
            {c('ai.use') && (
              <Button onClick={() => openAI()}>
                Ask AI
              </Button>
            )}
            {c('reports.build') && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/reports/new')}>
                New report
              </Button>
            )}
          </>
        }
      />
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search reports" className="md:w-[320px]" />
        <FilterChips
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'All', count: filtered.length },
            { value: 'pinned', label: 'Pinned', count: groups.pinned.length },
            { value: 'mine', label: 'Mine', count: groups.mine.length },
            { value: 'shared', label: 'Shared', count: groups.shared.length },
            { value: 'system', label: 'Templates', count: groups.system.length },
          ]}
        />
      </div>
      {q.isLoading ? (
        <SkeletonCards n={8} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !all.length ? (
        <Card>
          <EmptyState
            title="No reports yet"
            body="Build a report from any dataset — revenue, hours, tasks, deals — or ask Seereon AI and save the answer."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {c('ai.use') && <Button onClick={() => openAI()}>Ask AI</Button>}
                {c('reports.build') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/reports/new')}>New report</Button>}
              </div>
            }
          />
        </Card>
      ) : !filtered.length ? (
        <Card>
          <EmptyState compact title="No reports match" body={`Nothing matches “${search}”. Try another word, or ask AI to build it.`} action={c('ai.use') ? <Button onClick={() => openAI(search)}>Ask AI: “{search}”</Button> : undefined} />
        </Card>
      ) : (
        <div className="space-y-7">
          {visible.map((s) => {
            const list = groups[s.key]
            if (tab === 'all' && !list.length) return null
            return (
              <section key={s.key}>
                <h2 className="mb-2.5 text-[14px] font-semibold text-ink">
                  {s.title} <span className="tnum font-normal text-ink-3">· {list.length}</span>
                </h2>
                {list.length ? (
                  <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4')}>
                    {list.map((r) => (
                      <ReportCard key={`${s.key}-${r.id}`} r={r} />
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-ink-3">{s.empty}</p>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
