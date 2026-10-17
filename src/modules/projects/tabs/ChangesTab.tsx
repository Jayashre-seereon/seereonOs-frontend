// G5.04 — change requests: KPIs, CR-n rows, raise / estimate, approve (adds value to the contract) / reject,
// and "Add its tasks to the WBS" once approved. Nothing enters the plan without an approved change request.
import { useEffect, useState } from 'react'
import { Check, ClipboardList, ListTree, Pencil, Plus, Trash2, X } from '@/ui/icons'
import type { ChangeRequest } from '@/types/entities'
import { crApi, type ChangeRequestInput, type CrProposedTask, type ProjectDetail } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import { usePeopleMap } from '@/api/core'
import { CR_STATUS } from '@/domain/labels'
import { fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorState, Field, IconButton, Input, MoneyInput, PeoplePicker, Select, Skeleton, StatusBadge, Textarea, useConfirm, useReadOnly } from '@/ui'

const INV = (pid: string) => [['project', pid], ['projects'], ['delivery'], ['tasks']]

export function ChangesTab({ d }: { d: ProjectDetail }) {
  const readOnly = useReadOnly()
  const q = useApi(['project', d.project.id, 'crs'], () => crApi.list(d.project.id))
  const [edit, setEdit] = useState<{ open: boolean; cr: ChangeRequest | null }>({ open: false, cr: null })
  const [decide, setDecide] = useState<ChangeRequest | null>(null)
  const [addTasks, setAddTasks] = useState<ChangeRequest | null>(null)
  const { askReason } = useConfirm()
  const reject = useMut((v: { cr: ChangeRequest; reason: string }) => crApi.reject(v.cr.id, v.reason), { invalidate: INV(d.project.id), success: (_r, v) => `CR-${v.cr.number} rejected` })
  const done = useMut((cr: ChangeRequest) => crApi.update(cr.id, { status: 'done' }, cr.version), { invalidate: INV(d.project.id), success: (_r, cr) => `CR-${cr.number} marked done` })
  if (q.isLoading)
    return (
      <Card>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="mt-4 h-24 w-full" />
      </Card>
    )
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  const c = q.data
  const editable = c.can_manage && !readOnly
  return (
    <Card>
      <CardHeader
        title="Change requests"
        subtitle="Anything the client adds after signing. Approving adds its value to the contract; its tasks enter the WBS only after approval."
        action={editable ? <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ open: true, cr: null })}>Raise a change request</Button> : undefined}
      />
      <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
        <Kpi label="Raised" value={String(c.raised)} />
        <Kpi label="Awaiting decision" value={String(c.awaiting)} tone={c.awaiting ? 'warning' : undefined} />
        <Kpi label="Approved extra effort" value={`${fmtNum(c.approved_hours, 0)}h`} sub={c.approved_value ? `${fmtMoney(c.approved_value)} added` : undefined} />
        <Kpi label="Scope growth vs baseline" value={c.scope_growth === null ? '—' : fmtPct(c.scope_growth, 0)} sub={`of ${fmtNum(c.baseline_hours, 0)}h baseline`} tone={c.scope_growth !== null && c.scope_growth > 0.05 ? 'warning' : undefined} />
      </div>
      {!c.items.length ? (
        <EmptyState compact icon={<ClipboardList />} title="No change requests" body="When the client asks for more, raise it here so hours, schedule impact and value are agreed before work starts." action={editable ? <Button size="sm" variant="primary" onClick={() => setEdit({ open: true, cr: null })}>Raise a change request</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {c.items.map((cr) => {
            const open = cr.status === 'raised' || cr.status === 'estimated'
            const approved = cr.status === 'approved' || cr.status === 'done'
            return (
              <li key={cr.id} className="py-3.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="tnum text-[14px] font-semibold text-brand-text">CR-{cr.number ?? '?'}</span>
                  <span className="min-w-0 text-[14px] font-semibold text-ink">{cr.title}</span>
                  <StatusBadge map={{ ...CR_STATUS, raised: { label: 'Awaiting estimate', tone: 'neutral' }, estimated: { label: 'Awaiting decision', tone: 'neutral' } }} value={cr.status} size="sm" />
                </div>
                <p className="tnum mt-1 text-[12.5px] leading-snug text-ink-3">
                  Requested by {cr.requested_by_client || 'the client'}
                  {cr.requested_on ? ` on ${fmtDate(cr.requested_on)}` : ''}. {cr.hours ? `${fmtNum(cr.hours, 1)}h effort` : 'Not estimated yet'}, {cr.impact_days ?? 0} working day{cr.impact_days === 1 ? '' : 's'} impact, billable {fmtMoney(cr.value_paise)}.
                </p>
                {(cr.note || cr.description) && <p className="mt-0.5 max-w-[90ch] text-[12.5px] leading-snug text-ink-2">{cr.note || cr.description}</p>}
                {(cr.proposed_tasks ?? []).length > 0 && (
                  <p className="mt-0.5 text-[12.5px] text-ink-3">
                    Proposed tasks: {(cr.proposed_tasks ?? []).map((t) => `${t.title} (${fmtNum(t.est_hours, 1)}h)`).join(', ')}
                  </p>
                )}
                {cr.tasks_added_on && <p className="mt-0.5 text-[12.5px] text-success-text">Tasks added to the WBS on {fmtDate(cr.tasks_added_on.slice(0, 10))}.</p>}
                {editable && (open || (approved && !cr.tasks_added_on) || cr.status === 'approved') && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {open && (
                      <>
                        <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => setDecide(cr)}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          icon={<X className="size-3.5" />}
                          onClick={async () => {
                            const r = await askReason({ title: `Reject CR-${cr.number} “${cr.title}”?`, label: 'Reason', placeholder: 'e.g. Client withdrew the request after the cost estimate', confirmLabel: 'Reject', tone: 'danger' })
                            if (r) reject.mutate({ cr, reason: r })
                          }}
                        >
                          Reject
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit({ open: true, cr })}>
                          {cr.status === 'raised' ? 'Estimate' : 'Edit'}
                        </Button>
                      </>
                    )}
                    {approved && !cr.tasks_added_on && (
                      <Button size="sm" icon={<ListTree className="size-3.5" />} onClick={() => setAddTasks(cr)}>
                        Add its tasks to the WBS
                      </Button>
                    )}
                    {cr.status === 'approved' && (
                      <Button size="sm" variant="ghost" loading={done.isPending} onClick={() => done.mutate(cr)}>
                        Mark delivered
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <CrDialog d={d} next={c.next_number} open={edit.open} cr={edit.cr} onOpenChange={(o) => setEdit((x) => ({ ...x, open: o }))} />
      <DecideDialog d={d} cr={decide} onClose={() => setDecide(null)} />
      <AddTasksDialog d={d} cr={addTasks} onClose={() => setAddTasks(null)} />
    </Card>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warning' }) {
  return (
    <div className="min-w-0">
      <div className={cn('tnum whitespace-nowrap text-[22px] font-semibold leading-tight', tone === 'warning' ? 'text-warning-text' : 'text-ink')}>{value}</div>
      <div className="text-[12.5px] leading-snug text-ink-3">{label}</div>
      {sub && <div className="tnum text-[12px] text-ink-3">{sub}</div>}
    </div>
  )
}

/* ---------------- proposed tasks editor ---------------- */
function TaskRows({ rows, onChange, errors }: { rows: CrProposedTask[]; onChange: (r: CrProposedTask[]) => void; errors?: Record<string, string> }) {
  const set = (i: number, p: Partial<CrProposedTask>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_88px_36px] gap-2 sm:grid-cols-[minmax(0,1fr)_88px_180px_36px]">
          <Input aria-label={`Task ${i + 1} title`} value={r.title} placeholder="Task title" invalid={!!errors?.[`proposed_tasks.${i}.title`]} onChange={(e) => set(i, { title: e.target.value })} />
          <Input aria-label={`Task ${i + 1} hours`} inputMode="decimal" suffix="h" value={r.est_hours ? String(r.est_hours) : ''} invalid={!!errors?.[`proposed_tasks.${i}.est_hours`]} onChange={(e) => set(i, { est_hours: Number(e.target.value.replace(/[^0-9.]/g, '') || 0) })} />
          <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
            <PeoplePicker value={r.owner_id} onChange={(v) => set(i, { owner_id: v })} placeholder="Owner" clearable />
          </div>
          <IconButton label={`Remove task ${i + 1}`} size="sm" onClick={() => onChange(rows.filter((_, k) => k !== i))} className="self-center">
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { title: '', est_hours: 0, owner_id: null }])}>
        Add a task
      </Button>
    </div>
  )
}

/* ---------------- raise / estimate ---------------- */
function CrDialog({ d, next, open, cr, onOpenChange }: { d: ProjectDetail; next: number; open: boolean; cr: ChangeRequest | null; onOpenChange: (o: boolean) => void }) {
  const blank = (): ChangeRequestInput => ({ title: '', description: '', requested_by_client: '', requested_on: todayISO(), hours: 0, impact_days: 0, value_paise: 0, note: '', proposed_tasks: [] })
  const [f, setF] = useState<ChangeRequestInput>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    setF(
      cr
        ? { title: cr.title, description: cr.description, requested_by_client: cr.requested_by_client ?? '', requested_on: cr.requested_on ?? todayISO(), hours: cr.hours, impact_days: cr.impact_days ?? 0, value_paise: cr.value_paise, note: cr.note ?? '', proposed_tasks: cr.proposed_tasks ?? [] }
        : blank(),
    )
  }, [open, cr])
  const onError = (e: ApiError) => setErrors((x) => ({ ...x, [e.field ?? 'title']: e.message }))
  const body = (): ChangeRequestInput => ({ ...f, title: f.title.trim(), requested_by_client: f.requested_by_client.trim(), proposed_tasks: f.proposed_tasks.filter((t) => t.title.trim()) })
  const add = useMut(() => crApi.raise(d.project.id, body()), { invalidate: INV(d.project.id), success: (r) => `CR-${r.number} raised`, onSuccess: () => onOpenChange(false), onError })
  const save = useMut(() => crApi.update(cr!.id, body(), cr!.version), { invalidate: INV(d.project.id), success: (r) => `CR-${r.number} saved`, onSuccess: () => onOpenChange(false), onError })
  const taskHours = f.proposed_tasks.reduce((s, t) => s + (t.est_hours || 0), 0)
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.title.trim()) e.title = 'Say what the client wants added.'
    if (!f.requested_by_client.trim()) e.requested_by_client = 'Who at the client asked for it?'
    if (!f.requested_on) e.requested_on = 'Pick the date it was requested.'
    if (f.hours < 0) e.hours = 'Hours must be zero or more.'
    if (!Number.isInteger(f.impact_days) || f.impact_days < 0) e.impact_days = 'Whole working days, 0 or more.'
    f.proposed_tasks.forEach((t, i) => {
      if (t.title.trim() && (!t.est_hours || t.est_hours <= 0)) e[`proposed_tasks.${i}.est_hours`] = 'Hours'
    })
    if (Object.keys(e).some((k) => k.startsWith('proposed_tasks'))) e.proposed_tasks = 'Give every proposed task its hours.'
    setErrors(e)
    if (Object.keys(e).length) return
    if (cr) save.mutate(undefined)
    else add.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={cr ? `${cr.status === 'raised' ? 'Estimate' : 'Edit'} CR-${cr.number}` : `Raise a change request (CR-${next})`}
      description="With effort hours filled in, it is ready for a decision. Its tasks enter the WBS only once it is approved."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={add.isPending || save.isPending} onClick={submit}>
            {cr ? 'Save' : 'Raise change request'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What’s changing" required error={errors.title} className="sm:col-span-2">
          <Input autoFocus value={f.title} invalid={!!errors.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Transport module: bus routes and fees" />
        </Field>
        <Field label="Requested by (client)" required error={errors.requested_by_client}>
          <Input value={f.requested_by_client} invalid={!!errors.requested_by_client} onChange={(e) => setF({ ...f, requested_by_client: e.target.value })} placeholder="e.g. School CFO" />
        </Field>
        <Field label="Requested on" required error={errors.requested_on}>
          <Input type="date" value={f.requested_on} max={todayISO()} invalid={!!errors.requested_on} onChange={(e) => setF({ ...f, requested_on: e.target.value })} />
        </Field>
        <Field label="Effort" error={errors.hours} hint={taskHours && !f.hours ? `Proposed tasks add up to ${fmtNum(taskHours, 1)}h.` : 'Hours of extra work.'}>
          <Input inputMode="decimal" suffix="h" value={f.hours ? String(f.hours) : ''} invalid={!!errors.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value.replace(/[^0-9.]/g, '') || 0) })} />
        </Field>
        <Field label="Schedule impact" error={errors.impact_days} hint="Working days it adds to the plan.">
          <Input inputMode="numeric" suffix="days" value={f.impact_days ? String(f.impact_days) : ''} invalid={!!errors.impact_days} onChange={(e) => setF({ ...f, impact_days: Number(e.target.value.replace(/[^0-9]/g, '') || 0) })} />
        </Field>
        <Field label="Billable value" error={errors.value_paise} hint="Added to the contract when approved.">
          <MoneyInput value={f.value_paise} onChange={(v) => setF({ ...f, value_paise: v })} invalid={!!errors.value_paise} />
        </Field>
        <Field label="Note / reason">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Requested after UAT round 1 demo" />
        </Field>
        <Field label="Details" className="sm:col-span-2">
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What exactly the client asked for" />
        </Field>
        <Field label="Proposed tasks" error={errors.proposed_tasks} hint="Optional now; you can add them when it is approved." className="sm:col-span-2">
          <TaskRows rows={f.proposed_tasks} onChange={(r) => setF({ ...f, proposed_tasks: r })} errors={errors} />
        </Field>
      </div>
    </Dialog>
  )
}

/* ---------------- approve ---------------- */
function DecideDialog({ d, cr, onClose }: { d: ProjectDetail; cr: ChangeRequest | null; onClose: () => void }) {
  const [addValue, setAddValue] = useState(true)
  const [createMs, setCreateMs] = useState(false)
  const [msName, setMsName] = useState('')
  const [msEnd, setMsEnd] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!cr) return
    setAddValue(cr.value_paise > 0)
    setCreateMs(false)
    setMsName(`CR-${cr.number} ${cr.title}`)
    setMsEnd(d.project.end_on < todayISO() ? todayISO() : d.project.end_on)
    setErrors({})
  }, [cr, d.project.end_on])
  const mut = useMut(() => crApi.approve(cr!.id, { add_to_contract: addValue, milestone: createMs ? { name: msName.trim(), planned_end: msEnd } : null }), {
    invalidate: INV(d.project.id),
    success: () => `CR-${cr!.number} approved`,
    onSuccess: onClose,
    onError: (e: ApiError) => setErrors((x) => ({ ...x, [e.field ?? 'form']: e.message })),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (createMs && !msName.trim()) e['milestone.name'] = 'Name the milestone.'
    if (createMs && !msEnd) e['milestone.planned_end'] = 'Pick an end date.'
    setErrors(e)
    if (!Object.keys(e).length) mut.mutate(undefined)
  }
  return (
    <Dialog
      open={!!cr}
      onOpenChange={(o) => !o && onClose()}
      title={cr ? `Approve CR-${cr.number} “${cr.title}”` : 'Approve'}
      description={cr ? `${fmtNum(cr.hours, 1)}h effort · ${cr.impact_days ?? 0} working days impact · ${fmtMoney(cr.value_paise)}` : undefined}
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
        <Checkbox checked={addValue} onChange={setAddValue} disabled={!cr?.value_paise} label={`Add ${fmtMoney(cr?.value_paise ?? 0)} to the contract value`} description={`Contract goes from ${fmtMoney(d.project.contract_value_paise)} to ${fmtMoney(d.project.contract_value_paise + (addValue ? cr?.value_paise ?? 0 : 0))}.`} />
        <Checkbox checked={createMs} onChange={setCreateMs} label="Create a billing milestone for this work" description="Billed at the change request value. Its tasks set the deadline once added." />
        {createMs && (
          <div className="grid gap-3 sm:grid-cols-2 sm:pl-7">
            <Field label="Milestone name" required error={errors['milestone.name']}>
              <Input value={msName} onChange={(e) => setMsName(e.target.value)} invalid={!!errors['milestone.name']} />
            </Field>
            <Field label="Provisional end" required error={errors['milestone.planned_end']} hint={msEnd > d.project.end_on ? 'The project end moves to this date.' : undefined}>
              <Input type="date" value={msEnd} onChange={(e) => setMsEnd(e.target.value)} invalid={!!errors['milestone.planned_end']} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/* ---------------- add its tasks to the WBS ---------------- */
function AddTasksDialog({ d, cr, onClose }: { d: ProjectDetail; cr: ChangeRequest | null; onClose: () => void }) {
  const people = usePeopleMap()
  const [rows, setRows] = useState<CrProposedTask[]>([])
  const [ms, setMs] = useState<string>('new')
  const [start, setStart] = useState(todayISO())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!cr) return
    setStart(todayISO())
    setRows(cr.proposed_tasks?.length ? cr.proposed_tasks : [{ title: cr.title, est_hours: cr.hours || 8, owner_id: null }])
    setMs(cr.milestone_id && d.milestones.some((m) => m.id === cr.milestone_id) ? cr.milestone_id : 'new')
    setError(null)
  }, [cr, d.milestones])
  const mut = useMut(() => {
    // start_on: the CR's work starts today or on the start the client asked for (server checks it is not in the past)
    const b = { milestone_id: ms, tasks: rows.filter((r) => r.title.trim()), start_on: start }
    return crApi.addTasks(cr!.id, b)
  }, {
    invalidate: INV(d.project.id),
    success: (r) => `${r.tasks} task${r.tasks === 1 ? '' : 's'} added to the WBS`,
    onSuccess: onClose,
    onError: (e: ApiError) => setError(e.message),
  })
  const total = rows.reduce((s, r) => s + (r.est_hours || 0), 0)
  return (
    <Dialog
      open={!!cr}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={cr ? `Add CR-${cr.number}’s tasks to the WBS` : 'Add tasks'}
      description="They are scheduled back to back from the start date (today unless the client asked for a later start); the milestone’s deadline follows its last task. Adjust dates and dependencies in the WBS afterwards. This can be done once per change request."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} disabled={!rows.some((r) => r.title.trim())} onClick={() => mut.mutate(undefined)}>
            Add {rows.filter((r) => r.title.trim()).length} task{rows.filter((r) => r.title.trim()).length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Milestone">
          <Select
            value={ms}
            onChange={(e) => setMs(e.target.value)}
            options={[{ value: 'new', label: cr ? `New milestone: CR-${cr.number} ${cr.title}` : 'New milestone' }, ...d.milestones.map((m) => ({ value: m.id, label: `M${m.no} ${m.name}` }))]}
          />
        </Field>
        <Field label="Start" hint="Today, or the later start the client asked for.">
          <Input type="date" value={start} min={todayISO()} onChange={(e) => setStart(e.target.value)} className="sm:w-[200px]" />
        </Field>
        <Field label="Tasks" error={error} hint={`${fmtNum(total, 1)}h in total${cr?.hours ? ` · ${fmtNum(cr.hours, 1)}h approved` : ''}${rows.some((r) => r.owner_id) ? ` · owners: ${[...new Set(rows.map((r) => people.get(r.owner_id)?.name).filter(Boolean))].join(', ')}` : ''}`}>
          <TaskRows rows={rows} onChange={setRows} />
        </Field>
      </div>
    </Dialog>
  )
}
