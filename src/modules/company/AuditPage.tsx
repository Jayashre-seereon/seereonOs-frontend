import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { History } from '@/ui/icons'
import { useApi } from '@/api/query'
import { companyApi, ENTITY_LABEL, type AuditQuery, type AuditRow } from '@/api/company'
import { fmtDateTime, relTime } from '@/domain/calendar'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportTable } from '@/reports/export'
import { Avatar, Badge, Button, DataTable, EmptyState, Field, Input, PageHeader, SearchInput, Select, type Column } from '@/ui'

const SOURCE_LABEL: Record<AuditRow['source'], string> = { activity: 'Activity', project_status: 'Status history', deal_stage: 'Stage history', task_review: 'Task review', admin: 'Platform admin' }
const entityLabel = (e: string) => ENTITY_LABEL[e] ?? e.replace(/_/g, ' ')

/** /audit — admin-only, searchable trail of who changed what. */
export default function AuditPage() {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [actor, setActor] = useState('')
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(t)
  }, [text])
  useEffect(() => setPage(1), [q, actor, entity, from, to])
  const query: AuditQuery = { q: q || undefined, actor: actor || undefined, entity: entity || undefined, from: from || undefined, to: to || undefined }
  const r = useApi(['audit', q, actor, entity, from, to, page], () => companyApi.audit({ ...query, page }), { placeholderData: (p) => p })
  const d = r.data
  const filtered = !!(q || actor || entity || from || to)
  const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1

  const exportTable = async (): Promise<ExportTable> => {
    const all = await companyApi.audit({ ...query, all: 1 })
    return {
      title: 'Audit trail',
      subtitle: [from && `From ${from}`, to && `to ${to}`, actor && `by ${all.actors.find((a) => a.id === actor)?.name}`, entity && entityLabel(entity), q && `“${q}”`].filter(Boolean).join(' · ') || 'All activity',
      category: 'Compliance report',
      orientation: 'landscape',
      columns: [
        { key: 'at', label: 'When', type: 'string' },
        { key: 'who', label: 'Who', type: 'string' },
        { key: 'entity', label: 'Entity', type: 'string' },
        { key: 'record', label: 'Record', type: 'string' },
        { key: 'summary', label: 'What happened', type: 'string' },
        { key: 'before', label: 'Before', type: 'string' },
        { key: 'after', label: 'After', type: 'string' },
      ],
      rows: all.items.map((x) => ({ at: fmtDateTime(x.at), who: x.actor?.name ?? 'System', entity: entityLabel(x.entity), record: x.entity_label, summary: x.summary, before: x.before ?? '', after: x.after ?? '' })),
      kpis: [{ label: 'Events', value: String(all.total) }],
    }
  }

  const cols: Column<AuditRow>[] = [
    { key: 'at', header: 'When', width: '150px', cell: (x) => <span className="tnum whitespace-nowrap text-ink-2" title={fmtDateTime(x.at)}>{fmtDateTime(x.at)}</span> },
    { key: 'who', header: 'Who', cell: (x) => (x.actor ? <span className="flex min-w-0 max-w-[180px] items-center gap-2"><Avatar name={x.actor.name} hue={x.actor.hue} size={22} /><span className="truncate">{x.actor.name}</span></span> : <span className="text-ink-3">System</span>) },
    {
      key: 'entity', header: 'Record', hideBelow: 'lg',
      cell: (x) => (
        <div className="min-w-0 max-w-[240px]">
          <div className="text-[12px] text-ink-3">{entityLabel(x.entity)}</div>
          {x.link ? <Link to={x.link} onClick={(e) => e.stopPropagation()} className="block truncate text-ink hover:underline">{x.entity_label}</Link> : <div className="truncate">{x.entity_label}</div>}
        </div>
      ),
    },
    {
      key: 'summary', header: 'What happened',
      cell: (x) => (
        <div className="min-w-[280px]">
          <div className="line-clamp-2 text-ink">{x.summary}</div>
          {(x.before || x.after) && x.source !== 'activity' && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
              {x.before && <Badge size="sm">{x.before.replace(/_/g, ' ')}</Badge>}
              <span className="text-ink-3">→</span>
              {x.after && <Badge size="sm" tone="info">{x.after.replace(/_/g, ' ')}</Badge>}
            </div>
          )}
        </div>
      ),
    },
    { key: 'source', header: 'Source', hideBelow: 'xl', cell: (x) => <span className="whitespace-nowrap text-[12.5px] text-ink-3">{SOURCE_LABEL[x.source]}</span> },
  ]

  return (
    <div>
      <PageHeader
        title="Audit trail"
        subtitle="Who changed what, and when — across projects, tasks, timesheets, deals, goals and workspace administration."
        actions={<ExportMenu table={d && d.total ? exportTable : null} filename="audit-trail" />}
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))_150px_150px_auto] lg:items-end">
        <Field label="Search" className="sm:col-span-2 lg:col-span-1">
          <SearchInput value={text} onChange={setText} placeholder="Search summaries, records, people" />
        </Field>
        <Field label="Person">
          <Select value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Anyone" options={(d?.actors ?? []).map((a) => ({ value: a.id, label: a.name }))} />
        </Field>
        <Field label="Entity">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="All types" options={(d?.entities ?? []).map((e) => ({ value: e.value, label: `${e.label} (${e.count})` }))} />
        </Field>
        <Field label="From">
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button variant="ghost" disabled={!filtered} onClick={() => (setText(''), setQ(''), setActor(''), setEntity(''), setFrom(''), setTo(''))} className="justify-self-start">
          Clear
        </Button>
      </div>

      <DataTable
        rows={d?.items}
        columns={cols}
        rowKey={(x) => x.source + ':' + x.id}
        loading={r.isLoading}
        error={r.error}
        onRetry={() => r.refetch()}
        pageSize={100}
        dense
        empty={<EmptyState icon={<History />} title={filtered ? 'No matching events' : 'No activity yet'} body={filtered ? 'Widen the dates or clear a filter.' : 'Changes people make show up here.'} compact />}
        mobileCard={(x) => (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
              <span className="min-w-0 truncate">{x.actor?.name ?? 'System'} · {entityLabel(x.entity)}</span>
              <span className="tnum shrink-0 whitespace-nowrap">{relTime(x.at)}</span>
            </div>
            <div className="mt-1 text-[13.5px] leading-snug text-ink">{x.summary}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{x.entity_label}</div>
          </div>
        )}
      />
      {d && d.total > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-3">
          <span className="tnum">
            {(d.page - 1) * d.page_size + 1}–{Math.min(d.total, d.page * d.page_size)} of {d.total} events
          </span>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={page <= 1 || r.isFetching} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="tnum whitespace-nowrap">Page {page} of {pages}</span>
              <Button size="sm" disabled={page >= pages || r.isFetching} onClick={() => setPage((p) => p + 1)}>Next 100</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
