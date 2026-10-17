import { useState } from 'react'
import { Pencil } from '@/ui/icons'
import { useMut } from '@/api/query'
import { adminApi, useRoster, type RosterPerson as RosterPersonBase, type RosterView as RosterViewBase, type UserPatch } from '@/api/admin'
import { announce, guarded, isPending } from '@/api/changes'
import type { CostRate } from '@/types/entities'
import { fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, MoneyInput, PageHeader, Select, SkeletonRows, Tooltip, useReadOnly, type Column } from '@/ui'

/** v6: cost per hour = monthly CTC ÷ (working days in the month × minimum hours) — Feature Guide §6/§16. */
type RosterPerson = RosterPersonBase & { cost_per_hour_paise?: number | null }
type RosterView = Omit<RosterViewBase, 'people'> & { people: RosterPerson[]; cost_month?: string; working_days_month?: number }
const monthLabel = (ym?: string) => (ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : 'this month')

const FUNCTION_LABEL: Record<RosterPerson['department_kind'], string> = { management: 'Management', delivery: 'Delivery', sales: 'Sales', operations: 'Operations' }
const INV = [['team-roster'], ['users'], ['people'], ['cost-rates'], ['changes'], ['approvals'], ['payroll']]

/** Team & settings → Team (Feature Guide §16 "Team"): role, function, joined, reports to (who approves the
 *  timesheet), access level, productive hours a day and monthly CTC (cost_rates.view only). All eight columns fit
 *  at ≥1280 px: cells are read-only text and each row has an Edit button (the same dialog phones use). */
export default function TeamRosterPage() {
  const q = useRoster()
  const ro = useReadOnly()
  const [edit, setEdit] = useState<RosterPerson | null>(null)
  const [ctc, setCtc] = useState<RosterPerson | null>(null)
  const d = q.data as RosterView | undefined

  if (q.isLoading)
    return (
      <div>
        <PageHeader title="Team" />
        <SkeletonRows rows={8} />
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />

  const canEdit = d.can_edit && !ro
  const canAccess = d.can_edit_access && !ro
  const roleLabel = (key: string, persona: string) => {
    const r = d.roles.find((x) => x.key === key)
    return r ? `Auto (${r.name})` : `Auto (${persona})`
  }
  const fnName = (p: RosterPerson) => p.department_name ?? FUNCTION_LABEL[p.department_kind]
  const cols: Column<RosterPerson>[] = [
    {
      key: 'name', header: 'Name', sortValue: (p) => p.name,
      cell: (p) => (
        <div className="min-w-[84px]">
          <div className="font-semibold leading-snug text-ink">{p.name}</div>
          {p.employee_code && <div className="text-[12px] text-ink-3">{p.employee_code}</div>}
          {p.status !== 'active' && <Badge size="sm" tone="neutral">Deactivated</Badge>}
        </div>
      ),
    },
    { key: 'role', header: 'Role', sortValue: (p) => p.title, cell: (p) => <span className="block min-w-[84px] leading-snug text-ink-2">{p.title}</span> },
    { key: 'fn', header: 'Function', sortValue: fnName, cell: (p) => <span>{fnName(p)}</span> },
    { key: 'joined', header: 'Joined', cell: (p) => <span className="tnum block min-w-[64px] leading-snug">{fmtDate(p.joined_on)}</span> },
    { key: 'rt', header: 'Reports to', sortValue: (p) => p.reports_to_name ?? '', cell: (p) => <span className="block leading-snug">{p.reports_to_name ?? <span className="text-ink-3">No one (self-approves)</span>}</span> },
    { key: 'access', header: 'Access', sortValue: (p) => p.role_name, cell: (p) => <span className="block leading-snug">{roleLabel(p.role_key, p.persona)}</span> },
    {
      key: 'hours', header: 'Hours/day', align: 'right',
      cell: (p) => (
        <span className="tnum">
          {p.effective_productive_hours}
          {p.productive_hours === null && <span className="block text-[11.5px] text-ink-3">default</span>}
        </span>
      ),
    },
    ...(d.can_see_ctc
      ? [
          {
            key: 'ctc', header: 'Monthly CTC', align: 'right' as const, sortValue: (p: RosterPerson) => p.monthly_ctc_paise ?? 0,
            cell: (p: RosterPerson) => <CtcCell p={p} canEdit={d.can_edit_ctc && !ro} onEdit={() => setCtc(p)} />,
          },
        ]
      : []),
  ]

  return (
    <div>
      <PageHeader title="Team" subtitle="Everyone who uses the board. Reports to decides who approves their timesheet; access decides their dashboard view. Monthly CTC drives cost per hour and payroll. Click a person to edit their row." />
      <DataTable
        rows={d.people}
        columns={cols}
        rowKey={(p) => p.id}
        initialSort={undefined}
        rowClassName={(p) => (p.status !== 'active' ? 'opacity-60' : undefined)}
        onRowClick={canEdit || canAccess ? (p) => p.status === 'active' && setEdit(p) : undefined}
        empty={<EmptyState compact title="No one here yet" body="Invite people from People." />}
        mobileCard={(p) => (
          <div className="min-w-0">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold">{p.name}</div>
                <div className="truncate text-[12.5px] text-ink-3">{p.title}</div>
              </div>
              {(canEdit || canAccess) && p.status === 'active' && (
                <IconButton size="sm" label={`Edit ${p.name}`} onClick={() => setEdit(p)}>
                  <Pencil className="size-4" />
                </IconButton>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
              <Def label="Function" value={p.department_name ?? FUNCTION_LABEL[p.department_kind]} />
              <Def label="Joined" value={fmtDate(p.joined_on)} />
              <Def label="Reports to" value={p.reports_to_name ?? 'No one (self-approves)'} />
              <Def label="Access" value={roleLabel(p.role_key, p.persona)} />
              <Def label="Hours/day" value={`${p.effective_productive_hours}h${p.productive_hours === null ? ' (default)' : ''}`} />
              {d.can_see_ctc && <Def label="Monthly CTC" value={p.monthly_ctc_paise === null ? '—' : `${fmtMoney(p.monthly_ctc_paise)}${p.cost_per_hour_paise != null ? ` · ${fmtMoney(p.cost_per_hour_paise)}/h` : ''}`} />}
            </dl>
            {d.can_see_ctc && d.can_edit_ctc && !ro && p.status === 'active' && (
              <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => setCtc(p)}>
                Change CTC
              </Button>
            )}
          </div>
        )}
      />
      <Card className="mt-3" pad={false}>
        <p className="px-4 py-3 text-[12.5px] leading-snug text-ink-3">
          {d.can_see_ctc ? 'Monthly CTC is visible only to people who can see cost rates; contributors can’t read it. ' : 'Monthly CTC is hidden: it is visible only to people who can see cost rates. '}
          Cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day){d.working_days_month ? ` — ${monthLabel(d.cost_month)}: CTC ÷ (${d.working_days_month} × ${d.min_hours}h)` : ''}. Example: ₹60,000 ÷ (22 × 9) = ₹303 per hour. Hours/day is the productive task time planning and forecasts assume (company default {d.default_productive_hours}h); the timesheet minimum is separate.
        </p>
      </Card>
      {edit && <EditDialog p={edit} view={d} canEdit={canEdit} canAccess={canAccess} onClose={() => setEdit(null)} />}
      {ctc && <CtcDialog p={ctc} onClose={() => setCtc(null)} />}
    </div>
  )
}

function Def({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-3">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  )
}

function useSave(onDone?: () => void) {
  return useMut(({ p, patch }: { p: RosterPerson; patch: UserPatch }) => adminApi.updateUser(p.id, patch, p.version), {
    invalidate: INV,
    onSuccess: (r) => {
      if (r.access) announce(r.access, 'Access updated')
      else
        // job fields apply directly
        announce({ pending: false, result: r.user, result_id: r.user.id }, `${r.user.name} updated`)
      onDone?.()
    },
  })
}

function CtcCell({ p, canEdit, onEdit }: { p: RosterPerson; canEdit: boolean; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <div className="text-right">
        <div className="tnum whitespace-nowrap">{p.monthly_ctc_paise === null ? <span className="text-ink-3">—</span> : fmtMoney(p.monthly_ctc_paise)}</div>
        {p.cost_per_hour_paise != null && <div className="tnum whitespace-nowrap text-[12px] text-ink-3">{fmtMoney(p.cost_per_hour_paise)}/hour</div>}
        {p.pending_ctc && (
          <Tooltip content={`${p.pending_ctc.summary ?? 'Change'} — waiting for a checker.`}>
            <span>
              <Badge size="sm" tone="info">Pending</Badge>
            </span>
          </Tooltip>
        )}
      </div>
      {canEdit && p.status === 'active' && !p.pending_ctc && (
        <IconButton size="sm" label={`Change ${p.name}’s CTC`} onClick={(e) => (e.stopPropagation(), onEdit())}>
          <Pencil className="size-3.5" />
        </IconButton>
      )}
    </div>
  )
}

/** CTC changes go through the cost-rate endpoint, which is maker-checked in this workspace. */
function CtcDialog({ p, onClose }: { p: RosterPerson; onClose: () => void }) {
  const [ctc, setCtc] = useState<number>(p.monthly_ctc_paise ?? 0)
  const [eff, setEff] = useState(todayISO())
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null)
  const m = useMut(() => guarded<CostRate>('POST', '/cost-rates', { user_id: p.id, monthly_ctc_paise: ctc, variable_pct: p.variable_pct ?? 0, sales_target_paise: null, effective_from: eff }), {
    invalidate: INV,
    silentError: true,
    onError: (e) => setErr(e),
    onSuccess: (r) => {
      announce(r, isPending(r) ? '' : `${p.name}’s CTC updated`)
      onClose()
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Change ${p.name.split(' ')[0]}’s monthly CTC`}
      description="A new rate starts on the date you choose; history is kept. Salary changes may need a second person to approve them."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!ctc} onClick={() => m.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Monthly CTC" required error={err?.field === 'monthly_ctc_paise' ? err.message : null} hint={p.monthly_ctc_paise !== null ? `Now ${fmtMoney(p.monthly_ctc_paise)}` : undefined}>
          <MoneyInput value={ctc} onChange={setCtc} invalid={err?.field === 'monthly_ctc_paise'} />
        </Field>
        <Field label="Effective from" required error={err?.field === 'effective_from' ? err.message : null}>
          <Input type="date" value={eff} onChange={(e) => setEff(e.target.value)} invalid={err?.field === 'effective_from'} />
        </Field>
        {err && !['monthly_ctc_paise', 'effective_from'].includes(err.field ?? '') && <p className="text-[13px] text-danger-text">{err.message}</p>}
      </div>
    </Dialog>
  )
}

/** Phones: edit one person's row in a sheet. */
function EditDialog({ p, view, canEdit, canAccess, onClose }: { p: RosterPerson; view: RosterView; canEdit: boolean; canAccess: boolean; onClose: () => void }) {
  const [f, setF] = useState({ department_id: p.department_id ?? '', joined_on: p.joined_on, reports_to_id: p.reports_to_id ?? '', role_key: p.role_key, hours: p.productive_hours === null ? '' : String(p.productive_hours) })
  const save = useSave(onClose)
  const submit = () => {
    const patch: UserPatch = {}
    if (canEdit) {
      if ((f.department_id || null) !== p.department_id && f.department_id) patch.department_id = f.department_id
      if (f.joined_on !== p.joined_on) patch.joined_on = f.joined_on
      if ((f.reports_to_id || null) !== p.reports_to_id) patch.reports_to_id = f.reports_to_id || null
      const h = f.hours.trim() === '' ? null : Number(f.hours)
      if (h !== p.productive_hours) patch.productive_hours = h
    }
    if (canAccess && f.role_key !== p.role_key) patch.role_key = f.role_key
    if (!Object.keys(patch).length) return onClose()
    save.mutate({ p, patch })
  }
  const people = view.people.filter((x) => x.status === 'active' && x.id !== p.id)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={p.name}
      description={p.title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {canEdit && view.departments.length > 0 && (
          <Field label="Function">
            <Select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })} options={[...(p.department_id ? [] : [{ value: '', label: FUNCTION_LABEL[p.department_kind] }]), ...view.departments.map((x) => ({ value: x.id, label: x.name }))]} />
          </Field>
        )}
        {canEdit && (
          <Field label="Joined">
            <Input type="date" value={f.joined_on} onChange={(e) => setF({ ...f, joined_on: e.target.value })} />
          </Field>
        )}
        {canEdit && (
          <Field label="Reports to" hint="Decides who approves their timesheet.">
            <Select value={f.reports_to_id} onChange={(e) => setF({ ...f, reports_to_id: e.target.value })} options={[{ value: '', label: 'No one (self-approves)' }, ...people.map((x) => ({ value: x.id, label: x.name }))]} />
          </Field>
        )}
        {canAccess && (
          <Field label="Access" hint="Decides their dashboard view and permissions. May need a second person to approve.">
            <Select value={f.role_key} onChange={(e) => setF({ ...f, role_key: e.target.value })} options={view.roles.map((r) => ({ value: r.key, label: r.name }))} />
          </Field>
        )}
        {canEdit && (
          <Field label="Productive hours a day" hint={`Task hours planning assumes. Empty = company default (${view.default_productive_hours}h). Up to ${view.min_hours}h.`}>
            <Input type="number" inputMode="decimal" min={0.5} max={view.min_hours} step={0.5} value={f.hours} placeholder={String(view.default_productive_hours)} onChange={(e) => setF({ ...f, hours: e.target.value })} className={cn('tnum')} />
          </Field>
        )}
      </div>
    </Dialog>
  )
}
