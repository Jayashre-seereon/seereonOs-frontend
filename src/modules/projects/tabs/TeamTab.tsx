import { useEffect, useState } from 'react'
import { AlertTriangle, MoreHorizontal, Pencil, Plus, Trash2, Users } from '@/ui/icons'
import { projectsApi, type AllocationInput, type AllocationView, type PersonLoad, type ProjectDetail } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { ApiError } from '@/api/http'
import { fmtDate, parseISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import {
  Avatar, Badge, Button, Callout, Card, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Menu, PeoplePicker, PersonName, Select, SkeletonRows, Tooltip, useConfirm, useReadOnly, type Column,
} from '@/ui'

export function TeamTab({ d }: { d: ProjectDetail }) {
  const readOnly = useReadOnly()
  const editable = d.can_edit && !readOnly
  const [dlg, setDlg] = useState<{ open: boolean; a: AllocationView | null }>({ open: false, a: null })
  const { confirm } = useConfirm()
  const load = useApi(['project', d.project.id, 'load'], () => projectsApi.load(d.project.id))
  const del = useMut((a: AllocationView) => projectsApi.deleteAllocation(a.id), { invalidate: [['project', d.project.id]], success: 'Allocation removed' })

  const columns: Column<AllocationView>[] = [
    { key: 'person', header: 'Person', sortValue: (r) => r.user_id, cell: (r) => <PersonName id={r.user_id} size={24} /> },
    { key: 'ms', header: 'Milestone', sortValue: (r) => r.ms_code, cell: (r) => <span className="text-[13px]"><span className="tnum text-ink-3">{r.ms_code}</span> {r.ms_name}</span> },
    { key: 'pct', header: 'Allocation', align: 'right', sortValue: (r) => r.pct, cell: (r) => <span className="tnum font-medium">{r.pct}%</span> },
    { key: 'from', header: 'From', sortValue: (r) => r.from_on, cell: (r) => <span className="tnum">{fmtDate(r.from_on)}</span> },
    { key: 'to', header: 'To', sortValue: (r) => r.to_on, cell: (r) => <span className="tnum">{fmtDate(r.to_on)}</span> },
    {
      key: 'menu', header: '', width: '44px',
      cell: (r) =>
        editable ? (
          <div onClick={(e) => e.stopPropagation()}>
            <Menu
              label="Allocation actions"
              trigger={<IconButton size="sm" label="Allocation actions"><MoreHorizontal className="size-4" /></IconButton>}
              items={[
                { label: 'Edit allocation', icon: <Pencil />, onSelect: () => setDlg({ open: true, a: r }) },
                { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: async () => (await confirm({ title: 'Remove this allocation?', body: 'Planned cost and resource load update straight away.', confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(r) },
              ]}
            />
          </div>
        ) : null,
    },
  ]
  const overPeople = (load.data?.people ?? []).filter((p) => p.over_days.length)

  return (
    <div className="space-y-4">
      {overPeople.length > 0 && (
        <Callout tone={load.data?.block_over ? 'danger' : 'warning'} icon={<AlertTriangle />} title={`${overPeople.length} ${overPeople.length === 1 ? 'person is' : 'people are'} over ${load.data?.max_pct}% on some days`}>
          {overPeople.map((p) => (
            <OverLine key={p.user_id} p={p} />
          ))}
        </Callout>
      )}
      <Card>
        <CardHeader
          title="Allocations"
          subtitle="Resource allocation by milestone: who works on which milestone (M1, M2…), what % of their time, from and to. All four are required, so cost always lands on a milestone and a period. Hours and cost are on the Costing & margin tab."
          action={editable ? <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setDlg({ open: true, a: null })}>Allocate</Button> : undefined}
        />
          <DataTable
            rows={d.allocations}
            rowKey={(r) => r.id}
            columns={columns}
            dense
            onRowClick={editable ? (r) => setDlg({ open: true, a: r }) : undefined}
            empty={<EmptyState compact icon={<Users />} title="No one allocated yet" body="Allocate people to milestones so planned cost and resource load are accurate." action={editable ? <Button size="sm" variant="primary" onClick={() => setDlg({ open: true, a: null })}>Allocate someone</Button> : undefined} />}
            mobileCard={(r) => (
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <PersonName id={r.user_id} size={28} className="min-w-0 flex-1" />
                  <span className="tnum shrink-0 text-[14px] font-semibold">{r.pct}%</span>
                </div>
                <div className="mt-1.5 flex min-w-0 items-baseline justify-between gap-3 pl-[40px] text-[12.5px] text-ink-3">
                  <span className="min-w-0 truncate">
                    <span className="tnum">{r.ms_code}</span> {r.ms_name}
                  </span>
                  <span className="tnum shrink-0 whitespace-nowrap">
                    {fmtDate(r.from_on)} – {fmtDate(r.to_on)}
                  </span>
                </div>
              </div>
            )}
          />
      </Card>
      <Card>
        <CardHeader title="Resource load, next 10 working days" subtitle="Total allocation across all projects. This project’s share is the darker part." />
        {load.isLoading ? <SkeletonRows rows={4} /> : load.error ? <ErrorState error={load.error} onRetry={() => load.refetch()} /> : !load.data?.people.length ? <EmptyState compact title="No team on this project yet" /> : <LoadStrip people={load.data.people} max={load.data.max_pct} />}
      </Card>
      <AllocationDialog d={d} open={dlg.open} a={dlg.a} onOpenChange={(o) => setDlg((x) => ({ ...x, open: o }))} />
    </div>
  )
}

function OverLine({ p }: { p: PersonLoad }) {
  const { get } = usePeopleMap()
  const first = p.over_days[0]
  const last = p.over_days[p.over_days.length - 1]
  const peak = Math.max(...p.over_days.map((x) => x.pct))
  return (
    <div className="mt-0.5">
      <span className="font-medium text-ink">{get(p.user_id)?.name ?? '—'}</span>: {p.over_days.length} working day{p.over_days.length === 1 ? '' : 's'} ({fmtDate(first.date)}
      {p.over_days.length > 1 ? ` – ${fmtDate(last.date)}` : ''}), peak {peak}%
    </div>
  )
}

function cellTone(pct: number, max: number) {
  if (pct === 0) return 'bg-surface-2'
  if (pct > max) return 'bg-danger'
  if (pct > max * 0.85) return 'bg-warning'
  if (pct >= max * 0.5) return 'bg-success'
  return 'bg-success/45'
}

function LoadStrip({ people, max }: { people: PersonLoad[]; max: number }) {
  const { get } = usePeopleMap()
  const days = people[0].days
  return (
    <div className="-mx-4 overflow-x-auto px-4 scroll-thin md:mx-0 md:px-0">
      <table className="w-full min-w-[520px] border-separate border-spacing-y-1.5 text-[12.5px]">
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
            <th className="sticky left-0 z-[1] w-[150px] bg-surface pr-2 text-left font-semibold">Person</th>
            {days.map((d) => (
              <th key={d.date} className="px-0.5 text-center font-semibold">
                <span className="block">{parseISO(d.date).toLocaleDateString('en-IN', { weekday: 'narrow' })}</span>
                <span className="tnum block font-medium normal-case">{parseISO(d.date).getDate()}</span>
              </th>
            ))}
            <th className="pl-2 text-right font-semibold">Avg</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const u = get(p.user_id)
            return (
              <tr key={p.user_id}>
                <td className="sticky left-0 z-[1] bg-surface pr-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {u && <Avatar name={u.name} hue={u.avatar_hue} size={22} />}
                    <span className="truncate font-medium">{u?.name.split(' ')[0] ?? '—'}</span>
                  </span>
                </td>
                {p.days.map((d) => (
                  <td key={d.date} className="px-0.5">
                    <Tooltip content={`${fmtDate(d.date, 'long')}: ${d.total_pct}% total${d.project_pct ? `, ${d.project_pct}% here` : ''}`}>
                      <div className={cn('relative h-7 min-w-[28px] overflow-hidden rounded-[3px]', cellTone(d.total_pct, max))}>
                        {d.project_pct > 0 && d.total_pct > 0 && <div className="absolute inset-x-0 bottom-0 bg-black/15" style={{ height: `${Math.min(100, (d.project_pct / Math.max(d.total_pct, 1)) * 100)}%` }} />}
                        <span className={cn('tnum absolute inset-0 grid place-items-center text-[10.5px] font-medium', d.total_pct > max * 0.85 || d.total_pct >= max * 0.5 ? 'text-white' : 'text-ink-2')}>{d.total_pct || ''}</span>
                      </div>
                    </Tooltip>
                  </td>
                ))}
                <td className="pl-2 text-right">
                  <Badge size="sm" tone={p.avg_pct > max ? 'danger' : p.avg_pct > max * 0.85 ? 'warning' : p.avg_pct < 50 ? 'neutral' : 'success'}>
                    {Math.round(p.avg_pct)}%
                  </Badge>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm bg-success" />50–85%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm bg-warning" />85–{max}%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm bg-danger" />Over {max}%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm bg-surface-2 ring-1 ring-line" />Free</span>
      </div>
    </div>
  )
}

export function AllocationDialog({ d, open, a, onOpenChange }: { d: ProjectDetail; open: boolean; a: AllocationView | null; onOpenChange: (o: boolean) => void }) {
  const blank = (): AllocationInput => ({ user_id: null, milestone_id: null, pct: 50, from_on: null, to_on: null })
  const [f, setF] = useState<AllocationInput>(blank)
  // '' = not chosen yet. Feature Guide §6: the milestone is required (no "all milestones" rows)
  const [msSel, setMsSel] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    setF(a ? { user_id: a.user_id, milestone_id: a.milestone_id, pct: a.pct, from_on: a.from_on, to_on: a.to_on } : blank())
    setMsSel(a ? a.milestone_id ?? '' : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, a?.id])
  const onError = (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message }))
  const inv = [['project', d.project.id], ['projects'], ['margins']]
  const add = useMut((b: AllocationInput) => projectsApi.addAllocation(d.project.id, b), { invalidate: inv, success: 'Allocation added', onSuccess: () => onOpenChange(false), onError })
  const save = useMut((b: AllocationInput) => projectsApi.updateAllocation(a!.id, b, a!.version), { invalidate: inv, success: 'Allocation saved', onSuccess: () => onOpenChange(false), onError })
  const pickMs = (id: string) => {
    setMsSel(id)
    const m = d.milestones.find((x) => x.id === id)
    const clamp = (v: string) => (v < d.project.start_on ? d.project.start_on : v > d.project.end_on ? d.project.end_on : v)
    const from = m ? clamp(m.planned_start) : null
    const to = m ? clamp(m.planned_end) : null
    // a milestone change moves the dates to that milestone's dates (they can be narrowed after)
    setF((x) => ({ ...x, milestone_id: id || null, from_on: from ?? x.from_on, to_on: to ?? x.to_on }))
    setErrors((e) => ({ ...e, milestone_id: '', from_on: m ? '' : e.from_on, to_on: m ? '' : e.to_on }))
  }
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.user_id) e.user_id = 'Choose the person.'
    if (!msSel) e.milestone_id = d.milestones.length ? 'Choose the milestone (M1, M2…).' : 'Add milestones in the WBS tab first: every allocation lands on a milestone.'
    if (!f.pct || f.pct < 1 || f.pct > 100) e.pct = 'Between 1% and 100%.'
    if (!f.from_on) e.from_on = 'Required.'
    if (!f.to_on) e.to_on = 'Required.'
    if (f.from_on && f.to_on && f.to_on < f.from_on) e.to_on = 'Ends before it starts.'
    setErrors(e)
    if (Object.keys(e).length) return
    if (a) save.mutate(f)
    else add.mutate(f)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={a ? 'Edit allocation' : 'Allocate a person'}
      description={`Dates must sit inside the project (${fmtDate(d.project.start_on)} – ${fmtDate(d.project.end_on)}). You’ll be warned if anyone goes over capacity across projects.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={add.isPending || save.isPending} onClick={submit}>
            {a ? 'Save allocation' : 'Allocate'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Person" required error={errors.user_id} className="sm:col-span-2">
          <PeoplePicker value={f.user_id} invalid={!!errors.user_id} onChange={(v) => { setF({ ...f, user_id: v }); setErrors((x) => ({ ...x, user_id: '' })) }} />
        </Field>
        <Field label="Milestone" required error={errors.milestone_id}>
          <Select value={msSel} invalid={!!errors.milestone_id} onChange={(e) => pickMs(e.target.value)} placeholder="Choose…" options={d.milestones.map((m) => ({ value: m.id, label: `M${m.no} ${m.name}` }))} />
        </Field>
        <Field label="% of time" required error={errors.pct}>
          <Input type="number" inputMode="numeric" min={1} max={100} step={5} suffix="%" value={f.pct ?? ''} invalid={!!errors.pct} onChange={(e) => setF({ ...f, pct: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Field label="From" required error={errors.from_on}>
          <Input type="date" value={f.from_on ?? ''} min={d.project.start_on} max={d.project.end_on} invalid={!!errors.from_on} onChange={(e) => setF({ ...f, from_on: e.target.value || null })} />
        </Field>
        <Field label="To" required error={errors.to_on}>
          <Input type="date" value={f.to_on ?? ''} min={f.from_on ?? d.project.start_on} max={d.project.end_on} invalid={!!errors.to_on} onChange={(e) => setF({ ...f, to_on: e.target.value || null })} />
        </Field>
      </div>
    </Dialog>
  )
}
