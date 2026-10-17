// /lifecycle — onboarding and exit checklists: owner per item, due dates from the joining / resignation date,
// progress, overdue items; exits record type, reason, last day and rehire eligibility.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { UserCheck, UserMinus } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { hrApi, type ChecklistView } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { addDays, diffDays, fmtDate, todayISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import {
  Avatar, Badge, Button, Callout, Card, Checkbox, Combobox, Dialog, EmptyState, ErrorState, Field, Input, KV, PageHeader, Progress, Select, Sheet, SkeletonCards, StatCard, Switch, Tabs, Textarea, useReadOnly,
} from '@/ui'
import { OWNER_ROLE } from './components'

const INV = [['lifecycle'], ['hr-dashboard'], ['assets'], ['directory']]
const EXIT_TYPE: Record<string, string> = { resignation: 'Resignation', termination: 'Termination', contract_end: 'Contract end', retirement: 'Retirement' }
type Tab = 'onboarding' | 'offboarding' | 'completed'

export default function LifecyclePage() {
  const q = useApi(['lifecycle'], hrApi.lifecycle)
  const d = q.data
  const ro = useReadOnly()
  const [tab, setTab] = useState<Tab>('onboarding')
  const [open, setOpen] = useState<string | null>(null)
  const [start, setStart] = useState<'onboarding' | 'offboarding' | null>(null)
  const items = d?.items ?? []
  const openOn = items.filter((c) => c.status === 'open' && c.kind === 'onboarding')
  const openOff = items.filter((c) => c.status === 'open' && c.kind === 'offboarding')
  const done = items.filter((c) => c.status === 'completed')
  const overdue = items.filter((c) => c.status === 'open').reduce((s, c) => s + c.overdue, 0)
  const assetsOut = openOff.reduce((s, c) => s + c.assets_out, 0)
  const list = tab === 'onboarding' ? openOn : tab === 'offboarding' ? openOff : done
  const sel = items.find((c) => c.id === open) ?? null
  return (
    <div>
      <PageHeader
        title="Onboarding & exits"
        subtitle="Checklists for people joining and leaving. Each item has an owner and a due date; exits deactivate the account after the last day once every item is done."
        actions={
          !ro && (
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              <Button onClick={() => setStart('offboarding')}>Start an exit</Button>
              <Button variant="primary" onClick={() => setStart('onboarding')}>Start onboarding</Button>
            </div>
          )
        }
      />
      {q.isLoading ? (
        <SkeletonCards n={4} />
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4 md:space-y-5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
            <StatCard label="Joining" value={openOn.length} sub="open onboarding" onClick={() => setTab('onboarding')} />
            <StatCard label="Leaving" value={openOff.length} sub="open exits" onClick={() => setTab('offboarding')} />
            <StatCard label="Overdue items" value={overdue} tone={overdue ? 'danger' : 'success'} sub="across open checklists" />
            <StatCard label="Assets to collect" value={assetsOut} tone={assetsOut ? 'warning' : undefined} sub={<Link to="/assets" className="hover:underline">from people leaving</Link>} />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'onboarding', label: 'Onboarding', count: openOn.length }, { value: 'offboarding', label: 'Exits', count: openOff.length }, { value: 'completed', label: 'Completed', count: done.length }]} />
          {list.length ? (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((c) => <ChecklistCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />)}
            </ul>
          ) : (
            <Card pad={false}>
              <EmptyState
                icon={tab === 'offboarding' ? <UserMinus /> : <UserCheck />}
                title={tab === 'onboarding' ? 'Nobody is joining right now' : tab === 'offboarding' ? 'No exits in progress' : 'No completed checklists'}
                body={tab === 'onboarding' ? 'Hiring a candidate in Recruitment starts their onboarding automatically.' : tab === 'offboarding' ? 'Start an exit when someone resigns so nothing is missed.' : undefined}
              />
            </Card>
          )}
        </div>
      )}
      {sel && <ChecklistSheet c={sel} onClose={() => setOpen(null)} />}
      {start && d && <StartDialog kind={start} people={d.people} onClose={() => setStart(null)} />}
    </div>
  )
}

function ChecklistCard({ c, onOpen }: { c: ChecklistView; onOpen: () => void }) {
  const t = todayISO()
  const ref = c.kind === 'offboarding' ? c.last_day : c.start_on
  const delta = ref ? diffDays(ref, t) : null
  return (
    <li>
      <button type="button" onClick={onOpen} className="block w-full rounded-lg border border-line bg-surface p-4 text-left transition hover:border-line-strong hover:bg-surface-2/40">
        <div className="flex items-start gap-3">
          <Avatar name={c.person_name} hue={c.person_hue} size={34} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">{c.person_name}</div>
            <div className="truncate text-[12.5px] text-ink-3">{c.person_title}</div>
          </div>
          {c.person_status === 'invited' ? <Badge size="sm" tone="info">Invite pending</Badge> : c.person_status === 'deactivated' ? <Badge size="sm">Deactivated</Badge> : null}
        </div>
        <div className="mt-3 text-[12.5px] text-ink-2">
          {c.kind === 'onboarding' ? 'Joins' : 'Last day'} <span className="tnum font-medium">{fmtDate(ref)}</span>
          {delta !== null && c.status === 'open' && <span className="text-ink-3"> · {delta > 0 ? `in ${delta}d` : delta === 0 ? 'today' : `${-delta}d ago`}</span>}
        </div>
        <div className="mt-2.5 flex items-center gap-2.5">
          <Progress value={c.total ? c.done / c.total : 0} tone={c.status === 'completed' ? 'success' : c.overdue ? 'warning' : 'brand'} className="flex-1" height={5} />
          <span className="tnum shrink-0 text-[12px] font-medium text-ink-2">{c.done}/{c.total}</span>
        </div>
        {(c.overdue > 0 || c.assets_out > 0) && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {c.overdue > 0 && <Badge size="sm" tone="danger">{c.overdue} overdue</Badge>}
            {c.assets_out > 0 && <Badge size="sm" tone="warning">{c.assets_out} asset{c.assets_out > 1 ? 's' : ''} to collect</Badge>}
          </div>
        )}
      </button>
    </li>
  )
}

function ChecklistSheet({ c, onClose }: { c: ChecklistView; onClose: () => void }) {
  const ro = useReadOnly()
  const [editing, setEditing] = useState(false)
  const toggle = useMut((v: { item: string; done: boolean }) => hrApi.toggleItem(c.id, v.item, v.done), { invalidate: INV })
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      width={600}
      title={`${c.kind === 'onboarding' ? 'Onboarding' : 'Exit'} · ${c.person_name}`}
      subtitle={`${c.done} of ${c.total} done${c.overdue ? ` · ${c.overdue} overdue` : ''}${c.status === 'completed' ? ' · completed' : ''}`}
      footer={c.kind === 'offboarding' && !ro ? <Button onClick={() => setEditing(true)}>Edit exit details</Button> : undefined}
    >
      <div className="space-y-5">
        <Progress value={c.total ? c.done / c.total : 0} tone={c.status === 'completed' ? 'success' : 'brand'} />
        <KV
          cols={c.kind === 'offboarding' ? 3 : 2}
          items={
            c.kind === 'offboarding'
              ? [
                  { label: 'Resignation date', value: fmtDate(c.start_on, 'long') },
                  { label: 'Last day', value: fmtDate(c.last_day, 'long') },
                  { label: 'Exit type', value: c.exit_type ? EXIT_TYPE[c.exit_type] : '—' },
                  { label: 'Rehire eligible', value: c.rehire_eligible === null ? 'Not decided' : c.rehire_eligible ? 'Yes' : 'No' },
                  { label: 'Account', value: c.person_status === 'deactivated' ? 'Deactivated' : 'Active' },
                  { label: 'Assets still with them', value: c.assets_out ? <Link to="/assets" className="text-brand-text hover:underline">{c.assets_out}</Link> : 'None' },
                ]
              : [
                  { label: 'Joining date', value: fmtDate(c.start_on, 'long') },
                  { label: 'Account', value: c.person_status === 'invited' ? 'Invite pending' : c.person_status === 'active' ? 'Active' : 'Deactivated' },
                ]
          }
        />
        {c.exit_reason && <p className="rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-2">{c.exit_reason}</p>}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {c.items.map((i) => (
            <li key={i.id} className={cn('flex items-start gap-3 px-3.5 py-3', i.done_on && 'bg-surface-2/40')}>
              <div className="pt-0.5">
                <Checkbox checked={!!i.done_on} disabled={!i.can_toggle || ro || toggle.isPending} onChange={(v) => toggle.mutate({ item: i.id, done: v })} label={<span className="sr-only">{i.label}</span>} />
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn('text-[13.5px] font-medium', i.done_on ? 'text-ink-3 line-through decoration-ink-3/50' : 'text-ink')}>{i.label}</div>
                <div className="mt-0.5 text-[12px] text-ink-3">
                  {i.done_on ? `Done ${fmtDate(i.done_on)} by ${i.done_by_name ?? '—'}` : <span className={cn(i.overdue && 'font-medium text-danger-text')}>{i.overdue ? 'Overdue · ' : ''}due {fmtDate(i.due_on)}</span>}
                </div>
              </div>
              <Badge size="sm">{OWNER_ROLE[i.owner_role] ?? i.owner_role}</Badge>
            </li>
          ))}
        </ul>
        {c.kind === 'onboarding' && c.person_status === 'invited' && <Callout tone="info">The invite is still pending. Items owned by the employee can be ticked by them after they join.</Callout>}
      </div>
      {editing && <ExitDialog c={c} onClose={() => setEditing(false)} />}
    </Sheet>
  )
}

function ExitDialog({ c, onClose }: { c: ChecklistView; onClose: () => void }) {
  const [last, setLast] = useState(c.last_day ?? '')
  const [type, setType] = useState(c.exit_type ?? 'resignation')
  const [reason, setReason] = useState(c.exit_reason ?? '')
  const [rehire, setRehire] = useState(!!c.rehire_eligible)
  const [err, setErr] = useState<string | null>(null)
  const m = useMut(() => hrApi.updateLifecycle(c.id, { last_day: last, exit_type: type as ChecklistView['exit_type'], exit_reason: reason, rehire_eligible: rehire }, c.version), { invalidate: INV, success: 'Exit details saved', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErr(e.message) })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Exit details" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Last working day"><Input type="date" value={last} min={c.start_on} onChange={(e) => setLast(e.target.value)} /></Field>
          <Field label="Exit type"><Select value={type} onChange={(e) => setType(e.target.value as typeof type)} options={Object.entries(EXIT_TYPE).map(([value, label]) => ({ value, label }))} /></Field>
        </div>
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Switch checked={rehire} onChange={setRehire} label="Eligible for rehire" />
        {err && <Callout tone="danger">{err}</Callout>}
      </div>
    </Dialog>
  )
}

function StartDialog({ kind, people, onClose }: { kind: 'onboarding' | 'offboarding'; people: { id: string; name: string; kind: 'user' | 'invite' }[]; onClose: () => void }) {
  const opts = people.filter((p) => kind === 'onboarding' || p.kind === 'user').map((p) => ({ value: p.id, label: p.name, group: p.kind === 'invite' ? 'Invited' : 'People' }))
  const [who, setWho] = useState<string | null>(null)
  const [start, setStart] = useState(todayISO())
  const [last, setLast] = useState(addDays(todayISO(), 30))
  const [type, setType] = useState('resignation')
  const [reason, setReason] = useState('')
  const [rehire, setRehire] = useState(true)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMut(() => hrApi.startLifecycle({ kind, person_id: who ?? '', start_on: start, ...(kind === 'offboarding' ? { last_day: last, exit_type: type, exit_reason: reason, rehire_eligible: rehire } : {}) }), {
    invalidate: INV, success: kind === 'onboarding' ? 'Onboarding checklist started' : 'Exit checklist started', silentError: true, onSuccess: onClose,
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind === 'onboarding' ? 'Start onboarding' : 'Start an exit'}
      description={kind === 'onboarding' ? 'Creates the standard joining checklist: offer letter, documents, laptop, accounts, policies, buddy and 30/60/90-day check-ins.' : 'Creates the exit checklist: notice, knowledge transfer, exit interview, asset return, access, settlement and experience letter.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>{kind === 'onboarding' ? 'Start onboarding' : 'Start exit'}</Button></>}
    >
      <div className="space-y-4">
        <Field label="Person" required error={errs.person_id}>
          <Combobox value={who} onChange={setWho} options={opts} placeholder="Choose a person" invalid={!!errs.person_id} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={kind === 'onboarding' ? 'Joining date' : 'Resignation date'} required error={errs.start_on}><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          {kind === 'offboarding' && <Field label="Last working day" required error={errs.last_day}><Input type="date" value={last} min={start} onChange={(e) => setLast(e.target.value)} /></Field>}
        </div>
        {kind === 'offboarding' && (
          <>
            <Field label="Exit type" required error={errs.exit_type}><Select value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(EXIT_TYPE).map(([value, label]) => ({ value, label }))} /></Field>
            <Field label="Reason" required error={errs.exit_reason}><Textarea rows={3} value={reason} invalid={!!errs.exit_reason} onChange={(e) => setReason(e.target.value)} placeholder="Why they are leaving, in their words" /></Field>
            <Switch checked={rehire} onChange={setRehire} label="Eligible for rehire" />
          </>
        )}
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}
