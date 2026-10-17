import { Fragment, useState } from 'react'
import { ChevronDown, UserCheck } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { timeApi, workApi, type ApprovalItem, type ApprovalTeamView } from '@/api/work'
import type { ApiError } from '@/api/http'
import { addDays, fmtDate, fmtDateTime, parseISO, relTime, todayISO, weekLabel } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, SectionTitle, Segmented, Skeleton, SkeletonRows, Textarea, useConfirm, useReadOnly } from '@/ui'
import { WeekReadOnly } from './WeekGrid'

const LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const INV = [['approvals'], ['team'], ['timesheet'], ['payroll']]
/** "19 Sept" */
const dm = (d: string | null | undefined) => {
  if (!d) return '—'
  const x = parseISO(d.slice(0, 10))
  return `${x.getDate()} ${x.toLocaleDateString('en-GB', { month: 'short' })}`
}
const range = (mon: string) => `${dm(mon)} – ${dm(addDays(mon, 6))}`

/** UI-16 — /approvals: timesheet approvals, the approval KPI and "My team's timesheets" (Feature Guide §9). */
export default function ApprovalsPage() {
  const q = useApi(['approvals', 'list'], workApi.approvals, { refetchInterval: 60_000 })
  const ro = useReadOnly()
  const [sel, setSel] = useState<string[]>([])
  const bulk = useMut((ids: string[]) => workApi.bulkApprove(ids), {
    invalidate: INV,
    success: (r) => (r.approved.length ? `Approved ${r.approved.length} week${r.approved.length > 1 ? 's' : ''}` : null),
    onSuccess: () => setSel([]),
  })
  const d = q.data
  const pending = d?.pending ?? []
  const overdue = pending.filter((p) => p.overdue).length
  const eligible = pending.filter((p) => !p.days_below_min).map((p) => p.week_id)
  const k = d?.kpi

  return (
    <div>
      <PageHeader
        title="Timesheet approvals"
        meta={d && pending.length ? <Badge tone="danger">{pending.length} waiting</Badge> : null}
        subtitle={`Approve or reject within ${d?.sla_days ?? 2} working days of submission. Each one you miss is a lapse on your Approvals KPI and pulls down your weekly score.`}
      />
      {q.isLoading ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[76px] rounded-lg" />)}
          </div>
          <SkeletonRows rows={5} className="mt-6" />
        </>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
            <Kpi value={k?.on_time_pct == null ? '—' : `${Math.round(k.on_time_pct * 100)}%`} label="Approvals on time, last 30 days" tone={k?.on_time_pct != null && k.on_time_pct < 0.8 ? 'danger' : undefined} />
            <Kpi value={String(k?.lapses ?? 0)} label="Approval lapses, last 30 days (negative KPI)" tone={k?.lapses ? 'danger' : undefined} />
            <Kpi value={String(overdue)} label="Overdue right now" tone={overdue ? 'danger' : undefined} />
            <Kpi value={String(pending.length - overdue)} label="Waiting, within deadline" />
          </div>

          <SectionTitle
            className="mt-7"
            action={
              d.bulk_enabled && pending.length > 1 && !ro ? (
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setSel(sel.length ? [] : eligible)} disabled={!eligible.length}>
                    {sel.length ? 'Clear' : `Select ${eligible.length} clean`}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={!sel.length} loading={bulk.isPending} onClick={() => bulk.mutate(sel)}>
                    Approve{sel.length ? ` ${sel.length}` : ''}
                  </Button>
                </div>
              ) : null
            }
          >
            Waiting for you
          </SectionTitle>
          {!pending.length ? (
            <Card pad={false}>
              <EmptyState icon={<UserCheck />} title="You’re all caught up" body="When someone who reports to you submits a week, it shows up here." />
            </Card>
          ) : (
            <>
              <WaitingTable pending={pending} bulk={d.bulk_enabled && !ro} sel={sel} setSel={setSel} />
              <div className="space-y-2.5 lg:hidden">
                {pending.map((p) => (
                  <PendingCard key={p.week_id} p={p} selectable={d.bulk_enabled && !ro} selected={sel.includes(p.week_id)} onSelect={(v) => setSel((s) => (v ? [...s, p.week_id] : s.filter((x) => x !== p.week_id)))} />
                ))}
              </div>
              {d.bulk_enabled && pending.some((p) => p.days_below_min) && <p className="mt-2 px-1 text-[12px] text-ink-3">Weeks with short days can’t be bulk approved — review them one at a time.</p>}
            </>
          )}

          {d.unlock_requests.length > 0 && (
            <>
              <SectionTitle className="mt-8">Unlock requests</SectionTitle>
              <div className="space-y-2.5">
                {d.unlock_requests.map((p) => (
                  <UnlockRequestCard key={p.week_id} p={p} maxDays={d.unlock_max_days} />
                ))}
              </div>
            </>
          )}

          <TeamTimesheets />

          {d.recent.length > 0 && (
            <>
              <SectionTitle className="mt-8">Decided in the last 2 weeks</SectionTitle>
              <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {d.recent.map((r) => (
                  <div key={r.week_id} className="flex items-center gap-3 px-4 py-2.5 xl:grid xl:grid-cols-[minmax(0,1fr)_200px_90px_150px_90px] xl:gap-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Avatar name={r.user.name} hue={r.user.avatar_hue} size={28} />
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-medium">{r.user.name}</div>
                        <div className="truncate text-[12.5px] text-ink-3 xl:hidden">
                          {weekLabel(r.week_start)} · {fmtNum(r.total, 1)}h
                        </div>
                      </div>
                    </div>
                    <span className="tnum hidden whitespace-nowrap text-[13px] text-ink-2 xl:block">{weekLabel(r.week_start)}</span>
                    <span className="tnum hidden whitespace-nowrap text-right text-[13px] text-ink-2 xl:block">{fmtNum(r.total, 1)}h</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'neutral'} size="sm">
                        {r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : r.status}
                      </Badge>
                      {r.late && <Badge tone="warning" size="sm">Late</Badge>}
                    </div>
                    <span className="hidden whitespace-nowrap text-right text-[12.5px] text-ink-3 xl:block">{relTime(r.decided_at)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  )
}

function Kpi({ value, label, tone }: { value: string; label: string; tone?: 'danger' }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className={cn('tnum text-[24px] font-semibold leading-tight', tone === 'danger' ? 'text-danger-text' : 'text-ink')}>{value}</div>
      <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{label}</div>
    </div>
  )
}

function DayHours({ p }: { p: ApprovalItem }) {
  const days = p.day_totals.filter((d) => !d.hidden)
  return (
    <div className="flex items-end gap-0.5" aria-label="Hours by day">
      {days.map((d) => {
        const off = d.kind === 'weekly_off' || d.kind === 'holiday'
        return (
          <div key={d.date} className="flex w-[34px] flex-col items-center" title={`${fmtDate(d.date, 'day')}: ${d.total}h${off ? ' (off)' : d.kind === 'leave' ? ' (leave)' : ''}`}>
            <span className={cn('text-[11px]', d.below_min ? 'font-semibold text-ink' : 'text-ink-3')}>{LETTER[parseISO(d.date).getDay()]}</span>
            <span className={cn('tnum whitespace-nowrap text-[13px]', d.below_min ? 'font-semibold text-danger-text' : off ? 'text-ink-3' : 'text-ink')}>{fmtNum(d.total, 1)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Approve / reason / reject — shared by the desktop table and phone cards. */
function useDecide(p: ApprovalItem) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const approve = useMut(() => workApi.approve(p.week_id), { invalidate: INV, success: `Approved ${p.user.name}’s timesheet` })
  const reject = useMut(() => workApi.reject(p.week_id, reason.trim()), {
    invalidate: INV,
    success: 'Timesheet sent back to fix',
    silentError: true,
    onError: (e: ApiError) => setErr(e.message),
  })
  const doReject = () => {
    if (reason.trim().length < 5) return setErr('Give a reason of at least 5 characters so they know what to fix.')
    setErr(null)
    reject.mutate(undefined)
  }
  return { reason, setReason: (v: string) => (setReason(v), setErr(null)), err, approve, reject, doReject, busy: approve.isPending || reject.isPending }
}

function DecideControls({ p, stacked }: { p: ApprovalItem; stacked?: boolean }) {
  const dc = useDecide(p)
  return (
    <div className={cn('min-w-0', stacked ? 'space-y-2' : '')}>
      <div className={cn('flex gap-2', stacked ? 'flex-col min-[420px]:flex-row' : 'items-center')}>
        <Button size="sm" variant="primary" onClick={() => dc.approve.mutate(undefined)} loading={dc.approve.isPending} disabled={dc.busy} className={stacked ? 'min-[420px]:order-last' : undefined}>
          Approve
        </Button>
        <Input
          value={dc.reason}
          onChange={(e) => dc.setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dc.doReject()}
          placeholder="Reason to reject"
          aria-label={`Reason to reject ${p.user.name}’s week`}
          invalid={!!dc.err}
          className={cn('h-9 min-w-0 text-[13px]', stacked ? 'flex-1' : 'shrink-0 px-2.5')}
          style={stacked ? undefined : { width: 128, fontSize: 12.5 }}
        />
        <Button size="sm" variant="secondary" onClick={dc.doReject} loading={dc.reject.isPending} disabled={dc.busy}>
          Reject
        </Button>
      </div>
      {dc.err && <p className="mt-1 text-[12px] text-danger-text">{dc.err}</p>}
    </div>
  )
}

function DueBy({ p }: { p: ApprovalItem }) {
  return p.overdue ? (
    <div className="whitespace-nowrap font-semibold text-danger-text">
      <div className="tnum">{dm(p.sla_due)}</div>
      <div>Overdue</div>
    </div>
  ) : (
    <div className="tnum whitespace-nowrap text-ink">{dm(p.sla_due)}</div>
  )
}

/* ---------------- desktop: waiting list with expandable week (master–detail) ---------------- */
function WaitingTable({ pending, bulk, sel, setSel }: { pending: ApprovalItem[]; bulk: boolean; sel: string[]; setSel: (fn: (s: string[]) => string[]) => void }) {
  const ro = useReadOnly()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="hidden overflow-hidden rounded-lg border border-line bg-surface lg:block">
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[940px] border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
              {bulk && <th className="w-10 py-2.5 pl-4" />}
              <th className="py-2.5 pl-4 pr-3">Person</th>
              <th className="px-3 py-2.5">Week</th>
              <th className="px-3 py-2.5">Hours by day</th>
              <th className="px-3 py-2.5 text-right">Total</th>
              <th className="px-3 py-2.5">Due by</th>
              <th className="py-2.5 pl-3 pr-4" aria-label={ro ? undefined : 'Decision'} />
            </tr>
          </thead>
          <tbody>
            {pending.map((p) => (
              <Fragment key={p.week_id}>
                <tr className={cn('border-b border-line align-middle', open === p.week_id && 'bg-surface-2/50')}>
                  {bulk && (
                    <td className="py-3 pl-4">
                      <div className={cn(p.days_below_min && 'pointer-events-none opacity-40')} title={p.days_below_min ? 'Has short days — review it on its own' : undefined}>
                        <Checkbox checked={sel.includes(p.week_id)} disabled={!!p.days_below_min} onChange={(v) => setSel((s) => (v ? [...s, p.week_id] : s.filter((x) => x !== p.week_id)))} />
                      </div>
                    </td>
                  )}
                  <td className="py-3 pl-4 pr-3">
                    <button type="button" onClick={() => setOpen(open === p.week_id ? null : p.week_id)} aria-expanded={open === p.week_id} className="group flex min-w-0 items-start gap-1.5 text-left">
                      <ChevronDown className={cn('mt-0.5 size-4 shrink-0 text-ink-3 transition-transform', open === p.week_id && 'rotate-180')} />
                      <span className="min-w-0 max-w-[180px]">
                        <span className="block truncate font-semibold text-ink group-hover:underline">{p.user.name}</span>
                        <span className="block whitespace-nowrap text-[12.5px] text-ink-3">
                          Submitted {dm(p.submitted_at)}
                          {p.via_delegation ? ' · delegated' : ''}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="tnum whitespace-nowrap px-3 py-3 text-ink">{range(p.week_start)}</td>
                  <td className="px-3 py-3">
                    <DayHours p={p} />
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="tnum whitespace-nowrap font-semibold">{fmtNum(p.total, 1)}h</div>
                    <div className={cn('whitespace-nowrap text-[12.5px]', p.days_below_min ? 'text-ink-2' : 'text-ink-3')}>{p.days_below_min ? `${p.days_below_min} short day${p.days_below_min > 1 ? 's' : ''}` : 'No short days'}</div>
                  </td>
                  <td className="px-3 py-3">
                    <DueBy p={p} />
                  </td>
                  <td className="py-3 pl-3 pr-4">{!ro && <DecideControls p={p} />}</td>
                </tr>
                {open === p.week_id && (
                  <tr className="border-b border-line">
                    <td colSpan={bulk ? 7 : 6} className="bg-surface-2/40 p-3">
                      <WeekDetail userId={p.user.id} week={p.week_start} compact />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- phones & tablets ---------------- */
function PendingCard({ p, selectable, selected, onSelect }: { p: ApprovalItem; selectable: boolean; selected: boolean; onSelect: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const ro = useReadOnly()
  return (
    <Card pad={false} className={cn('overflow-hidden transition', selected && 'border-brand')}>
      <div className="space-y-3 p-3.5">
        <div className="flex min-w-0 items-start gap-3">
          {selectable && (
            <div className={cn('pt-0.5', p.days_below_min && 'pointer-events-none opacity-40')}>
              <Checkbox checked={selected} onChange={onSelect} disabled={!!p.days_below_min} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">{p.user.name}</div>
            <div className="truncate text-[12.5px] text-ink-3">
              Submitted {dm(p.submitted_at)} · {range(p.week_start)}
            </div>
          </div>
          <div className="shrink-0 text-right text-[12.5px]">
            <div className="text-ink-3">Due by</div>
            <DueBy p={p} />
          </div>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 overflow-x-auto no-scrollbar">
            <DayHours p={p} />
          </div>
          <div className="shrink-0 text-right">
            <div className="tnum whitespace-nowrap text-[16px] font-semibold leading-tight">{fmtNum(p.total, 1)}h</div>
            <div className="whitespace-nowrap text-[12px] text-ink-3">{p.days_below_min ? `${p.days_below_min} short day${p.days_below_min > 1 ? 's' : ''}` : 'No short days'}</div>
          </div>
        </div>
        {!ro && <DecideControls p={p} stacked />}
      </div>
      <div className="border-t border-line px-3.5 py-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="-ml-1.5 inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[13px] font-medium text-ink-2 hover:text-ink">
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
          {open ? 'Hide week' : 'View week'}
        </button>
      </div>
      {open && (
        <div className="border-t border-line p-3">
          <WeekDetail userId={p.user.id} week={p.week_start} />
        </div>
      )}
    </Card>
  )
}

export function WeekDetail({ userId, week, compact }: { userId: string; week: string; compact?: boolean }) {
  const q = useApi(['timesheet', week, 'user', userId], () => workApi.week(week, userId))
  if (q.isLoading) return <SkeletonRows rows={3} className={compact ? 'p-4' : undefined} />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return <WeekReadOnly view={q.data} compact={compact} />
}

/* ---------------- unlock (request or manager's own initiative) ---------------- */
type UnlockTarget = { userName: string; weekStart: string; weekId: string | null; userId: string; request: string | null }
function UnlockDialog({ t, maxDays, onClose }: { t: UnlockTarget; maxDays: number; onClose: () => void }) {
  const [days, setDays] = useState(Math.min(2, maxDays))
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const m = useMut(() => (t.weekId ? timeApi.unlock(t.weekId, days, reason.trim()) : timeApi.unlockMissing(t.userId, t.weekStart, days, reason.trim())), {
    invalidate: [...INV, ['approvals', 'team']],
    success: (r) => `Week unlocked for ${t.userName} until ${fmtDate(r.unlock_until)}`,
    silentError: true,
    onError: (e: ApiError) => setErr(e.message),
    onSuccess: onClose,
  })
  const go = () => {
    if (!t.request && reason.trim().length < 5) return setErr('Say why you are reopening this week (at least 5 characters). They’ll see it.')
    setErr(null)
    m.mutate(undefined)
  }
  const opts = Array.from({ length: maxDays }, (_, i) => i + 1)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Unlock ${t.userName.split(' ')[0]}’s week`}
      description={`${weekLabel(t.weekStart)}. They can edit and submit it until the window closes, then it locks again.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={go}>
            Unlock for {days} day{days > 1 ? 's' : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {t.request && <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">Their request: “{t.request}”</div>}
        <Field label="Unlock for" hint={`Open until the end of ${fmtDate(addDays(todayISO(), days - 1), 'long')}. Up to ${maxDays} days.`}>
          {maxDays <= 7 ? (
            <Segmented block value={String(days)} onChange={(v) => setDays(Number(v))} options={opts.map((n) => ({ value: String(n), label: `${n}d` }))} />
          ) : (
            <input type="range" min={1} max={maxDays} value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-full accent-[var(--brand)]" aria-label="Days" />
          )}
        </Field>
        <Field label="Reason" required={!t.request} error={err} htmlFor="unlock-reason" hint={t.request ? 'Optional — they asked for it.' : 'Required: you are reopening it without a request.'}>
          <Textarea id="unlock-reason" rows={2} value={reason} invalid={!!err} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client visit Friday–Saturday; log the payroll engine hours." />
        </Field>
      </div>
    </Dialog>
  )
}

function UnlockRequestCard({ p, maxDays }: { p: ApprovalItem; maxDays: number }) {
  const ro = useReadOnly()
  const [open, setOpen] = useState(false)
  const { askReason } = useConfirm()
  const deny = useMut((reason: string) => workApi.denyUnlock(p.week_id, reason), { invalidate: INV, success: 'Unlock request declined' })
  const doDeny = async () => {
    const r = await askReason({ title: 'Decline unlock request', label: 'Reason', placeholder: 'e.g. Log these hours next week against the same task.', confirmLabel: 'Decline', minLength: 5, tone: 'danger' })
    if (r) deny.mutate(r)
  }
  return (
    <Card className="md:flex md:items-start md:gap-6">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Avatar name={p.user.name} hue={p.user.avatar_hue} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px] font-semibold">{p.user.name}</span>
            <span className="text-[12.5px] text-ink-3">{weekLabel(p.week_start)} · locked</span>
          </div>
          <p className="mt-1 text-[13.5px] leading-snug text-ink-2">“{p.unlock_reason}”</p>
          <p className="mt-1 text-[12.5px] text-ink-3">Requested {p.unlock_requested_at ? fmtDateTime(p.unlock_requested_at) : ''}</p>
        </div>
      </div>
      {!ro && (
        <div className="mt-3 flex shrink-0 justify-end gap-2 md:mt-0">
          <Button size="sm" variant="secondary" onClick={doDeny} loading={deny.isPending}>
            Decline
          </Button>
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Unlock week
          </Button>
        </div>
      )}
      {open && <UnlockDialog t={{ userName: p.user.name, userId: p.user.id, weekStart: p.week_start, weekId: p.week_id, request: p.unlock_reason }} maxDays={maxDays} onClose={() => setOpen(false)} />}
    </Card>
  )
}

/* ---------------- My team's timesheets (4 weeks, coloured by status) ---------------- */
const CHIP: Record<ApprovalTeamView['people'][number]['cells'][number]['status'], { label: string; cls: string }> = {
  approved: { label: 'Approved', cls: 'bg-success-soft text-success-text' },
  submitted: { label: 'Submitted', cls: 'bg-warning-soft text-warning-text' },
  locked: { label: 'Locked', cls: 'bg-danger-soft text-danger-text' },
  open: { label: 'Draft', cls: 'bg-surface-2 text-ink-2' },
  rejected: { label: 'Rejected', cls: 'bg-danger-soft text-danger-text' },
  upcoming: { label: 'Not started', cls: 'bg-surface-2 text-ink-3' },
}
function Chip({ status }: { status: keyof typeof CHIP }) {
  return <span className={cn('inline-flex h-6 items-center whitespace-nowrap rounded px-2 text-[12px] font-semibold', CHIP[status].cls)}>{CHIP[status].label}</span>
}

function TeamTimesheets() {
  const q = useApi(['approvals', 'team'], () => timeApi.approvalTeam(4))
  const ro = useReadOnly()
  const [target, setTarget] = useState<UnlockTarget | null>(null)
  const d = q.data
  if (q.isLoading) return <SkeletonRows rows={4} className="mt-8" />
  if (q.error || !d) return <ErrorState className="mt-8" error={q.error} onRetry={() => q.refetch()} />
  if (!d.people.length) return null
  const unlockBtn = (p: ApprovalTeamView['people'][number], c: ApprovalTeamView['people'][number]['cells'][number]) =>
    c.can_unlock && !ro ? (
      <Button size="sm" variant="secondary" onClick={() => setTarget({ userName: p.user.name, userId: p.user.id, weekStart: c.week_start, weekId: c.week_id, request: c.unlock_reason })}>
        Unlock
      </Button>
    ) : null
  return (
    <>
      <SectionTitle className="mt-8">My team’s timesheets</SectionTitle>
      {/* desktop / tablet */}
      <div className="hidden overflow-hidden rounded-lg border border-line bg-surface md:block">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                <th className="py-2.5 pl-4 pr-3">Person</th>
                {d.weeks.map((w) => (
                  <th key={w} className="whitespace-nowrap px-3 py-2.5">
                    {dm(w)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.user.id} className="border-b border-line last:border-0">
                  <td className="py-2.5 pl-4 pr-3">
                    <div className="truncate text-ink">{p.user.name}</div>
                    {(p.via_delegation || p.approver_name) && <div className="truncate text-[12px] text-ink-3">{p.via_delegation ? `Covering for ${p.approver_name}` : `Approver ${p.approver_name}`}</div>}
                  </td>
                  {p.cells.map((c) => (
                    <td key={c.week_start} className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip status={c.status} />
                        {c.unlock_requested && <span className="text-[12px] text-ink-3">asked to unlock</span>}
                        {c.unlocked_until && <span className="whitespace-nowrap text-[12px] text-ink-3">open to {dm(c.unlocked_until)}</span>}
                        {unlockBtn(p, c)}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* phones */}
      <div className="space-y-2.5 md:hidden">
        {d.people.map((p) => (
          <Card key={p.user.id} pad={false} className="p-3.5">
            <div className="truncate text-[14px] font-semibold">{p.user.name}</div>
            <div className="mt-2 divide-y divide-line">
              {p.cells.map((c) => (
                <div key={c.week_start} className="flex min-h-[44px] items-center gap-2 py-1.5">
                  <span className="tnum w-[64px] shrink-0 text-[13px] text-ink-3">{dm(c.week_start)}</span>
                  <Chip status={c.status} />
                  <span className="ml-auto">{unlockBtn(p, c)}</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <p className="mt-2 px-1 text-[12px] text-ink-3">A week that ends without being submitted locks. Unlock reopens it for the person for a set number of days.</p>
      {target && <UnlockDialog t={target} maxDays={d.unlock_max_days} onClose={() => setTarget(null)} />}
    </>
  )
}
