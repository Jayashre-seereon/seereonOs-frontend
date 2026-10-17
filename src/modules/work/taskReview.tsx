// Task review building blocks (v3 governance): submit for review, approve with a quality rating, send back,
// timeliness badge and the review timeline. Used by the task drawer, My tasks, Team tasks and project screens.
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, CornerDownLeft, ExternalLink, History, Send } from '@/ui/icons'
import { useMut } from '@/api/query'
import { tasksApi, taskflowApi, type TaskReviewInfo, type Timeliness } from '@/api/tasks'
import type { ApiError } from '@/api/http'
import { usePeopleMap } from '@/api/core'
import type { TaskReview } from '@/types/business'
import { diffDays, fmtDate, fmtDateTime, todayISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { Badge, Button, Callout, Dialog, Field, Input, Select, Textarea } from '@/ui'
import { useTaskInvalidate } from './TaskDrawerHost'

/* ---------------- labels ---------------- */
export const DELAY_REASONS: { value: string; label: string }[] = [
  { value: 'scope_change', label: 'Scope changed' },
  { value: 'dependency', label: 'Waiting on another task' },
  { value: 'client_delay', label: 'Client delay / input pending' },
  { value: 'underestimated', label: 'Effort underestimated' },
  { value: 'leave_absence', label: 'Leave or absence' },
  { value: 'priority_change', label: 'Re-prioritised by manager' },
  { value: 'technical_issue', label: 'Technical issue' },
  { value: 'resource_shortage', label: 'Resource shortage' },
  { value: 'other', label: 'Other' },
]
export const delayLabel = (c: string | null | undefined) => (c ? DELAY_REASONS.find((r) => r.value === c)?.label ?? c : '')
export const RATING_LABEL = ['', 'Needs rework', 'Below expectations', 'Meets expectations', 'Good', 'Excellent']
export const PRIORITY: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'danger' }> = {
  low: { label: 'Low', tone: 'neutral' },
  normal: { label: 'Normal', tone: 'neutral' },
  high: { label: 'High', tone: 'warning' },
  urgent: { label: 'Urgent', tone: 'danger' },
}

/* ---------------- badges ---------------- */
export function TimelinessBadge({ timeliness, variance, size = 'sm', className }: { timeliness: Timeliness | null | undefined; variance: number | null | undefined; size?: 'sm' | 'md'; className?: string }) {
  if (!timeliness) return null
  const v = Math.abs(variance ?? 0)
  const label = timeliness === 'early' ? `Early by ${v}d` : timeliness === 'late' ? `Late by ${v}d` : 'On time'
  return (
    <Badge size={size} tone={timeliness === 'late' ? 'danger' : 'success'} className={cn('whitespace-nowrap', className)}>
      {label}
    </Badge>
  )
}
export function LateBadge({ days, className }: { days: number; className?: string }) {
  if (days <= 0) return null
  return (
    <Badge size="sm" tone="danger" className={cn('whitespace-nowrap', className)}>
      {days}d late
    </Badge>
  )
}
export function RatingText({ value, className }: { value: number | null | undefined; className?: string }) {
  if (!value) return null
  return (
    <span className={cn('tnum whitespace-nowrap text-[12.5px] text-ink-2', className)} title={RATING_LABEL[value]}>
      Quality {value}/5
    </span>
  )
}

/** 1–5 quality rating as a row of buttons (keyboard and touch friendly). */
export function RatingInput({ value, onChange, invalid }: { value: number; onChange: (v: number) => void; invalid?: boolean }) {
  return (
    <div>
      <div role="radiogroup" aria-label="Quality rating" className={cn('grid grid-cols-5 gap-1 rounded-md border bg-surface-2 p-0.5', invalid ? 'border-danger' : 'border-line')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} — ${RATING_LABEL[n]}`}
            onClick={() => onChange(n)}
            className={cn(
              'tnum h-10 rounded-[5px] text-[14px] font-semibold transition sm:h-9',
              value >= n && value ? 'bg-brand text-white' : 'text-ink-2 hover:bg-surface hover:text-ink',
              value === n && 'ring-2 ring-brand/30',
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="mt-1 h-4 text-[12px] text-ink-3">{value ? RATING_LABEL[value] : 'Rate the quality of the work'}</p>
    </div>
  )
}

/* ---------------- submit for review ---------------- */
export interface SubmittableTask {
  id: string
  title: string
  wbs?: string
  due_on: string
}
export function SubmitReviewDialog({ task, open, onOpenChange, onDone }: { task: SubmittableTask | null; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const inv = useTaskInvalidate()
  const [note, setNote] = useState('')
  const [proof, setProof] = useState('')
  const [code, setCode] = useState('')
  const [reason, setReason] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (open) {
      setNote('')
      setProof('')
      setCode('')
      setReason('')
      setErrs({})
      setTouched(false)
    }
  }, [open, task?.id])
  const today = todayISO()
  const late = !!task && today > task.due_on
  const lateDays = task && late ? diffDays(today, task.due_on) : 0
  const m = useMut(() => taskflowApi.submit(task!.id, { note: note.trim(), proof_url: proof.trim() || null, delay_reason_code: (late ? code : null) as never, delay_reason: late ? reason.trim() : null }), {
    success: 'Submitted for review',
    silentError: true,
    onSuccess: () => {
      inv(task!.id)
      onOpenChange(false)
      onDone?.()
    },
    onError: (e: ApiError) => {
      if (e.field) setErrs({ [e.field]: e.message })
      else setErrs({ _: e.message })
    },
  })
  const local: Record<string, string | null> = {
    note: note.trim().length < 5 ? 'Describe what you delivered (at least 5 characters).' : null,
    delay_reason_code: late && !code ? 'Choose why it’s late.' : null,
    delay_reason: late && reason.trim().length < 15 ? `Explain the delay in at least 15 characters (${reason.trim().length}/15).` : null,
    proof_url: proof.trim() && !/^https?:\/\/\S+\.\S+/.test(proof.trim()) ? 'Use a full link starting with https://' : null,
  }
  const show = (k: string) => (touched ? local[k] : null) || errs[k] || null
  const go = () => {
    setTouched(true)
    setErrs({})
    if (Object.values(local).some(Boolean)) return
    m.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Submit for review"
      description={task ? `${task.wbs ? `${task.wbs} ` : ''}${task.title}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Send className="size-4" />} loading={m.isPending} onClick={go}>
            Submit for review
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {late && (
          <Callout tone="warning" icon={<AlertTriangle />} title={`Due ${fmtDate(task!.due_on)} — ${lateDays} day${lateDays === 1 ? '' : 's'} late`}>
            Tell your reviewer why. The reason stays on the task and shows on the delivery dashboards.
          </Callout>
        )}
        <Field label="What did you deliver?" required error={show('note')} hint="What changed, where to look, how it was tested.">
          <Textarea rows={4} value={note} invalid={!!show('note')} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Payslip PDF matches the approved layout; tested with 12 employees across both mines." />
        </Field>
        <Field label="Proof link" error={show('proof_url')} hint="Optional — a PR, a Drive folder, a staging URL or a screen recording.">
          <Input value={proof} invalid={!!show('proof_url')} onChange={(e) => setProof(e.target.value)} placeholder="https://" inputMode="url" />
        </Field>
        {late && (
          <div className="grid gap-4">
            <Field label="Reason for delay" required error={show('delay_reason_code')}>
              <Select value={code} invalid={!!show('delay_reason_code')} onChange={(e) => setCode(e.target.value)} placeholder="Choose a reason" options={DELAY_REASONS} />
            </Field>
            <Field label="What happened?" required error={show('delay_reason')} hint="At least 15 characters: the cause and what you did about it.">
              <Textarea rows={3} value={reason} invalid={!!show('delay_reason')} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client shared the final pay structure two days late, so testing moved to Monday." />
            </Field>
          </div>
        )}
        {errs._ && <p className="text-[13px] font-medium text-danger-text">{errs._}</p>}
      </div>
    </Dialog>
  )
}

/* ---------------- approve / send back ---------------- */
export function useReviewActions(taskId: string, onDone?: () => void) {
  const inv = useTaskInvalidate()
  const done = () => {
    inv(taskId)
    onDone?.()
  }
  const approve = useMut((v: { rating: number; note: string }) => taskflowApi.approve(taskId, v.rating, v.note.trim() || undefined), { success: 'Task approved', onSuccess: done, silentError: true })
  const sendBack = useMut((v: { reason: string; due: string }) => taskflowApi.sendBack(taskId, v.reason.trim(), v.due || null), { success: 'Sent back to the owner', onSuccess: done, silentError: true })
  const direct = useMut((v: { rating: number; note: string }) => tasksApi.setStatus(taskId, 'done', null, v.rating), { success: 'Marked done', onSuccess: done, silentError: true })
  return { approve, sendBack, direct }
}

/** Approve form body (inline or in a dialog). */
export function ApproveForm({ taskId, onDone, onCancel, direct, compact }: { taskId: string; onDone?: () => void; onCancel?: () => void; direct?: boolean; compact?: boolean }) {
  const { approve, direct: directMut } = useReviewActions(taskId, onDone)
  const mut = direct ? directMut : approve
  const [rating, setRating] = useState(0)
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const errMsg = (mut.error as ApiError | null)?.message
  return (
    <div className="space-y-3">
      <Field label="Quality" required error={touched && !rating ? 'Choose a rating from 1 to 5.' : null}>
        <RatingInput value={rating} onChange={setRating} invalid={touched && !rating} />
      </Field>
      <Field label="Note to the owner" hint="Optional — what was good, what to keep doing.">
        <Textarea rows={compact ? 2 : 3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Clean handover, tests included." />
      </Field>
      {errMsg && <p className="text-[12.5px] font-medium text-danger-text">{errMsg}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          icon={<Check className="size-4" />}
          loading={mut.isPending}
          onClick={() => {
            setTouched(true)
            if (rating) mut.mutate({ rating, note })
          }}
        >
          {direct ? 'Mark done' : 'Approve'}
        </Button>
      </div>
    </div>
  )
}

export function SendBackForm({ taskId, dueOn, onDone, onCancel, compact }: { taskId: string; dueOn: string; onDone?: () => void; onCancel?: () => void; compact?: boolean }) {
  const { sendBack } = useReviewActions(taskId, onDone)
  const [reason, setReason] = useState('')
  const [due, setDue] = useState('')
  const [touched, setTouched] = useState(false)
  const today = todayISO()
  const err = (sendBack.error as ApiError | null) ?? null
  const short = reason.trim().length < 10
  return (
    <div className="space-y-3">
      <Field label="What needs to change?" required error={touched && short ? `Write at least 10 characters (${reason.trim().length}/10).` : err?.field === 'reason' ? err.message : null}>
        <Textarea rows={compact ? 2 : 3} value={reason} invalid={touched && short} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The export misses the arrears column; add it and attach a sample file." />
      </Field>
      <Field label="New due date" hint={`Optional — currently due ${fmtDate(dueOn)}. The change is kept in the task history.`} error={err?.field === 'new_due_on' ? err.message : null}>
        <Input type="date" value={due} min={today} onChange={(e) => setDue(e.target.value)} />
      </Field>
      {err && !err.field && <p className="text-[12.5px] font-medium text-danger-text">{err.message}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="outline-danger"
          icon={<CornerDownLeft className="size-4" />}
          loading={sendBack.isPending}
          onClick={() => {
            setTouched(true)
            if (!short) sendBack.mutate({ reason, due })
          }}
        >
          Send back
        </Button>
      </div>
    </div>
  )
}

export function ReviewDialog({ mode, task, open, onOpenChange, onDone }: { mode: 'approve' | 'send_back' | 'direct'; task: { id: string; title: string; wbs?: string; due_on: string } | null; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  if (!task) return null
  const close = () => onOpenChange(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={mode === 'send_back' ? 'Send back for changes' : mode === 'direct' ? 'Mark done' : 'Approve task'} description={`${task.wbs ? `${task.wbs} ` : ''}${task.title}`}>
      <div className="pb-1">
        {mode === 'send_back' ? (
          <SendBackForm key={task.id} taskId={task.id} dueOn={task.due_on} onCancel={close} onDone={() => { close(); onDone?.() }} />
        ) : (
          <ApproveForm key={task.id} taskId={task.id} direct={mode === 'direct'} onCancel={close} onDone={() => { close(); onDone?.() }} />
        )}
      </div>
    </Dialog>
  )
}

/* ---------------- review timeline ---------------- */
function Step({ title, at, children, tone = 'neutral' }: { title: ReactNode; at?: string | null; children?: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'info' }) {
  const dot = { neutral: 'bg-line-strong', success: 'bg-success', danger: 'bg-danger', info: 'bg-info' }[tone]
  return (
    <li className="relative pb-4 pl-5 last:pb-0">
      <span className={cn('absolute left-0 top-[7px] size-2 rounded-full', dot)} aria-hidden />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="min-w-0 text-[13.5px] text-ink">{title}</div>
        {at && <span className="tnum shrink-0 text-[12px] text-ink-3">{fmtDateTime(at)}</span>}
      </div>
      {children && <div className="mt-1 space-y-1 text-[13px] leading-relaxed text-ink-2">{children}</div>}
    </li>
  )
}

export function ReviewTimeline({ reviews, reschedules, dueOn }: { reviews: TaskReview[]; reschedules?: TaskReviewInfo['reschedules']; dueOn: string }) {
  const people = usePeopleMap()
  const name = (id: string | null | undefined) => people.get(id)?.name ?? 'Someone'
  if (!reviews.length && !reschedules?.length) return <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-3">Not submitted yet. When the owner submits it, each review round shows here.</p>
  type Ev = { at: string; node: ReactNode }
  const ev: Ev[] = []
  for (const r of reviews) {
    const lateSub = r.submitted_at.slice(0, 10) > dueOn
    ev.push({
      at: r.submitted_at,
      node: (
        <Step key={`s${r.id}`} at={r.submitted_at} tone="info" title={<><span className="font-medium">{name(r.submitted_by)}</span> submitted round {r.round}{lateSub && <Badge size="sm" tone="danger" className="ml-2">after due date</Badge>}</>}>
          {r.submission_note && <p className="whitespace-pre-wrap">{r.submission_note}</p>}
          {r.delay_reason_code && (
            <p className="text-warning-text">
              <span className="font-medium">Delay — {delayLabel(r.delay_reason_code)}:</span> {r.delay_reason}
            </p>
          )}
          {r.proof_url && (
            <a href={r.proof_url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-brand-text hover:underline">
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="truncate">{r.proof_url}</span>
            </a>
          )}
        </Step>
      ),
    })
    if (r.decision && r.decided_at)
      ev.push({
        at: r.decided_at,
        node: (
          <Step key={`d${r.id}`} at={r.decided_at} tone={r.decision === 'approved' ? 'success' : 'danger'} title={<><span className="font-medium">{name(r.decided_by)}</span> {r.decision === 'approved' ? 'approved' : 'sent it back'}{r.quality_rating ? <span className="tnum ml-2 text-[12.5px] text-ink-3">Quality {r.quality_rating}/5 · {RATING_LABEL[r.quality_rating]}</span> : null}</>}>
            {r.decision_reason && <p className={cn('whitespace-pre-wrap', r.decision === 'sent_back' && 'text-danger-text')}>{r.decision_reason}</p>}
          </Step>
        ),
      })
  }
  for (const s of reschedules ?? [])
    ev.push({
      at: s.at,
      node: (
        <Step key={`r${s.at}`} at={s.at} title={<><History className="mr-1 inline size-3.5 text-ink-3" /><span className="font-medium">{name(s.actor_id)}</span> rescheduled</>}>
          <p>{s.summary}</p>
        </Step>
      ),
    })
  ev.sort((a, b) => a.at.localeCompare(b.at))
  return <ol className="rounded-lg border border-line px-4 py-3">{ev.map((e) => e.node)}</ol>
}
