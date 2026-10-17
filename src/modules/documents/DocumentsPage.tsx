// Documents: my documents (incl. read-required), company library, and project libraries.
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Badge, Callout, Card, Combobox, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, Select, SkeletonRows, StatCard, Tabs, type Column } from '@/ui'
import { FileText } from '@/ui/icons'
import { usePeopleMap } from '@/api/core'
import { DOC_CATEGORY, useDocProjects, useDocuments, type DocListItem } from '@/api/documents'
import type { DocCategory } from '@/types/business'
import { fmtDate } from '@/domain/calendar'
import { DocLibrary, DocSheet, DocStatus, FileIcon, typeLabel } from './shared'

type Tab = 'mine' | 'company' | 'project'
const TABS: Tab[] = ['mine', 'company', 'project']

export default function DocumentsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'mine') as Tab
  const openId = params.get('doc')
  const setParam = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        return n
      },
      { replace: k === 'doc' && !v },
    )
  const summary = useDocuments({ scope: 'mine' })
  const projects = useDocProjects()
  const all = summary.data?.items ?? []
  const pending = summary.data?.pending_count ?? 0

  return (
    <div>
      <PageHeader title="Documents" subtitle="Project documents your team needs, and the company’s policies, processes and templates." />
      <div className="mb-5 grid grid-cols-3 gap-3 lg:max-w-[720px]">
        <StatCard label="Read required" value={summary.isLoading ? '–' : pending} tone={pending ? 'warning' : undefined} sub={pending ? 'To acknowledge' : 'All caught up'} onClick={() => setParam('tab', 'mine')} />
        <StatCard label="Project documents" value={summary.isLoading ? '–' : all.filter((d) => d.project_id).length} sub={`${projects.data?.filter((p) => p.doc_count).length ?? 0} projects`} onClick={() => setParam('tab', 'project')} />
        <StatCard label="Company library" value={summary.isLoading ? '–' : all.filter((d) => !d.project_id).length} sub="Policies & processes" onClick={() => setParam('tab', 'company')} />
      </div>
      <Tabs
        value={tab}
        onChange={(v) => setParam('tab', v === 'mine' ? null : v)}
        tabs={[
          { value: 'mine', label: 'My documents', count: pending || undefined },
          { value: 'company', label: 'Company library' },
          { value: 'project', label: 'By project' },
        ]}
      />
      {tab === 'mine' && <MyDocuments onOpen={(id) => setParam('doc', id)} />}
      {tab === 'company' && <DocLibrary projectId={null} onOpen={(id) => setParam('doc', id)} />}
      {tab === 'project' && <ByProject onOpen={(id) => setParam('doc', id)} />}
      <DocSheet id={openId} onClose={() => setParam('doc', null)} />
    </div>
  )
}

/* ---------------- My documents ---------------- */
function MyDocuments({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const list = useDocuments({ scope: 'mine', q: q || undefined, category: category || undefined })
  const { get } = usePeopleMap()
  const items = list.data?.items ?? []
  const pending = items.filter((d) => d.my_ack === 'pending')
  const rest = items.filter((d) => d.my_ack !== 'pending')

  const cols: Column<DocListItem>[] = useMemo(
    () => [
      {
        key: 'title', header: 'Title', sortValue: (d) => d.title.toLowerCase(),
        cell: (d) => (
          <div className="flex min-w-0 items-start gap-2.5">
            <FileIcon name={d.file_name} isLink={d.is_link} className="mt-0.5" />
            <div className="min-w-0">
              <div className="truncate font-medium text-ink">{d.title}</div>
              <div className="truncate text-[12px] text-ink-3">{typeLabel(d)}</div>
            </div>
          </div>
        ),
      },
      {
        key: 'project', header: 'Project', width: '220px', hideBelow: 'lg', sortValue: (d) => d.project_name ?? '',
        cell: (d) => (d.project_id ? <span className="block truncate text-ink-2" title={d.project_name ?? ''}><span className="tnum text-ink-3">{d.project_code}</span> {d.project_name}</span> : <span className="text-ink-3">Company library</span>),
      },
      { key: 'cat', header: 'Category', width: '140px', hideBelow: 'xl', sortValue: (d) => DOC_CATEGORY[d.category], cell: (d) => <span className="whitespace-nowrap text-ink-2">{DOC_CATEGORY[d.category]}</span> },
      { key: 'ver', header: 'Version', width: '80px', sortValue: (d) => d.current_version, cell: (d) => <span className="tnum text-ink-2">v{d.current_version}</span> },
      {
        key: 'upd', header: 'Updated', width: '150px', hideBelow: 'lg', sortValue: (d) => d.updated_at,
        cell: (d) => (
          <div className="min-w-0">
            <div className="tnum whitespace-nowrap text-ink-2">{fmtDate(d.updated_at.slice(0, 10))}</div>
            <div className="truncate text-[12px] text-ink-3">{get(d.updated_by)?.name ?? '—'}</div>
          </div>
        ),
      },
      { key: 'status', header: 'Status', width: '150px', cell: (d) => <DocStatus d={d} managerView={false} /> },
    ],
    [get],
  )
  const card = (d: DocListItem) => (
    <div className="flex min-w-0 items-start gap-2.5">
      <FileIcon name={d.file_name} isLink={d.is_link} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{d.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{d.project_id ? `${d.project_code} · ${d.project_name}` : 'Company library'}</div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[12px] text-ink-3">
            {DOC_CATEGORY[d.category]} · v{d.current_version} · {fmtDate(d.updated_at.slice(0, 10))}
          </span>
          <span className="shrink-0">
            <DocStatus d={d} managerView={false} />
          </span>
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2.5 md:flex-row md:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search all documents" className="md:max-w-[320px] md:flex-1" />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} placeholder="All categories" options={(Object.keys(DOC_CATEGORY) as DocCategory[]).map((c) => ({ value: c, label: DOC_CATEGORY[c] }))} className="md:w-[200px]" aria-label="Category" />
      </div>
      {list.isLoading ? (
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      ) : list.error ? (
        <Card>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </Card>
      ) : items.length === 0 ? (
        <Card pad={false}>
          <EmptyState icon={<FileText />} title={q || category ? 'No documents match' : 'No documents yet'} body={q || category ? 'Try another search or category.' : 'Documents shared on your projects and the company library appear here.'} />
        </Card>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <section>
              <Callout tone="warning" title={`${pending.length} ${pending.length === 1 ? 'document needs' : 'documents need'} your acknowledgement`} className="mb-3">
                Open each one, read it, and select Acknowledge.
              </Callout>
              <h3 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
                Read required
                <Badge tone="warning" size="sm">
                  {pending.length}
                </Badge>
              </h3>
              <DataTable rows={pending} columns={cols} rowKey={(d) => d.id} onRowClick={(d) => onOpen(d.id)} mobileCard={card} stickyHeader={false} />
            </section>
          )}
          {rest.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
                {pending.length ? 'All other documents' : 'All documents'}
                <span className="tnum text-[12px] font-normal text-ink-3">{rest.length}</span>
              </h3>
              <DataTable rows={rest} columns={cols} rowKey={(d) => d.id} onRowClick={(d) => onOpen(d.id)} mobileCard={card} stickyHeader={false} initialSort={{ key: 'upd', dir: 'desc' }} />
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- By project ---------------- */
export function ByProject({ onOpen }: { onOpen: (id: string) => void }) {
  const projects = useDocProjects()
  const [params, setParams] = useSearchParams()
  const list = projects.data ?? []
  const pid = params.get('project') ?? ''
  const selected = list.find((p) => p.id === pid) ?? null
  useEffect(() => {
    if (!pid && list.length) {
      const first = list.find((p) => p.pending) ?? list.find((p) => p.doc_count) ?? list[0]
      setParams(
        (p) => {
          const n = new URLSearchParams(p)
          n.set('project', first.id)
          return n
        },
        { replace: true },
      )
    }
  }, [pid, list, setParams])

  if (projects.isLoading)
    return (
      <Card>
        <SkeletonRows rows={4} />
      </Card>
    )
  if (projects.error)
    return (
      <Card>
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      </Card>
    )
  if (!list.length)
    return (
      <Card pad={false}>
        <EmptyState title="You are not on any project yet" body="Project documents appear here once you have a task or an allocation on a project." />
      </Card>
    )
  return (
    <div>
      <div className="mb-4 flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
        <span className="text-[13px] font-medium text-ink-2">Project</span>
        <Combobox
          value={selected?.id ?? null}
          onChange={(v) =>
            v &&
            setParams((p) => {
              const n = new URLSearchParams(p)
              n.set('project', v)
              return n
            })
          }
          options={list.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}`, hint: p.pending ? `${p.pending} to read` : `${p.doc_count} ${p.doc_count === 1 ? 'doc' : 'docs'}` }))}
          placeholder="Choose a project"
          searchPlaceholder="Search projects"
          className="md:w-[420px]"
        />
      </div>
      {selected && <DocLibrary key={selected.id} projectId={selected.id} onOpen={onOpen} />}
    </div>
  )
}
