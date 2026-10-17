import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, CheckCheck, Inbox, Send } from '@/ui/icons'
import { useApi, useMut, toastError } from '@/api/query'
import { changesApi } from '@/api/changes'
import { ChangeDiff } from '@/modules/workflows/ChangeDiff'
import { companyApi, type InboxGroup, type InboxItem, type InboxView, type MyRequest } from '@/api/company'
import type { ApiError } from '@/api/http'
import { fmtDateTime, relTime, todayISO } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { cn } from '@/lib/utils'
import { useUI } from '@/stores/ui'
import {
  Avatar, Badge, Button, Callout, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, Field, FilterChips, PageHeader, Segmented, Sheet, Skeleton, SkeletonRows, StatCard, Tabs, Textarea, toast, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { WeekDetail } from '@/modules/work/ApprovalsPage'
import { GROUP_LABEL, GROUP_ORDER, REQUEST_TONE, dueText, fmtFact, kindLabel, KIND_LABEL } from './shared'

type Filter = 'all' | 'overdue' | InboxGroup
const INVALIDATE = [['inbox'], ['approvals'], ['team'], ['timesheet'], ['tasks'], ['my-tasks'], ['leave'], ['expenses'], ['purchases'], ['appraisals'], ['changes'], ['workflows'], ['payroll'], ['cost-rates'], ['budgets'], ['mc-config'], ['roles'], ['users']]

/** /inbox — every decision waiting on me, plus what I've asked others for. */
export default function InboxPage() {
  const [tab, setTab] = useState<'waiting' | 'mine'>('waiting')
  const q = useApi(['inbox', 'list'], companyApi.inbox, { refetchInterval: 60_000 })
  const mine = useApi(['inbox', 'mine'], companyApi.myRequests)
  const myPending = mine.data?.filter((r) => r.state === 'pending').length
  return (
    <div>
      <PageHeader title="Approvals inbox" subtitle="Every decision waiting on you in one place, oldest deadline first." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'waiting', label: 'Waiting on me', count: q.data?.counts.all },
          { value: 'mine', label: 'My requests', count: myPending || undefined },
        ]}
      />
      {tab === 'waiting' ? (
        q.isLoading ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[88px] rounded-lg" />)}</div>
            <SkeletonRows rows={6} className="mt-6" />
          </>
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data ? (
          <Waiting view={q.data} />
        ) : null
      ) : (
        <MyRequests q={mine} />
      )}
    </div>
  )
}

/* ================================================================== */
/* Waiting on me                                                       */
/* ================================================================== */
function Waiting({ view }: { view: InboxView }) {
  const ro = useReadOnly()
  const [filter, setFilter] = useState<Filter>('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [sel, setSel] = useState<string[]>([])
  const [unavailable, setUnavailable] = useState<string[]>([])
  const markUnavailable = (id: string) => setUnavailable((u) => (u.includes(id) ? u : [...u, id]))
  const c = view.counts
  const items = useMemo(() => view.items.filter((i) => (filter === 'all' ? true : filter === 'overdue' ? i.overdue : i.group === filter)), [view.items, filter])
  const bulkable = (i: InboxItem) => !ro && i.bulk && i.stage === 'approve' && !unavailable.includes(i.id) && (i.kind === 'expense' || (i.kind === 'timesheet' && view.bulk_enabled))
  const eligible = items.filter(bulkable).map((i) => i.id)
  const selected = sel.filter((id) => eligible.includes(id))
  const ordered = GROUP_ORDER.flatMap((g) => items.filter((i) => i.group === g))
  const active = ordered.find((i) => i.id === activeId) ?? ordered[0] ?? null
  const sheetItem = view.items.find((i) => i.id === sheetId) ?? null

  const [bulkBusy, setBulkBusy] = useState(false)
  const runBulk = async () => {
    const targets = view.items.filter((i) => selected.includes(i.id))
    setBulkBusy(true)
    let ok = 0
    const failed: string[] = []
    for (const it of targets) {
      try {
        await companyApi.decide(it, 'approve')
        ok++
      } catch (e) {
        const er = e as ApiError
        if (er.code === 'ROUTE_NOT_FOUND') markUnavailable(it.id)
        failed.push(`${it.requester?.name ?? it.title}: ${er.message}`)
      }
    }
    setBulkBusy(false)
    setSel([])
    if (ok) toast.success(`Approved ${ok} item${ok > 1 ? 's' : ''}`)
    if (failed.length) toast.warning(`${failed.length} not approved`, { description: failed.slice(0, 3).join(' · ') })
    await refresh()
  }
  const refresh = useRefresh()

  const chips: { value: Filter; label: string; count?: number }[] = [
    { value: 'all', label: 'All', count: c.all },
    { value: 'overdue', label: 'Overdue', count: c.overdue },
    ...GROUP_ORDER.filter((g) => c[g] > 0 || g === 'timesheets' || g === 'tasks').map((g) => ({ value: g as Filter, label: GROUP_LABEL[g], count: c[g] })),
  ]
  const groups = GROUP_ORDER.map((g) => ({ g, list: items.filter((i) => i.group === g) })).filter((x) => x.list.length)
  const money = view.items.filter((i) => i.amount && i.stage !== 'read').reduce((s, i) => s + (i.amount ?? 0), 0)

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatCard label="Waiting on me" value={c.all} />
        <StatCard label="Overdue" value={c.overdue} tone={c.overdue ? 'danger' : undefined} hint={`Timesheets are due ${view.sla_days} working days after submission; everything else within 2 working days.`} />
        <StatCard label="Timesheets and tasks" value={c.timesheets + c.tasks} />
        <StatCard label="Money awaiting decision" value={money ? fmtMoney(money) : '—'} />
      </div>

      <div className="mt-6">
        <FilterChips value={filter} onChange={(v) => setFilter(v)} options={chips} />
      </div>
      {eligible.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="text-[13px] text-ink-2">{selected.length ? `${selected.length} selected` : `${eligible.length} can be approved in bulk`}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSel(selected.length ? [] : eligible)}>
              {selected.length ? 'Clear' : 'Select all'}
            </Button>
            <Button size="sm" variant="primary" icon={<CheckCheck className="size-4" />} disabled={!selected.length} loading={bulkBusy} onClick={runBulk}>
              Approve selected
            </Button>
          </div>
        </div>
      )}

      {!items.length ? (
        <Card pad={false} className="mt-4">
          <EmptyState icon={<Inbox />} title={filter === 'all' ? 'You’re all caught up' : 'Nothing here'} body={filter === 'all' ? 'Timesheets, task reviews, leave, expenses, purchases and changes to check that need your decision show up here.' : 'No items match this filter.'} action={filter !== 'all' ? <Button size="sm" onClick={() => setFilter('all')}>Show all</Button> : undefined} />
        </Card>
      ) : (
        <>
          {/* desktop: master–detail */}
          <div className="mt-4 hidden overflow-hidden rounded-lg border border-line bg-surface lg:grid lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]">
            <div role="listbox" aria-label="Waiting on me" className="max-h-[calc(100vh-300px)] min-h-[460px] overflow-y-auto border-r border-line scroll-thin">
              {groups.map(({ g, list }) => (
                <div key={g}>
                  <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-line bg-surface-2 px-4 py-1.5 text-[12px] font-medium text-ink-3">
                    <span>{GROUP_LABEL[g]}</span>
                    <span className="tnum">{list.length}</span>
                  </div>
                  {list.map((i) => (
                    <ListItem key={i.id} i={i} on={i.id === active?.id} onClick={() => setActiveId(i.id)} bulk={bulkable(i)} showCheck={eligible.length > 0 && (i.kind === 'timesheet' || i.kind === 'expense') && i.stage === 'approve'} checked={selected.includes(i.id)} onCheck={(v) => setSel((s) => (v ? [...s, i.id] : s.filter((x) => x !== i.id)))} />
                  ))}
                </div>
              ))}
            </div>
            <div className="min-w-0">{active && <DetailPane key={active.id} i={active} unavailable={unavailable.includes(active.id)} onUnavailable={() => markUnavailable(active.id)} />}</div>
          </div>

          {/* phones and tablets: list → sheet */}
          <div className="mt-4 space-y-5 lg:hidden">
            {groups.map(({ g, list }) => (
              <section key={g}>
                <div className="mb-2 flex items-center justify-between px-1 text-[13px] font-semibold text-ink-2">
                  <span>{GROUP_LABEL[g]}</span>
                  <span className="tnum text-ink-3">{list.length}</span>
                </div>
                <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                  {list.map((i) => (
                    <ListItem key={i.id} i={i} on={false} onClick={() => setSheetId(i.id)} bulk={bulkable(i)} showCheck={eligible.length > 0 && (i.kind === 'timesheet' || i.kind === 'expense') && i.stage === 'approve'} checked={selected.includes(i.id)} onCheck={(v) => setSel((s) => (v ? [...s, i.id] : s.filter((x) => x !== i.id)))} mobile />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {eligible.length > 0 && items.some((i) => (i.kind === 'timesheet' || i.kind === 'expense') && i.warnings.length) && <p className="mt-2 px-1 text-[12px] text-ink-3">Items with warnings can’t be bulk approved. Open and decide them one by one.</p>}
        </>
      )}

      <Sheet
        open={!!sheetItem}
        onOpenChange={(o) => !o && setSheetId(null)}
        title={sheetItem?.title ?? ''}
        subtitle={sheetItem ? `${kindLabel(sheetItem)} · ${dueText(sheetItem, todayISO())}` : undefined}
        footer={sheetItem ? <Actions i={sheetItem} unavailable={unavailable.includes(sheetItem.id)} onUnavailable={() => markUnavailable(sheetItem.id)} onDone={() => setSheetId(null)} block /> : undefined}
      >
        {sheetItem && <DetailBody i={sheetItem} unavailable={unavailable.includes(sheetItem.id)} />}
      </Sheet>
    </>
  )
}

function useRefresh() {
  const inv = useMut(async () => null, { invalidate: INVALIDATE })
  return () => inv.mutateAsync(undefined)
}

function ListItem({ i, on, onClick, bulk, showCheck, checked, onCheck, mobile }: { i: InboxItem; on: boolean; onClick: () => void; bulk: boolean; showCheck: boolean; checked: boolean; onCheck: (v: boolean) => void; mobile?: boolean }) {
  const today = todayISO()
  return (
    <div
      role="option"
      aria-selected={on}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      className={cn('flex cursor-pointer items-center gap-3 px-4 py-3 outline-none transition focus-visible:bg-surface-2', !mobile && 'border-b border-line', on ? 'bg-brand-soft/60 shadow-[inset_2px_0_0_var(--brand)]' : 'hover:bg-surface-2/60')}
    >
      {showCheck && (
        <div onClick={(e) => e.stopPropagation()} className={cn('shrink-0', !bulk && 'pointer-events-none opacity-40')} title={!bulk ? 'Has warnings — decide it individually' : undefined}>
          <Checkbox checked={checked} disabled={!bulk} onChange={onCheck} />
        </div>
      )}
      {i.requester ? <Avatar name={i.requester.name} hue={i.requester.hue} size={30} /> : <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-3">{KIND_LABEL[i.kind].slice(0, 2).toUpperCase()}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{i.title}</span>
          {i.amount ? <span className="tnum shrink-0 whitespace-nowrap text-[13px] font-medium">{fmtMoney(i.amount)}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-3">
          <span className="min-w-0 flex-1 truncate">{i.step_label ? `${i.step_label.split(' · ')[0]} · ` : ''}{i.subtitle}</span>
          <span className="shrink-0 whitespace-nowrap">{i.overdue ? <Badge tone="danger" size="sm">Overdue</Badge> : i.warnings.length ? <span className="text-warning-text">{i.warnings.length} warning{i.warnings.length > 1 ? 's' : ''}</span> : i.due_at === today ? 'Due today' : i.due_at ? dueText(i, today) : ''}</span>
        </div>
      </div>
    </div>
  )
}

function DetailPane({ i, unavailable, onUnavailable }: { i: InboxItem; unavailable: boolean; onUnavailable: () => void }) {
  const today = todayISO()
  return (
    <div className="flex h-full max-h-[calc(100vh-300px)] min-h-[460px] flex-col">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1 basis-[280px]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="sm">{kindLabel(i)}</Badge>
            {i.overdue ? <Badge tone="danger" size="sm">Overdue</Badge> : <span className="text-[12.5px] text-ink-3">{dueText(i, today)}</span>}
            {i.via_delegation && <Badge tone="info" size="sm">Delegated to you</Badge>}
            {i.step_label && <Badge tone="accent" size="sm">{i.step_label}</Badge>}
          </div>
          <h3 className="mt-1.5 text-[16px] font-semibold leading-snug text-ink">{i.title}</h3>
          <div className="mt-0.5 text-[12.5px] text-ink-3">{i.subtitle}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Actions i={i} unavailable={unavailable} onUnavailable={onUnavailable} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4 scroll-thin">
        <DetailBody i={i} unavailable={unavailable} />
      </div>
    </div>
  )
}

function DetailBody({ i, unavailable }: { i: InboxItem; unavailable: boolean }) {
  const navigate = useNavigate()
  const openTask = useUI((s) => s.openTask)
  return (
    <div className="space-y-4">
      {unavailable && (
        <Callout tone="info" title={`Decide this in ${i.screen}`} action={<Button size="sm" onClick={() => navigate(i.link)}>Open</Button>}>
          Deciding from the inbox isn’t connected for this item yet.
        </Callout>
      )}
      {i.step_label && <div className="lg:hidden"><Badge tone="accent" size="sm">{i.step_label}</Badge></div>}
      {i.escalates_to && <p className="text-[12.5px] text-ink-3">{i.overdue ? 'Past its deadline — escalates' : 'If not decided by the deadline, it escalates'} to {i.escalates_to}.</p>}
      {i.warnings.length > 0 && (
        <Callout tone="warning" title={i.warnings.length > 1 ? `${i.warnings.length} things to check` : 'Check before deciding'}>
          <ul className="list-disc space-y-0.5 pl-4">
            {i.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Callout>
      )}
      {i.requester && (
        <div className="flex items-center gap-3">
          <Avatar name={i.requester.name} hue={i.requester.hue} size={34} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium">{i.requester.name}</div>
            <div className="truncate text-[12.5px] text-ink-3">
              {i.requester.title}
              {i.submitted_at ? ` · ${i.kind === 'document' ? 'updated' : 'submitted'} ${relTime(i.submitted_at)}` : ''}
            </div>
          </div>
        </div>
      )}
      {i.note && (
        <blockquote className="rounded-md border border-line bg-surface-2/60 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-2">
          {i.note}
        </blockquote>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12.5px] xl:grid-cols-3">
        {i.facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-ink-3">{f.label}</dt>
            <dd className={cn('mt-0.5 break-words text-[13.5px] text-ink', (f.type === 'money' || f.type === 'hours' || f.type === 'number') && 'tnum', f.tone === 'danger' && 'text-danger-text', f.tone === 'success' && 'text-success-text', f.tone === 'warning' && 'text-warning-text')}>{fmtFact(f.value, f.type)}</dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="text-ink-3">Waiting</dt>
          <dd className="tnum mt-0.5 text-[13.5px] text-ink">{i.days_waiting} day{i.days_waiting === 1 ? '' : 's'}</dd>
        </div>
      </dl>
      {i.kind === 'change' && <ChangePreview id={i.entity_id} />}
      {i.kind === 'timesheet' && i.user_id && i.week_start && (
        <div className="-mx-1 overflow-hidden rounded-lg border border-line">
          <WeekDetail userId={i.user_id} week={i.week_start} compact />
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {i.actions.includes('open') ? null : i.kind === 'task_review' && i.task_id ? (
          <Button size="sm" variant="ghost" icon={<ArrowUpRight className="size-4" />} onClick={() => openTask(i.task_id!)}>Open task</Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<ArrowUpRight className="size-4" />} onClick={() => navigate(i.link)}>Open in {i.screen}</Button>
        )}
        {i.submitted_at && <span className="ml-auto self-center text-[12px] text-ink-3">Received {fmtDateTime(i.submitted_at)}</span>}
      </div>
    </div>
  )
}

/* ---------------- actions (inline decisions via the owning area's endpoint) ---------------- */
function Actions({ i, unavailable, onUnavailable, onDone, block }: { i: InboxItem; unavailable: boolean; onUnavailable: () => void; onDone?: () => void; block?: boolean }) {
  const ro = useReadOnly()
  const navigate = useNavigate()
  const { askReason, confirm } = useConfirm()
  const [rateOpen, setRateOpen] = useState(false)
  const who = i.requester?.name.split(' ')[0] ?? ''
  const m = useMut((v: { action: 'approve' | 'reject' | 'pay' | 'send_back'; body?: Record<string, unknown> }) =>
    i.kind === 'change'
      ? v.action === 'reject' ? changesApi.reject(i.entity_id, String(v.body?.reason ?? '')) : changesApi.approve(i.entity_id)
      : companyApi.decide(i, v.action, v.body), {
    invalidate: INVALIDATE,
    silentError: true,
    success: (_, v) => ({ approve: i.kind === 'vendor_bill' ? 'Bill approved' : i.kind === 'task_review' ? 'Task approved' : i.kind === 'change' ? 'Change approved and applied' : `${kindLabel(i)} approved`, reject: i.kind === 'change' ? 'Change rejected' : `${kindLabel(i)} rejected`, pay: 'Marked as paid', send_back: 'Task sent back' })[v.action],
    onSuccess: () => {
      setRateOpen(false)
      onDone?.()
    },
    onError: (e) => {
      if (e.code === 'ROUTE_NOT_FOUND') {
        onUnavailable()
        toast.info(`Decide this in ${i.screen}`, { description: 'Deciding from the inbox isn’t connected for this item yet.', action: { label: 'Open', onClick: () => navigate(i.link) } })
      } else toastError(e)
    },
  })
  if (ro) return <Button size="sm" onClick={() => navigate(i.link)} className={cn(block && 'w-full')}>Open in {i.screen}</Button>
  const open = (
    <Button size="sm" variant={i.actions.includes('open') ? 'primary' : 'secondary'} onClick={() => (i.kind === 'task_review' && i.task_id ? useUI.getState().openTask(i.task_id) : navigate(i.link))} className={cn(block && 'flex-1')}>
      {i.kind === 'document' ? 'Open and read' : i.kind === 'appraisal' ? 'Open review' : i.kind === 'change_request' ? 'Open change request' : `Open in ${i.screen}`}
    </Button>
  )
  if (unavailable || i.actions.includes('open')) return open
  const reject = async () => {
    const isTask = i.kind === 'task_review'
    const isChange = i.kind === 'change'
    const reason = await askReason({
      title: isTask ? `Send back to ${who}` : isChange ? 'Reject this change' : `Reject ${kindLabel(i).toLowerCase()}`,
      body: isTask ? 'Say what needs to change. The task goes back to them with your note.' : `${i.title}. ${who ? `${who} sees your reason.` : ''}`,
      label: isTask ? 'What needs to change?' : 'Reason',
      placeholder: isTask ? 'e.g. The export misses the GST column; add it and attach a sample file.' : isChange ? 'e.g. The new threshold should stay at ₹25,000 until the audit closes.' : 'e.g. Book this against the client project, not general admin.',
      confirmLabel: isTask ? 'Send back' : 'Reject',
      minLength: isTask || isChange ? 10 : 5,
      tone: 'danger',
    })
    if (reason) m.mutate({ action: isTask ? 'send_back' : 'reject', body: { reason } })
  }
  const pay = async () => {
    const ok = await confirm({ title: 'Record payment', body: `${i.title} · ${fmtMoney(i.amount)}. This marks it paid and posts it to the ledger.`, confirmLabel: 'Mark as paid' })
    if (ok) m.mutate({ action: 'pay' })
  }
  const busy = m.isPending
  return (
    <>
      {i.actions.includes('reject') && <Button size="sm" variant="secondary" onClick={reject} disabled={busy} className={cn(block && 'flex-1')}>Reject</Button>}
      {i.actions.includes('send_back') && <Button size="sm" variant="secondary" onClick={reject} disabled={busy} className={cn(block && 'flex-1')}>Send back</Button>}
      {i.actions.includes('pay') && <Button size="sm" variant="primary" icon={<Send className="size-4" />} onClick={pay} loading={busy} className={cn(block && 'flex-1')}>Mark as paid</Button>}
      {i.actions.includes('approve') && (
        <Button size="sm" variant="primary" loading={busy} onClick={() => (i.kind === 'task_review' ? setRateOpen(true) : m.mutate({ action: 'approve' }))} className={cn(block && 'flex-1')}>
          Approve
        </Button>
      )}
      {i.kind === 'task_review' && <RateDialog open={rateOpen} onOpenChange={setRateOpen} title={i.title} busy={busy} onSubmit={(rating, note) => m.mutate({ action: 'approve', body: { quality_rating: rating, note: note || undefined } })} />}
    </>
  )
}

/** Before → after of a change waiting for my check (loaded on demand). */
function ChangePreview({ id }: { id: string }) {
  const q = useApi(['changes', 'one', id], () => changesApi.get(id))
  if (q.isLoading) return <Skeleton className="h-24 rounded-lg" />
  if (q.error || !q.data) return null
  return (
    <section>
      <h4 className="mb-2 text-[13px] font-semibold text-ink">What changes</h4>
      <ChangeDiff c={q.data} />
    </section>
  )
}

function RateDialog({ open, onOpenChange, title, busy, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; busy: boolean; onSubmit: (rating: number, note: string) => void }) {
  const [rating, setRating] = useState('4')
  const [note, setNote] = useState('')
  const HINT: Record<string, string> = { '1': 'Poor — major rework needed', '2': 'Below expectations', '3': 'Meets expectations', '4': 'Good — minor polish only', '5': 'Excellent — reference quality' }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Approve task"
      description={title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => onSubmit(Number(rating), note.trim())}>Approve with {rating}/5</Button>
        </>
      }
    >
      <Field label="Quality rating" hint={HINT[rating]} required>
        <Segmented block value={rating} onChange={setRating} options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))} />
      </Field>
      <Field label="Note for the owner" className="mt-4">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional — what was good, what to keep doing." rows={3} />
      </Field>
    </Dialog>
  )
}

/* ================================================================== */
/* My requests                                                         */
/* ================================================================== */
function MyRequests({ q }: { q: { data?: MyRequest[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  const navigate = useNavigate()
  const [f, setF] = useState<'all' | 'pending' | 'decided'>('all')
  const list = (q.data ?? []).filter((r) => (f === 'all' ? true : f === 'pending' ? r.state === 'pending' : r.state !== 'pending'))
  const cols: Column<MyRequest>[] = [
    { key: 'title', header: 'Request', cell: (r) => <Cell title={r.title} sub={r.subtitle} />, sortValue: (r) => r.title },
    { key: 'kind', header: 'Type', cell: (r) => <span className="whitespace-nowrap text-ink-2">{KIND_LABEL[r.kind]}</span>, sortValue: (r) => r.kind, hideBelow: 'lg' },
    { key: 'submitted', header: 'Submitted', cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{r.submitted_at ? relTime(r.submitted_at) : '—'}</span>, sortValue: (r) => r.submitted_at ?? '' },
    { key: 'state', header: 'Status', cell: (r) => <Badge tone={REQUEST_TONE[r.state]} size="sm">{r.state_label}</Badge>, sortValue: (r) => r.state },
    { key: 'who', header: 'With', cell: (r) => <span className="text-ink-2">{r.state === 'pending' ? (r.waiting_on ? `Waiting on ${r.waiting_on}` : 'Waiting') : r.decided_by ? `${r.decided_by}${r.decided_at ? ` · ${relTime(r.decided_at)}` : ''}` : '—'}</span>, hideBelow: 'xl' },
    { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <span className="tnum whitespace-nowrap">{r.amount ? fmtMoney(r.amount) : '—'}</span>, sortValue: (r) => r.amount ?? 0 },
  ]
  const pending = q.data?.filter((r) => r.state === 'pending').length ?? 0
  return (
    <>
      <div className="mb-4">
        <Segmented value={f} onChange={setF} options={[{ value: 'all', label: 'All', count: q.data?.length }, { value: 'pending', label: 'Waiting', count: pending }, { value: 'decided', label: 'Decided', count: (q.data?.length ?? 0) - pending }]} />
      </div>
      <DataTable
        rows={list}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        onRowClick={(r) => navigate(r.link)}
        pageSize={50}
        empty={<EmptyState icon={<Inbox />} title="No requests yet" body="Timesheets, task submissions, leave, expenses and purchase requests you send appear here with their status." compact />}
        mobileCard={(r) => (
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <Cell title={r.title} sub={`${KIND_LABEL[r.kind]} · ${r.subtitle}`} />
              <Badge tone={REQUEST_TONE[r.state]} size="sm">{r.state_label}</Badge>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
              <span className="min-w-0 truncate">{r.state === 'pending' ? `Waiting on ${r.waiting_on ?? '—'}` : r.decided_by ? `By ${r.decided_by}` : r.submitted_at ? relTime(r.submitted_at) : ''}</span>
              {r.amount ? <span className="tnum shrink-0 whitespace-nowrap font-medium text-ink">{fmtMoney(r.amount)}</span> : null}
            </div>
            {r.reason && r.state !== 'pending' && <p className="mt-1.5 text-[12.5px] text-ink-2">“{r.reason}”</p>}
          </div>
        )}
      />
    </>
  )
}

function Cell({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13.5px] font-medium text-ink">{title}</div>
      {sub && <div className="truncate text-[12.5px] text-ink-3">{sub}</div>}
    </div>
  )
}
