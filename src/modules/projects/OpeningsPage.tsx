import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, MoreHorizontal, Pencil, Plus, Trash2, UserPlus } from '@/ui/icons'
import type { Opening } from '@/types/entities'
import { projectsApi, type OpeningInput, type OpeningView } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import type { Tone } from '@/domain/labels'
import { diffDays, fmtDate, todayISO } from '@/domain/calendar'
import { useSession } from '@/stores/session'
import { usePermissionHolders } from '@/api/core'
import { cn } from '@/lib/utils'
import {
  Badge, Button, Combobox, DataTable, Dialog, EmptyState, Field, FilterChips, IconButton, Input, Menu, PageHeader, PeoplePicker, PersonName, Select, StatusBadge, Textarea, useConfirm, useReadOnly, type Column,
} from '@/ui'

const STATUS: Record<Opening['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'info' },
  interviewing: { label: 'Interviewing', tone: 'accent' },
  offered: { label: 'Offered', tone: 'warning' },
  filled: { label: 'Filled', tone: 'success' },
  on_hold: { label: 'On hold', tone: 'neutral' },
}
const ORDER: Opening['status'][] = ['open', 'interviewing', 'offered', 'filled', 'on_hold']
type F = Opening['status'] | 'all' | 'active'

export default function OpeningsPage() {
  const readOnly = useReadOnly()
  const q = useApi(['openings'], projectsApi.openings)
  const [f, setF] = useState<F>('active')
  const [dlg, setDlg] = useState<{ open: boolean; o: OpeningView | null }>({ open: false, o: null })
  const { confirm } = useConfirm()
  const setStatus = useMut((v: { o: OpeningView; s: Opening['status'] }) => projectsApi.updateOpening(v.o.id, { status: v.s }, v.o.version), { invalidate: [['openings']], success: (_r, v) => `${v.o.role}: ${STATUS[v.s].label}` })
  const del = useMut((o: OpeningView) => projectsApi.deleteOpening(o.id), { invalidate: [['openings']], success: 'Opening removed' })
  const all = q.data ?? []
  const active = (o: OpeningView) => o.status !== 'filled' && o.status !== 'on_hold'
  const rows = all.filter((o) => f === 'all' || (f === 'active' ? active(o) : o.status === f))
  const count = (x: F) => (x === 'all' ? all.length : x === 'active' ? all.filter(active).length : all.filter((o) => o.status === x).length)
  const seats = all.filter(active).reduce((s, o) => s + o.count, 0)
  const today = todayISO()

  const statusMenu = (o: OpeningView) => (
    <Menu
      label="Change status"
      align="start"
      trigger={
        <button type="button" disabled={readOnly} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 rounded-sm">
          <StatusBadge map={STATUS} value={o.status} size="sm" />
          {!readOnly && <ChevronDown className="size-3 text-ink-3" />}
        </button>
      }
      items={ORDER.filter((s) => s !== o.status).map((s) => ({ label: STATUS[s].label, onSelect: () => setStatus.mutate({ o, s }) }))}
    />
  )
  const actions = (o: OpeningView) =>
    readOnly ? null : (
      <Menu
        label="Opening actions"
        trigger={<IconButton size="sm" label="Opening actions" onClick={(e) => e.stopPropagation()}><MoreHorizontal className="size-4" /></IconButton>}
        items={[
          { label: 'Edit', icon: <Pencil />, onSelect: () => setDlg({ open: true, o }) },
          { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: async () => (await confirm({ title: `Remove the ${o.role} opening?`, body: 'Use Filled or On hold instead if you want to keep the record.', confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(o) },
        ]}
      />
    )
  const needed = (o: OpeningView) => {
    if (!o.needed_by) return <span className="text-ink-3">—</span>
    const late = active(o) && o.needed_by < today
    const soon = active(o) && !late && diffDays(o.needed_by, today) <= 14
    return <span className={cn('tnum', late ? 'text-danger-text' : soon ? 'text-warning-text' : '')}>{fmtDate(o.needed_by)}{late ? ' · late' : ''}</span>
  }

  const columns: Column<OpeningView>[] = [
    { key: 'role', header: 'Role', sortValue: (r) => r.role, cell: (r) => <div><div className="font-medium">{r.role}</div>{r.notes && <div className="max-w-[320px] truncate text-[12px] text-ink-3">{r.notes}</div>}</div> },
    { key: 'project', header: 'Project', sortValue: (r) => r.project_name ?? '', cell: (r) => (r.project_name ? <span className="text-[13px]"><span className="tnum text-ink-3">{r.project_code}</span> {r.project_name}</span> : <span className="text-ink-3">General</span>) },
    { key: 'count', header: 'Seats', align: 'right', sortValue: (r) => r.count, cell: (r) => <span className="tnum">{r.count}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => ORDER.indexOf(r.status), cell: (r) => <div onClick={(e) => e.stopPropagation()}>{statusMenu(r)}</div> },
    { key: 'owner', header: 'Owner', hideBelow: 'lg', cell: (r) => <PersonName id={r.owner_id} size={22} /> },
    { key: 'needed', header: 'Needed by', sortValue: (r) => r.needed_by ?? '9999', cell: needed },
    { key: 'menu', header: '', width: '44px', cell: (r) => <div onClick={(e) => e.stopPropagation()}>{actions(r)}</div> },
  ]
  return (
    <div>
      <PageHeader
        title="Openings"
        subtitle={q.data ? `${seats} seat${seats === 1 ? '' : 's'} to fill across ${count('active')} active opening${count('active') === 1 ? '' : 's'}` : 'Hiring needs tied to projects.'}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} disabled={readOnly} onClick={() => setDlg({ open: true, o: null })} className="max-md:w-full">New opening</Button>}
      />
      <FilterChips
        className="mb-4"
        value={f}
        onChange={setF}
        options={[{ value: 'active' as F, label: 'Active', count: count('active') }, { value: 'all' as F, label: 'All', count: count('all') }, ...ORDER.map((s) => ({ value: s as F, label: STATUS[s].label, count: count(s) }))]}
      />
      <DataTable
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => r.id}
        columns={columns}
        onRowClick={readOnly ? undefined : (r) => setDlg({ open: true, o: r })}
        initialSort={undefined}
        empty={<EmptyState icon={<UserPlus />} title={all.length ? 'No openings in this filter' : 'No openings yet'} body={all.length ? undefined : 'Log a hiring need against a project so delivery and HR see the same list.'} action={!all.length && !readOnly ? <Button variant="primary" onClick={() => setDlg({ open: true, o: null })}>New opening</Button> : undefined} />}
        mobileCard={(r) => (
          <div>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-semibold">
                  {r.role} <span className="tnum text-ink-3">× {r.count}</span>
                </div>
                <div className="truncate text-[12.5px] text-ink-3">{r.project_name ? `${r.project_code} ${r.project_name}` : 'General'}</div>
              </div>
              <div onClick={(e) => e.stopPropagation()} className="-mr-1.5 -mt-1 shrink-0">{actions(r)}</div>
            </div>
            {r.notes && <p className="mt-1.5 line-clamp-2 text-[13px] text-ink-2">{r.notes}</p>}
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5 text-[12.5px]" onClick={(e) => e.stopPropagation()}>
              {statusMenu(r)}
              <span className="text-ink-3">Needed by {needed(r)}</span>
              <PersonName id={r.owner_id} size={20} />
            </div>
          </div>
        )}
      />
      <OpeningDialog open={dlg.open} o={dlg.o} onOpenChange={(o) => setDlg((x) => ({ ...x, open: o }))} />
    </div>
  )
}

function OpeningDialog({ open, o, onOpenChange }: { open: boolean; o: OpeningView | null; onOpenChange: (v: boolean) => void }) {
  const { user } = useSession()
  const owners = usePermissionHolders('openings.manage')
  const projects = useApi(['projects', { status: 'all', q: '', type: '', sort: 'priority' }], () => projectsApi.list({ status: 'all' }), { enabled: open })
  const blank = (): OpeningInput => ({ role: '', project_id: null, count: 1, status: 'open', owner_id: user?.id ?? '', needed_by: null, notes: '' })
  const [f, setF] = useState<OpeningInput>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    setF(o ? { role: o.role, project_id: o.project_id, count: o.count, status: o.status, owner_id: o.owner_id, needed_by: o.needed_by, notes: o.notes } : blank())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, o?.id])
  const onError = (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message }))
  const add = useMut((b: OpeningInput) => projectsApi.addOpening(b), { invalidate: [['openings']], success: 'Opening added', onSuccess: () => onOpenChange(false), onError })
  const save = useMut((b: OpeningInput) => projectsApi.updateOpening(o!.id, b, o!.version), { invalidate: [['openings']], success: 'Opening saved', onSuccess: () => onOpenChange(false), onError })
  const projOpts = useMemo(() => (projects.data?.items ?? []).filter((p) => !['closed', 'completed'].includes(p.status) || p.id === f.project_id).map((p) => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.client}` })), [projects.data, f.project_id])
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.role.trim()) e.role = 'Name the role.'
    if (!f.count || f.count < 1) e.count = 'At least 1.'
    if (!f.owner_id) e.owner_id = 'Choose an owner.'
    setErrors(e)
    if (Object.keys(e).length) return
    if (o) save.mutate(f)
    else add.mutate(f)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={o ? 'Edit opening' : 'New opening'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={add.isPending || save.isPending} onClick={submit}>{o ? 'Save opening' : 'Add opening'}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role" required error={errors.role} className="sm:col-span-2">
          <Input autoFocus value={f.role} invalid={!!errors.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="e.g. SAP CPI consultant" />
        </Field>
        <Field label="Project" hint="Leave empty for a general hire." className="sm:col-span-2">
          <Combobox value={f.project_id} onChange={(v) => setF({ ...f, project_id: v })} options={projOpts} placeholder="General (no project)" searchPlaceholder="Search projects" clearable />
        </Field>
        <Field label="Seats" required error={errors.count}>
          <Input type="number" min={1} max={50} value={f.count} invalid={!!errors.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} />
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Opening['status'] })} options={ORDER.map((s) => ({ value: s, label: STATUS[s].label }))} />
        </Field>
        <Field label="Owner" required error={errors.owner_id}>
          <PeoplePicker value={f.owner_id || null} onChange={(v) => setF({ ...f, owner_id: v ?? '' })} invalid={!!errors.owner_id} filter={(p) => (owners ? owners.has(p.id) : ['admin', 'pm', 'ops'].includes(p.role))} />
        </Field>
        <Field label="Needed by" error={errors.needed_by}>
          <Input type="date" value={f.needed_by ?? ''} onChange={(e) => setF({ ...f, needed_by: e.target.value || null })} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Stage, candidates, budget…" />
        </Field>
      </div>
      {o && <Badge tone="neutral" size="sm" className="mt-3">Created {fmtDate(o.created_at.slice(0, 10))}</Badge>}
    </Dialog>
  )
}
