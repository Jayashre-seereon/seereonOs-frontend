// /appraisals/:id — the form for the viewer's stage (self → manager → HR) next to the system metrics panel.
import { useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { Check } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { hrApi, type AppraisalDetail, type Metrics } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Callout, Card, CardHeader, ErrorState, Field, Input, PageHeader, SkeletonRows, StatusBadge, Textarea, useConfirm, useReadOnly } from '@/ui'
import { GoalsPanel } from './GoalsPanel'
import { AppraisalWorkflowCard } from './AppraisalWorkflow'
import { useWfForAppraisal } from '@/api/wf'
import { APPRAISAL_STATUS, MetricRow, Rating, RatingInput, days, pct, pctTone } from './components'

const INV = [['appraisal'], ['appraisals'], ['performance'], ['hr-dashboard']]

export default function AppraisalPage() {
  const { id = '' } = useParams()
  const q = useApi(['appraisal', id], () => hrApi.appraisal(id))
  const a = q.data
  return (
    <div>
      <PageHeader
        back={{ to: a?.viewer.is_self && !a.viewer.is_hr ? '/performance' : '/appraisals', label: a?.viewer.is_self ? 'My performance' : 'Appraisals' }}
        title={a ? (a.viewer.is_self ? `My appraisal · ${a.cycle.name}` : `${a.user.name} · ${a.cycle.name}`) : 'Appraisal'}
        subtitle={a ? `${a.user.title} · period ${fmtDate(a.cycle.period_from)} – ${fmtDate(a.cycle.period_to)}${a.manager_name ? ` · manager ${a.manager_name}` : ''}` : undefined}
        actions={a ? <StatusBadge map={APPRAISAL_STATUS} value={a.status} /> : undefined}
      />
      {q.isLoading ? <SkeletonRows rows={8} /> : q.error || !a ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Body a={a} />}
    </div>
  )
}

const STEPS: { key: AppraisalDetail['status']; label: string }[] = [
  { key: 'self_pending', label: 'Self review' },
  { key: 'manager_pending', label: 'Manager review' },
  { key: 'hr_pending', label: 'HR calibration' },
  { key: 'completed', label: 'Completed' },
]

function Stepper({ a }: { a: AppraisalDetail }) {
  const idx = STEPS.findIndex((s) => s.key === a.status)
  const dueFor = [a.cycle.self_due, a.cycle.manager_due, a.cycle.hr_due, null]
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STEPS.map((s, i) => {
        const done = i < idx || a.status === 'completed'
        const cur = i === idx && a.status !== 'completed'
        return (
          <li key={s.key} className={cn('min-w-0 rounded-md border px-3 py-2', cur ? 'border-brand bg-brand-soft' : 'border-line bg-surface')}>
            <div className="flex items-center gap-1.5">
              {done ? <Check className="size-4 shrink-0 text-success-text" /> : <span className={cn('tnum grid size-4 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold', cur ? 'bg-brand text-white' : 'bg-surface-2 text-ink-3')}>{i + 1}</span>}
              <span className={cn('truncate text-[13px]', cur ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-ink-3')}>{s.label}</span>
            </div>
            <div className="mt-0.5 truncate pl-[22px] text-[11.5px] text-ink-3">{dueFor[i] ? `due ${fmtDate(dueFor[i])}` : a.closed_at ? fmtDate(a.closed_at.slice(0, 10)) : '—'}</div>
          </li>
        )
      })}
    </ol>
  )
}

function Body({ a }: { a: AppraisalDetail }) {
  const ro = useReadOnly()
  const stage = ro ? 'view' : a.stage_for_viewer
  // v7: a workflow-managed appraisal shows the employee only their own review and the final outcome
  const wf = useWfForAppraisal(a.id).data
  const selfOnly = !!wf && a.viewer.is_self && !a.viewer.is_hr
  return (
    <div className="grid gap-4 lg:grid-cols-12 md:gap-5">
      <div className="min-w-0 space-y-4 lg:col-span-8 md:space-y-5">
        <Card>
          <Stepper a={a} />
          {a.sent_back_reason && a.status !== 'completed' && <Callout className="mt-3" tone="warning" title="Sent back">{a.sent_back_reason}</Callout>}
        </Card>

        {/* v7: appraisals launched through a workflow are acted on in the workflow; progress shows here */}
        <AppraisalWorkflowCard appraisalId={a.id} />

        {stage === 'self' ? (
          <SelfForm a={a} />
        ) : (
          <Section title="Self review" who={a.user.name} at={a.submitted_self_at} rating={a.self_rating} comments={a.self_comments} pending={a.status === 'self_pending' ? `Waiting for ${a.viewer.is_self ? 'you' : a.user.name.split(' ')[0]} — due ${fmtDate(a.cycle.self_due)}` : null} />
        )}

        {stage === 'manager' ? (
          <ManagerForm a={a} />
        ) : selfOnly && a.status === 'completed' ? null : a.show_ratings || a.status === 'completed' ? (
          <Section title="Manager review" who={a.manager_name} at={a.submitted_manager_at} rating={a.manager_rating} comments={a.manager_comments} pending={a.status === 'self_pending' || a.status === 'manager_pending' ? (a.status === 'manager_pending' ? `Waiting for ${a.manager_name ?? 'the manager'} — due ${fmtDate(a.cycle.manager_due)}` : 'Starts after the self review') : null} />
        ) : (
          <Card>
            <CardHeader title="Manager and HR review" />
            <p className="text-[13.5px] text-ink-2">{a.status === 'manager_pending' ? `${a.manager_name ?? 'Your manager'} is reviewing.` : 'HR is calibrating ratings across the team.'} You’ll see the ratings and comments once the appraisal is completed.</p>
          </Card>
        )}

        {stage === 'hr' ? (
          <HrForm a={a} />
        ) : a.status === 'completed' ? (
          <Card>
            <CardHeader title="Final outcome" subtitle={a.closed_at ? `Completed ${fmtDateTime(a.closed_at)}` : undefined} />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Out label="Final rating"><Rating value={a.final_rating} /></Out>
              <Out label="Increment"><span className="tnum">{a.increment_pct === null ? '—' : `${a.increment_pct}%`}</span></Out>
              <Out label="Promotion">{a.promotion_to ?? 'None'}</Out>
            </div>
            {a.hr_comments && <p className="mt-4 whitespace-pre-line text-[13.5px] text-ink-2">{a.hr_comments}</p>}
          </Card>
        ) : a.show_ratings ? (
          <Section title="HR calibration" who={null} at={null} rating={null} comments="" pending={a.status === 'hr_pending' ? `Waiting for HR — due ${fmtDate(a.cycle.hr_due)}` : 'Starts after the manager review'} />
        ) : null}

        <GoalsPanel goals={a.goals} userId={a.user.id} cycles={[{ id: a.cycle.id, name: a.cycle.name }]} canAdd={false} title="Goals for this cycle" subtitle="Weighted achievement feeds the goals score" />
      </div>

      <div className="min-w-0 lg:col-span-4">
        <div className="lg:sticky lg:top-4">
          <MetricsPanel m={a.live} weights={a.cycle.weights} done={a.status === 'completed'} />
        </div>
      </div>
    </div>
  )
}

function Out({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[14px] font-medium">{children}</div>
    </div>
  )
}

function Section({ title, who, at, rating, comments, pending }: { title: string; who: string | null; at: string | null; rating: number | null; comments: string; pending: string | null }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={pending ?? (at ? `${who ?? ''} · ${fmtDateTime(at)}` : undefined)} action={!pending && rating !== null ? <Rating value={rating} /> : undefined} />
      {pending ? <p className="text-[13px] text-ink-3">Nothing submitted yet.</p> : <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-ink-2">{comments || '—'}</p>}
    </Card>
  )
}

function Counter({ n, min }: { n: number; min: number }) {
  return <span className={cn('tnum text-[12px]', n >= min ? 'text-ink-3' : 'text-warning-text')}>{n}/{min}+</span>
}

function SelfForm({ a }: { a: AppraisalDetail }) {
  const [rating, setRating] = useState<number | null>(a.self_rating)
  const [comments, setComments] = useState(a.self_comments)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const { confirm } = useConfirm()
  const save = useMut(() => hrApi.submitSelf(a.id, { rating: rating ?? 0, comments }, a.version), { invalidate: INV, success: 'Self review submitted', silentError: true, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }) })
  const submit = async () => {
    const e: Record<string, string> = {}
    if (!rating) e.rating = 'Pick a rating.'
    if (comments.trim().length < 30) e.comments = 'Write at least 30 characters.'
    setErrs(e)
    if (Object.keys(e).length) return
    if (await confirm({ title: 'Submit your self review?', body: 'It goes to your manager and can’t be edited afterwards unless they send it back.', confirmLabel: 'Submit' })) save.mutate(undefined)
  }
  return (
    <Card>
      <CardHeader title="Your self review" subtitle={`Due ${fmtDate(a.cycle.self_due)}. Look at the metrics on the right — your manager sees the same numbers.`} />
      <div className="space-y-4">
        <Field label="How did this period go overall?" required error={errs.rating}>
          <RatingInput value={rating} onChange={setRating} />
        </Field>
        <Field label="What you delivered, and where you want to grow" required error={errs.comments} aside={<Counter n={comments.trim().length} min={30} />}>
          <Textarea rows={6} value={comments} invalid={!!errs.comments} onChange={(e) => setComments(e.target.value)} placeholder="Key deliveries, the impact they had, what got in the way, and what you want to learn next." />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" className="w-full sm:w-auto" loading={save.isPending} onClick={submit}>Submit self review</Button>
        </div>
      </div>
    </Card>
  )
}

function ManagerForm({ a }: { a: AppraisalDetail }) {
  const [rating, setRating] = useState<number | null>(a.manager_rating)
  const [comments, setComments] = useState(a.manager_comments)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const { askReason } = useConfirm()
  const save = useMut(() => hrApi.submitManager(a.id, { rating: rating ?? 0, comments }, a.version), { invalidate: INV, success: 'Manager review submitted to HR', silentError: true, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }) })
  const back = useMut((reason: string) => hrApi.sendBack(a.id, reason), { invalidate: INV, success: 'Sent back to the employee' })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!rating) e.rating = 'Pick a rating.'
    if (comments.trim().length < 30) e.comments = 'Write at least 30 characters.'
    setErrs(e)
    if (!Object.keys(e).length) save.mutate(undefined)
  }
  const sys = a.live.suggested
  return (
    <Card>
      <CardHeader title="Your review as manager" subtitle={`Due ${fmtDate(a.cycle.manager_due)}. Rate against the period’s evidence; the behaviour score is your rating.`} />
      <div className="space-y-4">
        <Field label="Manager rating" required error={errs.rating} aside={sys !== null ? <span className="text-[12px] text-ink-3">System suggests <span className="tnum font-semibold text-ink-2">{sys}</span></span> : undefined}>
          <RatingInput value={rating} onChange={setRating} />
        </Field>
        <Field label="What went well, what to improve — with examples" required error={errs.comments} aside={<Counter n={comments.trim().length} min={30} />}>
          <Textarea rows={6} value={comments} invalid={!!errs.comments} onChange={(e) => setComments(e.target.value)} />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            onClick={async () => {
              const r = await askReason({ title: 'Send the self review back?', body: `${a.user.name} will be asked to revise and resubmit.`, label: 'What should change', minLength: 10, confirmLabel: 'Send back' })
              if (r) back.mutate(r)
            }}
          >
            Send back
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>Submit to HR</Button>
        </div>
      </div>
    </Card>
  )
}

function HrForm({ a }: { a: AppraisalDetail }) {
  const [rating, setRating] = useState<number | null>(a.manager_rating)
  const [inc, setInc] = useState('')
  const [promo, setPromo] = useState('')
  const [comments, setComments] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const { confirm, askReason } = useConfirm()
  const sys = a.live.suggested
  const deviates = sys !== null && rating !== null && Math.abs(rating - sys) > 1
  const save = useMut(() => hrApi.submitHr(a.id, { rating: rating ?? 0, comments, increment_pct: Number(inc), promotion_to: promo.trim() || null }, a.version), {
    invalidate: INV, success: 'Appraisal completed', silentError: true, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const back = useMut((reason: string) => hrApi.sendBack(a.id, reason), { invalidate: INV, success: 'Sent back to the manager' })
  const submit = async () => {
    const e: Record<string, string> = {}
    if (!rating) e.rating = 'Pick the calibrated rating.'
    if (inc === '' || Number(inc) < 0 || Number(inc) > 50) e.increment_pct = 'Enter an increment between 0 and 50%.'
    if (deviates && comments.trim().length < 15) e.comments = `The rating is more than 1 away from the system score (${sys}). Explain why in at least 15 characters.`
    setErrs(e)
    if (Object.keys(e).length) return
    if (await confirm({ title: 'Complete this appraisal?', body: `Final rating ${rating}/5, increment ${inc}%${promo.trim() ? `, promotion to ${promo.trim()}` : ''}. The rating is locked and ${a.user.name} can see it.`, confirmLabel: 'Complete appraisal' })) save.mutate(undefined)
  }
  return (
    <Card>
      <CardHeader title="HR calibration" subtitle={`Due ${fmtDate(a.cycle.hr_due)}. Compare with the manager rating and the system score before locking.`} />
      <div className="mb-4 grid grid-cols-3 gap-3 rounded-md border border-line bg-surface-2/50 p-3">
        <Out label="Self"><span className="tnum">{a.self_rating ?? '—'}</span></Out>
        <Out label="Manager"><span className="tnum">{a.manager_rating ?? '—'}</span></Out>
        <Out label="System"><span className="tnum">{sys ?? '—'}</span></Out>
      </div>
      <div className="space-y-4">
        <Field label="Final (calibrated) rating" required error={errs.rating}>
          <RatingInput value={rating} onChange={setRating} step={0.5} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Increment" required error={errs.increment_pct}>
            <Input type="number" min={0} max={50} step={0.5} value={inc} invalid={!!errs.increment_pct} onChange={(e) => setInc(e.target.value)} suffix="%" />
          </Field>
          <Field label="Promotion to" hint="Leave empty for no change in title">
            <Input value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="e.g. Lead MERN Developer" />
          </Field>
        </div>
        <Field label={deviates ? 'Reason for differing from the system score' : 'HR comments'} required={deviates} error={errs.comments} hint={deviates ? undefined : 'Optional unless the rating differs from the system score by more than 1.'}>
          <Textarea rows={4} value={comments} invalid={!!errs.comments} onChange={(e) => setComments(e.target.value)} />
        </Field>
        {deviates && !errs.comments && <Callout tone="warning">This rating is more than one point away from the system score ({sys}). Record why.</Callout>}
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            onClick={async () => {
              const r = await askReason({ title: 'Send back to the manager?', body: 'They will revise the manager review and resubmit.', label: 'What should change', minLength: 10, confirmLabel: 'Send back' })
              if (r) back.mutate(r)
            }}
          >
            Send back
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>Complete appraisal</Button>
        </div>
      </div>
    </Card>
  )
}

function MetricsPanel({ m, weights, done }: { m: Metrics; weights: AppraisalDetail['cycle']['weights']; done: boolean }) {
  const parts: { key: string; label: string; w: number; v: number | null }[] = [
    { key: 'goals', label: 'Goals', w: weights.goals, v: m.score_goals },
    { key: 'tasks', label: 'Tasks', w: weights.tasks, v: m.score_tasks },
    { key: 'timesheets', label: 'Timesheets', w: weights.timesheets, v: m.score_timesheets },
    { key: 'behaviour', label: 'Behaviour (manager)', w: weights.behaviour, v: m.score_behaviour },
  ]
  return (
    <Card>
      <CardHeader title="System metrics" subtitle={done ? 'Snapshot taken when the appraisal was completed' : 'Live from tasks, reviews, timesheets and goals in the period'} />
      <div className="flex items-end justify-between gap-3 rounded-md border border-line bg-surface-2/50 px-3.5 py-3">
        <div className="min-w-0">
          <div className="text-[12px] text-ink-3">Suggested score</div>
          <div className="tnum text-[26px] font-semibold leading-tight">{m.suggested ?? '—'}<span className="text-[14px] font-medium text-ink-3"> / 5</span></div>
        </div>
        <Badge size="sm">weighted</Badge>
      </div>
      <ul className="mt-3 space-y-2">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-ink-2">{p.label}</span>
            <span className="tnum w-10 shrink-0 text-right text-[12px] text-ink-3">{p.w}%</span>
            <span className={cn('tnum w-10 shrink-0 text-right font-semibold', p.v === null && 'font-normal text-ink-3')}>{p.v ?? '—'}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 divide-y divide-line border-t border-line">
        <MetricRow label="On-time delivery" value={pct(m.on_time_pct)} tone={pctTone(m.on_time_pct)} hint={`${m.tasks_completed} tasks completed`} />
        <MetricRow label="Average slip" value={days(m.avg_variance_days)} hint="working days vs due date" />
        <MetricRow label="First-pass approval" value={pct(m.first_pass_pct)} tone={pctTone(m.first_pass_pct)} />
        <MetricRow label="Review quality" value={m.avg_quality === null ? '—' : `${fmtNum(m.avg_quality, 1)} / 5`} />
        <MetricRow label="Timesheet compliance" value={pct(m.timesheet_compliance)} tone={pctTone(m.timesheet_compliance, 0.9, 0.75)} hint={`${m.late_submissions} late submission${m.late_submissions === 1 ? '' : 's'}`} />
        <MetricRow label="Goals achievement" value={pct(m.goals_score)} tone={pctTone(m.goals_score, 0.9, 0.7)} hint="weighted by goal weight" />
        {m.approval_sla_pct !== null && <MetricRow label="Approvals within SLA" value={pct(m.approval_sla_pct)} tone={pctTone(m.approval_sla_pct)} hint="as a manager" />}
      </div>
      <p className="mt-3 text-[12px] leading-snug text-ink-3">Each part is scored 1–5 and weighted by the cycle. Parts without data are left out and the rest re-weighted.</p>
    </Card>
  )
}
