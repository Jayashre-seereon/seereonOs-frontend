// /workflows/run/:id — one running workflow: stage timeline, the current reviewer's form (earlier stages shown
// read-only, already filtered by the server to what this viewer may see), compensation facts, outputs, history.
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EyeOff, FileText, Mail, Send, UserCog } from '@/ui/icons'
import { useMut } from '@/api/query'
import { wfApi, WF_INV, useWfInstance, type WfDetail, type WfFacts } from '@/api/wf'
import type { ApiError } from '@/api/http'
import { fmtDate } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { Badge, Button, Callout, Card, CardHeader, Dialog, ErrorState, Field, PageHeader, PeoplePicker, SkeletonRows, StatusBadge, Textarea, useConfirm, useReadOnly } from '@/ui'
import { FactsCard, FieldInput, FieldValue, HISTORY_LABEL, PersonChip, PROCESS_LABEL, StageTimeline, WF_STATUS, when } from './shared'

export default function WfInstancePage() {
  const { id = '' } = useParams()
  const q = useWfInstance(id)
  const d = q.data
  return (
    <div>
      <PageHeader
        back={{ to: '/workflows', label: 'Workflows' }}
        title={d?.title ?? 'Workflow'}
        subtitle={d ? `${d.template_name} · ${PROCESS_LABEL[d.process]} · started by ${d.initiator?.name ?? '—'} on ${fmtDate(d.created_at.slice(0, 10))}` : undefined}
        actions={d ? <StatusBadge map={WF_STATUS} value={d.status} /> : undefined}
      />
      {q.isLoading ? <SkeletonRows rows={8} /> : q.error || !d ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Body d={d} />}
    </div>
  )
}

function Body({ d }: { d: WfDetail }) {
  const ro = useReadOnly()
  const done = d.stages.filter((s) => s.status === 'done' && (s.fields.length > 0 || s.hidden_count > 0))
  return (
    <div className="grid gap-4 md:gap-5 lg:grid-cols-12">
      <div className="min-w-0 space-y-4 md:space-y-5 lg:col-span-8">
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold">{d.status === 'in_progress' ? `Step ${d.stage_index + 1} of ${d.stage_count}` : WF_STATUS[d.status].label}</h2>
            {d.template_rev !== d.latest_rev && <Badge size="sm">Runs on revision {d.template_rev} (latest {d.latest_rev})</Badge>}
          </div>
          <StageTimeline stages={d.stages} />
          {d.context.note && <p className="mt-3 text-[13px] text-ink-2"><span className="text-ink-3">Note: </span>{d.context.note}</p>}
          {d.escalated && <Callout className="mt-3" tone="warning" title="Escalated">This step passed its deadline and was moved to {d.assignee?.name ?? 'the manager'}.</Callout>}
        </Card>

        {d.form && !ro ? (
          <StageForm key={`${d.id}:${d.stage_index}:${d.history.length}`} d={d} />
        ) : d.status === 'in_progress' ? (
          <Callout tone="info" title={`Waiting for ${d.assignee?.name ?? 'someone'}`}>
            {d.stage_name} is due {d.due_on ? fmtDate(d.due_on, 'long') : 'soon'}.{d.overdue ? ' It is overdue.' : ''} You’ll be notified when it moves on.
          </Callout>
        ) : null}

        {done.map((s) => (
          <Card key={s.key}>
            <CardHeader title={s.name} subtitle={s.person ? `${s.person.name}${s.acted_at ? ` · ${when(s.acted_at)}` : ''}` : undefined} />
            {s.fields.length ? (
              <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
                {s.fields.map((f) => <FieldValue key={f.key} f={f} display={f.display} />)}
              </dl>
            ) : null}
            {s.hidden_count > 0 && (
              <p className={cn('flex items-center gap-1.5 text-[12.5px] text-ink-3', s.fields.length && 'mt-3')}>
                <EyeOff className="size-3.5" />
                {s.hidden_count} {s.hidden_count === 1 ? 'parameter is' : 'parameters are'} not shared with you at this stage.
              </p>
            )}
          </Card>
        ))}

        <Comments d={d} />
      </div>

      <div className="min-w-0 space-y-4 md:space-y-5 lg:col-span-4">
        {d.facts && !d.form?.sees_compensation && <FactsCard f={d.facts} />}
        {d.outputs.length > 0 && <Outputs d={d} />}
        <Details d={d} />
        <History d={d} />
      </div>
    </div>
  )
}

/* ---------------- the current reviewer's form ---------------- */
function StageForm({ d }: { d: WfDetail }) {
  const form = d.form!
  const [vals, setVals] = useState<Record<string, unknown>>(form.values)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [facts, setFacts] = useState<WfFacts | null>(d.facts)
  const { confirm, askReason } = useConfirm()
  const last = d.stage_index === d.stage_count - 1
  const next = d.stages[d.stage_index + 1]
  const onErr = (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message })
  const act = useMut((b: { action: 'submit' | 'send_back' | 'reject'; values?: Record<string, unknown>; reason?: string }) => wfApi.act(d.id, b, d.version), {
    invalidate: WF_INV, silentError: true, onError: onErr,
    success: (_, b) => (b.action === 'send_back' ? 'Sent back' : b.action === 'reject' ? 'Workflow rejected' : last ? 'Approved — workflow completed' : 'Submitted to the next stage'),
  })
  // live compensation preview for stages that see pay (HR, finance)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const numeric = form.fields.filter((f) => ['percent', 'number', 'money', 'date', 'rating'].includes(f.type)).map((f) => vals[f.key])
  useEffect(() => {
    if (!form.sees_compensation) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      wfApi.preview(d.id, vals).then((r) => setFacts(r.facts)).catch(() => {})
    }, 350)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(numeric), form.sees_compensation, d.id])

  const set = (k: string, v: unknown) => {
    setVals((s) => ({ ...s, [k]: v }))
    if (errs[k] || errs.form) setErrs((e) => ({ ...e, [k]: '', form: '' }))
  }
  const submit = async () => {
    const e: Record<string, string> = {}
    for (const f of form.fields) {
      const v = vals[f.key]
      const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v !== true)
      if (f.required && empty) e[f.key] = f.type === 'checkbox' ? 'Tick this before you submit.' : 'Required.'
      else if (f.type === 'textarea' && f.min && String(v ?? '').trim().length > 0 && String(v).trim().length < f.min) e[f.key] = `Write at least ${f.min} characters.`
    }
    setErrs(e)
    if (Object.keys(e).length) return
    const ok = await confirm({
      title: last ? 'Approve and complete?' : form.stage_key === d.stages[0]?.key ? `Submit ${form.stage_name.toLowerCase()}?` : 'Approve this stage?',
      body: last ? 'The completion actions run now (letters, emails, CTC change for approval).' : `It moves to ${next?.name ?? 'the next stage'}${next?.person ? ` (${next.person.name})` : ''}. You can’t edit it afterwards unless it is sent back.`,
      confirmLabel: last ? 'Approve and complete' : 'Submit',
    })
    if (ok) act.mutate({ action: 'submit', values: vals })
  }
  return (
    <div className="space-y-4 md:space-y-5">
      <Card className="border-brand/40">
        <CardHeader title={`Your step: ${form.stage_name}`} subtitle={d.perms.acting_as === 'delegate' ? `You are acting for ${d.assignee?.name} (delegation).` : d.due_on ? `Due ${fmtDate(d.due_on, 'long')}` : undefined} />
        {form.instructions && <p className="-mt-1 mb-4 text-[13px] leading-relaxed text-ink-2">{form.instructions}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {form.fields.map((f) => (
            <div key={f.key} className={cn('min-w-0', (f.type === 'textarea' || f.type === 'rating' || f.type === 'file') && 'sm:col-span-2')}>
              <FieldInput f={f} value={vals[f.key]} onChange={(v) => set(f.key, v)} error={errs[f.key] || null} />
            </div>
          ))}
          {!form.fields.length && <p className="text-[13.5px] text-ink-2 sm:col-span-2">This stage has no parameters — review the details and approve.</p>}
        </div>
        {errs.form && <Callout className="mt-4" tone="danger">{errs.form}</Callout>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {form.can_reject && (
            <Button variant="outline-danger" disabled={act.isPending} onClick={async () => {
              const r = await askReason({ title: 'Reject this workflow?', body: 'It stops here and the people involved are told.', label: 'Why is it rejected', minLength: 10, confirmLabel: 'Reject', tone: 'danger' })
              if (r) act.mutate({ action: 'reject', reason: r })
            }}>Reject</Button>
          )}
          {form.can_send_back && (
            <Button disabled={act.isPending} onClick={async () => {
              const prev = d.stages[d.stage_index - 1]
              const r = await askReason({ title: `Send back to ${prev?.name ?? 'the previous stage'}?`, body: `${prev?.person?.name ?? 'They'} will revise and resubmit.`, label: 'What should change', minLength: 10, confirmLabel: 'Send back' })
              if (r) act.mutate({ action: 'send_back', reason: r })
            }}>Send back</Button>
          )}
          <Button variant="primary" icon={<Send />} loading={act.isPending} onClick={submit}>{last ? 'Approve and complete' : form.stage_key === d.stages[0]?.key ? 'Submit' : 'Approve'}</Button>
        </div>
      </Card>
      {form.sees_compensation && facts && <FactsCard f={facts} live />}
    </div>
  )
}

/* ---------------- right column ---------------- */
function Outputs({ d }: { d: WfDetail }) {
  const icon = (k: string) => (k === 'document' ? <FileText className="size-4" /> : k === 'email' ? <Mail className="size-4" /> : <UserCog className="size-4" />)
  return (
    <Card>
      <CardHeader title="Outputs" subtitle="What the workflow produced when it finished" />
      <ul className="space-y-2.5">
        {d.outputs.map((o) => (
          <li key={o.kind + o.ref_id} className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 shrink-0 text-ink-3">{icon(o.kind)}</span>
            <span className="min-w-0 flex-1">
              {o.link ? <Link to={o.link} className="block break-words text-[13.5px] font-medium text-brand-text hover:underline">{o.label}</Link> : <span className="block break-words text-[13.5px] font-medium">{o.label}</span>}
              {o.status && <span className={cn('block text-[12px]', o.status.startsWith('Waiting') ? 'text-warning-text' : 'text-ink-3')}>{o.status}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Details({ d }: { d: WfDetail }) {
  const ro = useReadOnly()
  const { askReason } = useConfirm()
  const [reassign, setReassign] = useState(false)
  const cancel = useMut((reason: string) => wfApi.cancel(d.id, reason), { invalidate: WF_INV, success: 'Workflow cancelled' })
  return (
    <Card>
      <CardHeader title="Details" />
      <dl className="space-y-3">
        <Row label="Employee"><PersonChip p={d.subject} /></Row>
        {d.status === 'in_progress' && <Row label="Now with"><PersonChip p={d.assignee} sub={d.stage_name ?? undefined} /></Row>}
        <Row label="Started by"><PersonChip p={d.initiator} sub={when(d.created_at)} /></Row>
        {d.context.cycle_name && <Row label="Appraisal cycle"><span className="text-[13.5px]">{d.context.cycle_name}</span></Row>}
        {d.context.appraisal_id && <Row label="Appraisal record"><Link to={`/appraisals/${d.context.appraisal_id}`} className="text-[13.5px] font-medium text-brand-text hover:underline">Open appraisal</Link></Row>}
        {d.completed_at && <Row label={d.status === 'completed' ? 'Completed' : 'Closed'}><span className="text-[13.5px]">{when(d.completed_at)}</span></Row>}
      </dl>
      {(d.perms.can_reassign || d.perms.can_cancel) && !ro && (
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row lg:flex-col xl:flex-row">
          {d.perms.can_reassign && <Button size="sm" onClick={() => setReassign(true)}>Reassign step</Button>}
          {d.perms.can_cancel && (
            <Button size="sm" variant="outline-danger" loading={cancel.isPending} onClick={async () => {
              const r = await askReason({ title: 'Cancel this workflow?', body: 'Nothing further happens; values entered so far are kept for the record.', label: 'Why are you cancelling', minLength: 10, confirmLabel: 'Cancel workflow', tone: 'danger' })
              if (r) cancel.mutate(r)
            }}>Cancel workflow</Button>
          )}
        </div>
      )}
      {reassign && <ReassignDialog d={d} onClose={() => setReassign(false)} />}
    </Card>
  )
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
      <dt className="text-[12.5px] text-ink-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function ReassignDialog({ d, onClose }: { d: WfDetail; onClose: () => void }) {
  const [to, setTo] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMut(() => wfApi.reassign(d.id, { user_id: to ?? '', note }), {
    invalidate: WF_INV, success: 'Step reassigned', silentError: true, onSuccess: onClose,
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!to) e.user_id = 'Choose who takes over.'
    if (note.trim().length < 5) e.note = 'Say why (at least 5 characters).'
    setErrs(e)
    if (!Object.keys(e).length) m.mutate(undefined)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={`Reassign ${d.stage_name ?? 'step'}`} description={`Now with ${d.assignee?.name ?? '—'}.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={submit}>Reassign</Button></>}>
      <div className="space-y-4">
        <Field label="New assignee" required error={errs.user_id}>
          <PeoplePicker value={to} onChange={setTo} invalid={!!errs.user_id} filter={(p) => p.id !== d.assignee?.id && p.id !== d.subject?.id} />
        </Field>
        <Field label="Reason" required error={errs.note}>
          <Textarea rows={3} value={note} invalid={!!errs.note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Subhankar is on leave this week" />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

function History({ d }: { d: WfDetail }) {
  return (
    <Card>
      <CardHeader title="History" />
      <ol className="space-y-3">
        {[...d.history].reverse().map((h, i) => (
          <li key={i} className="min-w-0 border-l-2 border-line pl-3">
            <div className="text-[13px]">
              <span className="font-medium">{HISTORY_LABEL[h.action] ?? h.action}</span>
              <span className="text-ink-3"> · {h.stage_name}</span>
            </div>
            <div className="text-[12px] text-ink-3">{h.by?.name ?? 'System'} · {when(h.at)}{h.to ? ` → ${h.to.name}` : ''}</div>
            {h.note && <p className="mt-0.5 break-words text-[12.5px] text-ink-2">{h.note}</p>}
          </li>
        ))}
      </ol>
    </Card>
  )
}

function Comments({ d }: { d: WfDetail }) {
  const ro = useReadOnly()
  const [text, setText] = useState('')
  const m = useMut(() => wfApi.comment(d.id, text.trim()), { invalidate: [['wf']], success: 'Comment added', onSuccess: () => setText('') })
  return (
    <Card>
      <CardHeader title="Comments" subtitle="Everyone who can open this workflow sees comments, including the employee." />
      {d.comments.length > 0 && (
        <ul className="mb-4 space-y-3">
          {d.comments.map((c) => (
            <li key={c.id} className="min-w-0">
              <div className="text-[12.5px] text-ink-3"><span className="font-medium text-ink-2">{c.by?.name ?? '—'}</span> · {when(c.at)}</div>
              <p className="mt-0.5 whitespace-pre-line break-words text-[13.5px]">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {d.perms.can_comment && !ro && (
        <div className="space-y-2">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" aria-label="Comment" />
          <div className="flex justify-end">
            <Button size="sm" disabled={text.trim().length < 2} loading={m.isPending} onClick={() => m.mutate(undefined)}>Post comment</Button>
          </div>
        </div>
      )}
    </Card>
  )
}
