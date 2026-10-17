import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Command } from 'cmdk'
import { AlertTriangle, CalendarClock, Check, GitBranch, Maximize2, Plus, X } from '@/ui/icons'
import { useQueryClient } from '@tanstack/react-query'
import { tasksApi } from '@/api/tasks'
import { deliveryApi, PRIORITY_P, TASK_RELATION, type RiskTaskLink, type TaskDetailV7 } from '@/api/work'
import { useApi, useMut, useScopeKey } from '@/api/query'
import { ApiError } from '@/api/http'
import { usePeopleMap } from '@/api/core'
import { useUI, useWeek } from '@/stores/ui'
import { useSession } from '@/stores/session'
import type { Comment, Complexity, TaskTag } from '@/types/entities'
import { COMPLEXITY, COMPLEXITY_ORDER, TASK_STAGE, TASK_STATUS, TASK_TAG_LABEL } from '@/domain/labels'
import { STAGE } from '@/domain/delivery'
import { diffDays, fmtDate, relTime, todayISO, weekStart } from '@/domain/calendar'
import { fmtHours } from '@/domain/money'
import { cn } from '@/lib/utils'
import {
  Avatar, Badge, Button, Callout, ErrorState, Field, IconButton, Input, Menu, PeoplePicker, PersonName, Popover, Progress, Segmented, Select, Sheet, Skeleton, StatusBadge, Textarea, toast, useCan, useConfirm, useReadOnly,
} from '@/ui'
import { ApiError as ApiErr } from '@/api/http'
import { TaskFormSheet, type TaskFormPrefill } from './TaskForm'
import { TaskV7Panel } from './tasks/TaskV7Panel'
import { MentionInput, RichText, mentionsIn } from './MentionInput'
import { LateBadge, PRIORITY, RatingText, ReviewDialog, ReviewTimeline, SubmitReviewDialog, TimelinessBadge, delayLabel } from './taskReview'
import { EstimateHintLine, FlagSlipDialog, ProgressDialog, StageBadge, StageSelect, TagBadge, type StageTask } from './taskStage'

type Detail = TaskDetailV7


/** Invalidate everything a task write can affect across modules. */
export function useTaskInvalidate() {
  const qc = useQueryClient()
  const scope = useScopeKey()
  return (id?: string) => {
    for (const k of [['task', id].filter(Boolean), ['my-tasks'], ['project'], ['projects'], ['tasks'], ['timesheet'], ['insights'], ['dash'], ['team-tasks'], ['task-analytics'], ['approvals'], ['notifications'], ['delivery']])
      qc.invalidateQueries({ queryKey: [...scope, ...k] })
  }
}

/** UI-13 — global task drawer. Opened by useUI().openTask(id); /tasks/:id is the full, deep-linkable page (TaskPage). */
export default function TaskDrawerHost() {
  const { taskId, openTask } = useUI()
  const close = () => openTask(null)
  return (
    <Sheet
      open={!!taskId}
      onOpenChange={(o) => !o && close()}
      width={640}
      title={<span className="sr-only">Task details</span>}
      subtitle={taskId ? <TaskHeader key={taskId} id={taskId} /> : null}
    >
      {taskId ? <TaskSections key={taskId} id={taskId} mode="drawer" /> : null}
    </Sheet>
  )
}

function useDetail(id: string) {
  return useApi(['task', id], () => deliveryApi.detail(id) as Promise<Detail>, { staleTime: 5_000 })
}

/** Weekday names of ISO dates: "Tue, Wed". */
export function weekdays(days: string[]) {
  return days.map((d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })).join(', ')
}

/* ---------------- header: project / milestone, WBS + editable title ---------------- */
export function TaskHeader({ id, page }: { id: string; page?: boolean }) {
  const q = useDetail(id)
  const ro = useReadOnly()
  const inv = useTaskInvalidate()
  const d = q.data
  const [title, setTitle] = useState('')
  useEffect(() => setTitle(d?.task.title ?? ''), [d?.task.title])
  const save = useMut((t: string) => tasksApi.update(id, { title: t }, d?.task.version), {
    success: 'Title updated',
    onSuccess: () => inv(id),
    onError: (e) => {
      setTitle(d?.task.title ?? '')
      if (e.code === 'STALE') q.refetch()
    },
  })
  if (q.error && !d) return <h2 className={cn('font-semibold leading-snug text-ink', page ? 'text-[20px]' : 'text-[17px]')}>Task</h2>
  if (q.isLoading || !d)
    return (
      <div className="space-y-2 pt-1">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-4/5" />
      </div>
    )
  const editable = d.can_edit && !ro
  return (
    <div className="min-w-0 space-y-1.5 text-ink">
      <div className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-3', !page && 'pr-8')}>
        {d.relation && d.relation !== 'owner' && (
          <Badge size="sm" tone={TASK_RELATION[d.relation].tone === 'brand' ? 'info' : TASK_RELATION[d.relation].tone} className="mr-1">
            {TASK_RELATION[d.relation].label}
          </Badge>
        )}
        <Link to={`/projects/${d.project.id}`} onClick={() => useUI.getState().openTask(null)} className="text-brand-text hover:underline">
          {d.project.code} · {d.project.name}
        </Link>
        {d.milestone && (
          <>
            <span aria-hidden>/</span>
            <span className="truncate">M{d.milestone.no} {d.milestone.name}</span>
          </>
        )}
      </div>
      <div className="flex items-start gap-2">
        <span className={cn('tnum shrink-0 text-ink-3', page ? 'mt-[7px] text-[15px]' : 'mt-[5px] text-[13px]')}>{d.wbs}</span>
        {editable ? (
          <textarea
            value={title}
            rows={1}
            aria-label="Task title"
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLTextAreaElement).blur()
              }
              if (e.key === 'Escape') setTitle(d.task.title)
            }}
            onBlur={() => {
              const t = title.trim()
              if (!t) return setTitle(d.task.title)
              if (t !== d.task.title) save.mutate(t)
            }}
            className={cn(
              'field-sizing-content min-h-[30px] w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 font-semibold leading-snug outline-none hover:border-line focus:border-brand focus:ring-[3px] focus:ring-brand/15',
              page ? 'text-[20px] md:text-[22px]' : 'text-[17px]',
            )}
          />
        ) : (
          <h2 className={cn('font-semibold leading-snug', page ? 'text-[20px] md:text-[22px]' : 'text-[17px]')}>{d.task.title}</h2>
        )}
        <span className="mt-[6px] flex shrink-0 items-center gap-1.5">
          <TagBadge tag={d.task.tag} />
          {d.priority && d.priority !== 'normal' && <Badge size="sm" tone={PRIORITY_P[d.priority].tone}>{PRIORITY_P[d.priority].code}</Badge>}
        </span>
      </div>
    </div>
  )
}

/* ---------------- body, in the Feature Guide's order ---------------- */
export function TaskSections({ id, mode }: { id: string; mode: 'drawer' | 'page' }) {
  const q = useDetail(id)
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </div>
    )
  if (q.error instanceof ApiErr && q.error.status === 403)
    return (
      <Callout tone="info" title="This task isn’t shared with you">
        {q.error.message} Ask the owner or the project manager to add you as a watcher if you need to follow it.
      </Callout>
    )
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return <Loaded d={q.data} refetch={() => q.refetch()} mode={mode} />
}

/** A numbered section heading that mirrors the guide's list ("Each task has: …"). */
function SectionHead({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

function Loaded({ d, refetch, mode }: { d: Detail; refetch: () => void; mode: 'drawer' | 'page' }) {
  const ro = useReadOnly()
  const people = usePeopleMap()
  const week = useWeek()
  const t = d.task
  const editable = d.can_edit && !ro
  const canStatus = d.can_change_status && !ro
  const rv = d.review
  const [dlg, setDlg] = useState<null | 'submit' | 'approve' | 'send_back' | 'direct' | 'progress' | 'slip'>(null)
  const [follow, setFollow] = useState<null | TaskFormPrefill>(null)
  const st: StageTask = {
    id: t.id, title: t.title, wbs: d.wbs, due_on: t.due_on, start_on: t.start_on, stage: d.stage, progress: d.progress, status: t.status, version: t.version,
    can_move: d.can_change_status, can_submit: rv.can_submit, can_review: t.status === 'in_review' ? rv.can_review : !rv.self_review && (rv.can_review || d.can_edit),
    can_edit: d.can_edit, owner_id: t.owner_id, backup_id: t.backup_id, logged_hours: d.actual_hours,
  }
  const waiting = STAGE[d.stage].group === 'waiting'
  const open = t.status !== 'done' && t.status !== 'in_review'
  const ownerName = people.get(t.owner_id)?.name ?? 'the owner'
  const logWeek = week || weekStart(todayISO())
  const logTo = `/timesheet/${logWeek}?task=${t.id}`
  const leaveDays = d.owner_leave_days ?? []

  return (
    <div className="space-y-7 pb-2">
      {/* quick actions */}
      {(d.can_log_time || mode === 'drawer' || d.can_create_followup) && (
        <div className="-mt-1 flex flex-wrap items-center gap-2">
          {d.can_log_time && !ro && (
            <Link to={logTo} onClick={() => useUI.getState().openTask(null)}>
              <Button size="sm" icon={<CalendarClock className="size-4" />}>
                Log time
              </Button>
            </Link>
          )}
          {d.can_create_followup && !ro && (
            <Menu
              label="Create sub-task or follow-up"
              align="start"
              trigger={
                <Button size="sm" icon={<GitBranch className="size-4" />}>
                  Create sub-task / follow-up
                </Button>
              }
              items={[
                { label: 'Sub-task (part of this task)', onSelect: () => setFollow({ project_id: t.project_id, milestone_id: t.milestone_id, parent_task_id: t.id, owner_id: t.owner_id, tag: t.tag ?? 'feature' }) },
                { label: 'Follow-up (starts after this task)', onSelect: () => setFollow({ project_id: t.project_id, milestone_id: t.milestone_id, parent_task_id: t.id, depends_on: [t.id], owner_id: t.owner_id, title: `Follow-up: ${t.title}`.slice(0, 200) }) },
              ]}
            />
          )}
          {mode === 'drawer' && (
            <Link to={`/tasks/${t.id}`} onClick={() => useUI.getState().openTask(null)}>
              <Button size="sm" variant="ghost" icon={<Maximize2 className="size-4" />}>
                Open full page
              </Button>
            </Link>
          )}
        </div>
      )}
      <TaskFormSheet
        open={!!follow}
        onOpenChange={(o) => !o && setFollow(null)}
        prefill={follow ?? undefined}
        title={follow?.depends_on?.length ? 'Create follow-up' : 'Create sub-task'}
        subtitle={`Linked to ${d.wbs} ${t.title}.`}
      />
      {d.covering_me && (
        <Callout tone="info" title={`You’re covering this task for ${people.get(d.covering_me.from_user_id)?.name ?? ownerName}`}>
          {d.covering_me.reason === 'leave' ? `On leave ${weekdays(d.covering_me.days)}. ` : `Delegated to you ${fmtDate(d.covering_me.days[0])} – ${fmtDate(d.covering_me.days[d.covering_me.days.length - 1])}. `}
          You can move it and log time on it on those days.
        </Callout>
      )}

      {/* 1 — Owner & backup */}
      <section>
        <SectionHead title="Owner and backup" hint="One owner is accountable. The backup covers the task when the owner is on leave." />
        <OwnerBackup d={d} editable={editable} refetch={refetch} />
        {leaveDays.length > 0 && open && (
          <p className="mt-2 text-[12.5px] text-warning-text">
            {ownerName} is on leave {weekdays(leaveDays)} this week.{' '}
            {t.backup_id ? `On those days the task is in ${people.get(t.backup_id)?.name ?? 'the backup'}’s Covering list and they can log time on it.` : 'There is no backup: set one so the task isn’t left uncovered.'}
          </p>
        )}
      </section>

      {/* 2 — Estimate, dates, complexity */}
      <section>
        <SectionHead title="Estimate and dates" hint="Estimated hours, start and due date, and complexity. Complexity feeds estimation accuracy in Insights." />
        <EstimateDates d={d} editable={editable} refetch={refetch} />
      </section>

      {/* 3 — Status */}
      <section className="space-y-3">
        <SectionHead
          title="Status"
          hint="To do, In progress, Blocked, In review, Done. The detailed stage under it drives progress."
          action={<StatusBadge map={TASK_STATUS} value={t.status} size="md" />}
        />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field label="Stage">
            <StageSelect t={st} />
          </Field>
          {canStatus && open && (
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button size="sm" onClick={() => setDlg('progress')}>Update progress</Button>
              <Button size="sm" onClick={() => setDlg('slip')}>Flag slip</Button>
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-[12.5px]">
            <span className="flex flex-wrap items-center gap-1.5 text-ink-3">
              <StageBadge stage={d.stage} />
              {d.critical && open && <Badge tone="danger" size="sm">Critical</Badge>}
              {d.cancelled && <Badge tone="neutral" size="sm">Cancelled</Badge>}
            </span>
            <span className="tnum font-medium text-ink">{d.progress}% done</span>
          </div>
          <Progress value={d.progress} max={100} height={5} tone={d.stage === 'completed' ? 'success' : waiting ? 'warning' : 'brand'} />
          {open && d.forecast_end && (
            <p className={cn('tnum mt-1.5 text-[12.5px]', d.forecast_end > t.due_on ? 'text-danger-text' : 'text-ink-3')}>
              Forecast end {fmtDate(d.forecast_end)}, target {fmtDate(t.due_on)}
              {d.float_days !== null ? ` · float ${d.float_days} working day${d.float_days === 1 ? '' : 's'} to the milestone` : ''}
            </p>
          )}
        </div>
        {d.blockers.length > 0 && open && (
          <Callout tone="danger" icon={<AlertTriangle />} title={`Can’t start: blocked by ${d.blockers.map((b) => b.wbs).join(', ')}`}>
            {d.blockers.map((b) => `${b.wbs} ${b.title} — owner ${people.get(b.owner_id)?.name ?? 'unassigned'}`).join('; ')}. Talk to {d.blockers.length === 1 ? 'them' : 'the owners'} or ask the PM to change the dependency.
          </Callout>
        )}
        {!canStatus && !ro && <p className="text-[12px] text-ink-3">Only the owner, backup or project manager can change the status.</p>}
        {waiting && t.blocked_reason && (
          <p className="text-[13px] text-warning-text">
            <span className="font-semibold">{TASK_STAGE[d.stage].label} since {fmtDate(d.stage_since)}:</span> {t.blocked_reason}
          </p>
        )}
        {t.slip_flagged_on && open && (
          <p className="text-[13px] text-warning-text">
            <span className="font-semibold">Slip flagged {fmtDate(t.slip_flagged_on)}:</span> {t.slip_note}
          </p>
        )}
        <ReviewBar d={d} onAction={setDlg} />
      </section>
      <ProgressDialog t={st} open={dlg === 'progress'} onOpenChange={(o) => !o && setDlg(null)} />
      <FlagSlipDialog t={st} open={dlg === 'slip'} onOpenChange={(o) => !o && setDlg(null)} />
      <SubmitReviewDialog open={dlg === 'submit'} onOpenChange={(o) => !o && setDlg(null)} task={{ id: t.id, title: t.title, wbs: d.wbs, due_on: t.due_on }} />
      <ReviewDialog mode={dlg === 'send_back' ? 'send_back' : dlg === 'direct' ? 'direct' : 'approve'} open={dlg === 'approve' || dlg === 'send_back' || dlg === 'direct'} onOpenChange={(o) => !o && setDlg(null)} task={{ id: t.id, title: t.title, wbs: d.wbs, due_on: t.due_on }} />

      {/* 4 — Depends on */}
      <Dependencies d={d} editable={editable} />

      {/* 5 — Thread */}
      <Comments d={d} />

      {/* v7 — accountability, definition of done, attachments, labels / billable / repeat, related tasks */}
      <section>
        <SectionHead title="Accountability and scope" hint="Reviewer, concerned manager and watchers; the definition of done the reviewer checks; files, labels, billing and repeat." />
        <TaskV7Panel d={d} editable={editable} />
      </section>

      {/* everything else the board tracks */}
      <section>
        <SectionHead title="More details" hint="Tag, reviewer, priority, milestone, description and review history." />
        <MoreDetails d={d} editable={editable} refetch={refetch} />
        <h4 className="mb-2 mt-5 text-[13px] font-semibold text-ink">Review history</h4>
        <ReviewTimeline reviews={rv.reviews} reschedules={rv.reschedules} dueOn={t.due_on} />
        <p className="mt-5 border-t border-line pt-3 text-[12.5px] text-ink-3">
          Created {fmtDate(t.created_at.slice(0, 10))} · updated {relTime(t.updated_at)}
        </p>
      </section>
    </div>
  )
}

/* ---------------- fields ---------------- */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-3 py-2 sm:grid-cols-[128px_minmax(0,1fr)]">
      <span className="text-[13px] text-ink-3">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function useSave(t: Detail['task'], refetch: () => void, after?: () => void) {
  const inv = useTaskInvalidate()
  return useMut((patch: Parameters<typeof deliveryApi.update>[1]) => deliveryApi.update(t.id, patch, t.version), {
    success: 'Saved',
    onSuccess: () => inv(t.id),
    onError: (e) => {
      if (e.code === 'STALE') refetch()
      after?.()
    },
  })
}

function OwnerBackup({ d, editable, refetch }: { d: Detail; editable: boolean; refetch: () => void }) {
  const t = d.task
  const save = useSave(t, refetch)
  if (!editable)
    return (
      <div className="divide-y divide-line rounded-lg border border-line px-4">
        <Row label="Owner"><PersonName id={t.owner_id} size={22} /></Row>
        <Row label="Backup">{t.backup_id ? <PersonName id={t.backup_id} size={22} /> : <span className="text-[13.5px] text-ink-3">No backup</span>}</Row>
      </div>
    )
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Owner (accountable)">
        <PeoplePicker value={t.owner_id} onChange={(v) => v !== t.owner_id && save.mutate({ owner_id: v })} placeholder="Unassigned" />
      </Field>
      <Field label="Backup" hint="Optional. Covers the task on the owner’s leave days.">
        <PeoplePicker value={t.backup_id} onChange={(v) => v !== t.backup_id && save.mutate({ backup_id: v })} filter={(p) => p.id !== t.owner_id} placeholder="No backup" clearable />
      </Field>
    </div>
  )
}

/** Low / Medium / High are the guide's three levels; Very high stays available as an extra. */
function ComplexityPicker({ value, onChange, disabled }: { value: Complexity; onChange: (c: Complexity) => void; disabled?: boolean }) {
  const main = ['low', 'medium', 'high'] as const
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        size="sm"
        value={(main as readonly string[]).includes(value) ? value : ('' as Complexity)}
        onChange={(v) => !disabled && v !== value && onChange(v)}
        options={main.map((c) => ({ value: c, label: COMPLEXITY[c].label }))}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => value !== 'very_high' && onChange('very_high')}
        aria-pressed={value === 'very_high'}
        className={cn('h-7 rounded-md border px-2.5 text-[12.5px] transition', value === 'very_high' ? 'border-danger bg-danger-soft font-medium text-danger-text' : 'border-line text-ink-3 hover:text-ink')}
      >
        Very high
      </button>
    </div>
  )
}

function EstimateDates({ d, editable, refetch }: { d: Detail; editable: boolean; refetch: () => void }) {
  const t = d.task
  const can = useCan()
  const [est, setEst] = useState(String(t.est_hours))
  useEffect(() => setEst(String(t.est_hours)), [t.est_hours])
  const save = useSave(t, refetch, () => setEst(String(t.est_hours)))
  const { askReason } = useConfirm()
  const changeDue = async (v: string) => {
    if (!v || v === t.due_on) return
    if (!t.owner_id) return save.mutate({ due_on: v })
    const reason = await askReason({ title: `Move the due date to ${fmtDate(v)}?`, body: `Currently due ${fmtDate(t.due_on)}. The owner is notified and the change stays in the task history.`, label: 'Why is the date moving?', placeholder: 'e.g. Client added two report formats to the scope', minLength: 10, confirmLabel: 'Move due date' })
    if (reason) save.mutate({ due_on: v, due_change_reason: reason })
  }
  const overdue = t.status !== 'done' && t.status !== 'in_review' && t.due_on < todayISO()
  const ratio = t.est_hours ? d.actual_hours / t.est_hours : 0
  const insightsLink = can('insights.view') ? (
    <Link to="/insights/estimation" onClick={() => useUI.getState().openTask(null)} className="font-medium text-brand-text hover:underline">
      Estimation accuracy
    </Link>
  ) : null
  return (
    <div className="space-y-3">
      {editable ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Estimated hours">
            <Input
              inputMode="decimal"
              suffix="h"
              value={est}
              onChange={(e) => setEst(e.target.value.replace(/[^0-9.]/g, ''))}
              onBlur={() => {
                const n = Number(est)
                if (!Number.isFinite(n) || n <= 0) return setEst(String(t.est_hours))
                if (n !== t.est_hours) save.mutate({ est_hours: Math.round(n * 4) / 4 })
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </Field>
          <Field label="Complexity">
            <ComplexityPicker value={t.complexity} onChange={(c) => save.mutate({ complexity: c })} />
          </Field>
          <Field label="Start">
            <Input type="date" value={t.start_on} onChange={(e) => e.target.value && e.target.value !== t.start_on && save.mutate({ start_on: e.target.value })} />
          </Field>
          <Field label="Due" error={overdue ? `${diffDays(todayISO(), t.due_on)} days overdue` : null}>
            <Input type="date" value={t.due_on} invalid={overdue} min={t.start_on} disabled={t.status === 'done'} onChange={(e) => changeDue(e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line px-4">
          <Row label="Estimated hours"><span className="tnum text-[13.5px]">{fmtHours(t.est_hours)}</span></Row>
          <Row label="Start"><span className="tnum text-[13.5px]">{fmtDate(t.start_on)}</span></Row>
          <Row label="Due"><span className={cn('tnum text-[13.5px]', overdue && 'font-medium text-danger-text')}>{fmtDate(t.due_on)}{overdue ? ` · ${diffDays(todayISO(), t.due_on)} days overdue` : ''}</span></Row>
          <Row label="Complexity"><StatusBadge map={COMPLEXITY} value={t.complexity} size="sm" /></Row>
        </div>
      )}
      <EstimateHintLine ownerId={t.owner_id} complexity={t.complexity} est={Number(est) || t.est_hours} onApply={editable && t.status !== 'done' ? (h) => { setEst(String(h)); save.mutate({ est_hours: h }) } : undefined} />
      <p className="text-[12px] leading-snug text-ink-3">
        Estimate vs actual hours, grouped by complexity and by person, is what {insightsLink ?? 'Estimation accuracy'}{insightsLink ? ' in Insights' : ' in Insights'} measures, so pick the complexity honestly.
      </p>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {[
          { k: 'Logged', v: fmtHours(d.actual_hours), cls: ratio > 1.2 ? 'text-danger-text' : 'text-ink' },
          { k: 'Estimate', v: fmtHours(t.est_hours), cls: 'text-ink' },
          { k: 'Approved', v: fmtHours(d.approved_hours), cls: 'text-ink' },
          { k: 'Remaining', v: t.est_hours > d.actual_hours ? fmtHours(t.est_hours - d.actual_hours) : '0h', cls: 'text-ink' },
        ].map((x) => (
          <div key={x.k} className="min-w-0 bg-surface px-3 py-2.5">
            <dt className="text-[12.5px] text-ink-3">{x.k}</dt>
            <dd className={cn('tnum mt-0.5 whitespace-nowrap text-[15px] font-semibold', x.cls)}>{x.v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2">
        <Progress className="flex-1" value={d.actual_hours} max={Math.max(t.est_hours, d.actual_hours, 1)} tone={ratio > 1.2 ? 'danger' : ratio > 1 ? 'warning' : 'brand'} height={4} />
        {ratio > 0 && <span className={cn('tnum shrink-0 text-[12px]', ratio > 1.2 ? 'font-medium text-danger-text' : 'text-ink-3')}>effort ratio ×{ratio.toFixed(2)}</span>}
      </div>
    </div>
  )
}

function MoreDetails({ d, editable, refetch }: { d: Detail; editable: boolean; refetch: () => void }) {
  const t = d.task
  const [desc, setDesc] = useState(t.description)
  const [descOpen, setDescOpen] = useState(false)
  useEffect(() => setDesc(t.description), [t.description])
  const save = useSave(t, refetch)
  const msOptions = [{ value: '', label: 'No milestone' }, ...(d.milestones ?? []).map((m) => ({ value: m.id, label: `M${m.no} ${m.name}` }))]
  if (!editable)
    return (
      <section className="divide-y divide-line rounded-lg border border-line px-4">
        <Row label="Tag"><span className="text-[13.5px]">{TASK_TAG_LABEL[t.tag ?? 'feature'].label}</span></Row>
        <Row label="Reviewer"><PersonName id={d.review.reviewer_id} size={22} /></Row>
        <Row label="Priority"><Badge size="sm" tone={PRIORITY_P[t.priority ?? 'normal'].tone}>{PRIORITY_P[t.priority ?? 'normal'].label}</Badge></Row>
        <Row label="Milestone"><span className="text-[13.5px]">{d.milestone ? `M${d.milestone.no} ${d.milestone.name}` : 'No milestone'}</span></Row>
        {t.description && (
          <div className="py-3">
            <div className="mb-1 text-[13px] text-ink-3">Description</div>
            <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{t.description}</p>
          </div>
        )}
      </section>
    )
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tag">
          <Select value={t.tag ?? 'feature'} onChange={(e) => save.mutate({ tag: e.target.value as TaskTag })} options={(Object.keys(TASK_TAG_LABEL) as TaskTag[]).map((k) => ({ value: k, label: TASK_TAG_LABEL[k].label }))} />
        </Field>
        <Field label="Reviewer" hint="Approves completion.">
          <PeoplePicker value={d.review.reviewer_id} onChange={(v) => v && v !== d.review.reviewer_id && save.mutate({ reviewer_id: v })} filter={(p) => p.id !== t.owner_id} />
        </Field>
        <Field label="Priority">
          <Select options={(['urgent', 'high', 'normal', 'low'] as const).map((value) => ({ value, label: PRIORITY_P[value].label }))} value={t.priority ?? 'normal'} onChange={(e) => save.mutate({ priority: e.target.value as 'normal' })} />
        </Field>
        <Field label="Milestone">
          <Select options={msOptions} value={t.milestone_id ?? ''} onChange={(e) => save.mutate({ milestone_id: e.target.value || null })} />
        </Field>
      </div>
      <Field label="Description" aside={descOpen ? null : undefined}>
        {descOpen || !t.description ? (
          <Textarea
            value={desc}
            rows={4}
            placeholder="Acceptance criteria, links and context for the owner"
            onFocus={() => setDescOpen(true)}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              setDescOpen(false)
              if (desc !== t.description) save.mutate({ description: desc })
            }}
          />
        ) : (
          <button type="button" onClick={() => setDescOpen(true)} className="w-full rounded-md border border-transparent px-3 py-2 text-left text-[14px] leading-relaxed text-ink-2 hover:border-line hover:bg-surface-2/60">
            <span className="whitespace-pre-wrap">{t.description}</span>
          </button>
        )}
      </Field>
    </section>
  )
}

/* ---------------- dependencies (Depends on / Blocks) ---------------- */
function Dependencies({ d, editable }: { d: Detail; editable: boolean }) {
  const inv = useTaskInvalidate()
  const people = usePeopleMap()
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<string[]>(d.dependencies.map((x) => x.id))
  const [cycle, setCycle] = useState<string | null>(null)
  useEffect(() => setSel(d.dependencies.map((x) => x.id)), [d.dependencies])
  const save = useMut((ids: string[]) => tasksApi.setDependencies(d.task.id, ids), {
    success: 'Dependencies saved',
    silentError: true,
    onSuccess: () => {
      setCycle(null)
      setOpen(false)
      inv(d.task.id)
    },
    onError: (e: ApiError) => {
      if (e.code === 'DEP_CYCLE') {
        setCycle(e.message)
        toast.error('That would create a loop', { description: e.message })
      } else toast.error(e.code === 'ROUTE_NOT_FOUND' ? 'Dependencies can’t be edited yet' : 'Couldn’t save dependencies', { description: e.message })
    },
  })
  const all = d.project_tasks ?? []
  const loops = new Set(d.downstream_ids ?? [])
  const openCount = d.waiting_on.filter((x) => !x.done).length
  const Chip = ({ r, kind }: { r: RiskTaskLink; kind: 'waits' | 'blocks' }) => (
    <div className={cn('flex items-start gap-1 pr-1.5', !r.done && kind === 'waits' ? 'bg-danger-soft/35' : r.held_up && kind === 'blocks' ? 'bg-warning-soft/40' : '')}>
      <button type="button" onClick={() => useUI.getState().openTask(r.id)} className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2 text-left transition hover:bg-surface-2/60">
        <span className="tnum mt-px shrink-0 text-[12.5px] text-ink-3">{r.wbs}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px]">{r.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-3">
            <span>owner {people.get(r.owner_id)?.name ?? 'unassigned'}</span>
            <span aria-hidden>·</span>
            <span className={cn(!r.done && kind === 'waits' && 'font-medium text-danger-text')}>{r.done ? 'Done' : `${TASK_STAGE[r.stage].label}${r.progress && r.stage !== 'new' && r.stage !== 'selected' ? ` ${r.progress}%` : ''}`}</span>
            <span aria-hidden>·</span>
            <span className={cn('tnum', r.held_up && (kind === 'waits' ? 'text-danger-text' : 'text-warning-text'))}>
              {kind === 'waits' ? (r.done ? `finished ${fmtDate(r.done_on ?? r.due_on)}` : `ends ${fmtDate(r.forecast_end)}`) : r.done ? `finished ${fmtDate(r.done_on ?? r.due_on)}` : `starts ${fmtDate(r.start_on)}${r.held_up ? ', will be held up' : ''}`}
            </span>
          </span>
        </span>
      </button>
      {kind === 'waits' && editable && (
        <IconButton size="xs" variant="ghost" label={`Remove dependency on ${r.wbs}`} className="mt-1.5" disabled={save.isPending} onClick={() => save.mutate(d.dependencies.map((x) => x.id).filter((x) => x !== r.id))}>
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  )
  return (
    <section>
      <SectionHead
        title="Depends on"
        hint="Tasks that must finish first. It can’t be started while one of them is open. Dependency chains build the critical path."
        action={
          editable ? (
            <Popover
              open={open}
              onOpenChange={(o) => {
                setOpen(o)
                if (!o) {
                  setSel(d.dependencies.map((x) => x.id))
                  setCycle(null)
                }
              }}
              align="end"
              className="w-[min(400px,92vw)] p-0"
              trigger={
                <Button size="sm" icon={<Plus className="size-4" />}>
                  Add dependency
                </Button>
              }
            >
              <Command className="flex max-h-[400px] flex-col" loop>
                <div className="border-b border-line px-3">
                  <Command.Input autoFocus placeholder="Search tasks in this project" className="h-11 w-full bg-transparent text-[14px] outline-none placeholder:text-ink-3" />
                </div>
                <Command.List className="min-h-0 flex-1 overflow-y-auto p-1 scroll-thin">
                  <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-3">No other tasks in this project</Command.Empty>
                  {all.map((r) => {
                    const on = sel.includes(r.id)
                    const loop = loops.has(r.id)
                    return (
                      <Command.Item
                        key={r.id}
                        value={`${r.wbs} ${r.title}`}
                        disabled={loop}
                        onSelect={() => !loop && setSel((s) => (on ? s.filter((x) => x !== r.id) : [...s, r.id]))}
                        className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] data-[selected=true]:bg-surface-2', loop ? 'cursor-not-allowed opacity-55' : 'cursor-pointer')}
                      >
                        <span className={cn('grid size-4 shrink-0 place-items-center rounded-[4px] border', on ? 'border-brand bg-brand text-white' : 'border-line-strong')}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                        <span className="tnum w-9 shrink-0 text-[12.5px] text-ink-3">{r.wbs}</span>
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        <span className="shrink-0 text-[12px] text-ink-3">{loop ? 'would loop' : TASK_STATUS[r.status].label}</span>
                      </Command.Item>
                    )
                  })}
                </Command.List>
              </Command>
              {cycle && <div className="border-t border-line bg-danger-soft px-3 py-2 text-[12.5px] font-medium text-danger-text">{cycle}</div>}
              <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
                <span className="text-[12px] text-ink-3">{sel.length} selected{loops.size ? ` · ${loops.size} greyed out: they already depend on this task` : ''}</span>
                <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(sel)}>
                  Save
                </Button>
              </div>
            </Popover>
          ) : undefined
        }
      />
      {d.waiting_on.length ? (
        <>
          {openCount > 0 && d.task.status !== 'done' && <p className="mb-2 text-[12.5px] font-medium text-danger-text">{openCount} open: this task can’t start until {openCount === 1 ? 'it finishes' : 'they finish'}.</p>}
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">{d.waiting_on.map((r) => <Chip key={r.id} r={r} kind="waits" />)}</div>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-3">No dependencies. This task can start any time.</p>
      )}
      <h4 className="mb-2 mt-4 text-[13px] font-semibold text-ink">Blocks {d.blocks.length ? <span className="tnum font-normal text-ink-3">({d.blocks.length})</span> : null}</h4>
      {d.blocks.length > 0 ? (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">{d.blocks.map((r) => <Chip key={r.id} r={r} kind="blocks" />)}</div>
      ) : (
        <p className="text-[13px] text-ink-3">No task waits on this one.</p>
      )}
    </section>
  )
}

/* ---------------- comments ---------------- */
function Comments({ d }: { d: Detail }) {
  const id = d.task.id
  const ro = useReadOnly()
  const me = useSession((s) => s.user)
  const people = usePeopleMap()
  const q = useApi(['task', id, 'comments'], () => tasksApi.comments(id))
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const names = useMemo(() => (people.data ?? []).map((p) => p.name), [people.data])
  const add = useMut((v: { body: string; parent_id: string | null }) => tasksApi.addComment(id, v.body, mentionsIn(v.body, people.data ?? []), v.parent_id), {
    invalidate: [['task', id, 'comments'], ['task', id], ['tasks']],
    success: (r, v) => {
      const n = (r as Comment).mentions?.filter((x) => x !== me?.id).length ?? 0
      const base = v.parent_id ? 'Reply posted' : 'Comment posted'
      return n ? `${base} · ${n === 1 ? `${people.get((r as Comment).mentions.find((x) => x !== me?.id))?.name ?? 'They'} gets` : `${n} people get`} a notification` : base
    },
    onSuccess: (_r, v) => {
      if (v.parent_id) {
        setReply('')
        setReplyTo(null)
      } else setText('')
    },
  })
  const tops = (q.data ?? []).filter((c) => !c.parent_id)
  const repliesOf = (cid: string) => (q.data ?? []).filter((c) => c.parent_id === cid)
  const canPost = d.can_comment && !ro
  const endRef = useRef<HTMLDivElement>(null)

  const Bubble = ({ c, isReply }: { c: Comment; isReply?: boolean }) => {
    const a = people.get(c.author_id)
    return (
      <div className="flex gap-2.5">
        <Avatar name={a?.name ?? '?'} hue={a?.avatar_hue ?? 150} size={isReply ? 24 : 30} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-medium text-ink">{a?.name ?? 'Former user'}</span>
            <span className="text-[12px] text-ink-3" title={new Date(c.created_at).toLocaleString('en-IN')}>{relTime(c.created_at)}</span>
          </div>
          <div className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">
            <RichText text={c.body} names={names} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <section id="thread" className="scroll-mt-20">
      <SectionHead
        title={`Thread${q.data?.length ? ` · ${q.data.length} comment${q.data.length === 1 ? '' : 's'}` : ''}`}
        hint="Comments on the task. Typing @name mentions a person: they get a notification and see it under “Tagged you” on their dashboard."
      />
      {q.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4">
          {!tops.length && <p className="text-[13px] text-ink-3">No comments yet. Ask a question or share an update — type @ to tag someone.</p>}
          {tops.map((c) => {
            const reps = repliesOf(c.id)
            return (
              <div key={c.id}>
                <Bubble c={c} />
                <div className="ml-10 mt-2 space-y-2.5 border-l border-line pl-3">
                  {reps.map((r) => (
                    <Bubble key={r.id} c={r} isReply />
                  ))}
                  {replyTo === c.id ? (
                    <div className="space-y-2">
                      <MentionInput value={reply} onChange={setReply} rows={2} autoFocus placeholder="Reply. Type @ to tag someone." onSubmit={() => reply.trim() && add.mutate({ body: reply.trim(), parent_id: c.id })} />
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="primary" disabled={!reply.trim()} loading={add.isPending} onClick={() => add.mutate({ body: reply.trim(), parent_id: c.id })}>
                          Reply
                        </Button>
                      </div>
                    </div>
                  ) : (
                    canPost && (
                      <button type="button" onClick={() => { setReplyTo(c.id); setReply('') }} className="text-[12.5px] font-medium text-ink-3 hover:text-brand-text">
                        Reply{reps.length ? ` (${reps.length})` : ''}
                      </button>
                    )
                  )}
                </div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}
      {canPost ? (
        <div className="mt-4 flex gap-2.5">
          <Avatar name={me?.name ?? '?'} hue={me?.avatar_hue ?? 150} size={30} className="hidden sm:inline-grid" />
          <div className="min-w-0 flex-1 space-y-2">
            <MentionInput value={text} onChange={setText} placeholder="Write a comment. Type @ to tag someone." onSubmit={() => text.trim() && add.mutate({ body: text.trim(), parent_id: null })} />
            <div className="flex items-center justify-between gap-2">
              <span className="hidden text-[12px] text-ink-3 sm:inline">⌘ Enter to post</span>
              <Button size="sm" variant="primary" disabled={!text.trim()} loading={add.isPending && !replyTo} onClick={() => add.mutate({ body: text.trim(), parent_id: null })} className="ml-auto">
                Comment
              </Button>
            </div>
          </div>
        </div>
      ) : (
        !ro && <p className="mt-3 text-[12.5px] text-ink-3">Only people on this project can comment.</p>
      )}
    </section>
  )
}

/* ---------------- review bar (v3 governance) ---------------- */
function ReviewBar({ d, onAction }: { d: Detail; onAction: (a: 'submit' | 'approve' | 'send_back' | 'direct') => void }) {
  const ro = useReadOnly()
  const people = usePeopleMap()
  const t = d.task
  const rv = d.review
  const reviewer = people.get(rv.reviewer_id)?.name ?? 'the reviewer'
  const last = rv.reviews[rv.reviews.length - 1]
  const sentBack = t.status !== 'in_review' && t.status !== 'done' && last?.decision === 'sent_back'
  if (t.status === 'done')
    return (
      <section className="rounded-lg border border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[13.5px] font-medium text-ink">{t.approved_by ? `Approved by ${people.get(t.approved_by)?.name ?? '—'}` : 'Done'}</span>
          <TimelinessBadge timeliness={t.timeliness} variance={t.variance_days} />
          <RatingText value={t.quality_rating} />
        </div>
        <p className="tnum mt-1 text-[12.5px] text-ink-3">
          Finished {fmtDate(t.done_on)} · due {fmtDate(t.due_on)}{t.approved_on ? ` · approved ${fmtDate(t.approved_on)}` : ''}{rv.reviews.length > 1 ? ` · ${rv.reviews.length} review rounds` : ''}
        </p>
        {t.delay_reason_code && <p className="mt-1 text-[12.5px] text-warning-text">Delay — {delayLabel(t.delay_reason_code)}: {t.delay_reason}</p>}
      </section>
    )
  if (t.status === 'in_review')
    return (
      <Callout tone="info" title={rv.can_review ? `Waiting for your review · round ${last?.round ?? 1}` : `Waiting for ${reviewer}’s review`}>
        <span className="tnum">Submitted {fmtDate(t.submitted_on)}</span>
        {t.submitted_on && t.submitted_on > t.due_on && <span className="text-danger-text"> · after the due date ({fmtDate(t.due_on)})</span>}
        {last?.submission_note && <span className="mt-1 block text-ink-2">“{last.submission_note}”</span>}
        {rv.can_review && !ro && (
          <span className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button size="sm" variant="secondary" onClick={() => onAction('send_back')}>Send back</Button>
            <Button size="sm" variant="primary" onClick={() => onAction('approve')}>Approve</Button>
          </span>
        )}
      </Callout>
    )
  return (
    <div className="space-y-3">
      {sentBack && (
        <Callout tone="danger" title={`Sent back by ${people.get(last.decided_by)?.name ?? 'the reviewer'}`}>
          {last.decision_reason}
        </Callout>
      )}
      {rv.can_submit && !ro && (
        <div className="flex flex-col gap-2 rounded-lg border border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-[13px] text-ink-2">
            <span className="font-medium text-ink">Finished?</span> {reviewer === 'the reviewer' ? 'Submit it for review.' : `${reviewer} reviews and approves it.`}
            {rv.late_now && <LateBadge days={rv.late_by_days} className="ml-2" />}
            {rv.late_now && <span className="mt-0.5 block text-[12.5px] text-ink-3">It’s past the due date — you’ll be asked for the reason.</span>}
          </div>
          <Button size="sm" variant="primary" className="shrink-0" onClick={() => onAction('submit')}>
            {sentBack ? 'Resubmit for review' : 'Submit for review'}
          </Button>
        </div>
      )}
      {!rv.can_submit && rv.reviewer_id && (
        <p className="text-[12.5px] text-ink-3">
          Reviewer: <span className="font-medium text-ink-2">{reviewer}</span>
        </p>
      )}
    </div>
  )
}
