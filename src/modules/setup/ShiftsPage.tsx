import { useMemo, useState } from 'react'
import type { Shift } from '@/types/access'
import { announce } from '@/api/changes'
import { useMut } from '@/api/query'
import { masterApi, useMasterList, useMasterPeople, WEEKDAYS } from '@/api/master'
import { Avatar, AvatarStack, Badge, Button, Callout, Card, Checkbox, EmptyState, ErrorState, Field, Input, PageHeader, SearchInput, Sheet, SkeletonCards, Switch } from '@/ui'
import { CheckCircle2, Clock, Plus, UserPlus } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { InactiveBadge, RecordDialog, RowMenu, errOf, rowMenu, useMasterActions, useMasterEdit, useSaveRecord } from './master/kit'

const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
function lengthOf(s: Pick<Shift, 'start_time' | 'end_time'>) {
  return (mins(s.end_time) - mins(s.start_time) + 1440) % 1440
}
const hrs = (m: number) => {
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

export default function ShiftsPage() {
  const q = useMasterList('shifts')
  const people = useMasterPeople()
  const canEdit = useMasterEdit('shifts')
  const actions = useMasterActions('shifts')
  const [edit, setEdit] = useState<Shift | 'new' | null>(null)
  const [assign, setAssign] = useState<Shift | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const all = q.data ?? []
  const inactive = all.filter((s) => !s.active).length
  const shifts = all.filter((s) => showInactive || s.active).sort((a, b) => Number(b.is_default) - Number(a.is_default) || Number(b.active) - Number(a.active) || a.start_time.localeCompare(b.start_time))
  const membersOf = useMemo(() => {
    const m = new Map<string, NonNullable<typeof people.data>>()
    for (const p of people.data ?? []) if (p.shift_id) m.set(p.shift_id, [...(m.get(p.shift_id) ?? []), p])
    return m
  }, [people.data])
  const makeDefault = useSaveDefault()

  return (
    <div>
      <PageHeader
        title="Shifts"
        subtitle="Working hours, breaks and grace periods. New joiners get the default shift until you move them."
        actions={
          canEdit && (
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>
              Add shift
            </Button>
          )
        }
      />
      {all.length > 0 && inactive > 0 && (
        <label className="mb-3 flex items-center justify-end gap-2.5 text-[13.5px] text-ink-2">
          <Switch checked={showInactive} onChange={setShowInactive} />
          <span>
            Show inactive<span className="tnum text-ink-3"> ({inactive})</span>
          </span>
        </label>
      )}
      {q.isLoading ? (
        <SkeletonCards n={2} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !shifts.length ? (
        <Card pad={false}>
          <EmptyState icon={<Clock />} title="No shifts yet" body="Add the hours people work. The first shift becomes the default for everyone." action={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>Add shift</Button>} />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shifts.map((s) => {
            const members = membersOf.get(s.id) ?? []
            const len = lengthOf(s)
            return (
              <Card key={s.id} className={cn('flex min-w-0 flex-col', !s.active && 'bg-surface-2/50')}>
                <div className="flex items-start gap-2">
                  <div className={cn('min-w-0 flex-1', !s.active && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h2 className="truncate text-[15px] font-semibold text-ink">{s.name}</h2>
                      <span className="font-mono text-[12px] text-ink-3">{s.code}</span>
                      {s.is_default && <Badge size="sm" tone="brand">Default</Badge>}
                      {s.night_shift && <Badge size="sm" tone="info">Night shift</Badge>}
                      {!s.active && <InactiveBadge />}
                    </div>
                    <div className="tnum mt-1 text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink">
                      {s.start_time} – {s.end_time}
                      {s.night_shift && <span className="ml-1.5 text-[12.5px] font-medium text-ink-3">next day</span>}
                    </div>
                  </div>
                  {canEdit && (
                    <RowMenu
                      label={`Actions for ${s.name}`}
                      items={rowMenu(s, actions, () => setEdit(s), s.is_default || !s.active ? [] : [{ label: 'Make default', icon: <CheckCircle2 />, onSelect: () => makeDefault.mutate(s) }])}
                    />
                  )}
                </div>
                <dl className={cn('mt-3 grid grid-cols-4 gap-2 border-t border-line pt-3 sm:gap-3', !s.active && 'opacity-60')}>
                  {[
                    ['Length', hrs(len)],
                    ['Break', `${s.break_minutes} min`],
                    ['Grace', `${s.grace_minutes} min`],
                    ['Min/day', `${s.min_hours}h`],
                  ].map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[12px] text-ink-3">{k}</dt>
                      <dd className="tnum mt-0.5 whitespace-nowrap text-[13.5px] font-medium text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className={cn('mt-3 flex flex-wrap items-center gap-1', !s.active && 'opacity-60')} aria-label="Working days">
                  {WEEKDAYS.map((w) => {
                    const on = s.working_days.includes(w.d)
                    return (
                      <span key={w.d} className={cn('inline-flex h-6 min-w-[36px] items-center justify-center rounded-sm px-1.5 text-[12px] font-medium', on ? 'bg-brand-soft text-brand-text' : 'bg-surface-2 text-ink-3 line-through decoration-ink-3/40')}>
                        {w.short}
                      </span>
                    )
                  })}
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                  <div className="flex min-w-0 items-center gap-2">
                    {members.length > 0 && <AvatarStack people={members.map((m) => ({ name: m.name, hue: m.avatar_hue }))} max={4} size={24} />}
                    <span className="tnum whitespace-nowrap text-[13px] text-ink-2">{members.length === 1 ? '1 person' : `${members.length} people`}</span>
                  </div>
                  {canEdit && s.active && (
                    <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={() => setAssign(s)}>
                      Assign people
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
      {edit && <ShiftDialog row={edit === 'new' ? null : edit} first={!all.length} onClose={() => setEdit(null)} />}
      {assign && <AssignSheet shift={assign} shifts={all} onClose={() => setAssign(null)} />}
    </div>
  )
}

function useSaveDefault() {
  return useMut((s: Shift) => masterApi.update('shifts', s.id, { is_default: true }, s.version), {
    invalidate: [['master'], ['changes']],
    onSuccess: (r, s) => announce(r, `${s.name} is now the default shift`),
  })
}

function ShiftDialog({ row, first, onClose }: { row: Shift | null; first: boolean; onClose: () => void }) {
  const [f, setF] = useState({
    name: row?.name ?? '', code: row?.code ?? '', start_time: row?.start_time ?? '09:30', end_time: row?.end_time ?? '18:30', break_minutes: String(row?.break_minutes ?? 60), grace_minutes: String(row?.grace_minutes ?? 15),
    min_hours: String(row?.min_hours ?? 8), working_days: row?.working_days ?? [1, 2, 3, 4, 5], is_default: row?.is_default ?? first,
  })
  const m = useSaveRecord('shifts', row, onClose)
  const e = m.error
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const valid = /^\d\d:\d\d$/.test(f.start_time) && /^\d\d:\d\d$/.test(f.end_time)
  const len = valid ? lengthOf(f) : 0
  const night = valid && mins(f.end_time) <= mins(f.start_time) && len > 0
  const toggle = (d: number) => set('working_days', f.working_days.includes(d) ? f.working_days.filter((x) => x !== d) : [...f.working_days, d])
  return (
    <RecordDialog
      title={row ? `Edit ${row.name}` : 'Add shift'}
      onClose={onClose}
      saving={m.isPending}
      saveLabel={row ? 'Save' : 'Add shift'}
      onSave={() =>
        m.mutate({
          name: f.name, code: f.code, start_time: f.start_time, end_time: f.end_time, break_minutes: Number(f.break_minutes), grace_minutes: Number(f.grace_minutes),
          min_hours: Number(f.min_hours), working_days: f.working_days, is_default: f.is_default,
        })
      }
    >
      <div className="grid grid-cols-[1fr_110px] gap-4">
        <Field label="Name" htmlFor="sh-name" required error={errOf(e, 'name')}>
          <Input id="sh-name" value={f.name} onChange={(x) => set('name', x.target.value)} placeholder="e.g. Client shift" invalid={!!errOf(e, 'name')} />
        </Field>
        <Field label="Code" htmlFor="sh-code" required error={errOf(e, 'code')}>
          <Input id="sh-code" value={f.code} onChange={(x) => set('code', x.target.value.toUpperCase())} placeholder="CLT" maxLength={8} invalid={!!errOf(e, 'code')} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Starts" htmlFor="sh-start" required error={errOf(e, 'start_time')}>
          <Input id="sh-start" type="time" value={f.start_time} onChange={(x) => set('start_time', x.target.value)} invalid={!!errOf(e, 'start_time')} />
        </Field>
        <Field label="Ends" htmlFor="sh-end" required error={errOf(e, 'end_time')}>
          <Input id="sh-end" type="time" value={f.end_time} onChange={(x) => set('end_time', x.target.value)} invalid={!!errOf(e, 'end_time')} />
        </Field>
      </div>
      {valid && len > 0 && (
        <p className="-mt-1 text-[12.5px] text-ink-3">
          {hrs(len)} long{Number(f.break_minutes) > 0 ? `, ${hrs(Math.max(0, len - Number(f.break_minutes)))} of work after the break` : ''}
          {night ? ' · ends the next day (night shift)' : ''}
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field label="Break" htmlFor="sh-break" error={errOf(e, 'break_minutes')}>
          <Input id="sh-break" type="number" inputMode="numeric" min={0} max={240} value={f.break_minutes} onChange={(x) => set('break_minutes', x.target.value)} suffix="min" invalid={!!errOf(e, 'break_minutes')} />
        </Field>
        <Field label="Grace" htmlFor="sh-grace" error={errOf(e, 'grace_minutes')}>
          <Input id="sh-grace" type="number" inputMode="numeric" min={0} max={120} value={f.grace_minutes} onChange={(x) => set('grace_minutes', x.target.value)} suffix="min" invalid={!!errOf(e, 'grace_minutes')} />
        </Field>
        <Field label="Min hours" htmlFor="sh-min" error={errOf(e, 'min_hours')}>
          <Input id="sh-min" type="number" inputMode="decimal" step="0.5" min={1} max={16} value={f.min_hours} onChange={(x) => set('min_hours', x.target.value)} suffix="h" invalid={!!errOf(e, 'min_hours')} />
        </Field>
      </div>
      <Field label="Working days" required error={errOf(e, 'working_days')}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Working days">
          {WEEKDAYS.map((w) => {
            const on = f.working_days.includes(w.d)
            return (
              <button
                key={w.d}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(w.d)}
                className={cn('h-9 min-w-[44px] rounded-md border px-2 text-[13px] font-medium transition', on ? 'border-brand bg-brand-soft text-brand-text' : 'border-line-strong bg-surface text-ink-3 hover:text-ink')}
              >
                {w.short}
              </button>
            )
          })}
        </div>
      </Field>
      <Checkbox
        checked={f.is_default}
        disabled={!!row?.is_default}
        onChange={(v) => set('is_default', v)}
        label="Default shift"
        description={row?.is_default ? 'New joiners get this shift. To change it, make another shift the default.' : 'New joiners and anyone without a shift follow the default.'}
      />
      {errOf(e, 'is_default') && <p className="text-[12.5px] font-medium text-danger-text">{errOf(e, 'is_default')}</p>}
    </RecordDialog>
  )
}

function AssignSheet({ shift, shifts, onClose }: { shift: Shift; shifts: Shift[]; onClose: () => void }) {
  const people = useMasterPeople()
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const nameOf = useMemo(() => new Map(shifts.map((s) => [s.id, s.name])), [shifts])
  const list = (people.data ?? []).filter((p) => !search.trim() || `${p.name} ${p.title} ${p.employee_code ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  const m = useMut(() => masterApi.assignShift(shift.id, sel), {
    invalidate: [['master'], ['changes']],
    onSuccess: (r) => {
      announce(r, `${sel.length === 1 ? '1 person' : `${sel.length} people`} moved to ${shift.name}`)
      onClose()
    },
  })
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Assign people to ${shift.name}`}
      subtitle={`${shift.start_time} – ${shift.end_time}. People already on this shift are ticked.`}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!sel.length} loading={m.isPending} onClick={() => m.mutate(undefined)}>
            {sel.length ? `Move ${sel.length === 1 ? '1 person' : `${sel.length} people`}` : 'Pick people'}
          </Button>
        </>
      }
    >
      <SearchInput value={search} onChange={setSearch} placeholder="Search people" className="mb-3" />
      {people.isLoading ? (
        <SkeletonCards n={2} />
      ) : people.error ? (
        <ErrorState error={people.error} onRetry={() => people.refetch()} />
      ) : !list.length ? (
        <EmptyState compact title="No one matches" body="Try another name or employee code." />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {list.map((p) => {
            const here = p.shift_id === shift.id
            const on = here || sel.includes(p.id)
            const toggle = () => !here && setSel((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))
            return (
              <li key={p.id}>
                <div
                  role="button"
                  tabIndex={here ? -1 : 0}
                  aria-disabled={here || undefined}
                  onClick={toggle}
                  onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggle())}
                  className={cn('flex min-h-[52px] items-center gap-3 px-3.5 py-2.5 outline-none focus-visible:bg-surface-2', here ? 'bg-surface-2/50' : 'cursor-pointer hover:bg-surface-2/60')}
                >
                  <span onClick={(e) => e.stopPropagation()} className="flex">
                    <Checkbox checked={on} disabled={here} onChange={(v) => setSel((s) => (v ? [...s, p.id] : s.filter((x) => x !== p.id)))} />
                  </span>
                  <Avatar name={p.name} hue={p.avatar_hue} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">{p.name}</span>
                    <span className="block truncate text-[12.5px] text-ink-3">{[p.employee_code, p.title].filter(Boolean).join(' · ')}</span>
                  </span>
                  <Badge size="sm" tone={here ? 'brand' : 'neutral'} className="max-w-[120px] truncate">
                    {here ? 'On this shift' : nameOf.get(p.shift_id ?? '') ?? 'No shift'}
                  </Badge>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {sel.length > 0 && (
        <Callout tone="info" className="mt-3">
          {sel.length === 1 ? '1 person' : `${sel.length} people`} will start following {shift.name} from their next working day.
        </Callout>
      )}
    </Sheet>
  )
}
