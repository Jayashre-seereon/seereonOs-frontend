// v5 task workflow UI (Feature Guide §7): the 10-stage select, Update progress, Flag slip, Reassign, Remove/cancel
// and the estimate check. Every screen that changes a task's state uses these, so the review flow
// (Completed → submit / approve) and the dependency rule behave the same everywhere.
import { useEffect, useState } from 'react'
import type { Complexity, TaskStage, TaskStatus, TaskTag } from '@/types/entities'
import { deliveryApi } from '@/api/work'
import { tasksApi } from '@/api/tasks'
import { toastError, useApi, useMut } from '@/api/query'
import { TASK_STAGE, TASK_STAGE_ORDER, TASK_TAG_LABEL } from '@/domain/labels'
import { STAGE } from '@/domain/delivery'
import { fmtDate, todayISO } from '@/domain/calendar'
import { fmtHours } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Dialog, Field, Input, PeoplePicker, Select, Textarea, toast, useConfirm, useReadOnly } from '@/ui'
import { Lightbulb } from '@/ui/icons'
import { ReviewDialog, SubmitReviewDialog } from './taskReview'
import { useTaskInvalidate } from './TaskDrawerHost'

/** The minimum a row needs for the stage control and the action dialogs. */
export interface StageTask {
  id: string
  title: string
  wbs: string
  due_on: string
  start_on?: string
  stage: TaskStage
  progress: number
  status: TaskStatus
  version?: number
  can_move: boolean
  can_submit: boolean
  can_review: boolean
  can_edit?: boolean
  owner_id?: string | null
  backup_id?: string | null
  logged_hours?: number
}

export function StageBadge({ stage, progress, size = 'sm', className }: { stage: TaskStage; progress?: number; size?: 'sm' | 'md'; className?: string }) {
  const s = TASK_STAGE[stage]
  return (
    <Badge tone={s.tone} size={size} className={className}>
      {s.label}
      {progress !== undefined && stage !== 'completed' && stage !== 'new' && stage !== 'selected' ? <span className="tnum">{progress}%</span> : null}
    </Badge>
  )
}
export function TagBadge({ tag, size = 'sm' }: { tag: TaskTag | null | undefined; size?: 'sm' | 'md' }) {
  if (!tag || tag === 'feature') return null
  const t = TASK_TAG_LABEL[tag]
  return (
    <Badge tone={t.tone} size={size}>
      {t.label}
    </Badge>
  )
}

/* ---------------------------------------------------------------- */
/* Stage select                                                       */
/* ---------------------------------------------------------------- */
const REVIEW = '__review'
const APPROVE = '__approve'
const SEND_BACK = '__send_back'

export function StageSelect({ t, size = 'md', className, label = 'Stage' }: { t: StageTask; size?: 'sm' | 'md'; className?: string; label?: string }) {
  const ro = useReadOnly()
  const inv = useTaskInvalidate()
  const { askReason } = useConfirm()
  const [dlg, setDlg] = useState<null | 'submit' | 'approve' | 'send_back' | 'direct'>(null)
  const mut = useMut((b: { stage: TaskStage; note?: string | null }) => deliveryApi.setStage(t.id, b), {
    success: (_r, b) => `${t.wbs} → ${TASK_STAGE[b.stage].label}`,
    onSuccess: () => inv(t.id),
    silentError: true,
    onError: (e, b) => {
      // G7.05: "A task cannot be started while something it depends on is still open" — the server names the
      // blocking task and its owner, so the conversation goes to the right person.
      if (e.code === 'TASK_BLOCKED') toast.error(`${t.wbs} can’t move to ${TASK_STAGE[b.stage].label} yet`, { description: e.message, duration: 9000 })
      else toastError(e)
      inv(t.id)
    },
  })
  const inReview = t.status === 'in_review'
  const onChange = async (v: string) => {
    if (v === REVIEW || v === t.stage) return
    if (v === APPROVE) return setDlg('approve')
    if (v === SEND_BACK) return setDlg('send_back')
    const stage = v as TaskStage
    if (stage === 'completed') {
      if (t.can_review) return setDlg('direct')
      if (t.can_submit) return setDlg('submit')
      return toast.info('Tasks are completed through review', { description: 'The owner submits it for review and the reviewer approves it.' })
    }
    let note: string | null = null
    if (STAGE[stage].group === 'waiting') {
      note = await askReason({
        title: `${TASK_STAGE[stage].label}: ${t.wbs}`,
        body: stage === 'waiting_feedback' ? 'Whose feedback are you waiting for, and on what? It shows on the PM’s risk list.' : stage === 'on_hold' ? 'Why is it on hold? It shows on the PM’s risk list.' : 'What is blocking the task? The project manager is notified.',
        label: stage === 'waiting_feedback' ? 'Waiting for' : stage === 'on_hold' ? 'On hold because' : 'Blocked because',
        placeholder: stage === 'waiting_feedback' ? 'e.g. Needs the final role list from the school principal' : stage === 'on_hold' ? 'e.g. Client paused UAT until the new term' : 'e.g. Waiting on client VPN access',
        minLength: stage === 'blocked' ? 3 : 5,
        confirmLabel: `Move to ${TASK_STAGE[stage].label}`,
      })
      if (!note) return
    }
    mut.mutate({ stage, note })
  }
  const options = [
    ...(inReview ? [{ value: REVIEW, label: `In review (${TASK_STAGE[t.stage].label})` }] : []),
    ...(inReview && t.can_review ? [{ value: APPROVE, label: 'Approve…' }, { value: SEND_BACK, label: 'Send back…' }] : []),
    ...(inReview ? [] : TASK_STAGE_ORDER.map((s) => ({ value: s, label: s === 'completed' && t.status !== 'done' ? (t.can_review ? 'Completed (approve)…' : 'Completed (submit for review)…') : TASK_STAGE[s].label }))),
  ]
  const reviewer = inReview && !t.can_review
  return (
    <>
      <Select
        aria-label={label}
        className={cn(size === 'sm' ? '[--ctl-h:32px] text-[13px]' : '[--ctl-h:36px] text-[13.5px]', className)}
        value={inReview ? REVIEW : t.stage}
        disabled={ro || !t.can_move || mut.isPending || reviewer}
        title={reviewer ? 'Waiting for the reviewer to approve or send back' : undefined}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
        options={options}
      />
      <span onClick={(e) => e.stopPropagation()} className="contents">
        <SubmitReviewDialog open={dlg === 'submit'} onOpenChange={(o) => !o && setDlg(null)} task={{ id: t.id, title: t.title, wbs: t.wbs, due_on: t.due_on }} onDone={() => inv(t.id)} />
        <ReviewDialog
          mode={dlg === 'send_back' ? 'send_back' : dlg === 'direct' ? 'direct' : 'approve'}
          open={dlg === 'approve' || dlg === 'send_back' || dlg === 'direct'}
          onOpenChange={(o) => !o && setDlg(null)}
          task={{ id: t.id, title: t.title, wbs: t.wbs, due_on: t.due_on }}
          onDone={() => inv(t.id)}
        />
      </span>
    </>
  )
}

/* ---------------------------------------------------------------- */
/* Update progress                                                    */
/* ---------------------------------------------------------------- */
export function ProgressDialog({ t, open, onOpenChange }: { t: StageTask | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const inv = useTaskInvalidate()
  const [v, setV] = useState(0)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !t) return
    setV(t.progress)
    setNote('')
    setError(null)
  }, [open, t])
  const min = t ? STAGE[t.stage].minProgress : 0
  const mut = useMut((b: { progress: number; note?: string }) => deliveryApi.setProgress(t!.id, b), {
    success: (_r, b) => `${t!.wbs} at ${b.progress}%`,
    silentError: true,
    onSuccess: () => {
      inv(t!.id)
      onOpenChange(false)
    },
    onError: (e) => setError(e.message),
  })
  if (!t) return null
  const submit = () => {
    if (v === 100) return setError('At 100% the task is finished: set the stage to Completed so it goes through review.')
    if (v < min) return setError(`${TASK_STAGE[t.stage].label} means at least ${min}% done.`)
    mut.mutate({ progress: v, note: note.trim() || undefined })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Update progress · ${t.wbs}`}
      description={t.title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>
            Save progress
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Done" error={error} hint={`Stage: ${TASK_STAGE[t.stage].label}${min ? ` (at least ${min}%)` : ''}. Earned hours = estimate × progress.`}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={99}
              step={5}
              value={Math.min(v, 99)}
              aria-label="Progress"
              onChange={(e) => {
                setV(Number(e.target.value))
                setError(null)
              }}
              className="h-2 min-w-0 flex-1 cursor-pointer accent-[var(--brand)]"
            />
            <Input
              inputMode="numeric"
              suffix="%"
              aria-label="Progress percent"
              className="w-[92px] shrink-0"
              value={String(v)}
              invalid={!!error}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^0-9]/g, '') || 0)
                setV(Math.max(0, Math.min(100, n)))
                setError(null)
              }}
            />
          </div>
        </Field>
        <Field label="Note" hint="Optional. Posted on the task thread so the PM sees what moved.">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Fee import done for campus 1; campus 2 file has 40 bad rows, fixing today" />
        </Field>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------------------- */
/* Flag slip (early warning)                                          */
/* ---------------------------------------------------------------- */
export function FlagSlipDialog({ t, open, onOpenChange }: { t: StageTask | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const inv = useTaskInvalidate()
  const [note, setNote] = useState('')
  const [due, setDue] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setNote('')
    setDue('')
    setErrors({})
  }, [open])
  const mut = useMut((b: { note: string; new_due_on: string | null }) => deliveryApi.flagSlip(t!.id, b), {
    success: (_r, b) => (b.new_due_on ? `Slip flagged · ${t!.wbs} now ends ${fmtDate(b.new_due_on)}` : `Slip flagged on ${t!.wbs}`),
    silentError: true,
    onSuccess: () => {
      inv(t!.id)
      onOpenChange(false)
    },
    onError: (e) => setErrors(e.field ? { [e.field]: e.message } : { note: e.message }),
  })
  if (!t) return null
  const submit = () => {
    const e: Record<string, string> = {}
    if (note.trim().length < 10) e.note = 'Say why it will slip (at least 10 characters).'
    if (due && due < todayISO()) e.new_due_on = 'The new target end can’t be in the past.'
    setErrors(e)
    if (!Object.keys(e).length) mut.mutate({ note: note.trim(), new_due_on: due || null })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Flag slip · ${t.wbs}`}
      description={`Raise it early: it counts as an early warning on the weekly scorecard. Target end today is ${fmtDate(t.due_on)}.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>
            Flag slip
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Why will it slip?" required error={errors.note}>
          <Textarea autoFocus rows={3} value={note} invalid={!!errors.note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Client test data arrives Thursday, two days after we need it" />
        </Field>
        <Field label="New target end" error={errors.new_due_on} hint="Optional. Moving it keeps the baseline and records the revision.">
          <Input type="date" value={due} min={t.start_on && t.start_on > todayISO() ? t.start_on : todayISO()} invalid={!!errors.new_due_on} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------------------- */
/* Reassign owner / backup                                            */
/* ---------------------------------------------------------------- */
export function ReassignDialog({ t, open, onOpenChange }: { t: StageTask | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const inv = useTaskInvalidate()
  const [owner, setOwner] = useState<string | null>(null)
  const [backup, setBackup] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !t) return
    setOwner(t.owner_id ?? null)
    setBackup(t.backup_id ?? null)
    setError(null)
  }, [open, t])
  const mut = useMut((b: { owner_id: string | null; backup_id: string | null }) => deliveryApi.update(t!.id, b, t!.version), {
    success: `Reassigned`,
    silentError: true,
    onSuccess: () => {
      inv(t!.id)
      onOpenChange(false)
    },
    onError: (e) => setError(e.message),
  })
  if (!t) return null
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Reassign ${t.wbs}`}
      description={t.title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={mut.isPending}
            onClick={() => {
              if (owner && backup && owner === backup) return setError('The backup must be a different person from the owner.')
              mut.mutate({ owner_id: owner, backup_id: backup })
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Owner" hint="Accountable for the task; notified when it changes hands.">
          <PeoplePicker value={owner} onChange={setOwner} placeholder="Unassigned" />
        </Field>
        <Field label="Backup" error={error} hint="Covers the task when the owner is on leave.">
          <PeoplePicker value={backup} onChange={setBackup} filter={(p) => p.id !== owner} placeholder="No backup" clearable />
        </Field>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------------------- */
/* Remove: delete, or cancel when hours are logged                    */
/* ---------------------------------------------------------------- */
export function useRemoveTask() {
  const inv = useTaskInvalidate()
  const { confirm, askReason } = useConfirm()
  const del = useMut((t: StageTask) => tasksApi.remove(t.id, t.version), { success: (_r, t) => `${t.wbs} deleted`, onSuccess: (_r, t) => inv(t.id) })
  const cancel = useMut((v: { t: StageTask; reason: string }) => deliveryApi.cancel(v.t.id, v.reason), { success: (_r, v) => `${v.t.wbs} cancelled`, onSuccess: (_r, v) => inv(v.t.id) })
  return async (t: StageTask) => {
    if ((t.logged_hours ?? 0) > 0) {
      const reason = await askReason({
        title: `Cancel ${t.wbs} ${t.title}?`,
        body: `${fmtHours(t.logged_hours ?? 0)} are logged on it, so it can’t be deleted — those hours stay on the project cost and payroll. Cancelling closes it at the hours spent and keeps it out of delivery KPIs.`,
        label: 'Why is it cancelled?',
        placeholder: 'e.g. Client dropped the feature in the CR-2 discussion',
        minLength: 5,
        confirmLabel: 'Cancel task',
        tone: 'danger',
      })
      if (reason) cancel.mutate({ t, reason })
      return
    }
    if (await confirm({ title: `Remove ${t.wbs} ${t.title}?`, body: `Its dependencies and comments go with it. ${t.wbs} won’t be reused.`, confirmLabel: 'Remove task', tone: 'danger' })) del.mutate(t)
  }
}

/* ---------------------------------------------------------------- */
/* Estimate check (G15.04)                                            */
/* ---------------------------------------------------------------- */
export function EstimateHintLine({ ownerId, complexity, est, onApply, className }: { ownerId: string | null | undefined; complexity: Complexity; est: number | null | undefined; onApply?: (h: number) => void; className?: string }) {
  const [deb, setDeb] = useState(est ?? null)
  useEffect(() => {
    const h = setTimeout(() => setDeb(est ?? null), 350)
    return () => clearTimeout(h)
  }, [est])
  const q = useApi(['tasks', 'estimate-hint', ownerId ?? '', complexity, deb ?? ''], () => deliveryApi.estimateHint({ owner_id: ownerId ?? null, complexity, est: deb }), { staleTime: 60_000 })
  const h = q.data
  if (!h?.message) return null
  return (
    <div className={cn('flex items-start gap-2 rounded-md border border-line bg-surface-2/60 px-3 py-2 text-[12.5px] leading-snug', h.buffer_pct > 0 ? 'text-warning-text' : 'text-ink-3', className)}>
      <Lightbulb className="mt-px size-4 shrink-0" />
      <span className="min-w-0 flex-1">{h.message}</span>
      {onApply && h.suggested_hours && est && h.suggested_hours !== est ? (
        <button type="button" onClick={() => onApply(h.suggested_hours!)} className="shrink-0 whitespace-nowrap font-medium text-brand-text hover:underline">
          Use {h.suggested_hours}h
        </button>
      ) : null}
    </div>
  )
}
