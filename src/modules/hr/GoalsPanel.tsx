// Goals / KRAs list with add, progress update and manager approval. Used on the performance profile and appraisal form.
import { useState } from 'react'
import { Plus } from '@/ui/icons'
import { useMut } from '@/api/query'
import { hrApi, type GoalView } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { fmtDate } from '@/domain/calendar'
import { Badge, Button, Callout, Card, CardHeader, Dialog, EmptyState, Field, Input, Menu, Progress, Select, Textarea, useConfirm, useReadOnly } from '@/ui'
import { MoreHorizontal } from '@/ui/icons'
import { cn } from '@/lib/utils'
import type { Tone } from '@/domain/labels'
import { FEEDBACK_KIND, VISIBILITY } from './components'
import type { FeedbackView } from '@/api/hr'
import { Avatar } from '@/ui'
import { relTime } from '@/domain/calendar'

const GOAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Awaiting approval', tone: 'warning' },
  agreed: { label: 'Agreed', tone: 'info' },
  on_track: { label: 'On track', tone: 'success' },
  at_risk: { label: 'At risk', tone: 'danger' },
  achieved: { label: 'Achieved', tone: 'success' },
  missed: { label: 'Missed', tone: 'neutral' },
}
const INV = [['performance'], ['appraisal'], ['appraisals']]

export function GoalsPanel({ goals, userId, cycles, canAdd, title = 'Goals & KRAs', subtitle, className }: { goals: GoalView[]; userId: string; cycles: { id: string; name: string }[]; canAdd: boolean; title?: string; subtitle?: string; className?: string }) {
  const ro = useReadOnly()
  const [adding, setAdding] = useState(false)
  const [progress, setProgress] = useState<GoalView | null>(null)
  const { confirm } = useConfirm()
  const approve = useMut((id: string) => hrApi.approveGoal(id), { invalidate: INV, success: 'Goal approved' })
  const setStatus = useMut((v: { g: GoalView; status: string }) => hrApi.updateGoal(v.g.id, { status: v.status as GoalView['status'] }, v.g.version), { invalidate: INV, success: 'Goal updated' })
  const del = useMut((id: string) => hrApi.deleteGoal(id), { invalidate: INV, success: 'Goal removed' })
  const byCycle = new Map<string, GoalView[]>()
  for (const g of goals) byCycle.set(g.cycle_id ?? '', [...(byCycle.get(g.cycle_id ?? '') ?? []), g])
  const cycleName = (id: string) => cycles.find((c) => c.id === id)?.name ?? (id ? 'Earlier cycle' : 'No cycle')
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader title={title} subtitle={subtitle} action={canAdd && !ro && cycles.length > 0 ? <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add goal</Button> : undefined} />
      {!goals.length ? (
        <EmptyState compact title="No goals set" body={canAdd ? 'Add goals with weights that total 100% for the cycle. Your manager approves them.' : 'Goals agreed for the cycle show here.'} />
      ) : (
        <div className="space-y-4">
          {[...byCycle.entries()].map(([cid, gs]) => {
            const total = gs.filter((g) => g.status !== 'missed').reduce((s, g) => s + g.weight, 0)
            return (
              <div key={cid} className="min-w-0">
                {byCycle.size > 1 || total !== 100 ? (
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-ink-3">
                    <span className="truncate">{cycleName(cid)}</span>
                    <span className={cn('tnum whitespace-nowrap', total !== 100 && 'font-medium text-warning-text')}>Weights {total}%{total !== 100 ? ' — must total 100%' : ''}</span>
                  </div>
                ) : null}
                <ul className="divide-y divide-line">
                  {gs.map((g) => {
                    const p = Math.min(1, g.progress)
                    const items = [
                      ...(g.can_edit && g.manager_approved ? [{ label: 'Update progress', onSelect: () => setProgress(g) }] : []),
                      ...(g.can_approve ? [{ label: 'Approve goal', onSelect: () => approve.mutate(g.id) }] : []),
                      ...(g.can_edit && g.can_close && g.manager_approved && !g.can_approve && g.status !== 'achieved' ? [{ label: 'Mark achieved', onSelect: () => setStatus.mutate({ g, status: 'achieved' }) }] : []),
                      ...(g.can_edit && g.manager_approved && g.status !== 'at_risk' && g.status !== 'achieved' ? [{ label: 'Flag at risk', onSelect: () => setStatus.mutate({ g, status: 'at_risk' }) }] : []),
                      ...(g.can_edit ? [{ label: 'Remove goal', danger: true, onSelect: async () => { if (await confirm({ title: 'Remove this goal?', body: `“${g.title}” (${g.weight}%) is deleted. Weights for the cycle must still total 100%.`, confirmLabel: 'Remove', tone: 'danger' })) del.mutate(g.id) } }] : []),
                    ]
                    return (
                      <li key={g.id} className="py-3 first:pt-1">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-[13.5px] font-medium text-ink">{g.title}</span>
                              <Badge size="sm" tone={GOAL_STATUS[g.status].tone}>{GOAL_STATUS[g.status].label}</Badge>
                            </div>
                            <div className="mt-0.5 text-[12px] text-ink-3">
                              {g.kra} · weight <span className="tnum">{g.weight}%</span>{g.measure ? ` · ${g.measure}` : ''} · due {fmtDate(g.due_on)}
                            </div>
                            <div className="mt-2 flex items-center gap-2.5">
                              <Progress value={p} tone={g.status === 'at_risk' ? 'danger' : p >= 1 ? 'success' : 'brand'} className="flex-1" height={5} />
                              <span className="tnum shrink-0 whitespace-nowrap text-[12px] text-ink-2">{g.current} / {g.target} {g.unit}</span>
                            </div>
                          </div>
                          {!ro && items.length > 0 && (
                            <Menu label="Goal actions" trigger={<Button size="sm" variant="ghost" aria-label="Goal actions"><MoreHorizontal className="size-4" /></Button>} items={items} />
                          )}
                        </div>
                        {g.can_approve && !ro && (
                          <div className="mt-2 flex justify-end">
                            <Button size="xs" variant="secondary" loading={approve.isPending && approve.variables === g.id} onClick={() => approve.mutate(g.id)}>Approve goal</Button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      {adding && <GoalDialog userId={userId} cycles={cycles} onClose={() => setAdding(false)} />}
      {progress && <ProgressDialog g={progress} onClose={() => setProgress(null)} />}
    </Card>
  )
}

function GoalDialog({ userId, cycles, onClose }: { userId: string; cycles: { id: string; name: string }[]; onClose: () => void }) {
  const [f, setF] = useState({ cycle_id: cycles[0]?.id ?? '', title: '', kra: '', weight: '20', measure: '', target: '', unit: '', due_on: '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }))
  const save = useMut(() => hrApi.addGoal({ user_id: userId, cycle_id: f.cycle_id || null, title: f.title, kra: f.kra, weight: Number(f.weight), measure: f.measure, target: Number(f.target), unit: f.unit, due_on: f.due_on }), {
    invalidate: INV, success: 'Goal added', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add goal" description="Weights for a person’s goals in a cycle must add up to exactly 100%." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Add goal</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cycle" required error={errs.cycle_id}>
            <Select value={f.cycle_id} onChange={(e) => set('cycle_id')(e.target.value)} options={cycles.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label="Key result area" hint="e.g. Delivery, Quality, People">
            <Input value={f.kra} onChange={(e) => set('kra')(e.target.value)} placeholder="Delivery" />
          </Field>
        </div>
        <Field label="Goal" required error={errs.title}>
          <Input value={f.title} invalid={!!errs.title} onChange={(e) => set('title')(e.target.value)} placeholder="Ship the parent app v1" />
        </Field>
        <Field label="How it is measured" error={errs.measure}>
          <Textarea rows={2} value={f.measure} onChange={(e) => set('measure')(e.target.value)} placeholder="Screens released to production" />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Weight %" required error={errs.weight}>
            <Input type="number" min={5} max={100} value={f.weight} invalid={!!errs.weight} onChange={(e) => set('weight')(e.target.value)} />
          </Field>
          <Field label="Target" required error={errs.target}>
            <Input type="number" min={0} value={f.target} invalid={!!errs.target} onChange={(e) => set('target')(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Input value={f.unit} onChange={(e) => set('unit')(e.target.value)} placeholder="screens" />
          </Field>
          <Field label="Due" required error={errs.due_on}>
            <Input type="date" value={f.due_on} invalid={!!errs.due_on} onChange={(e) => set('due_on')(e.target.value)} />
          </Field>
        </div>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

function ProgressDialog({ g, onClose }: { g: GoalView; onClose: () => void }) {
  const [cur, setCur] = useState(String(g.current))
  const [err, setErr] = useState<string | null>(null)
  const save = useMut(() => hrApi.updateGoal(g.id, { current: Number(cur) }, g.version), { invalidate: INV, success: 'Progress saved', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErr(e.message) })
  return (
    <Dialog open size="sm" onOpenChange={(o) => !o && onClose()} title="Update progress" description={g.title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save progress</Button></>}>
      <Field label={`Current (target ${g.target} ${g.unit})`} error={err}>
        <Input type="number" min={0} value={cur} invalid={!!err} onChange={(e) => setCur(e.target.value)} />
      </Field>
    </Dialog>
  )
}

export function FeedbackPanel({ items, toUserId, toName, canGive, className }: { items: FeedbackView[]; toUserId: string; toName: string; canGive: boolean; className?: string }) {
  const ro = useReadOnly()
  const [open, setOpen] = useState(false)
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader title="Feedback" subtitle="Praise, things to improve and 1:1 notes" action={canGive && !ro ? <Button size="sm" onClick={() => setOpen(true)}>Give feedback</Button> : undefined} />
      {!items.length ? (
        <EmptyState compact title="No feedback yet" body="Feedback from managers and colleagues appears here." />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((f) => (
            <li key={f.id} className="flex gap-3 py-3 first:pt-1">
              <Avatar name={f.from_name} hue={f.from_hue} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[13px] font-medium">{f.from_name}</span>
                  <Badge size="sm" tone={FEEDBACK_KIND[f.kind].tone}>{FEEDBACK_KIND[f.kind].label}</Badge>
                  {f.visibility !== 'public' && <span className="text-[11.5px] text-ink-3">{f.visibility === 'manager' ? 'Managers only' : 'Private'}</span>}
                  <span className="ml-auto whitespace-nowrap text-[12px] text-ink-3">{relTime(f.at)}</span>
                </div>
                <p className="mt-1 text-[13px] leading-snug text-ink-2">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <FeedbackDialog toUserId={toUserId} toName={toName} onClose={() => setOpen(false)} />}
    </Card>
  )
}

function FeedbackDialog({ toUserId, toName, onClose }: { toUserId: string; toName: string; onClose: () => void }) {
  const [kind, setKind] = useState<'praise' | 'improvement' | 'one_on_one'>('praise')
  const [vis, setVis] = useState<'public' | 'manager' | 'private'>('public')
  const [body, setBody] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const save = useMut(() => hrApi.addFeedback({ to_user_id: toUserId, kind, body, visibility: vis }), {
    invalidate: [['performance']], success: 'Feedback shared', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Feedback for ${toName}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Share feedback</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" error={errs.kind}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} options={Object.entries(FEEDBACK_KIND).map(([value, v]) => ({ value, label: v.label }))} />
          </Field>
          <Field label="Who can see it" error={errs.visibility}>
            <Select value={vis} onChange={(e) => setVis(e.target.value as typeof vis)} options={Object.entries(VISIBILITY).map(([value, label]) => ({ value, label }))} />
          </Field>
        </div>
        <Field label="Feedback" required error={errs.body} hint="Be specific: what happened and why it mattered.">
          <Textarea rows={4} value={body} invalid={!!errs.body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}
