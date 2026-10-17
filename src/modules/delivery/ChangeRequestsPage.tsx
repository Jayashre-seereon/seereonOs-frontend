// /delivery/change-requests — every change request across the viewer's projects with a status filter and approve /
// reject for people who manage that project's CRs; or one project's Changes tab (same component as the project page).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { Check, X } from '@/ui/icons'
import type { ChangeRequest } from '@/types/entities'
import { crApi, type ChangeRequestList, type ProjectListItem } from '@/api/projects'
import { useMut, useScopeKey } from '@/api/query'
import { ApiError } from '@/api/http'
import { CR_STATUS } from '@/domain/labels'
import { fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney, fmtNum } from '@/domain/money'
import { Button, Card, Checkbox, DataTable, Dialog, EmptyState, Field, FilterChips, Input, PageHeader, Select, StatCard, StatusBadge, useConfirm, useReadOnly, type Column } from '@/ui'
import { ChangesTab } from '@/modules/projects/tabs/ChangesTab'
import { ModeSwitch, ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, useViewMode, WithProject } from './shared'

const INV = (pid: string) => [['project', pid], ['projects'], ['delivery'], ['tasks']]
const STATUS_MAP = { ...CR_STATUS, raised: { label: 'Awaiting estimate', tone: 'neutral' as const }, estimated: { label: 'Awaiting decision', tone: 'neutral' as const } }
type Filter = 'open' | 'approved' | 'rejected' | 'done' | 'all'
interface Row {
  cr: ChangeRequest
  p: ProjectListItem
  can_manage: boolean
}
const isOpen = (cr: ChangeRequest) => cr.status === 'raised' || cr.status === 'estimated'

export default function DeliveryChangeRequestsPage() {
  const { q, items } = useDeliveryProjects()
  const { mode, setMode } = useViewMode(true)
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="Change requests" subtitle="Client asks after signing, across your projects. Approving adds the value to the contract; tasks enter the WBS only after approval." />
      <ProjectsGate q={q} items={items}>
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === 'all' ? (
          <Overview projects={items} />
        ) : (
          <>
            <ProjectPickerCard projects={items} id={id} onChange={choose} tab="changes" />
            <WithProject id={id}>{(d) => <ChangesTab d={d} />}</WithProject>
          </>
        )}
      </ProjectsGate>
    </div>
  )
}

function Overview({ projects }: { projects: ProjectListItem[] }) {
  const nav = useNavigate()
  const scope = useScopeKey()
  const readOnly = useReadOnly()
  const { askReason } = useConfirm()
  const qs = useQueries({ queries: projects.map((p) => ({ queryKey: [...scope, 'project', p.id, 'crs'], queryFn: () => crApi.list(p.id), retry: false })) })
  const [filter, setFilter] = useState<Filter>('open')
  const [project, setProject] = useState('')
  const [decide, setDecide] = useState<Row | null>(null)
  const lists = qs.map((x, i) => ({ p: projects[i], l: x.data as ChangeRequestList | undefined }))
  const all: Row[] = useMemo(() => lists.flatMap(({ p, l }) => (l ? l.items.map((cr) => ({ cr, p, can_manage: l.can_manage })) : [])), [qs.map((x) => x.dataUpdatedAt).join(), projects]) // eslint-disable-line react-hooks/exhaustive-deps
  const loading = qs.some((x) => x.isLoading)
  const reject = useMut((v: Row & { reason: string }) => crApi.reject(v.cr.id, v.reason), { invalidate: [], success: (_r, v) => `CR-${v.cr.number} rejected` })
  const qc = useInvalidate()
  const rows = all.filter((r) => (!project || r.p.id === project) && (filter === 'all' || (filter === 'open' ? isOpen(r.cr) : r.cr.status === filter)))
  const count = (f: Filter) => all.filter((r) => (f === 'all' ? true : f === 'open' ? isOpen(r.cr) : r.cr.status === f)).length
  const approvedValue = all.filter((r) => r.cr.status === 'approved' || r.cr.status === 'done').reduce((s, r) => s + r.cr.value_paise, 0)
  const awaitingValue = all.filter((r) => isOpen(r.cr)).reduce((s, r) => s + r.cr.value_paise, 0)
  const columns: Column<Row>[] = [
    { key: 'no', header: 'CR', width: '72px', sortValue: (r) => r.cr.number ?? 0, cell: (r) => <span className="tnum font-semibold text-brand-text">CR-{r.cr.number ?? '?'}</span> },
    {
      key: 'title', header: 'Change request', sortValue: (r) => r.cr.title,
      cell: (r) => (
        <div className="min-w-0">
          <div className="text-[13.5px] text-ink">{r.cr.title}</div>
          <div className="text-[12px] text-ink-3"><span className="tnum">{r.p.code}</span> · {r.p.name}</div>
        </div>
      ),
    },
    { key: 'req', header: 'Requested', sortValue: (r) => r.cr.requested_on ?? r.cr.created_at, cell: (r) => <div className="min-w-0 text-[13px]"><div className="truncate">{r.cr.requested_by_client || 'Client'}</div><div className="tnum text-[12px] text-ink-3">{fmtDate(r.cr.requested_on ?? r.cr.created_at.slice(0, 10))}</div></div> },
    { key: 'hours', header: 'Effort', align: 'right', sortValue: (r) => r.cr.hours, cell: (r) => <span className="tnum whitespace-nowrap">{r.cr.hours ? `${fmtNum(r.cr.hours, 1)}h` : '—'}</span> },
    { key: 'impact', header: 'Impact', align: 'right', hideBelow: 'lg', sortValue: (r) => r.cr.impact_days ?? 0, cell: (r) => <span className="tnum whitespace-nowrap">{r.cr.impact_days ?? 0}d</span> },
    { key: 'value', header: 'Value', align: 'right', sortValue: (r) => r.cr.value_paise, cell: (r) => <span className="tnum whitespace-nowrap">{fmtMoney(r.cr.value_paise)}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => r.cr.status, cell: (r) => <StatusBadge map={STATUS_MAP} value={r.cr.status} size="sm" /> },
    { key: 'act', header: '', width: '196px', cell: (r) => actions(r) },
  ]
  function actions(r: Row) {
    if (!r.can_manage || !isOpen(r.cr)) return null
    return (
      <div className="flex justify-end gap-1.5 whitespace-nowrap max-md:justify-start" onClick={(e) => e.stopPropagation()}>
        <Button size="xs" variant="primary" disabled={readOnly} icon={<Check className="size-3.5" />} onClick={() => setDecide(r)}>
          Approve
        </Button>
        <Button
          size="xs"
          disabled={readOnly}
          icon={<X className="size-3.5" />}
          onClick={async () => {
            const reason = await askReason({ title: `Reject CR-${r.cr.number} “${r.cr.title}”?`, label: 'Reason', placeholder: 'e.g. Client withdrew the request after the cost estimate', confirmLabel: 'Reject', tone: 'danger' })
            if (reason) reject.mutate({ ...r, reason }, { onSuccess: () => qc(r.p.id) })
          }}
        >
          Reject
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label="Awaiting decision" value={String(count('open'))} tone={count('open') ? 'warning' : undefined} sub={awaitingValue ? `${fmtMoney(awaitingValue)} proposed` : 'Nothing pending'} />
        <StatCard label="Approved" value={String(count('approved') + count('done'))} sub={`${fmtMoney(approvedValue)} added`} />
        <StatCard label="Rejected" value={String(count('rejected'))} />
        <StatCard label="Projects with CRs" value={String(new Set(all.map((r) => r.p.id)).size)} sub={`${all.length} change requests`} />
      </div>
      <Card pad={false}>
        <div className="flex flex-col gap-3 border-b border-line p-4 md:flex-row md:items-end md:justify-between md:px-5">
          <FilterChips
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: 'Awaiting', count: count('open') },
              { value: 'approved', label: 'Approved', count: count('approved') },
              { value: 'done', label: 'Delivered', count: count('done') },
              { value: 'rejected', label: 'Rejected', count: count('rejected') },
              { value: 'all', label: 'All', count: count('all') },
            ]}
          />
          <Field label="Project" className="md:w-[300px]">
            <Select value={project} onChange={(e) => setProject(e.target.value)} options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} aria-label="Filter by project" />
          </Field>
        </div>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.cr.id}
          loading={loading && !all.length}
          initialSort={{ key: 'req', dir: 'desc' }}
          onRowClick={(r) => nav(`/projects/${r.p.id}/changes`)}
          empty={<EmptyState compact title="No change requests here" body={filter === 'open' ? 'Nothing is waiting for a decision.' : 'Try another status or project.'} />}
          mobileCard={(r) => (
            <div className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] text-ink-3"><span className="tnum">{r.p.code}</span> · {r.p.name}</div>
                  <div className="text-[14px] font-medium text-ink"><span className="tnum text-brand-text">CR-{r.cr.number ?? '?'}</span> {r.cr.title}</div>
                </div>
                <StatusBadge map={STATUS_MAP} value={r.cr.status} size="sm" />
              </div>
              <div className="tnum mt-1 text-[12.5px] text-ink-3">
                {r.cr.hours ? `${fmtNum(r.cr.hours, 1)}h` : 'Not estimated'} · {r.cr.impact_days ?? 0}d impact · {fmtMoney(r.cr.value_paise)}
              </div>
              {r.can_manage && isOpen(r.cr) && <div className="mt-2">{actions(r)}</div>}
            </div>
          )}
        />
      </Card>
      <ApproveDialog row={decide} onClose={() => setDecide(null)} onDone={(pid) => qc(pid)} />
    </div>
  )
}

/** Invalidate the same keys the project's Changes tab does. */
function useInvalidate() {
  const scope = useScopeKey()
  const qc = useQueryClient()
  return (pid: string) => INV(pid).forEach((k) => qc.invalidateQueries({ queryKey: [...scope, ...k] }))
}

function ApproveDialog({ row, onClose, onDone }: { row: Row | null; onClose: () => void; onDone: (pid: string) => void }) {
  const cr = row?.cr ?? null
  const p = row?.p ?? null
  const [addValue, setAddValue] = useState(true)
  const [createMs, setCreateMs] = useState(false)
  const [msName, setMsName] = useState('')
  const [msEnd, setMsEnd] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!cr || !p) return
    setAddValue(cr.value_paise > 0)
    setCreateMs(false)
    setMsName(`CR-${cr.number} ${cr.title}`)
    setMsEnd(p.end_on < todayISO() ? todayISO() : p.end_on)
    setErrors({})
  }, [cr, p])
  const mut = useMut(() => crApi.approve(cr!.id, { add_to_contract: addValue, milestone: createMs ? { name: msName.trim(), planned_end: msEnd } : null }), {
    success: () => `CR-${cr!.number} approved`,
    onSuccess: () => {
      onDone(p!.id)
      onClose()
    },
    onError: (e: ApiError) => setErrors((x) => ({ ...x, [e.field ?? 'form']: e.message })),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (createMs && !msName.trim()) e['milestone.name'] = 'Name the milestone.'
    if (createMs && !msEnd) e['milestone.planned_end'] = 'Pick an end date.'
    setErrors(e)
    if (!Object.keys(e).length) mut.mutate(undefined)
  }
  const contract = p?.contract_value_paise
  return (
    <Dialog
      open={!!row}
      onOpenChange={(o) => !o && onClose()}
      title={cr ? `Approve CR-${cr.number} “${cr.title}”` : 'Approve'}
      description={cr && p ? `${p.code} ${p.name} · ${fmtNum(cr.hours, 1)}h effort · ${cr.impact_days ?? 0} working days impact · ${fmtMoney(cr.value_paise)}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {(errors.form || errors.hours) && <p className="text-[13px] font-medium text-danger-text">{errors.form || errors.hours}</p>}
        <Checkbox
          checked={addValue}
          onChange={setAddValue}
          disabled={!cr?.value_paise}
          label={`Add ${fmtMoney(cr?.value_paise ?? 0)} to the contract value`}
          description={typeof contract === 'number' ? `Contract goes from ${fmtMoney(contract)} to ${fmtMoney(contract + (addValue ? cr?.value_paise ?? 0 : 0))}.` : undefined}
        />
        <Checkbox checked={createMs} onChange={setCreateMs} label="Create a billing milestone for this work" description="Billed at the change request value. Its tasks set the deadline once added." />
        {createMs && (
          <div className="grid gap-3 sm:grid-cols-2 sm:pl-7">
            <Field label="Milestone name" required error={errors['milestone.name']}>
              <Input value={msName} onChange={(e) => setMsName(e.target.value)} invalid={!!errors['milestone.name']} />
            </Field>
            <Field label="Provisional end" required error={errors['milestone.planned_end']} hint={p && msEnd > p.end_on ? 'The project end moves to this date.' : undefined}>
              <Input type="date" value={msEnd} onChange={(e) => setMsEnd(e.target.value)} invalid={!!errors['milestone.planned_end']} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  )
}
