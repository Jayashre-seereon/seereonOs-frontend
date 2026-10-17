// Operations (Feature Guide §14, screenshot 026): tabs Recurring duties / People & timesheets / Payroll /
// Invoicing & collections. Recurring duties: KPIs, due & overdue occurrences with Mark done (rolls forward,
// on-time vs late recorded), and the full register (add, edit, delete, owner filter).
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useOpsSummary, type OpsSummary } from '@/api/dashboards'
import { DutiesPanel } from '@/modules/insights/home/OpsDuties'
import { MetricGrid, Panel, SeeAll } from '@/modules/insights/kit'
import PeopleSummaryPanel from '@/modules/hr/PeopleSummaryPanel'
import { fmtMoney } from '@/domain/money'
import { Tabs } from '@/ui'
import { MoreHorizontal, Pencil, Plus, Repeat, Trash2 } from '@/ui/icons'
import {
  Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, IconButton, Input, ListGroup, Menu, PageHeader, PeoplePicker, PersonName, SearchInput, Select, SkeletonRows, StatCard, Textarea, SectionTitle, useCan, useConfirm, useReadOnly, SkeletonCards,
} from '@/ui'
import { useMut } from '@/api/query'
import { opsApi, useOps, type OpsGroup, type OpsInput, type OpsRow } from '@/api/finance'
import { usePeopleMap, usePermissionHolders } from '@/api/core'
import { fmtDate, todayISO, addDays } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import type { ApiError } from '@/api/http'
import type { OpsItem, Recurrence } from '@/types/entities'

const CATEGORY: Record<OpsItem['category'], string> = { payroll: 'Payroll', compliance: 'Compliance', finance: 'Finance', admin: 'Admin', hr: 'HR', it: 'IT' }
const RECUR: Record<Recurrence, string> = { none: 'One-off', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' }
const GROUPS: { key: OpsGroup; title: string }[] = [
  { key: 'overdue', title: 'Overdue' },
  { key: 'due', title: 'Due this week' },
  { key: 'upcoming', title: 'Upcoming' },
  { key: 'done', title: 'Done' },
]
const INVALIDATE = [['ops'], ['notifications'], ['dash'], ['insights']]

type OpsTab = 'duties' | 'people' | 'payroll' | 'invoicing'
const TAB_INFO: Record<OpsTab, { label: string; line: string }> = {
  duties: { label: 'Recurring duties', line: 'Payroll, statutory filings, receivables follow-up and renewals: each with an owner and a due day. Mark done rolls a duty to its next date.' },
  people: { label: 'People & timesheets', line: 'Who has submitted last week’s timesheet, what is waiting for approval and who is away today, so payroll runs on approved days.' },
  payroll: { label: 'Payroll', line: 'The month’s pay from approved timesheets: working days, unapproved days, leave without pay, sales variable and net pay.' },
  invoicing: { label: 'Invoicing & collections', line: 'Milestones achieved but not invoiced, invoices awaiting payment and what is overdue, so cash comes in on time.' },
}
const PAY: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' }> = { not_started: { label: 'Not started', tone: 'neutral' }, draft: { label: 'Draft', tone: 'warning' }, final: { label: 'Final', tone: 'success' } }

function PeopleTab({ s }: { s: OpsSummary }) {
  const p = s.people
  return (
    <div className="space-y-4">
      <Panel title="Timesheet status" subtitle={`Last week starting ${fmtDate(p.last_week)}`} action={<SeeAll to="/approvals">Approvals</SeeAll>}>
        <MetricGrid
          items={[
            { label: 'People on timesheets', value: p.people },
            { label: 'Missing last week (not submitted)', value: p.missing_last_week, tone: p.missing_last_week ? 'warning' : 'success', to: '/insights/timesheet_compliance' },
            { label: 'Weeks waiting for approval', value: p.pending_approval, tone: p.pending_approval ? 'warning' : 'success', to: '/approvals' },
            { label: 'On leave today', value: p.on_leave_today, to: '/leave' },
          ]}
        />
      </Panel>
      <PeopleSummaryPanel />
    </div>
  )
}
function PayrollTab({ s }: { s: OpsSummary }) {
  const p = s.payroll
  if (!p.can)
    return (
      <Card>
        <EmptyState compact title="Payroll is restricted" body="Payroll is visible to people who prepare or finalise it. Ask the CEO or HR manager for the month’s status." />
      </Card>
    )
  return (
    <Panel title="Payroll" subtitle="This month and last" action={<SeeAll to="/payroll">Payroll</SeeAll>}>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {[
          { label: p.label, st: p.status, id: p.run_id },
          { label: p.last_label, st: p.last_status, id: p.last_run_id },
        ].map((x) => (
          <Link key={x.label} to={x.id ? `/payroll/${x.id}` : '/payroll'} className="flex items-center justify-between gap-3 rounded-md border border-line p-3 hover:bg-surface-2">
            <span className="text-[13.5px] font-medium">{x.label}</span>
            <Badge tone={PAY[x.st].tone}>{PAY[x.st].label}</Badge>
          </Link>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-ink-3">Anyone with unsubmitted or unapproved weeks is flagged on the payroll run before you pay. {s.people.missing_last_week ? `${s.people.missing_last_week} ${s.people.missing_last_week === 1 ? 'person hasn’t' : 'people haven’t'} submitted last week.` : 'Everyone submitted last week.'}</p>
    </Panel>
  )
}
function InvoicingTab({ s }: { s: OpsSummary }) {
  const v = s.invoicing
  if (!v.can)
    return (
      <Card>
        <EmptyState compact title="Finance is restricted" body="Invoices and collections are visible to people with finance access." />
      </Card>
    )
  return (
    <Panel title="Invoicing and collections" action={<SeeAll to="/finance/invoices">Invoices</SeeAll>}>
      <MetricGrid
        items={[
          { label: `Achieved, not yet invoiced (${v.achieved_count})`, value: fmtMoney(v.achieved_not_invoiced), tone: v.achieved_not_invoiced ? 'warning' : 'success', to: '/finance/invoices' },
          { label: 'Invoiced, awaiting payment', value: fmtMoney(v.outstanding), tone: v.outstanding ? 'warning' : 'success', to: '/finance/invoices' },
          { label: `Overdue (${v.overdue_count} invoice${v.overdue_count === 1 ? '' : 's'})`, value: fmtMoney(v.overdue_amount), tone: v.overdue_amount ? 'danger' : 'success' },
          { label: 'Collected this month', value: fmtMoney(v.collected_month), tone: 'success' },
        ]}
      />
    </Panel>
  )
}

export default function OperationsPage() {
  const [sp, setSp] = useSearchParams()
  const tab = ((['duties', 'people', 'payroll', 'invoicing'] as OpsTab[]).find((t) => t === sp.get('tab')) ?? 'duties') as OpsTab
  const summary = useOpsSummary()
  return (
    <div>
      <PageHeader title="Operations" subtitle="The company’s non-project work: recurring duties, people and timesheets, payroll, invoicing and collections." />
      <Tabs
        className="mb-3"
        value={tab}
        onChange={(v) => {
          const n = new URLSearchParams(sp)
          if (v === 'duties') n.delete('tab')
          else n.set('tab', v)
          setSp(n, { replace: true })
        }}
        tabs={(Object.keys(TAB_INFO) as OpsTab[]).map((k) => ({ value: k, label: TAB_INFO[k].label }))}
      />
      <p className="mb-4 text-[13px] leading-relaxed text-ink-3">{TAB_INFO[tab].line}</p>
      {tab === 'duties' ? (
        <>
          <DutiesPanel />
          <RegisterSection />
        </>
      ) : summary.isLoading ? (
        <SkeletonCards n={4} />
      ) : summary.error || !summary.data ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : tab === 'people' ? (
        <PeopleTab s={summary.data} />
      ) : tab === 'payroll' ? (
        <PayrollTab s={summary.data} />
      ) : (
        <InvoicingTab s={summary.data} />
      )}
    </div>
  )
}

function RegisterSection() {
  const [owner, setOwner] = useState('')
  const [q, setQ] = useState('')
  const ops = useOps({ owner_id: owner || undefined, q: q || undefined })
  const { data: people } = usePeopleMap()
  const opsOwners = usePermissionHolders('ops.manage')
  const readOnly = useReadOnly()
  const can = useCan()
  const canEdit = can('ops.manage') && !readOnly
  const [editing, setEditing] = useState<OpsRow | null>(null)
  const [adding, setAdding] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const { confirm } = useConfirm()
  const done = useMut((i: OpsRow) => opsApi.done(i.id), {
    invalidate: INVALIDATE,
    success: (r) => (r.next_due ? `Marked done · next due ${fmtDate(r.next_due)}` : 'Marked done'),
  })
  const del = useMut((i: OpsRow) => opsApi.remove(i.id, i.version), { invalidate: INVALIDATE, success: 'Item deleted' })
  const d = ops.data
  const grouped = useMemo(() => {
    const m: Record<OpsGroup, OpsRow[]> = { overdue: [], due: [], upcoming: [], done: [] }
    for (const i of d?.items ?? []) m[i.group].push(i)
    return m
  }, [d])
  const ownerOptions = [{ value: '', label: 'All owners' }, ...(people ?? []).filter((p) => p.status === 'active' && (opsOwners ? opsOwners.has(p.id) : ['admin', 'ops', 'pm'].includes(p.role))).map((p) => ({ value: p.id, label: p.name }))]

  const remove = async (i: OpsRow) => {
    if (await confirm({ title: `Delete “${i.item}”?`, body: i.recurring !== 'none' ? 'This stops the recurring responsibility for good. Its history stays in the activity log.' : 'The item is removed from the register.', confirmLabel: 'Delete', tone: 'danger' })) del.mutate(i)
  }
  const markDone = async (i: OpsRow) => {
    if (i.recurring === 'none' && !(await confirm({ title: `Mark “${i.item}” done?`, body: 'It is a one-off, so it moves to Done.', confirmLabel: 'Mark done' }))) return
    done.mutate(i)
  }

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold">Register</h2>
          <p className="text-[12.5px] text-ink-3">Every responsibility with its owner and next due date. Add, edit or retire duties here.</p>
        </div>
        {canEdit && (
          <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)} className="w-full sm:w-auto">
            Add responsibility
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2.5 md:flex-row md:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search duties" className="md:w-64" />
        <Select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} options={ownerOptions} className="md:w-48" />
      </div>

      <div className="mt-2">
        {ops.isLoading ? (
          <div className="mt-4 rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={5} /></div>
        ) : ops.error || !d ? (
          <ErrorState error={ops.error} onRetry={() => ops.refetch()} />
        ) : !d.items.length ? (
          <Card className="mt-4">
            <EmptyState
             
              title={owner || q ? 'No duties match' : 'No responsibilities yet'}
              body={owner || q ? 'Clear the owner filter or search.' : 'Add payroll, PF/ESI, GST and TDS so nothing slips. Recurring items roll forward when marked done.'}
              action={canEdit && !owner && !q ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add responsibility</Button> : undefined}
            />
          </Card>
        ) : (
          GROUPS.filter((g) => g.key !== 'done' || showDone).map((g) => {
            const list = grouped[g.key]
            if (!list.length && g.key !== 'overdue') return null
            return (
              <section key={g.key}>
                <SectionTitle className={g.key === 'overdue' ? 'mt-5' : undefined}>
                  {g.title} <span className="tnum font-normal text-ink-3">{list.length}</span>
                </SectionTitle>
                {!list.length ? (
                  <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-3">Nothing overdue.</div>
                ) : (
                  <ListGroup>
                    {list.map((i) => (
                      <OpsItemRow key={i.id} i={i} canEdit={canEdit} busy={done.isPending && done.variables?.id === i.id} onDone={() => markDone(i)} onEdit={() => setEditing(i)} onDelete={() => remove(i)} />
                    ))}
                  </ListGroup>
                )}
              </section>
            )
          })
        )}
        {d && d.counts.done > 0 && (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="ghost" onClick={() => setShowDone((v) => !v)}>
              {showDone ? 'Hide done items' : `Show ${d.counts.done} done`}
            </Button>
          </div>
        )}
      </div>

      <OpsDialog open={adding || !!editing} item={editing} onClose={() => { setAdding(false); setEditing(null) }} />
    </div>
  )
}

function OpsItemRow({ i, canEdit, busy, onDone, onEdit, onDelete }: { i: OpsRow; canEdit: boolean; busy: boolean; onDone: () => void; onEdit: () => void; onDelete: () => void }) {
  const when = i.group === 'done' ? `Done ${fmtDate(i.last_done_on)}` : i.days < 0 ? `${-i.days}d overdue` : i.days === 0 ? 'Due today' : i.days === 1 ? 'Due tomorrow' : `Due in ${i.days}d`
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('min-w-0 break-words text-[14px] font-medium text-ink', i.status === 'done' && 'text-ink-3 line-through')}>{i.item}</span>
          <Badge size="sm" tone="neutral">{CATEGORY[i.category]}</Badge>
          {i.recurring !== 'none' && (
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-3"><Repeat className="size-3" />{RECUR[i.recurring]}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
          <PersonName id={i.owner_id} size={18} className="text-[12.5px]" />
          <span className={cn('tnum', i.group === 'overdue' ? 'text-danger-text' : i.group === 'due' ? 'text-warning-text' : '')}>
            {fmtDate(i.due_on)} · {when}
          </span>
          {i.last_done_on && i.group !== 'done' && <span>Last done {fmtDate(i.last_done_on)}</span>}
        </div>
        {i.notes && <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-2">{i.notes}</p>}
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-1.5">
          {i.status === 'open' && (
            <Button size="sm" variant="secondary" loading={busy} onClick={onDone} className="flex-1 sm:flex-none">
              Mark done
            </Button>
          )}
          <Menu
            label="Item actions"
            trigger={<IconButton size="sm" label={`Actions for ${i.item}`}><MoreHorizontal className="size-4" /></IconButton>}
            items={[
              { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
              { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: onDelete },
            ]}
          />
        </div>
      )}
    </div>
  )
}

function OpsDialog({ open, item, onClose }: { open: boolean; item: OpsRow | null; onClose: () => void }) {
  const blank: OpsInput = { item: '', category: 'compliance', owner_id: '', due_on: addDays(todayISO(), 7), recurring: 'monthly', notes: '' }
  const [f, setF] = useState<OpsInput>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    setF(item ? { item: item.item, category: item.category, owner_id: item.owner_id, due_on: item.due_on, recurring: item.recurring, notes: item.notes } : blank)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item])
  const set = <K extends keyof OpsInput>(k: K, v: OpsInput[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
  }
  const onErr = (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message }))
  const add = useMut((b: OpsInput) => opsApi.add(b), { invalidate: INVALIDATE, success: 'Responsibility added', onSuccess: onClose, onError: onErr })
  const save = useMut((b: OpsInput) => opsApi.update(item!.id, b, item!.version), { invalidate: INVALIDATE, success: 'Changes saved', onSuccess: onClose, onError: onErr })
  const submit = () => {
    const e: Record<string, string> = {}
    if (f.item.trim().length < 3) e.item = 'Name the responsibility.'
    if (!f.owner_id) e.owner_id = 'Choose who owns it.'
    if (!f.due_on) e.due_on = 'Pick the next due date.'
    setErrors(e)
    if (Object.values(e).some(Boolean)) return
    if (item) save.mutate(f)
    else add.mutate(f)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={item ? 'Edit responsibility' : 'Add responsibility'}
      description="When it’s done the owner clicks Mark done; recurring items move to their next due date."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending || save.isPending} onClick={submit}>
            {item ? 'Save changes' : 'Add responsibility'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Responsibility" required error={errors.item} className="sm:col-span-2">
          <Input value={f.item} onChange={(e) => set('item', e.target.value)} placeholder="e.g. PF and ESI filing" invalid={!!errors.item} autoFocus={!item} />
        </Field>
        <Field label="Area">
          <Select value={f.category} onChange={(e) => set('category', e.target.value as OpsItem['category'])} options={Object.entries(CATEGORY).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Repeats">
          <Select value={f.recurring} onChange={(e) => set('recurring', e.target.value as Recurrence)} options={Object.entries(RECUR).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Owner" required error={errors.owner_id}>
          <PeoplePicker value={f.owner_id || null} onChange={(v) => set('owner_id', v ?? '')} invalid={!!errors.owner_id} />
        </Field>
        <Field label={item ? 'Next due' : 'First due'} required error={errors.due_on}>
          <Input type="date" value={f.due_on} onChange={(e) => set('due_on', e.target.value)} invalid={!!errors.due_on} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} placeholder="Portal, checklist or who to call" />
        </Field>
      </div>
    </Dialog>
  )
}

