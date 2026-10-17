import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Clock, Copy, KeyRound, Lock, LockOpen, MoreHorizontal, RotateCcw, Send, Undo2 } from '@/ui/icons'
import { useApi, useMut, useScopeKey } from '@/api/query'
import { workApi, type WeekView, type WorkItem } from '@/api/work'
import { addDays, fmtDate, fmtDateTime, parseISO, todayISO, weekLabel, weekStart } from '@/domain/calendar'
import { LEAVE_TYPE, WEEK_STATUS } from '@/domain/labels'
import { fmtNum } from '@/domain/money'
import type { LeaveType } from '@/types/entities'
import { cn } from '@/lib/utils'
import { useUI } from '@/stores/ui'
import { Button, Callout, Card, Dialog, ErrorState, Field, IconButton, Menu, PageHeader, Segmented, Select, Skeleton, StatusBadge, toast, useConfirm, useReadOnly } from '@/ui'
import { DayList, DayPills, DesktopGrid, EMPTY_DRAFT, futureLocked, Legend, visibleDays, type EmptyDraft } from './WeekGrid'
import { countedTotal, fromItem, fromView, leaveLabel, round2, rowTotal, signature, toInput, type DraftRow } from './timesheetModel'
import { DailyLog } from './DailyUpdatePage'

/** "Sun, 4 Oct" */
const shortDay = (d: string) => {
  const x = parseISO(d)
  return `${x.toLocaleDateString('en-GB', { weekday: 'short' })}, ${x.getDate()} ${x.toLocaleDateString('en-GB', { month: 'short' })}`
}
const LEAVE_OPTIONS: LeaveType[] = ['casual', 'sick', 'earned', 'compensatory', 'lwp', 'optional_holiday']

/** UI-15 — "Timesheet & log" (Feature Guide §8, img-013 + img-014): /timesheet and /timesheet/:week (Monday ISO).
 *  The weekly Timesheet card, then the End-of-day update and Friday demo cards. Follows the header week switcher both ways.
 *  /daily redirects here with ?section=log. */
export default function TimesheetPage() {
  const params = useParams()
  const navigate = useNavigate()
  const today = todayISO()
  const thisMon = weekStart(today)
  const uiWeek = useUI((s) => s.week)
  const setWeek = useUI((s) => s.setWeek)
  const routeWeek = params.week && /^\d{4}-\d{2}-\d{2}$/.test(params.week) ? weekStart(params.week) : null
  const week = routeWeek ?? uiWeek
  // normalise a non-Monday date in the URL
  useEffect(() => {
    if (params.week && routeWeek && params.week !== routeWeek) navigate(`/timesheet/${routeWeek}`, { replace: true })
  }, [params.week, routeWeek, navigate])
  // route → header week
  useEffect(() => {
    if (routeWeek && routeWeek !== useUI.getState().week) setWeek(routeWeek)
  }, [routeWeek, setWeek])
  // header week → route (only when the header changed it)
  const prevUi = useRef(uiWeek)
  useEffect(() => {
    if (prevUi.current === uiWeek) return
    prevUi.current = uiWeek
    if (uiWeek !== week) navigate(uiWeek === thisMon ? '/timesheet' : `/timesheet/${uiWeek}`)
  }, [uiWeek, week, thisMon, navigate])

  const q = useApi(['timesheet', week], () => workApi.week(week), { staleTime: 0 })
  // /daily → /timesheet?section=log: scroll to the End-of-day update
  const [sp] = useSearchParams()
  const toLog = sp.get('section') === 'log'
  useEffect(() => {
    if (!toLog) return
    let n = 0
    const t = window.setInterval(() => {
      const el = document.getElementById('ts-log')
      if (el && el.querySelector('#du-done, #du-date, #du-date2')) {
        el.scrollIntoView({ block: 'start' })
        window.clearInterval(t)
      } else if (++n > 40) window.clearInterval(t)
    }, 100)
    return () => window.clearInterval(t)
  }, [toLog])
  return (
    <div className="space-y-5">
      <WeekHeader week={week} thisMon={thisMon} view={q.data} />
      <Card>
        <div className="mb-3.5 min-w-0">
          <h2 className="text-[16px] font-semibold leading-snug text-ink">Timesheet</h2>
          <p className="mt-0.5 text-[13.5px] leading-snug text-ink-2">Hours per task and activity for the week shown above. Task hours become the task’s actual hours and cost.</p>
        </div>
        {q.isLoading ? (
          <GridSkeleton />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data ? (
          <Editor key={`${week}:${q.data.id}`} view={q.data} refetch={() => q.refetch()} />
        ) : null}
      </Card>
      <DailyLog id="ts-log" />
    </div>
  )
}

/* ---------------- header & week navigation ---------------- */
function WeekHeader({ week, thisMon, view }: { week: string; thisMon: string; view?: WeekView }) {
  const navigate = useNavigate()
  const go = (w: string) => navigate(`/timesheet/${w}`)
  const isThis = week === thisMon
  return (
    <PageHeader
      title="Timesheet & log"
      subtitle={`${weekLabel(week)}. Log the week’s hours against tasks and activities once a week, and post an end-of-day update with a proof link each day.`}
      meta={view ? <StatusBadge map={WEEK_STATUS} value={view.status} /> : null}
      actions={
        !isThis ? (
          <Button size="md" variant="secondary" onClick={() => go(thisMon)}>
            Back to this week
          </Button>
        ) : null
      }
    />
  )
}

function GridSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-14 w-full rounded-lg" />
      <div className="hidden overflow-hidden border-t border-line bg-surface md:block">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
            <Skeleton className="h-4 w-56" />
            {Array.from({ length: 6 }).map((__, j) => (
              <Skeleton key={j} className="ml-auto h-8 w-14" />
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-3 md:hidden">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
    </div>
  )
}

/* ---------------- status banner ---------------- */
function StatusBanner({ v, onRequestUnlock, requesting }: { v: WeekView; onRequestUnlock: () => void; requesting: boolean }) {
  const ro = useReadOnly()
  const by = shortDay(v.submit_by ?? v.week_end)
  if (v.status === 'open' && v.unlocked_until)
    return (
      <Callout tone="success" icon={<LockOpen />} title={`Unlocked until ${shortDay(v.unlocked_until)}.`}>
        Fill in the week and submit before then, or it locks again.
      </Callout>
    )
  if (v.status === 'open')
    return (
      <Callout tone="info" icon={<Clock />} title="Draft.">
        Save as you go and submit by {by}. After that the week locks.{v.approver ? '' : ' You have no manager, so it is approved automatically when you submit.'}
      </Callout>
    )
  if (v.status === 'submitted')
    return (
      <Callout tone="warning" icon={<Send />} title={`Submitted ${v.submitted_at ? fmtDateTime(v.submitted_at) : ''}.`}>
        Waiting for {v.approver?.name ?? 'your approver'} to approve{v.sla_due ? ` by ${shortDay(v.sla_due)}` : ''}. It’s read-only now.
      </Callout>
    )
  if (v.status === 'approved')
    return (
      <Callout tone="success" icon={<CheckCircle2 />} title="Approved.">
        {v.auto_approved ? 'Approved automatically (no manager above you)' : `Approved by ${v.decided_by?.name ?? 'your manager'}`} {v.decided_at ? `on ${fmtDate(v.decided_at.slice(0, 10))}` : ''}. These days count for pay.
      </Callout>
    )
  if (v.status === 'rejected')
    return (
      <Callout tone="danger" icon={<Undo2 />} title={`Sent back by ${v.decided_by?.name ?? 'your approver'}.`}>
        “{v.reject_reason}” Fix it and submit again.
      </Callout>
    )
  return (
    <Callout
      tone="danger"
      icon={<Lock />}
      title="Locked."
      action={
        v.can_request_unlock && !ro ? (
          <Button size="sm" variant="secondary" icon={<KeyRound className="size-3.5" />} loading={requesting} onClick={onRequestUnlock}>
            Request unlock
          </Button>
        ) : null
      }
    >
      This week ended on {shortDay(v.week_end)} without being submitted. Only your manager or the CEO can unlock it, for a set number of days, after you ask with a reason.
      {v.unlock_requested_at && <span className="mt-1 block font-medium text-ink">Unlock requested {fmtDateTime(v.unlock_requested_at)} — waiting for {v.approver?.name ?? 'an admin'}.</span>}
    </Callout>
  )
}

/* ---------------- editor ---------------- */
function Editor({ view, refetch }: { view: WeekView; refetch: () => void }) {
  const qc = useQueryClient()
  const scope = useScopeKey()
  const { confirm, askReason } = useConfirm()
  const ro = useReadOnly()
  const today = todayISO()
  const editable = view.editable && !ro
  const breaks = view.rules.breaks_count ?? true
  const [rows, setRows] = useState<DraftRow[]>(() => fromView(view))
  const [base, setBase] = useState(() => signature(fromView(view)))
  const [empty, setEmpty] = useState<EmptyDraft>(EMPTY_DRAFT)
  const [leaveOpen, setLeaveOpen] = useState(false)
  // "Rows with no hours disappear": a row whose hours were cleared goes away when you leave it (and on save)
  const hadHours = useRef(new Set<string>())
  for (const r of rows) if (rowTotal(r) > 0) hadHours.current.add(r.uid)
  const onRowLeave = (ri: number) => {
    const uid = rows[ri]?.uid
    if (!uid) return
    setRows((rs) => rs.filter((r) => !(r.uid === uid && !r.locked_reason && rowTotal(r) === 0 && hadHours.current.has(uid))))
  }
  const onAddTask = () => {
    const el = [document.getElementById('ts-pick'), document.getElementById('ts-pick-m')].find((x) => x && x.offsetParent !== null)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.click()
  }
  const dirty = editable && signature(rows) !== base
  const shown = visibleDays(view)
  const defaultDay = shown.find((d) => d.date === today)?.date ?? shown.find((d) => d.min_required > 0)?.date ?? view.week_start
  const [day, setDay] = useState(defaultDay)
  const items = useApi(['timesheet', 'items', view.week_start], () => workApi.workItems(view.week_start), { enabled: editable, staleTime: 60_000 })

  const accept = useCallback(
    (v: WeekView) => {
      qc.setQueryData([...scope, 'timesheet', v.week_start], v)
      const r = fromView(v)
      setRows(r)
      setBase(signature(r))
    },
    [qc, scope],
  )
  const invalidateOthers = () => {
    for (const k of [['my-tasks'], ['approvals'], ['leave'], ['team'], ['task'], ['daily']]) qc.invalidateQueries({ queryKey: [...scope, ...k] })
  }
  const onErr = (e: { code: string }) => e.code === 'STALE' && refetch()

  const save = useMut(() => workApi.saveWeek(view.week_start, toInput(rows), view.version), { success: 'Draft saved', onSuccess: (v) => (accept(v), invalidateOthers()), onError: onErr })
  const submit = useMut(() => workApi.submitWeek(view.week_start, dirty ? toInput(rows) : null, view.version), {
    success: (v) => ((v as WeekView & { approver_name?: string | null }).approver_name ? `Submitted to ${(v as WeekView & { approver_name?: string }).approver_name} for approval` : 'Submitted and approved'),
    onSuccess: (v) => (accept(v), invalidateOthers()),
    onError: onErr,
  })
  const unlock = useMut((reason: string) => workApi.requestUnlock(view.week_start, reason), {
    success: (v) => `Unlock requested from ${(v as WeekView & { approver_name?: string }).approver_name ?? 'your manager'}`,
    onSuccess: accept,
  })
  const copy = useMut((withHours: boolean) => workApi.copyPrevious(view.week_start, withHours), {
    success: (v) => {
      const n = (v as WeekView & { copied?: number }).copied ?? 0
      return n ? `${n} row${n > 1 ? 's' : ''} copied from last week` : 'Last week’s hours copied'
    },
    onSuccess: (v) => (accept(v), invalidateOthers()),
  })

  // ⌘S / Ctrl+S saves
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (editable && dirty && !save.isPending) save.mutate(undefined)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [editable, dirty, save])
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const focusRow = (idx: number) =>
    requestAnimationFrame(() => {
      if (!window.matchMedia('(min-width: 768px)').matches) return
      const col = Math.max(0, shown.findIndex((d) => d.date === today))
      const el = document.querySelector<HTMLElement>(`[data-cell="${idx}:${col}"]`) ?? document.querySelector<HTMLElement>(`[data-cell="${idx}:0"]`)
      el?.focus()
    })
  const pick = (it: WorkItem, extra: EmptyDraft) => {
    const next = [...rows, fromItem(it, extra)]
    setRows(next)
    setEmpty(EMPTY_DRAFT)
    focusRow(next.length - 1)
    if (it.kind === 'internal' && it.internal_code !== 'breaks' && view.rules.note_required && !extra.note.trim()) toast.message('Add a note saying what the time was for.')
  }
  // /timesheet/:week?task=<id> (e.g. "Log time" on a task): add that task's row once, then drop the parameter
  const [tsp, setTsp] = useSearchParams()
  const wantTask = tsp.get('task')
  const taskAdded = useRef(false)
  useEffect(() => {
    if (!wantTask || taskAdded.current || !editable || !items.data) return
    taskAdded.current = true
    const it = items.data.find((x) => x.kind === 'task' && x.task_id === wantTask)
    const at = rows.findIndex((r) => r.kind === 'task' && r.task_id === wantTask)
    if (at >= 0) focusRow(at)
    else if (it) pick(it, EMPTY_DRAFT)
    else toast.message('That task can’t take time this week (it may be closed or not yours).')
    const next = new URLSearchParams(tsp)
    next.delete('task')
    setTsp(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantTask, editable, items.data])
  const addBreaks = () => {
    const at = rows.findIndex((r) => r.kind === 'internal' && r.internal_code === 'breaks')
    if (at >= 0) {
      focusRow(at)
      return toast.message('Lunch, tea and stand-up is already on this week. Enter its hours in that row.')
    }
    const it = items.data?.find((x) => x.key === 'internal:breaks') ?? ({ key: 'internal:breaks', kind: 'internal', task_id: null, internal_code: 'breaks', leave_type: null, label: 'Lunch, tea and stand-up', hint: '', group: 'Activities', wbs: null, project_code: null } as WorkItem)
    const next = [...rows, fromItem(it)]
    setRows(next)
    focusRow(next.length - 1)
    if (!breaks) toast.message('Breaks are logged but don’t count toward the daily minimum in this company.')
  }
  const addLeave = (type: LeaveType, dates: string[], portion: 'full' | 'half') => {
    const hrs = portion === 'full' ? view.rules.min_hours : view.rules.min_hours / 2
    // one leave per day: clear these days from any other leave row
    let next = rows.map((r) => (r.kind === 'leave' && r.leave_type !== type && !r.locked_reason ? { ...r, hours: Object.fromEntries(Object.entries(r.hours).filter(([d]) => !dates.includes(d))) } : r))
    const at = next.findIndex((r) => r.kind === 'leave' && r.leave_type === type)
    if (at >= 0) next = next.map((r, i) => (i === at ? { ...r, hours: { ...r.hours, ...Object.fromEntries(dates.map((d) => [d, hrs])) } } : r))
    else {
      const it: WorkItem = { key: `leave:${type}`, kind: 'leave', task_id: null, internal_code: null, leave_type: type, label: leaveLabel(type), hint: '', group: 'Leave', wbs: null, project_code: null }
      next = [...next, fromItem(it, { hours: Object.fromEntries(dates.map((d) => [d, hrs])) })]
    }
    setRows(next)
    setLeaveOpen(false)
    toast.message(`${leaveLabel(type)} added for ${dates.length} day${dates.length > 1 ? 's' : ''}. Save the draft to record it.`)
  }
  const doCopy = () => {
    if (dirty) return toast.error('Save or discard your changes first, then copy last week’s rows.')
    copy.mutate(false)
  }

  const doSubmit = async () => {
    const short = shown.filter((d) => d.min_required > 0 && d.date <= today && round2(countedTotal(rows, d.date, breaks)) < d.min_required)
    const total = round2(rows.reduce((s, r) => s + Object.values(r.hours).reduce((a, b) => a + (b || 0), 0), 0))
    if (!total) return toast.error('Log your hours before submitting the week.')
    const noteMissing = rows.find((r) => r.kind === 'internal' && r.internal_code !== 'breaks' && view.rules.note_required && Object.values(r.hours).some((h) => h > 0) && r.note.trim().length < 3)
    if (noteMissing) return toast.error(`Add a note to “${noteMissing.label}” before submitting.`)
    const ok = await confirm({
      title: short.length ? `${short.length} short day${short.length > 1 ? 's' : ''} — submit anyway?` : 'Submit this week for approval?',
      body: short.length ? (
        <span>
          {short.map((d) => `${fmtDate(d.date, 'day')}: ${round2(countedTotal(rows, d.date, breaks))}h`).join(', ')} {short.length > 1 ? 'are' : 'is'} below {view.rules.min_hours}h. Short days may not be paid in full.
        </span>
      ) : (
        <span>
          {fmtNum(total, 2)}h for {weekLabel(view.week_start)} goes to {view.approver?.name ?? 'auto-approval'}. It becomes read-only for you.
        </span>
      ),
      confirmLabel: 'Submit for approval',
    })
    if (ok) submit.mutate(undefined)
  }
  const doUnlock = async () => {
    const reason = await askReason({ title: 'Ask to unlock this week', body: `${view.approver?.name ?? 'Your manager'} will be notified and can reopen it for up to ${view.rules.unlock_max_days} days.`, label: 'Reason', placeholder: 'e.g. Was at client site without laptop Friday–Saturday', confirmLabel: 'Send request', minLength: 5 })
    if (reason) unlock.mutate(reason)
  }
  const reset = async () => {
    if (await confirm({ title: 'Discard unsaved changes?', body: 'The grid goes back to the last saved version.', confirmLabel: 'Discard', tone: 'danger' })) {
      setRows(fromView(view))
      setEmpty(EMPTY_DRAFT)
    }
  }

  const logged = round2(rows.reduce((s, r) => s + Object.values(r.hours).reduce((a, b) => a + (b || 0), 0), 0))
  const countedToDate = round2(shown.filter((d) => d.date <= today).reduce((s, d) => s + countedTotal(rows, d.date, breaks), 0))
  const target = view.target_to_date ?? shown.filter((d) => d.date <= today).reduce((s, d) => s + d.min_required, 0)
  const pct = target ? Math.round((countedToDate / target) * 100) : null
  const selDay = shown.find((d) => d.date === day) ?? shown[0]
  const busy = save.isPending || submit.isPending

  const quick = editable && (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setLeaveOpen(true)}>
          + Leave or holiday
        </Button>
        <Button size="sm" variant="secondary" onClick={addBreaks}>
          + Lunch, tea and stand-up
        </Button>
        <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} loading={copy.isPending} onClick={doCopy}>
          Copy rows from last week
        </Button>
      </div>
      <p className="text-[12.5px] leading-snug text-ink-3">
        Fill one row at a time: pick a task or activity in the empty row and enter hours. A new empty row appears as soon as you pick. Rows with no hours disappear. A full-day leave row ({view.rules.min_hours}h) also marks you on leave for planning; a half day stays a working day.
      </p>
    </div>
  )

  const summary = (
    <p className="text-[13.5px] text-ink-2">
      This week: <span className="tnum font-semibold text-ink">{fmtNum(logged, 2)}h</span> logged{logged ? '' : ' (nothing yet)'}. Target to date <span className="tnum font-semibold text-ink">{target}h</span> at {view.rules.min_hours}h a working day:{' '}
      <span className={cn('tnum font-semibold', pct === null ? 'text-ink' : pct >= 100 ? 'text-success-text' : pct >= 80 ? 'text-warning-text' : 'text-danger-text')}>{pct === null ? '—' : `${pct}%`}</span>.
      {!breaks && rows.some((r) => r.internal_code === 'breaks') && <span className="text-ink-3"> Lunch, tea and stand-up doesn’t count toward the target.</span>}
    </p>
  )

  const moreItems = [
    { label: 'Copy rows and hours from last week', icon: <Copy />, onSelect: () => (dirty ? toast.error('Save or discard your changes first.') : copy.mutate(true)), disabled: !editable, hint: 'past days' },
    { separator: true, label: '' },
    { label: 'Discard changes', icon: <RotateCcw />, onSelect: reset, disabled: !dirty, danger: true },
  ]

  return (
    <div className="space-y-4">
      <StatusBanner v={view} onRequestUnlock={doUnlock} requesting={unlock.isPending} />

      {/* desktop grid */}
      <div className="hidden md:block">
        <DesktopGrid view={view} rows={rows} editable={editable} today={today} items={items.data} itemsLoading={items.isLoading} onChange={setRows} onPick={pick} empty={empty} onEmpty={setEmpty} inCard onAddTask={onAddTask} onRowLeave={onRowLeave} />
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <Legend future={editable && shown.some(futureLocked)} />
          {editable && <span className="text-[12px] text-ink-3">{dirty ? 'Unsaved changes · ⌘S to save' : 'All changes saved'}</span>}
        </div>
      </div>

      {/* phone: day by day */}
      <div className="md:hidden">
        <DayPills days={view.days} rows={rows} selected={day} onSelect={setDay} today={today} breaksCount={breaks} />
        {selDay && <DayList view={view} rows={rows} editable={editable} today={today} day={selDay} items={items.data} itemsLoading={items.isLoading} onChange={setRows} onPick={pick} empty={empty} onEmpty={setEmpty} onAddTask={onAddTask} />}
      </div>

      {summary}
      {quick}

      {editable && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 sm:flex">
          <Button variant="secondary" onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!dirty || submit.isPending}>
            Save draft
          </Button>
          <Button variant="primary" icon={<Send className="size-4 shrink-0" />} onClick={doSubmit} loading={submit.isPending} disabled={!view.can_submit || busy}>
            <span className="max-sm:hidden">{view.status === 'rejected' ? 'Resubmit for approval' : 'Submit for approval'}</span>
            <span className="hidden max-sm:inline">{view.status === 'rejected' ? 'Resubmit' : 'Submit'}</span>
          </Button>
          <Menu label="More actions" items={moreItems} trigger={<IconButton label="More actions" variant="secondary"><MoreHorizontal className="size-4" /></IconButton>} />
          <span className="col-span-3 text-[12px] text-ink-3 md:hidden">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        </div>
      )}

      {leaveOpen && <LeaveDialog view={view} onClose={() => setLeaveOpen(false)} onAdd={addLeave} />}
    </div>
  )
}

/* ---------------- + Leave or holiday ---------------- */
function LeaveDialog({ view, onClose, onAdd }: { view: WeekView; onClose: () => void; onAdd: (type: LeaveType, dates: string[], portion: 'full' | 'half') => void }) {
  const [type, setType] = useState<LeaveType>('casual')
  const [portion, setPortion] = useState<'full' | 'half'>('full')
  const optional = new Map((view.optional_holidays ?? []).map((h) => [h.date, h.name]))
  const days = visibleDays(view).filter((d) => d.kind !== 'weekly_off' && d.kind !== 'holiday')
  const allowed = (d: string) => (type === 'optional_holiday' ? optional.has(d) : true)
  const [sel, setSel] = useState<string[]>([])
  const chosen = sel.filter(allowed)
  const err = !chosen.length ? (type === 'optional_holiday' && !days.some((d) => optional.has(d.date)) ? 'There is no optional holiday this week. Optional holidays are listed in the holiday calendar.' : 'Pick at least one day.') : portion === 'half' && chosen.length > 1 ? 'A half day covers one date. Pick a single day.' : null
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add leave or holiday"
      description={`A full day is ${view.rules.min_hours}h and marks you on leave for planning. A half day (${view.rules.min_hours / 2}h) stays a working day.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!err} onClick={() => onAdd(type, chosen, portion)}>
            Add to the week
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Type" htmlFor="lv-type" hint={type === 'lwp' ? 'Unpaid: deducted in payroll.' : type === 'optional_holiday' ? 'Only on a listed optional holiday; counts against your yearly optional holidays.' : undefined}>
          <Select id="lv-type" value={type} onChange={(e) => setType(e.target.value as LeaveType)} options={LEAVE_OPTIONS.map((t) => ({ value: t, label: t === 'compensatory' ? 'Compensatory off' : LEAVE_TYPE[t] }))} />
        </Field>
        <Field label="Days">
          <div className="flex flex-wrap gap-1.5">
            {days.map((d) => {
              const on = sel.includes(d.date)
              const ok = allowed(d.date)
              return (
                <button
                  key={d.date}
                  type="button"
                  aria-pressed={on && ok}
                  disabled={!ok}
                  title={optional.get(d.date)}
                  onClick={() => setSel((s) => (on ? s.filter((x) => x !== d.date) : [...s, d.date]))}
                  className={cn('h-10 min-w-[64px] rounded-md border px-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40', on && ok ? 'border-brand bg-brand-soft text-brand-text' : 'border-line bg-surface text-ink-2 hover:text-ink')}
                >
                  {fmtDate(d.date, 'day')}
                </button>
              )
            })}
          </div>
        </Field>
        <Field label="Portion">
          <Segmented block value={portion} onChange={(v) => setPortion(v as 'full' | 'half')} options={[{ value: 'full', label: `Full day (${view.rules.min_hours}h)` }, { value: 'half', label: `Half day (${view.rules.min_hours / 2}h)` }]} />
        </Field>
        {err && sel.length > 0 && <p className="text-[12.5px] text-danger-text">{err}</p>}
        {type === 'optional_holiday' && optional.size > 0 && <p className="text-[12.5px] text-ink-3">This week: {[...optional.entries()].map(([d, n]) => `${n} (${fmtDate(d, 'day')})`).join(', ')}.</p>}
      </div>
    </Dialog>
  )
}
