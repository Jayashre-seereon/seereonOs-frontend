import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Palmtree, Pencil, Trash2 } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { workApi, type LeaveRow, type LeaveSummary, type LeaveView } from '@/api/work'
import { hrApi, LEAVE_INVALIDATE, type LeaveBalance, type LeaveRequestView } from '@/api/hr'
import { http, type ApiError } from '@/api/http'
import { useTenant } from '@/api/core'
import { addDays, addMonths, fmtDate, isWeeklyOff, monthOf, monthRange, parseISO, todayISO, weekStart } from '@/domain/calendar'
import { LEAVE_TYPE, WEEK_STATUS } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import type { LeaveType, Tenant } from '@/types/entities'
import type { LeavePolicy } from '@/types/business'
import {
  Avatar, Badge, Button, Callout, Card, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, FilterChips, IconButton, Input, PageHeader, PeoplePicker, Progress, Segmented, Select, Skeleton,
  StatusBadge, Tabs, Textarea, Tooltip, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { LEAVE_REQ_STATUS } from '@/modules/hr/components'

const TYPES = Object.keys(LEAVE_TYPE) as LeaveType[]
const TYPE_TONE: Record<LeaveType, string> = { casual: 'bg-info', sick: 'bg-warning', earned: 'bg-success', compensatory: 'bg-accent', lwp: 'bg-danger', optional_holiday: 'bg-brand' }
type Scope = LeaveView['scope']
type Tab = 'mine' | 'approve' | 'team' | 'records' | 'taken' | 'hr' | 'policy'

const range = (r: { from_on: string; to_on: string }) => (r.from_on === r.to_on ? fmtDate(r.from_on) : `${fmtDate(r.from_on)} – ${fmtDate(r.to_on)}`)
const dayLabel = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** /leave — balances, apply with approval, approve your team's requests, team calendar, records and policy. */
export default function LeavePage() {
  const me = useSession((s) => s.user)
  const ro = useReadOnly()
  // ?tab=hr opens "Record leave" directly (Team & settings › Leave links here)
  const [params] = useSearchParams()
  const initial = params.get('tab') as Tab | null
  const [tab, setTab] = useState<Tab>(initial && ['mine', 'approve', 'team', 'records', 'taken', 'hr', 'policy'].includes(initial) ? initial : 'mine')
  const [month, setMonth] = useState(monthOf(todayISO()))
  const [applying, setApplying] = useState<LeaveType | null>(null)
  const [entering, setEntering] = useState(false)
  const q = useApi(['leave-requests'], hrApi.leaveRequests)
  const d = q.data
  const leaveQ = useApi(['leave', 'calendar'], () => workApi.leave({ scope: 'all' }))
  const canEnter = !!leaveQ.data?.can_hr_entry

  const tabs = [
    { value: 'mine' as Tab, label: 'My requests', count: d?.mine.length },
    { value: 'approve' as Tab, label: 'To approve', count: d?.to_approve.length, hidden: !d?.is_approver },
    { value: 'team' as Tab, label: 'Team requests', hidden: !d?.team.length },
    { value: 'records' as Tab, label: 'Leave records' },
    { value: 'taken' as Tab, label: 'Taken this year', hidden: !(leaveQ.data?.can_see_all || d?.is_approver) },
    { value: 'hr' as Tab, label: 'Record leave', hidden: !canEnter },
    { value: 'policy' as Tab, label: 'Policy' },
  ]

  return (
    <div>
      <PageHeader
        title="Leave"
        subtitle={d ? `Balances for ${d.fy_label}. Requests go to your manager; approved days appear in your timesheet.` : 'Apply for leave and track approvals.'}
        actions={
          !ro && (
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              {canEnter && <Button onClick={() => setEntering(true)}>Enter leave for someone</Button>}
              <Button variant="primary" onClick={() => setApplying('casual')}>Apply for leave</Button>
            </div>
          )
        }
      />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            {d ? d.balances.map((b) => <BalanceCard key={b.type} b={b} onApply={ro ? undefined : () => setApplying(b.type)} />) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[112px] rounded-lg" />)}
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              <Tabs value={tab} onChange={setTab} tabs={tabs} className="mb-4" />
              {tab === 'mine' && <MyRequests rows={d?.mine} loading={q.isLoading} onApply={() => setApplying('casual')} />}
              {tab === 'approve' && <ToApprove rows={d?.to_approve} loading={q.isLoading} />}
              {tab === 'team' && <TeamRequests rows={d?.team} loading={q.isLoading} />}
              {tab === 'records' && <Records />}
              {tab === 'taken' && <TakenThisYear />}
              {tab === 'hr' && (
                <>
                  <HrEntry />
                  <h2 className="mb-2 mt-6 text-[15px] font-semibold">Leave taken this financial year</h2>
                  <TakenThisYear />
                </>
              )}
              {tab === 'policy' && <Policy policies={d?.policies} canEdit={!!d?.can_manage_policy && !ro} loading={q.isLoading} />}
            </div>
            <div className="min-w-0">
              <MonthCalendar month={month} onMonth={setMonth} view={leaveQ.data} meId={me?.id} />
            </div>
          </div>
        </>
      )}
      {applying && d && <ApplyDialog open onOpenChange={(o) => !o && setApplying(null)} initialType={applying} balances={d.balances} />}
      {entering && <AddLeaveDialog open={entering} onOpenChange={setEntering} hr />}
    </div>
  )
}

function BalanceCard({ b, onApply }: { b: LeaveBalance; onApply?: () => void }) {
  const usedPct = b.accrued ? (b.used + b.pending) / b.accrued : 0
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium text-ink-3">
          <span className={cn('size-2 shrink-0 rounded-sm', TYPE_TONE[b.type])} />
          <span className="truncate">{LEAVE_TYPE[b.type]}</span>
        </span>
        {onApply && b.remaining > 0 && (
          <button type="button" onClick={onApply} className="hidden shrink-0 text-[12px] font-medium text-brand-text hover:underline sm:inline">
            Apply
          </button>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={cn('tnum whitespace-nowrap text-[22px] font-semibold leading-none', b.remaining <= 0 ? 'text-danger-text' : 'text-ink')}>{b.remaining}</span>
        <span className="text-[12.5px] text-ink-3">left</span>
      </div>
      <Progress value={Math.min(1, usedPct)} tone={usedPct > 0.9 ? 'warning' : 'brand'} className="mt-3" height={5} />
      <div className="mt-2 text-[12px] leading-snug text-ink-3">
        <span className="tnum">{b.used}</span> used{b.pending ? <> · <span className="tnum">{b.pending}</span> pending</> : null} · <span className="tnum">{b.accrued}</span> {b.accrual === 'monthly' ? 'accrued' : 'for the year'}
      </div>
    </div>
  )
}

function useCancel() {
  const { confirm } = useConfirm()
  const m = useMut((id: string) => hrApi.cancelLeave(id), { invalidate: LEAVE_INVALIDATE, success: 'Request cancelled' })
  return async (r: LeaveRequestView) => {
    const ok = await confirm({
      title: 'Cancel this leave request?',
      body: r.status === 'approved' ? `Your approved ${LEAVE_TYPE[r.type].toLowerCase()} leave (${range(r)}) is removed from the calendar and your timesheet, and the days return to your balance.` : `${LEAVE_TYPE[r.type]} leave, ${range(r)}. Your manager is told.`,
      confirmLabel: 'Cancel request',
      cancelLabel: 'Keep it',
      tone: 'danger',
    })
    if (ok) m.mutate(r.id)
  }
}

function MyRequests({ rows, loading, onApply }: { rows?: LeaveRequestView[]; loading: boolean; onApply: () => void }) {
  const ro = useReadOnly()
  const cancel = useCancel()
  const cols: Column<LeaveRequestView>[] = [
    { key: 'dates', header: 'Dates', sortValue: (r) => r.from_on, cell: (r) => <span className="tnum whitespace-nowrap font-medium">{range(r)}</span> },
    { key: 'type', header: 'Type', cell: (r) => <TypeLabel t={r.type} half={r.portion === 'half'} /> },
    { key: 'days', header: 'Days', align: 'right', sortValue: (r) => r.days, cell: (r) => <span className="tnum">{r.days}</span> },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge size="sm" map={LEAVE_REQ_STATUS} value={r.status} /> },
    {
      key: 'note', header: 'Reason / decision', hideBelow: 'lg',
      cell: (r) => (
        <div className="min-w-0 max-w-[340px]">
          <div className="truncate text-ink-2">{r.reason}</div>
          <div className="truncate text-[12px] text-ink-3">{r.status === 'pending' ? `Waiting for ${r.approver_name ?? 'approval'}${stepOf(r) ? ` · ${stepOf(r)!.split(' · ')[0].toLowerCase()}` : ''}` : r.status === 'rejected' ? `${r.decision_reason ?? ''}` : r.status === 'approved' ? `Approved${r.approver_name ? ` by ${r.approver_name}` : ''}` : 'Cancelled by you'}</div>
        </div>
      ),
    },
    { key: 'act', header: '', align: 'right', width: '110px', cell: (r) => (r.can_cancel && !ro ? <Button size="xs" variant="ghost" onClick={() => cancel(r)}>Cancel</Button> : null) },
  ]
  return (
    <DataTable
      rows={rows}
      columns={cols}
      rowKey={(r) => r.id}
      loading={loading}
      initialSort={{ key: 'dates', dir: 'desc' }}
      empty={<EmptyState compact icon={<Palmtree />} title="No leave requests yet" body="Apply for leave and your manager gets a request to approve." action={!ro && <Button size="sm" onClick={onApply}>Apply for leave</Button>} />}
      mobileCard={(r) => (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="tnum text-[14px] font-medium">{range(r)}</div>
              <div className="mt-0.5 text-[12.5px] text-ink-3">{LEAVE_TYPE[r.type]} · {r.portion === 'half' ? 'half day' : dayLabel(r.days)}</div>
            </div>
            <StatusBadge size="sm" map={LEAVE_REQ_STATUS} value={r.status} />
          </div>
          <p className="text-[13px] text-ink-2">{r.status === 'rejected' && r.decision_reason ? `Rejected: ${r.decision_reason}` : r.reason}</p>
          {r.can_cancel && !ro && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => cancel(r)}>Cancel request</Button>
            </div>
          )}
        </div>
      )}
    />
  )
}

function TypeLabel({ t, half }: { t: LeaveType; half?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={cn('size-2 rounded-sm', TYPE_TONE[t])} />
      {LEAVE_TYPE[t]}
      {half && <span className="text-ink-3">· half</span>}
    </span>
  )
}

function ToApprove({ rows, loading }: { rows?: LeaveRequestView[]; loading: boolean }) {
  const ro = useReadOnly()
  const { askReason } = useConfirm()
  const approve = useMut((id: string) => hrApi.approveLeave(id), { invalidate: LEAVE_INVALIDATE, success: 'Leave approved' })
  const reject = useMut((v: { id: string; reason: string }) => hrApi.rejectLeave(v.id, v.reason), { invalidate: LEAVE_INVALIDATE, success: 'Leave rejected' })
  const doReject = async (r: LeaveRequestView) => {
    const reason = await askReason({ title: `Reject ${r.user_name}’s leave?`, body: `${LEAVE_TYPE[r.type]}, ${range(r)} (${dayLabel(r.days)}). They will see your reason.`, label: 'Reason', placeholder: 'e.g. Release week — can you move it by a few days?', confirmLabel: 'Reject leave', minLength: 5, tone: 'danger' })
    if (reason) reject.mutate({ id: r.id, reason })
  }
  if (loading) return <Skeleton className="h-40 rounded-lg" />
  if (!rows?.length)
    return (
      <Card pad={false}>
        <EmptyState icon={<Palmtree />} title="No leave waiting for you" body="When someone who reports to you applies, the request shows up here." />
      </Card>
    )
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.id} className="rounded-lg border border-line bg-surface p-3.5 md:px-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Avatar name={r.user_name} hue={r.user_hue} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[14px] font-medium">{r.user_name}</span>
                  <Badge size="sm">{LEAVE_TYPE[r.type]}</Badge>
                  {r.via_delegation && <Badge size="sm" tone="info">Delegated to you</Badge>}
                  {stepOf(r) && <Badge size="sm" tone="accent">{stepOf(r)!.split(' · ')[0]}</Badge>}
                </div>
                <div className="tnum mt-0.5 text-[13px] text-ink-2">
                  {range(r)} · {r.portion === 'half' ? 'half day' : dayLabel(r.days)}
                </div>
                <p className="mt-1 text-[13px] text-ink-3">“{r.reason}”</p>
              </div>
            </div>
            {!ro && r.can_approve && (
              <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
                <Button variant="outline-danger" size="sm" onClick={() => doReject(r)} loading={reject.isPending && reject.variables?.id === r.id}>Reject</Button>
                <Button variant="primary" size="sm" onClick={() => approve.mutate(r.id)} loading={approve.isPending && approve.variables === r.id}>Approve</Button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

function TeamRequests({ rows, loading }: { rows?: LeaveRequestView[]; loading: boolean }) {
  const [f, setF] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all')
  const list = (rows ?? []).filter((r) => f === 'all' || r.status === f)
  const cols: Column<LeaveRequestView>[] = [
    { key: 'who', header: 'Person', sortValue: (r) => r.user_name, cell: (r) => <span className="flex min-w-0 items-center gap-2"><Avatar name={r.user_name} hue={r.user_hue} size={24} /><span className="truncate font-medium">{r.user_name}</span></span> },
    { key: 'dates', header: 'Dates', sortValue: (r) => r.from_on, cell: (r) => <span className="tnum whitespace-nowrap">{range(r)}</span> },
    { key: 'type', header: 'Type', cell: (r) => <TypeLabel t={r.type} half={r.portion === 'half'} />, hideBelow: 'lg' },
    { key: 'days', header: 'Days', align: 'right', sortValue: (r) => r.days, cell: (r) => <span className="tnum">{r.days}</span> },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge size="sm" map={LEAVE_REQ_STATUS} value={r.status} /> },
    { key: 'by', header: 'Approver', cell: (r) => <span className="text-ink-2">{r.approver_name ?? '—'}</span>, hideBelow: 'xl' },
  ]
  return (
    <div>
      <FilterChips className="mb-3" value={f} onChange={setF} options={[{ value: 'all', label: 'All' }, { value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
      <DataTable
        rows={list}
        columns={cols}
        rowKey={(r) => r.id}
        loading={loading}
        initialSort={{ key: 'dates', dir: 'desc' }}
        empty={<EmptyState compact title="No requests match" />}
        mobileCard={(r) => (
          <div className="flex items-start gap-3">
            <Avatar name={r.user_name} hue={r.user_hue} size={30} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-[14px] font-medium">{r.user_name}</span>
                <StatusBadge size="sm" map={LEAVE_REQ_STATUS} value={r.status} />
              </div>
              <div className="tnum text-[12.5px] text-ink-3">{range(r)} · {LEAVE_TYPE[r.type]} · {dayLabel(r.days)}</div>
            </div>
          </div>
        )}
      />
    </div>
  )
}

function Records() {
  const me = useSession((s) => s.user)
  const ro = useReadOnly()
  const [scope, setScope] = useState<Scope>('mine')
  const q = useApi(['leave', scope], () => workApi.leave({ scope }))
  const d = q.data
  const effectiveScope = d?.scope ?? scope
  const { confirm } = useConfirm()
  const del = useMut((id: string) => workApi.deleteLeave(id), { invalidate: [['leave'], ['timesheet'], ['daily'], ['leave-requests']], success: 'Leave removed' })
  const doDelete = async (l: LeaveRow) => {
    if (await confirm({ title: 'Remove this leave?', body: `${LEAVE_TYPE[l.type]} (${l.portion === 'half' ? 'half day' : 'full day'}) on ${fmtDate(l.date, 'long')}${l.user_id !== me?.id ? ` for ${l.user_name}` : ''}. The leave row in that week’s timesheet is removed too.`, confirmLabel: 'Remove', tone: 'danger' })) del.mutate(l.id)
  }
  const cols: Column<LeaveRow>[] = [
    ...(effectiveScope !== 'mine' ? [{ key: 'who', header: 'Person', cell: (l: LeaveRow) => <span className="font-medium">{l.user_name}</span>, sortValue: (l: LeaveRow) => l.user_name } as Column<LeaveRow>] : []),
    { key: 'date', header: 'Date', cell: (l) => <span className="tnum whitespace-nowrap">{fmtDate(l.date, 'long')}</span>, sortValue: (l) => l.date },
    { key: 'type', header: 'Type', cell: (l) => <TypeLabel t={l.type} />, sortValue: (l) => l.type },
    { key: 'portion', header: 'Portion', cell: (l) => (l.portion === 'half' ? 'Half day' : 'Full day'), hideBelow: 'lg' },
    { key: 'source', header: 'Source', cell: (l) => <span className="text-ink-2">{l.source === 'hr' ? 'Approved / HR' : 'Timesheet'}</span>, hideBelow: 'xl' },
    { key: 'week', header: 'Week', cell: (l) => (l.week_status ? <StatusBadge map={WEEK_STATUS} value={l.week_status} size="sm" /> : <span className="text-ink-3">—</span>), hideBelow: 'lg' },
    {
      key: 'act', header: '', align: 'right', width: '56px',
      cell: (l) => (l.can_delete && !ro ? <IconButton label="Remove leave" size="sm" onClick={(e) => { e.stopPropagation(); doDelete(l) }}><Trash2 className="size-4" /></IconButton> : null),
    },
  ]
  return (
    <div>
      <FilterChips
        className="mb-3"
        value={effectiveScope}
        onChange={setScope}
        options={[{ value: 'mine', label: 'Mine' }, { value: 'team', label: 'My team' }, ...(d?.can_see_all ?? d?.can_hr_entry ? [{ value: 'all' as Scope, label: 'Everyone' }] : [])]}
      />
      <DataTable
        rows={d?.items}
        columns={cols}
        rowKey={(l) => l.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        initialSort={{ key: 'date', dir: 'desc' }}
        empty={<EmptyState compact title="No leave recorded" body="Approved requests and leave logged in timesheets appear here." />}
        mobileCard={(l) => (
          <div className="flex items-center gap-3">
            <div className="w-14 shrink-0">
              <div className="tnum whitespace-nowrap text-[13.5px] font-medium">{fmtDate(l.date)}</div>
              <div className="text-[12px] text-ink-3">{parseISO(l.date).toLocaleDateString('en-IN', { weekday: 'short' })}</div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 text-[14px] font-medium">
                <span className={cn('size-2 shrink-0 rounded-sm', TYPE_TONE[l.type])} />
                <span className="truncate">{effectiveScope !== 'mine' ? `${l.user_name} · ` : ''}{LEAVE_TYPE[l.type]}</span>
              </div>
              <div className="truncate text-[12.5px] text-ink-3">{l.portion === 'half' ? 'Half day' : 'Full day'} · {l.source === 'hr' ? 'approved / HR' : 'from timesheet'}</div>
            </div>
            {l.can_delete && !ro && (
              <IconButton label="Remove leave" onClick={(e) => { e.stopPropagation(); doDelete(l) }}>
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </div>
        )}
      />
    </div>
  )
}

function Policy({ policies, canEdit, loading }: { policies?: LeavePolicy[]; canEdit: boolean; loading: boolean }) {
  const [edit, setEdit] = useState<LeavePolicy | null>(null)
  const cols: Column<LeavePolicy>[] = [
    { key: 'type', header: 'Leave type', cell: (p) => <TypeLabel t={p.type} /> },
    { key: 'annual', header: 'Days a year', align: 'right', cell: (p) => <span className="tnum">{p.annual_days}</span> },
    { key: 'accrual', header: 'Credited', cell: (p) => (p.accrual === 'monthly' ? 'Monthly (1/12 each month)' : 'At the start of the year') },
    { key: 'carry', header: 'Carry forward', align: 'right', cell: (p) => <span className="tnum">{p.carry_forward_max ? `up to ${p.carry_forward_max}` : 'None'}</span> },
    { key: 'act', header: '', align: 'right', width: '56px', cell: (p) => (canEdit ? <IconButton label={`Edit ${LEAVE_TYPE[p.type]} policy`} size="sm" onClick={() => setEdit(p)}><Pencil className="size-4" /></IconButton> : null) },
  ]
  return (
    <div className="space-y-3">
      <DataTable
        rows={policies}
        columns={cols}
        rowKey={(p) => p.id}
        loading={loading}
        mobileCard={(p) => (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <TypeLabel t={p.type} />
              <div className="mt-0.5 text-[12.5px] text-ink-3">
                <span className="tnum">{p.annual_days}</span> days · {p.accrual === 'monthly' ? 'monthly' : 'upfront'} · carry {p.carry_forward_max ? `up to ${p.carry_forward_max}` : 'none'}
              </div>
            </div>
            {canEdit && <IconButton label={`Edit ${LEAVE_TYPE[p.type]} policy`} onClick={() => setEdit(p)}><Pencil className="size-4" /></IconButton>}
          </div>
        )}
      />
      <p className="px-1 text-[12.5px] text-ink-3">Leave without pay has no balance; it is deducted in payroll. People who join mid-year get a pro-rated share. Unused days carry into the next year up to the limit.</p>
      {edit && <PolicyDialog p={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function PolicyDialog({ p, onClose }: { p: LeavePolicy; onClose: () => void }) {
  const [annual, setAnnual] = useState(String(p.annual_days))
  const [carry, setCarry] = useState(String(p.carry_forward_max))
  const [accrual, setAccrual] = useState<LeavePolicy['accrual']>(p.accrual)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const save = useMut(() => hrApi.savePolicy(p.type, { annual_days: Number(annual), carry_forward_max: Number(carry), accrual }, p.version), {
    invalidate: [['leave-requests']], success: 'Policy saved', silentError: true, onSuccess: onClose,
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`${LEAVE_TYPE[p.type]} leave policy`}
      description="Changes apply to balances right away for everyone."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save policy</Button></>}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Days a year" error={errs.annual_days} required>
            <Input type="number" min={0} max={60} step={0.5} value={annual} invalid={!!errs.annual_days} onChange={(e) => setAnnual(e.target.value)} />
          </Field>
          <Field label="Carry forward (max)" error={errs.carry_forward_max}>
            <Input type="number" min={0} max={60} value={carry} invalid={!!errs.carry_forward_max} onChange={(e) => setCarry(e.target.value)} />
          </Field>
        </div>
        <Field label="Credited">
          <Segmented block value={accrual} onChange={setAccrual} options={[{ value: 'upfront', label: 'Start of year' }, { value: 'monthly', label: 'Monthly' }]} />
        </Field>
        {errs.form && <p className="text-[13px] text-danger-text">{errs.form}</p>}
      </div>
    </Dialog>
  )
}

function ApplyDialog({ open, onOpenChange, initialType, balances }: { open: boolean; onOpenChange: (o: boolean) => void; initialType: LeaveType; balances: LeaveBalance[] }) {
  const [type, setType] = useState<LeaveType>(initialType)
  const [portion, setPortion] = useState<'full' | 'half'>('full')
  const t0 = todayISO()
  const [from, setFrom] = useState(t0)
  const [to, setTo] = useState(t0)
  const [reason, setReason] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const bal = balances.find((b) => b.type === type)
  const save = useMut(() => hrApi.applyLeave({ from_on: from, to_on: portion === 'half' ? from : to, type, portion, reason }), {
    invalidate: LEAVE_INVALIDATE,
    success: (r) => (r.status === 'approved' ? 'Leave recorded' : 'Leave request sent to your manager'),
    silentError: true,
    onSuccess: () => onOpenChange(false),
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!from) e.from_on = 'Pick the first day.'
    if (portion === 'full' && to < from) e.to_on = 'The last day is before the first day.'
    if (reason.trim().length < 5) e.reason = 'Give a reason of at least 5 characters.'
    setErrs(e)
    if (!Object.keys(e).length) save.mutate(undefined)
  }
  const typeOpts = TYPES.map((t) => {
    const b = balances.find((x) => x.type === t)
    return { value: t, label: b ? `${LEAVE_TYPE[t]} — ${b.remaining} left` : LEAVE_TYPE[t] }
  })
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Apply for leave"
      description="Weekly offs and holidays inside the dates are not counted. Your manager approves the request."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={submit}>Send request</Button></>}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required error={errs.type}>
            <Select value={type} invalid={!!errs.type} onChange={(e) => setType(e.target.value as LeaveType)} options={typeOpts} />
          </Field>
          <Field label="Portion">
            <Segmented block value={portion} onChange={setPortion} options={[{ value: 'full', label: 'Full days' }, { value: 'half', label: 'Half day' }]} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={portion === 'half' ? 'Date' : 'From'} required error={errs.from_on}>
            <Input type="date" value={from} invalid={!!errs.from_on} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} />
          </Field>
          {portion === 'full' && (
            <Field label="To" required error={errs.to_on}>
              <Input type="date" value={to} min={from} invalid={!!errs.to_on} onChange={(e) => setTo(e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Reason" required error={errs.reason} hint="Your manager sees this.">
          <Textarea value={reason} invalid={!!errs.reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Family function in Cuttack" />
        </Field>
        {type === 'lwp' ? (
          <Callout tone="warning">Leave without pay is deducted in payroll (base ÷ working days, per day).</Callout>
        ) : bal ? (
          <p className="text-[12.5px] text-ink-3">
            <span className="tnum">{bal.remaining}</span> {LEAVE_TYPE[type].toLowerCase()} day{bal.remaining === 1 ? '' : 's'} left ({bal.used} used, {bal.pending} pending).
          </p>
        ) : null}
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

function MonthCalendar({ month, onMonth, view, meId }: { month: string; onMonth: (m: string) => void; view?: LeaveView; meId?: string }) {
  const tenant = useTenant()
  const settings = tenant.data?.settings as Tenant['settings'] | undefined
  const { from, to } = monthRange(month)
  const hol = useApi(['holidays-lite', month], () => workApi.holidays(from, to))
  const start = weekStart(from)
  const cells: string[] = []
  for (let d = start; d <= to || cells.length % 7; d = addDays(d, 1)) cells.push(d)
  const today = todayISO()
  const leaveBy = useMemo(() => {
    const m = new Map<string, LeaveRow[]>()
    for (const l of view?.items ?? []) m.set(l.date, [...(m.get(l.date) ?? []), l])
    return m
  }, [view])
  const holBy = new Map((hol.data ?? []).map((h) => [h.date, h]))
  const label = parseISO(from).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  const monthHol = (hol.data ?? []).filter((h) => h.date >= from && h.date <= to)
  return (
    <Card>
      <CardHeader
        title={label}
        action={
          <div className="flex items-center gap-1">
            <IconButton label="Previous month" size="sm" onClick={() => onMonth(monthOf(addMonths(from, -1)))}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <Button size="xs" variant="ghost" onClick={() => onMonth(monthOf(today))}>Today</Button>
            <IconButton label="Next month" size="sm" onClick={() => onMonth(monthOf(addMonths(from, 1)))}>
              <ChevronRight className="size-4" />
            </IconButton>
          </div>
        }
      />
      <div className="grid grid-cols-7 gap-1 text-center text-[12px] text-ink-3">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-1">{d.slice(0, 2)}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d) => {
          const inMonth = d >= from && d <= to
          const h = holBy.get(d)
          const off = settings ? isWeeklyOff(d, { settings, holidays: [] }) : parseISO(d).getDay() === 0
          const ls = leaveBy.get(d) ?? []
          const mine = ls.find((l) => l.user_id === meId)
          const others = ls.filter((l) => l.user_id !== meId)
          const tip = [h ? `Holiday: ${h.name}` : null, off ? 'Weekly off' : null, ...ls.map((l) => `${l.user_id === meId ? 'You' : l.user_name}: ${LEAVE_TYPE[l.type]}${l.portion === 'half' ? ' (half)' : ''}`)].filter(Boolean).join('\n')
          const cell = (
            <div
              className={cn(
                'relative flex h-10 flex-col items-center justify-center rounded-md text-[13px]',
                !inMonth && 'opacity-35',
                off || h ? 'bg-surface-2 text-ink-3' : 'bg-surface text-ink',
                h && 'bg-accent-soft text-accent-text',
                mine && cn('text-white', TYPE_TONE[mine.type]),
                d === today && 'ring-1 ring-inset ring-brand',
              )}
            >
              <span className={cn('tnum', mine?.portion === 'half' && 'underline decoration-2 underline-offset-2')}>{Number(d.slice(8))}</span>
              {others.length > 0 && (
                <span className="absolute bottom-1 flex gap-0.5">
                  {others.slice(0, 3).map((l) => <span key={l.id} className={cn('size-1.5 rounded-full', TYPE_TONE[l.type])} />)}
                </span>
              )}
            </div>
          )
          return tip ? <Tooltip key={d} content={<span className="whitespace-pre-line">{tip}</span>}>{cell}</Tooltip> : <div key={d}>{cell}</div>
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
        {TYPES.map((t) => (
          <span key={t} className="flex items-center gap-1.5"><span className={cn('size-2 rounded-sm', TYPE_TONE[t])} />{LEAVE_TYPE[t]}</span>
        ))}
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-accent-soft ring-1 ring-accent/30" />Holiday</span>
      </div>
      {monthHol.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-3 text-[13px]">
          {monthHol.map((h) => (
            <li key={h.date} className="flex items-center justify-between gap-3">
              <span className="truncate">{h.name}{h.optional && <span className="text-ink-3"> · optional</span>}</span>
              <span className="tnum shrink-0 whitespace-nowrap text-ink-3">{fmtDate(h.date, 'day')}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function AddLeaveDialog({ open, onOpenChange, hr }: { open: boolean; onOpenChange: (o: boolean) => void; hr: boolean }) {
  const me = useSession((s) => s.user)
  const [userId, setUserId] = useState<string | null>(me?.id ?? null)
  const [type, setType] = useState<LeaveType>('casual')
  const [portion, setPortion] = useState<'full' | 'half'>('full')
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [errs, setErrs] = useState<Record<string, string>>({})
  const save = useMut(() => workApi.addLeave({ user_id: hr && userId ? userId : undefined, from, to: portion === 'half' ? from : to, type, portion }), {
    invalidate: [['leave'], ['timesheet'], ['daily'], ['my-tasks']],
    success: (r) => `${r.created} leave day${r.created > 1 ? 's' : ''} recorded`,
    silentError: true,
    onSuccess: () => onOpenChange(false),
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!from) e.from = 'Pick the first day.'
    if (portion === 'full' && to < from) e.to = 'The end date is before the start date.'
    setErrs(e)
    if (!Object.keys(e).length) save.mutate(undefined)
  }
  const forOther = hr && userId && userId !== me?.id
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={hr ? 'Enter leave' : 'Add leave'}
      description="Weekly offs and holidays in the range are skipped. Leave can’t be added to a submitted, approved or locked week."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Record leave
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {hr && (
          <Field label="Person" hint={forOther ? 'Entered as HR — they can’t remove it themselves.' : undefined}>
            <PeoplePicker value={userId} onChange={setUserId} />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required>
            <Select value={type} onChange={(e) => setType(e.target.value as LeaveType)} options={TYPES.map((t) => ({ value: t, label: LEAVE_TYPE[t] }))} />
          </Field>
          <Field label="Portion">
            <Segmented block value={portion} onChange={setPortion} options={[{ value: 'full', label: 'Full day' }, { value: 'half', label: 'Half day' }]} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={portion === 'half' ? 'Date' : 'From'} required error={errs.from}>
            <Input type="date" value={from} invalid={!!errs.from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} />
          </Field>
          {portion === 'full' && (
            <Field label="To" error={errs.to}>
              <Input type="date" value={to} min={from} invalid={!!errs.to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          )}
        </div>
        {type === 'lwp' && <p className="rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning-text">Leave without pay is deducted in payroll (base ÷ working days per day).</p>}
        {errs.form && <p className="text-[13px] text-danger-text">{errs.form}</p>}
      </div>
    </Dialog>
  )
}

/* ---------------- Leave taken this financial year (Feature Guide §16) ---------------- */
const SUMMARY_COLS: [LeaveType | 'half' | 'ts', string][] = [
  ['casual', 'Casual leave'], ['sick', 'Sick leave'], ['earned', 'Earned or vacation leave'], ['compensatory', 'Compensatory off'], ['half', 'Half-day leave'], ['lwp', 'Leave without pay'], ['optional_holiday', 'Optional holiday'], ['ts', 'Days from timesheet'],
]
/** /leave/taken: taken = days up to today; later dates are "planned" (shown separately). */
type TakenSummary = Omit<LeaveSummary, 'rows'> & {
  as_of: string
  rows: (LeaveSummary['rows'][number] & { planned: { by_type: Record<LeaveType, number>; half_days: number; total: number; dates: { date: string; type: LeaveType; portion: 'full' | 'half' }[] } })[]
}
function TakenThisYear() {
  const q = useApi(['leave', 'taken'], () => http.get<TakenSummary>('/leave/taken'))
  const d = q.data
  type Row = TakenSummary['rows'][number]
  const val = (r: Row, k: (typeof SUMMARY_COLS)[number][0]) => (k === 'half' ? r.half_days : k === 'ts' ? r.timesheet_days : r.by_type[k])
  const cell = (n: number) => (n ? <span className="tnum">{n % 1 ? n.toFixed(1) : n}</span> : <span className="text-ink-3/50">—</span>)
  const plannedTip = (r: Row) => r.planned.dates.map((x) => `${fmtDate(x.date)} · ${LEAVE_TYPE[x.type]}${x.portion === 'half' ? ' (half day)' : ''}`).join('\n')
  const cols: Column<Row>[] = [
    { key: 'who', header: 'Person', sortValue: (r) => r.user.name, cell: (r) => <span className="font-medium">{r.user.name}</span> },
    ...SUMMARY_COLS.map(([k, label]) => ({ key: k, header: label, align: 'right' as const, width: '96px', sortValue: (r: Row) => val(r, k), cell: (r: Row) => cell(val(r, k)) })),
    {
      key: 'planned', header: 'Planned (after today)', align: 'right', width: '104px', sortValue: (r) => r.planned.total,
      cell: (r) => (r.planned.total ? <Tooltip content={plannedTip(r)}><span className="tnum cursor-help text-info-text underline decoration-dotted underline-offset-2">{r.planned.total % 1 ? r.planned.total.toFixed(1) : r.planned.total}</span></Tooltip> : <span className="text-ink-3/50">—</span>),
    },
  ]
  return (
    <div>
      <p className="mb-3 text-[13px] text-ink-3">{d ? `${d.fy_label} · ${fmtDate(d.from)} – ${fmtDate(d.to)} · taken up to ${fmtDate(d.as_of)}` : 'This financial year'}</p>
      <DataTable
        rows={d?.rows}
        columns={cols}
        rowKey={(r) => r.user.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        initialSort={{ key: 'who', dir: 'asc' }}
        empty={<EmptyState compact title="No leave taken this year" body="Leave recorded here or logged in timesheets shows up by type." />}
        mobileCard={(r) => (
          <div>
            <div className="text-[14px] font-medium">{r.user.name}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
              {SUMMARY_COLS.filter(([k]) => val(r, k) > 0).map(([k, label]) => (
                <div key={k} className="flex min-w-0 justify-between gap-2">
                  <dt className="truncate text-ink-3">{label}</dt>
                  <dd className="tnum shrink-0 text-ink">{val(r, k)}</dd>
                </div>
              ))}
              {r.planned.total > 0 && (
                <div className="flex min-w-0 justify-between gap-2">
                  <dt className="truncate text-ink-3">Planned</dt>
                  <dd className="tnum shrink-0 text-info-text">{r.planned.total}</dd>
                </div>
              )}
            </dl>
            {r.planned.total > 0 && <p className="mt-1.5 truncate text-[12px] text-ink-3">Planned: {r.planned.dates.map((x) => fmtDate(x.date)).join(', ')}</p>}
          </div>
        )}
      />
      <p className="mt-2 px-1 text-[12px] text-ink-3">Taken = leave days up to today (half days count 0.5, in the Half-day leave column). Leave dated after today is planned and shown separately. Days from timesheet = leave hours logged up to today ÷ {d?.min_hours ?? 9}h. Leave added here and leave rows in timesheets stay in step.</p>
    </div>
  )
}

/* ---------------- Record leave (HR): person + date range, list with Remove ---------------- */
function HrEntry() {
  const today = todayISO()
  const [userId, setUserId] = useState<string | null>(null)
  const [type, setType] = useState<LeaveType>('casual')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const q = useApi(['leave', 'hr-entry'], () => workApi.leave({ scope: 'all', from: addDays(today, -45), to: addDays(today, 180) }))
  const ro = useReadOnly()
  const { confirm } = useConfirm()
  const inv = [['leave'], ['timesheet'], ['daily'], ['leave-requests'], ['my-tasks']]
  const save = useMut(() => workApi.addLeave({ user_id: userId!, from, to: to || from, type, portion: 'full' }), {
    invalidate: inv,
    success: (r) => `${r.created} leave day${r.created > 1 ? 's' : ''} recorded`,
    silentError: true,
    onSuccess: () => (setFrom(''), setTo(''), setErrs({})),
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const del = useMut((id: string) => workApi.deleteLeave(id), { invalidate: inv, success: 'Leave removed' })
  const add = () => {
    const e: Record<string, string> = {}
    if (!userId) e.user_id = 'Choose a person.'
    if (!from) e.from = 'Pick the first day.'
    if (to && from && to < from) e.to = 'The end date is before the start date.'
    setErrs(e)
    if (!Object.keys(e).length) save.mutate(undefined)
  }
  const list = (q.data?.items ?? []).filter((l) => l.source === 'hr').sort((a, b) => a.date.localeCompare(b.date) || a.user_name.localeCompare(b.user_name))
  return (
    <Card>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Person" required error={errs.user_id}>
          <PeoplePicker value={userId} onChange={setUserId} placeholder="Choose a person" invalid={!!errs.user_id} />
        </Field>
        <Field label="From" required error={errs.from}>
          <Input type="date" value={from} invalid={!!errs.from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" error={errs.to}>
          <Input type="date" value={to} min={from || undefined} invalid={!!errs.to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as LeaveType)} options={TYPES.map((t) => ({ value: t, label: LEAVE_TYPE[t] }))} />
        </Field>
      </div>
      {errs.form && <p className="mt-2 text-[13px] text-danger-text">{errs.form}</p>}
      {errs.type && <p className="mt-2 text-[13px] text-danger-text">{errs.type}</p>}
      {!ro && (
        <Button variant="primary" className="mt-3" loading={save.isPending} onClick={add}>
          Add leave
        </Button>
      )}
      <p className="mt-2 text-[12px] text-ink-3">Weekly offs and holidays in the range are skipped. Each day appears as a leave row in that person’s timesheet.</p>
      <div className="mt-4 divide-y divide-line border-t border-line">
        {q.isLoading ? (
          <Skeleton className="mt-3 h-10 w-full" />
        ) : !list.length ? (
          <p className="py-4 text-[13px] text-ink-3">No leave entered by HR in this period.</p>
        ) : (
          list.map((l) => (
            <div key={l.id} className="flex min-h-[48px] items-center gap-3 py-2">
              <div className="min-w-0 flex-1 text-[13.5px]">
                <span className="font-semibold text-ink">{l.user_name}</span> <span className="whitespace-nowrap text-ink-2">{fmtDate(l.date, 'long')}</span>
                <span className="ml-1.5 text-[12.5px] text-ink-3">· {LEAVE_TYPE[l.type]}{l.portion === 'half' ? ' · half day' : ''}</span>
              </div>
              {l.can_delete && !ro && (
                <Button size="sm" variant="secondary" loading={del.isPending && del.variables === l.id} onClick={async () => (await confirm({ title: 'Remove this leave?', body: `${l.user_name}, ${fmtDate(l.date, 'long')}. The leave row in their timesheet is removed too.`, confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(l.id)}>
                  Remove
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  )
}

/** v4 workflow extra on leave rows: "Step 2 of 2 · HR approval" for multi-step leave chains. */
function stepOf(r: object): string | null {
  return (r as { step_label?: string | null }).step_label ?? null
}
