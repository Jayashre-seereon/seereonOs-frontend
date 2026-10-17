import { useState } from 'react'
import { usePeopleMap } from '@/api/core'
import { useMut } from '@/api/query'
import { adminApi, useDelegationOptions, useDelegations } from '@/api/admin'
import type { ApiError } from '@/api/http'
import { useSession } from '@/stores/session'
import { diffDays, fmtDate, todayISO } from '@/domain/calendar'
import type { Delegation } from '@/types/entities'
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, Input, PageHeader, PeoplePicker, SectionTitle, Select, SkeletonRows, useCan, useConfirm, useReadOnly } from '@/ui'

const INV = [['delegations'], ['approvals'], ['my-tasks'], ['team-tasks'], ['leave-requests']]
/** "29 Sept" */
const dm = (d: string) => fmtDate(d)

/** Settings → Delegations (Feature Guide §16): hand approvals (and optionally task follow-ups) to someone for a date range. */
export default function DelegationsPage() {
  const q = useDelegations()
  const { user } = useSession()
  const readOnly = useReadOnly()
  const manageAll = useCan()('users.manage')
  const today = todayISO()
  const list = q.data ?? []
  const groups: [string, Delegation[]][] = [
    ['Active now', list.filter((d) => d.from_on <= today && today <= d.to_on)],
    ['Upcoming', list.filter((d) => d.from_on > today)],
    ['Past', list.filter((d) => d.to_on < today)],
  ]
  return (
    <div>
      <PageHeader title="Delegations" subtitle="Hand your approvals (and optionally your task follow-ups) to another person for a date range, typically while on leave. Approvals made by the delegate count toward the delegate’s approval KPI." />
      {!readOnly && <AddDelegation />}
      {q.isLoading ? (
        <SkeletonRows rows={4} className="mt-6" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !list.length ? (
        <Card pad={false} className="mt-6">
          <EmptyState compact title="No delegations yet" body="Going on leave or to a client site? Hand your approvals and tasks to someone for those dates so nothing misses its deadline." />
        </Card>
      ) : (
        groups.map(([label, items]) =>
          items.length ? (
            <section key={label}>
              <SectionTitle className="mt-6">{label}</SectionTitle>
              <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {items.map((d) => (
                  <Row key={d.id} d={d} canDelete={!readOnly && (manageAll || d.from_user_id === user?.id)} />
                ))}
              </div>
            </section>
          ) : null,
        )
      )}
    </div>
  )
}

function Row({ d, canDelete }: { d: Delegation; canDelete: boolean }) {
  const people = usePeopleMap()
  const opts = useDelegationOptions()
  const { confirm } = useConfirm()
  const from = people.get(d.from_user_id)
  const to = people.get(d.to_user_id)
  const today = todayISO()
  const active = d.from_on <= today && today <= d.to_on
  const days = diffDays(d.to_on, d.from_on) + 1
  const project = d.project_id ? opts.data?.projects.find((p) => p.id === d.project_id) : null
  const del = useMut(() => adminApi.deleteDelegation(d.id), { invalidate: INV, success: 'Delegation removed' })
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 text-[13.5px]">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <span className="font-semibold text-ink">{from?.name ?? '—'}</span>
          <span className="text-ink-3">to</span>
          <span className="font-semibold text-ink">{to?.name ?? '—'}</span>
          <span className="tnum whitespace-nowrap text-ink-2">
            , {dm(d.from_on)} to {dm(d.to_on)}
          </span>
          {active && <Badge tone="success" size="sm">Active now</Badge>}
        </div>
        <div className="mt-0.5 text-[12.5px] text-ink-3">
          {d.project_id ? `${project ? `${project.code} · ${project.name}` : 'One project'} — task follow-ups and reviews only` : `All projects — approvals${d.include_tasks === false ? ' only' : ' and task follow-ups'}`} · {days} day{days === 1 ? '' : 's'}
          {d.reason ? <span className="text-ink-2"> · {d.reason}</span> : null}
        </div>
      </div>
      {canDelete && (
        <Button size="sm" variant="secondary" loading={del.isPending} onClick={async () => (await confirm({ title: 'Remove this delegation?', body: `${to?.name ?? 'The delegate'} stops covering for ${from?.name ?? 'this person'}.`, confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(undefined)}>
          Remove
        </Button>
      )}
    </div>
  )
}

function AddDelegation() {
  const { user } = useSession()
  const isAdmin = useCan()('users.manage')
  const opts = useDelegationOptions()
  const today = todayISO()
  const blank = { from_user_id: isAdmin ? '' : user?.id ?? '', to_user_id: '', project_id: '', from_on: '', to_on: '', reason: '' }
  const [f, setF] = useState(blank)
  // Feature Guide §16: task follow-ups are optional (on by default); a one-project delegation is task follow-ups only
  const [tasks, setTasks] = useState(true)
  const [err, setErr] = useState<ApiError | null>(null)
  const [local, setLocal] = useState<Record<string, string>>({})
  const m = useMut(() => adminApi.addDelegation({ ...f, project_id: f.project_id || null, include_tasks: f.project_id ? true : tasks }), {
    invalidate: INV,
    success: 'Delegation added',
    silentError: true,
    onError: setErr,
    onSuccess: () => (setF(blank), setTasks(true), setErr(null)),
  })
  const fe = (k: string) => local[k] ?? (err?.field === k ? err.message : undefined)
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.from_user_id) e.from_user_id = 'Choose who is away.'
    if (!f.to_user_id) e.to_user_id = 'Choose who covers.'
    else if (f.to_user_id === f.from_user_id) e.to_user_id = 'Pick someone other than the person who is away.'
    if (!f.from_on) e.from_on = 'Choose the first day.'
    if (!f.to_on) e.to_on = 'Choose the last day.'
    else if (f.from_on && f.to_on < f.from_on) e.to_on = 'The end date must be on or after the start date.'
    setLocal(e)
    setErr(null)
    if (!Object.keys(e).length) m.mutate(undefined)
  }
  const set = (k: keyof typeof f, v: string) => {
    setF({ ...f, [k]: v })
    if (local[k]) setLocal({ ...local, [k]: '' })
  }
  return (
    <Card>
      <div className="grid gap-x-3 gap-y-3 md:grid-cols-3">
        <Field label="Delegate from" required error={fe('from_user_id')} hint={isAdmin ? undefined : 'You can delegate your own approvals and tasks.'}>
          {isAdmin ? <PeoplePicker value={f.from_user_id || null} onChange={(v) => set('from_user_id', v ?? '')} invalid={!!fe('from_user_id')} /> : <PeoplePicker value={f.from_user_id} onChange={() => {}} filter={(p) => p.id === user?.id} />}
        </Field>
        <Field label="To" required error={fe('to_user_id')}>
          <PeoplePicker value={f.to_user_id || null} onChange={(v) => set('to_user_id', v ?? '')} filter={(p) => p.id !== f.from_user_id} invalid={!!fe('to_user_id')} />
        </Field>
        <Field label="Scope" error={fe('project_id')} hint={f.project_id ? 'Covers that project’s task follow-ups and reviews. Timesheet and leave approvals need All projects.' : tasks ? 'Approvals plus task follow-ups on every project.' : 'Approvals only.'}>
          <Select value={f.project_id} onChange={(e) => set('project_id', e.target.value)} options={[{ value: '', label: 'All projects' }, ...(opts.data?.projects ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} />
        </Field>
        <Field label="From date" required error={fe('from_on')}>
          <Input type="date" min={today} value={f.from_on} invalid={!!fe('from_on')} onChange={(e) => set('from_on', e.target.value)} />
        </Field>
        <Field label="To date" required error={fe('to_on')}>
          <Input type="date" min={f.from_on || today} value={f.to_on} invalid={!!fe('to_on')} onChange={(e) => set('to_on', e.target.value)} />
        </Field>
        <Field label="Note" error={fe('reason')}>
          <Input value={f.reason} placeholder="e.g. Annual leave" invalid={!!fe('reason')} onChange={(e) => set('reason', e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Checkbox
          checked={f.project_id ? true : tasks}
          disabled={!!f.project_id}
          onChange={setTasks}
          label="Include task follow-ups"
          description={f.project_id ? 'A one-project delegation always covers that project’s tasks.' : 'The delegate also follows up the open tasks of the person who is away; they show on the delegate’s “Covering” list.'}
        />
      </div>
      {err && !err.field && <p className="mt-2 text-[13px] text-danger-text">{err.message}</p>}
      <Button variant="primary" className="mt-4" loading={m.isPending} onClick={submit}>
        Add delegation
      </Button>
      <p className="mt-2 text-[12px] text-ink-3">Approvals made by the delegate count toward the delegate’s approval KPI.</p>
    </Card>
  )
}
