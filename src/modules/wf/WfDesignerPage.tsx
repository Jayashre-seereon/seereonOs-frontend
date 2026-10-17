// /workflows/designer/:id — design one workflow: stages (who acts, SLA, send-back), each stage's parameters (fields,
// validation, who may see each value), and the completion / rejection actions. The server validates on save.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { wfApi, useWfMeta, type TemplateBody, type WfIssue, type WfMeta } from '@/api/wf'
import type { ApiError } from '@/api/http'
import type { WfAction, WfAssignee, WfField, WfFieldType, WfProcess, WfStage } from '@/types/v7'
import { cn } from '@/lib/utils'
import {
  Badge, Button, Callout, Card, CardHeader, Checkbox, ErrorState, Field, IconButton, Input, PageHeader, PeoplePicker, Select, SkeletonRows, Switch, Textarea, useReadOnly,
} from '@/ui'
import { FIELD_TYPE_LABEL, PROCESS_LABEL } from './shared'

const ASSIGNEE_LABEL: Record<WfAssignee, string> = {
  subject: 'The employee (self)', reports_to: 'Reporting manager / TL', skip_level: 'Skip-level manager', department_head: 'Unit / department head', role: 'Anyone with a role', user: 'A specific person', initiator: 'Whoever starts it',
}
const ASSIGNEE_HINT: Record<WfAssignee, string> = {
  subject: 'The person the workflow is about fills this stage.',
  reports_to: 'The employee’s reporting manager or team lead.',
  skip_level: 'The manager’s manager.',
  department_head: 'Head of the employee’s unit (Setup → Departments). If that head is the employee or already reviewed earlier, it goes to the parent unit’s head; with no one left, to the employee’s manager.',
  role: 'Assigned to the first holder of the role; any holder can act.',
  user: 'Always this person.',
  initiator: 'The person who started the workflow.',
}
const ACTION_LABEL: Record<WfAction['type'], string> = {
  generate_document: 'Generate a document', send_email: 'Send an email', update_ctc: 'Update CTC (via Change approvals)', notify: 'Notify in the app', create_task: 'Create a task',
}
const TO_LABEL: Record<string, string> = { subject: 'The employee', initiator: 'Whoever started it', reports_to: 'The employee’s manager', participants: 'Everyone involved' }
const NUMERIC: WfFieldType[] = ['number', 'percent', 'money', 'rating']
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 30) || 'item'
const uniqueKey = (base: string, taken: string[]) => {
  let k = slug(base).length < 2 ? `${slug(base)}_1` : slug(base)
  for (let n = 2; taken.includes(k); n++) k = `${slug(base)}_${n}`
  return k
}

export default function WfDesignerPage() {
  const { id = '' } = useParams()
  const q = useApi(['wf', 'template', id], () => wfApi.template(id))
  const meta = useWfMeta()
  return (
    <div>
      {q.isLoading || meta.isLoading ? <SkeletonRows rows={10} /> : q.error || !q.data || !meta.data ? <ErrorState error={q.error ?? meta.error} onRetry={() => { q.refetch(); meta.refetch() }} /> : <Editor key={q.data.version} t={q.data} meta={meta.data} />}
    </div>
  )
}

type Draft = TemplateBody & { self_service: boolean }

function Editor({ t, meta }: { t: TemplateBody & { id: string; version: number; rev?: number; running: number; self_service?: boolean }; meta: WfMeta }) {
  const nav = useNavigate()
  const ro = useReadOnly()
  const [d, setD] = useState<Draft>(() => JSON.parse(JSON.stringify({ name: t.name, process: t.process, description: t.description, active: t.active, self_service: !!t.self_service, stages: t.stages, on_complete: t.on_complete, on_reject: t.on_reject })))
  const [open, setOpen] = useState<number | null>(0)
  const [issues, setIssues] = useState<WfIssue[] | null>(null)
  const [checking, setChecking] = useState(false)
  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify({ name: t.name, process: t.process, description: t.description, active: t.active, self_service: !!t.self_service, stages: t.stages, on_complete: t.on_complete, on_reject: t.on_reject }), [d, t])
  const save = useMut(() => wfApi.save(t.id, d, t.version), { invalidate: [['wf']], success: 'Workflow saved', silentError: true, onError: (e: ApiError) => setIssues([{ path: e.field ?? 'form', message: e.message }]) })
  const run = async (andSave: boolean) => {
    setChecking(true)
    try {
      const r = await wfApi.check(d, t.id)
      setIssues(r.issues)
      if (andSave && !r.issues.length) save.mutate(undefined)
    } catch (e) {
      setIssues([{ path: 'form', message: (e as Error).message }])
    } finally {
      setChecking(false)
    }
  }
  const setStage = (i: number, s: WfStage) => setD((x) => ({ ...x, stages: x.stages.map((y, k) => (k === i ? s : y)) }))
  const move = (i: number, dir: -1 | 1) => setD((x) => {
    const st = [...x.stages]
    const j = i + dir
    if (j < 0 || j >= st.length) return x
    ;[st[i], st[j]] = [st[j], st[i]]
    st.forEach((s, k) => { if (k === 0) s.can_send_back = false })
    setOpen(j)
    return { ...x, stages: st }
  })
  const addStage = () => setD((x) => {
    const key = uniqueKey('review', x.stages.map((s) => s.key))
    setOpen(x.stages.length)
    return { ...x, stages: [...x.stages, { key, name: 'New review', assignee: 'reports_to', sla_days: 3, can_send_back: x.stages.length > 0, instructions: '', fields: [{ key: 'comments', label: 'Comments', type: 'textarea', required: false, visible_to: ['all'] }] }] }
  })
  const issueFor = (prefix: string) => (issues ?? []).filter((i) => i.path === prefix || i.path.startsWith(prefix + '.'))
  return (
    <div>
      <PageHeader
        back={{ to: '/workflows/designer', label: 'Workflow designer' }}
        title={d.name || 'Untitled workflow'}
        subtitle={`${PROCESS_LABEL[d.process]} · revision ${t.rev ?? 1}${t.running ? ` · ${t.running} running (they keep the revision they started with)` : ''}`}
        meta={<><Badge size="sm" tone={d.active ? 'success' : 'neutral'}>{d.active ? 'Active' : 'Inactive'}</Badge>{dirty && <Badge size="sm" tone="warning">Unsaved changes</Badge>}</>}
        actions={
          <>
            <Button onClick={() => nav('/workflows')}>Running workflows</Button>
            <Button loading={checking && !save.isPending} disabled={ro} onClick={() => run(false)}>Check</Button>
            <Button variant="primary" disabled={ro || !dirty} loading={save.isPending} onClick={() => run(true)}>Save</Button>
          </>
        }
      />
      {issues && (issues.length ? (
        <Callout tone="danger" className="mb-4" title={`${issues.length} ${issues.length === 1 ? 'problem' : 'problems'} to fix before saving`}>
          <ul className="list-disc space-y-0.5 pl-4">{issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
        </Callout>
      ) : (
        <Callout tone="success" className="mb-4">No problems found.{dirty ? ' Save to apply your changes.' : ''}</Callout>
      ))}
      <div className="grid gap-4 md:gap-5 xl:grid-cols-12">
        <div className="min-w-0 space-y-4 md:space-y-5 xl:col-span-8">
          <Card>
            <CardHeader title="General" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required error={issueFor('name')[0]?.message}>
                <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </Field>
              <Field label="Process type" required>
                <Select value={d.process} onChange={(e) => setD({ ...d, process: e.target.value as WfProcess })} options={Object.entries(PROCESS_LABEL).map(([value, label]) => ({ value, label }))} />
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <Textarea rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
              </Field>
              <Switch checked={d.active} onChange={(v) => setD({ ...d, active: v })} label="Active" description="Only active workflows can be started." />
              <Switch checked={d.self_service} onChange={(v) => setD({ ...d, self_service: v })} label="Employees can start it themselves" description="About themselves, without “Start workflows for others”." />
            </div>
          </Card>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold">Stages</h2>
              <Button size="sm" icon={<Plus />} disabled={ro || d.stages.length >= 12} onClick={addStage}>Add stage</Button>
            </div>
            <div className="space-y-3">
              {d.stages.map((s, i) => (
                <StageEditor key={i} s={s} i={i} all={d.stages} meta={meta} open={open === i} onToggle={() => setOpen(open === i ? null : i)} onChange={(x) => setStage(i, x)}
                  onMove={(dir) => move(i, dir)} onRemove={() => { setD((x) => ({ ...x, stages: x.stages.filter((_, k) => k !== i) })); setOpen(null) }} issues={issueFor(`stages.${i}`)} />
              ))}
              {!d.stages.length && <Callout tone="warning">Add at least one stage.</Callout>}
            </div>
          </div>

          <ActionsEditor title="When the last stage approves" subtitle="Runs once, in order. A CTC change goes to Change approvals for a checker — it is never applied silently." list={d.on_complete} stages={d.stages} meta={meta} onChange={(l) => setD({ ...d, on_complete: l })} issues={issueFor('on_complete')} where="on_complete" />
          <ActionsEditor title="When someone rejects" subtitle="Usually a notification to whoever started it." list={d.on_reject} stages={d.stages} meta={meta} onChange={(l) => setD({ ...d, on_reject: l })} issues={issueFor('on_reject')} where="on_reject" />
        </div>
        <div className="min-w-0 space-y-4 md:space-y-5 xl:col-span-4">
          <Matrix stages={d.stages} />
          {meta.departments_without_head.length > 0 && d.stages.some((s) => s.assignee === 'department_head') && (
            <Callout tone="warning" title="Departments without a head">{meta.departments_without_head.join(', ')} — unit-head stages for people there go to the parent unit’s head.</Callout>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------------- one stage ---------------- */
function StageEditor({ s, i, all, meta, open, onToggle, onChange, onMove, onRemove, issues }: {
  s: WfStage; i: number; all: WfStage[]; meta: WfMeta; open: boolean; onToggle: () => void; onChange: (s: WfStage) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; issues: WfIssue[]
}) {
  const ro = useReadOnly()
  const set = (p: Partial<WfStage>) => onChange({ ...s, ...p })
  const role = meta.roles.find((r) => r.key === s.role_key)
  const who = s.assignee === 'role' ? `${role?.name ?? 'Role'}${role ? ` (${role.holders.slice(0, 2).join(', ') || 'nobody'})` : ''}` : ASSIGNEE_LABEL[s.assignee]
  const err = (k: string) => issues.find((x) => x.path === `stages.${i}.${k}`)?.message
  const addField = () => set({ fields: [...s.fields, { key: uniqueKey('field', s.fields.map((f) => f.key)), label: 'New parameter', type: 'text', required: false, visible_to: [] }] })
  return (
    <Card pad={false} className={cn(issues.length > 0 && 'border-danger/50')}>
      <div className="flex min-w-0 items-center gap-2 px-4 py-3 md:px-5">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={open}>
          <span className="tnum grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] font-semibold text-ink-2">{i + 1}</span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold">{s.name || 'Unnamed stage'}</span>
            <span className="block truncate text-[12.5px] text-ink-3">{who} · {s.sla_days} working day{s.sla_days === 1 ? '' : 's'} · {s.fields.length} parameter{s.fields.length === 1 ? '' : 's'}{issues.length ? ` · ${issues.length} to fix` : ''}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center">
          <IconButton label="Move up" size="sm" disabled={ro || i === 0} onClick={() => onMove(-1)}><ArrowUp className="size-4" /></IconButton>
          <IconButton label="Move down" size="sm" disabled={ro || i === all.length - 1} onClick={() => onMove(1)}><ArrowDown className="size-4" /></IconButton>
          <IconButton label="Remove stage" size="sm" disabled={ro || all.length <= 1} onClick={onRemove}><Trash2 className="size-4" /></IconButton>
        </div>
      </div>
      {open && (
        <div className="space-y-5 border-t border-line px-4 py-4 md:px-5">
          {issues.length > 0 && <Callout tone="danger"><ul className="list-disc space-y-0.5 pl-4">{issues.map((x, k) => <li key={k}>{x.message}</li>)}</ul></Callout>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Stage name" required error={err('name')} className="sm:col-span-2">
              <Input value={s.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Key" required error={err('key')} hint="Used in field references">
              <Input value={s.key} onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
            </Field>
            <Field label="SLA (working days)" required error={err('sla_days')}>
              <Input type="number" min={1} max={30} value={String(s.sla_days)} onChange={(e) => set({ sla_days: Number(e.target.value) })} />
            </Field>
            <Field label="Who acts" required error={err('assignee')} hint={ASSIGNEE_HINT[s.assignee]} className="sm:col-span-2">
              <Select value={s.assignee} onChange={(e) => set({ assignee: e.target.value as WfAssignee })} options={Object.entries(ASSIGNEE_LABEL).map(([value, label]) => ({ value, label }))} />
            </Field>
            {s.assignee === 'role' && (
              <Field label="Role" required error={err('role_key')} hint={role ? (role.holders.length ? `Held by ${role.holders.join(', ')}` : 'Nobody holds this role yet') : undefined} className="sm:col-span-2">
                <Select value={s.role_key ?? ''} placeholder="Choose a role" onChange={(e) => set({ role_key: e.target.value })} options={meta.roles.map((r) => ({ value: r.key, label: `${r.name} (${r.holders.length})` }))} />
              </Field>
            )}
            {s.assignee === 'user' && (
              <Field label="Person" required error={err('user_id')} className="sm:col-span-2">
                <PeoplePicker value={s.user_id ?? null} onChange={(v) => set({ user_id: v })} />
              </Field>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Switch checked={s.can_send_back} disabled={i === 0} onChange={(v) => set({ can_send_back: v })} label="Can send back" description="Return to the previous stage with a reason." />
            <Switch checked={!!s.sees_compensation} onChange={(v) => set({ sees_compensation: v })} label="Sees compensation" description="Current CTC, hikes, new CTC, budget impact and pay band." />
          </div>
          <Field label="Instructions for the reviewer">
            <Textarea rows={2} value={s.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} />
          </Field>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold">Parameters this reviewer fills</h3>
              <Button size="sm" icon={<Plus />} disabled={ro} onClick={addField}>Add parameter</Button>
            </div>
            <div className="space-y-3">
              {s.fields.map((f, fi) => (
                <FieldEditor key={fi} f={f} fi={fi} stage={s} si={i} all={all} issues={issues.filter((x) => x.path.startsWith(`stages.${i}.fields.${fi}`))}
                  onChange={(nf) => set({ fields: s.fields.map((x, k) => (k === fi ? nf : x)) })}
                  onMove={(dir) => { const fs = [...s.fields]; const j = fi + dir; if (j < 0 || j >= fs.length) return; [fs[fi], fs[j]] = [fs[j], fs[fi]]; set({ fields: fs }) }}
                  onRemove={() => set({ fields: s.fields.filter((_, k) => k !== fi) })} />
              ))}
              {!s.fields.length && <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-3">No parameters — the reviewer just approves, sends back or rejects.</p>}
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

/* ---------------- one field (parameter) ---------------- */
function FieldEditor({ f, fi, stage, si, all, issues, onChange, onMove, onRemove }: {
  f: WfField; fi: number; stage: WfStage; si: number; all: WfStage[]; issues: WfIssue[]; onChange: (f: WfField) => void; onMove: (d: -1 | 1) => void; onRemove: () => void
}) {
  const ro = useReadOnly()
  const set = (p: Partial<WfField>) => onChange({ ...f, ...p })
  const err = (k: string) => issues.find((x) => x.path === `stages.${si}.fields.${fi}.${k}`)?.message
  const toggle = (k: string) => set({ visible_to: f.visible_to.includes(k) ? f.visible_to.filter((x) => x !== k) : [...f.visible_to, k] })
  const caps = all.slice(0, si).flatMap((s) => s.fields.filter((x) => NUMERIC.includes(x.type)).map((x) => ({ value: `${s.key}.${x.key}`, label: `${s.name} › ${x.label}` })))
  const reasons = stage.fields.filter((x) => (x.type === 'text' || x.type === 'textarea') && x.key !== f.key).map((x) => ({ value: x.key, label: x.label }))
  const [opts, setOpts] = useState((f.options ?? []).join('\n'))
  useEffect(() => setOpts((f.options ?? []).join('\n')), [f.type]) // eslint-disable-line react-hooks/exhaustive-deps
  const others = all.filter((s) => s.key !== stage.key)
  return (
    <div className={cn('rounded-md border p-3', issues.length ? 'border-danger/50' : 'border-line')}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
        <Field label="Label" required error={err('label')} className="lg:col-span-4">
          <Input value={f.label} onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field label="Key" required error={err('key')} className="lg:col-span-3">
          <Input value={f.key} onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
        </Field>
        <Field label="Type" error={err('type')} className="lg:col-span-3">
          <Select value={f.type} onChange={(e) => { const type = e.target.value as WfFieldType; set({ type, options: type === 'select' ? f.options ?? ['Yes', 'No'] : undefined, min: undefined, max: undefined, max_from: NUMERIC.includes(type) ? f.max_from : null }) }} options={Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </Field>
        <div className="flex items-end justify-between gap-2 sm:col-span-2 lg:col-span-2 lg:flex-col lg:items-end">
          <Checkbox checked={f.required} onChange={(v) => set({ required: v })} label="Required" />
          <div className="flex">
            <IconButton label="Move parameter up" size="xs" disabled={ro || fi === 0} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></IconButton>
            <IconButton label="Move parameter down" size="xs" disabled={ro || fi === stage.fields.length - 1} onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></IconButton>
            <IconButton label="Remove parameter" size="xs" disabled={ro} onClick={onRemove}><Trash2 className="size-3.5" /></IconButton>
          </div>
        </div>
        {f.type === 'select' && (
          <Field label="Options (one per line)" required error={err('options')} className="sm:col-span-2 lg:col-span-6">
            <Textarea rows={3} value={opts} onChange={(e) => { setOpts(e.target.value); set({ options: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }) }} />
          </Field>
        )}
        {(f.type === 'number' || f.type === 'percent' || f.type === 'rating' || f.type === 'text' || f.type === 'textarea') && (
          <>
            <Field label={f.type === 'text' || f.type === 'textarea' ? 'Min. characters' : 'Min'} error={err('min')} className="lg:col-span-3">
              <Input type="number" value={f.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </Field>
            {f.type !== 'text' && f.type !== 'textarea' && (
              <Field label="Max" error={err('max')} className="lg:col-span-3">
                <Input type="number" value={f.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </Field>
            )}
          </>
        )}
        <Field label="Help text" className="sm:col-span-2 lg:col-span-6">
          <Input value={f.help ?? ''} onChange={(e) => set({ help: e.target.value })} />
        </Field>
        {NUMERIC.includes(f.type) && caps.length > 0 && (
          <>
            <Field label="Cap at an earlier value" hint="e.g. approved hike ≤ normalised hike" error={err('max_from')} className="lg:col-span-6">
              <Select value={f.max_from ?? ''} onChange={(e) => set({ max_from: e.target.value || null })} options={[{ value: '', label: 'No cap' }, ...caps]} />
            </Field>
            {f.max_from && (
              <Field label="Unless a reason is given in" hint="Leave empty to make the cap strict" error={err('override_field')} className="lg:col-span-6">
                <Select value={f.override_field ?? ''} onChange={(e) => set({ override_field: e.target.value || null })} options={[{ value: '', label: 'Strict cap' }, ...reasons]} />
              </Field>
            )}
          </>
        )}
        <div className="sm:col-span-2 lg:col-span-12">
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">Who else can see this value</div>
          <div className="flex flex-wrap gap-1.5">
            {others.map((o) => <Chip key={o.key} on={f.visible_to.includes(o.key)} onClick={() => toggle(o.key)}>{o.name || o.key}</Chip>)}
            <Chip on={f.visible_to.includes('subject')} onClick={() => toggle('subject')}>Employee (after completion)</Chip>
            <Chip on={f.visible_to.includes('all')} onClick={() => toggle('all')}>Everyone on the workflow</Chip>
          </div>
          {err('visible_to') && <p className="mt-1 text-[12.5px] font-medium text-danger-text">{err('visible_to')}</p>}
          <p className="mt-1 text-[12px] text-ink-3">{stage.name || 'This stage'} always sees its own values. {f.visible_to.length ? '' : 'Nobody else will see this value.'}</p>
        </div>
      </div>
    </div>
  )
}
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn('inline-flex h-7 max-w-full items-center gap-1 truncate rounded-sm border px-2 text-[12.5px]', on ? 'border-brand bg-brand-soft font-medium text-brand-text' : 'border-line-strong bg-surface text-ink-2 hover:bg-surface-2')}>
      {on && <Check className="size-3.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </button>
  )
}

/* ---------------- completion / rejection actions ---------------- */
function ActionsEditor({ title, subtitle, list, stages, meta, onChange, issues, where }: { title: string; subtitle: string; list: WfAction[]; stages: WfStage[]; meta: WfMeta; onChange: (l: WfAction[]) => void; issues: WfIssue[]; where: 'on_complete' | 'on_reject' }) {
  const ro = useReadOnly()
  const fields = (types?: WfFieldType[]) => stages.flatMap((s) => s.fields.filter((f) => !types || types.includes(f.type)).map((f) => ({ value: `${s.key}.${f.key}`, label: `${s.name} › ${f.label}` })))
  const set = (i: number, a: WfAction) => onChange(list.map((x, k) => (k === i ? a : x)))
  const types = (Object.keys(ACTION_LABEL) as WfAction['type'][]).filter((x) => where === 'on_complete' || x !== 'update_ctc')
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} action={<Button size="sm" icon={<Plus />} disabled={ro} onClick={() => onChange([...list, { type: 'notify', config: { to: 'subject', message: '' } }])}>Add action</Button>} />
      <div className="space-y-3">
        {list.map((a, i) => {
          const cfg = (a.config ?? {}) as Record<string, unknown>
          const setCfg = (p: Record<string, unknown>) => set(i, { ...a, config: { ...cfg, ...p } })
          const err = (k: string) => issues.find((x) => x.path === `${where}.${i}.${k}` || (k === '' && x.path === `${where}.${i}`))?.message
          const vars = Object.entries((cfg.vars ?? {}) as Record<string, string>)
          const when = (cfg.when ?? null) as { field?: string; equals?: string } | null
          return (
            <div key={i} className={cn('rounded-md border p-3', issues.some((x) => x.path.startsWith(`${where}.${i}`)) ? 'border-danger/50' : 'border-line')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={`Action ${i + 1}`} error={err('')}>
                  <Select value={a.type} onChange={(e) => set(i, { type: e.target.value as WfAction['type'], template_key: null, config: e.target.value === 'update_ctc' ? { hike_field: '', effective_field: '' } : { to: 'subject' } })} options={types.map((x) => ({ value: x, label: ACTION_LABEL[x] }))} />
                </Field>
                <div className="flex items-end justify-end">
                  <Button size="sm" variant="ghost" icon={<Trash2 />} disabled={ro} onClick={() => onChange(list.filter((_, k) => k !== i))}>Remove</Button>
                </div>
                {a.type === 'generate_document' && (
                  <Field label="Document template" required error={err('template_key')}>
                    <Select value={a.template_key ?? ''} placeholder="Choose a template" onChange={(e) => set(i, { ...a, template_key: e.target.value })} options={meta.doc_templates.map((x) => ({ value: x.key, label: `${x.name}${x.active ? '' : ' (inactive)'}` }))} />
                  </Field>
                )}
                {a.type === 'send_email' && (
                  <Field label="Email template" required error={err('template_key')}>
                    <Select value={a.template_key ?? ''} placeholder="Choose a template" onChange={(e) => set(i, { ...a, template_key: e.target.value })} options={meta.email_templates.map((x) => ({ value: x.key, label: x.name }))} />
                  </Field>
                )}
                {(a.type === 'send_email' || a.type === 'notify' || a.type === 'create_task') && (
                  <Field label={a.type === 'create_task' ? 'Assign to' : 'Send to'} error={err('to')}>
                    <Select value={String(cfg.to ?? 'subject')} onChange={(e) => setCfg({ to: e.target.value })} options={[...Object.entries(TO_LABEL).map(([value, label]) => ({ value, label })), ...meta.roles.map((r) => ({ value: `role:${r.key}`, label: `Role: ${r.name}` }))]} />
                  </Field>
                )}
                {a.type === 'notify' && (
                  <Field label="Message" className="sm:col-span-2">
                    <Input value={String(cfg.message ?? '')} onChange={(e) => setCfg({ message: e.target.value })} />
                  </Field>
                )}
                {a.type === 'create_task' && (
                  <>
                    <Field label="Task title" required error={err('title')}>
                      <Input value={String(cfg.title ?? '')} onChange={(e) => setCfg({ title: e.target.value })} />
                    </Field>
                    <Field label="Due in (working days)">
                      <Input type="number" min={1} max={60} value={String(cfg.due_days ?? 3)} onChange={(e) => setCfg({ due_days: Number(e.target.value) })} />
                    </Field>
                  </>
                )}
                {a.type === 'update_ctc' && (
                  <>
                    <Field label="Approved hike % comes from" required error={err('hike_field')}>
                      <Select value={String(cfg.hike_field ?? '')} placeholder="Choose a field" onChange={(e) => setCfg({ hike_field: e.target.value })} options={fields(['percent', 'number'])} />
                    </Field>
                    <Field label="Effective date comes from" required error={err('effective_field')}>
                      <Select value={String(cfg.effective_field ?? '')} placeholder="Choose a field" onChange={(e) => setCfg({ effective_field: e.target.value })} options={fields(['date'])} />
                    </Field>
                    <Field label="Recommended hike (shown to finance)">
                      <Select value={String(cfg.recommended_field ?? '')} onChange={(e) => setCfg({ recommended_field: e.target.value || undefined })} options={[{ value: '', label: 'Not used' }, ...fields(['percent', 'number'])]} />
                    </Field>
                    <Field label="Normalised hike (shown to finance)">
                      <Select value={String(cfg.normalised_field ?? '')} onChange={(e) => setCfg({ normalised_field: e.target.value || undefined })} options={[{ value: '', label: 'Not used' }, ...fields(['percent', 'number'])]} />
                    </Field>
                    <p className="text-[12px] leading-snug text-ink-3 sm:col-span-2">The new monthly CTC = current CTC × (1 + hike %). It is proposed under Change approvals (maker-checker, same rules as Settings → Cost rates).</p>
                  </>
                )}
                {(a.type === 'generate_document' || a.type === 'send_email') && (
                  <div className="sm:col-span-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-ink-2">Placeholders filled from parameters</span>
                      <Button size="xs" variant="ghost" icon={<Plus />} disabled={ro} onClick={() => setCfg({ vars: { ...Object.fromEntries(vars), [`var_${vars.length + 1}`]: '' } })}>Add</Button>
                    </div>
                    <div className="space-y-2">
                      {vars.map(([k, path], vi) => (
                        <div key={vi} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
                          <Input aria-label="Placeholder" value={k} onChange={(e) => setCfg({ vars: Object.fromEntries(vars.map(([kk, pp], j) => (j === vi ? [e.target.value.replace(/[^a-z0-9_]/gi, ''), pp] : [kk, pp]))) })} />
                          <Select aria-label="Parameter" value={path} placeholder="Choose a parameter" onChange={(e) => setCfg({ vars: Object.fromEntries(vars.map(([kk, pp], j) => (j === vi ? [kk, e.target.value] : [kk, pp]))) })} options={fields()} />
                          <IconButton label="Remove placeholder" size="sm" disabled={ro} onClick={() => setCfg({ vars: Object.fromEntries(vars.filter((_, j) => j !== vi)) })}><Trash2 className="size-4" /></IconButton>
                        </div>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[12px] text-ink-3">Employee, designation, department, company, manager and the CTC values (old_ctc, new_ctc, hike_pct) are filled automatically.</p>
                  </div>
                )}
                <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
                  <Field label="Only when" error={err('when')}>
                    <Select value={when?.field ?? ''} onChange={(e) => setCfg({ when: e.target.value ? { field: e.target.value, equals: when?.equals ?? '' } : undefined })} options={[{ value: '', label: 'Always' }, ...fields(['select', 'checkbox', 'text'])]} />
                  </Field>
                  {when?.field && (
                    <Field label="equals">
                      <Input value={String(when.equals ?? '')} onChange={(e) => setCfg({ when: { field: when.field, equals: e.target.value } })} />
                    </Field>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {!list.length && <p className="text-[13px] text-ink-3">No actions.</p>}
      </div>
    </Card>
  )
}

/* ---------------- who sees what ---------------- */
function Matrix({ stages }: { stages: WfStage[] }) {
  const cols = [...stages.map((s) => ({ key: s.key, name: s.name })), { key: 'subject', name: 'Employee' }]
  const sees = (owner: string, f: WfField, col: string) => col === owner || f.visible_to.includes('all') || f.visible_to.includes(col)
  return (
    <Card pad={false}>
      <div className="px-5 pt-4"><CardHeader title="Who sees what" subtitle="Each reviewer sees only the values marked for their stage. The employee sees theirs after completion." /></div>
      <div className="overflow-x-auto pb-3">
        <table className="w-full min-w-[420px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-3 py-2 text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">Parameter</th>
              {cols.map((c) => <th key={c.key} className="px-1.5 py-2 text-center text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3" title={c.name}><span className="block max-w-[64px] truncate">{c.name}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {stages.flatMap((s) => s.fields.map((f) => (
              <tr key={`${s.key}.${f.key}`} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5"><span className="block max-w-[180px] truncate">{f.label}</span><span className="block truncate text-[11px] text-ink-3">{s.name}</span></td>
                {cols.map((c) => (
                  <td key={c.key} className="px-1.5 py-1.5 text-center">
                    {c.key === s.key || (c.key === 'subject' && s.assignee === 'subject') ? <span className="text-[11px] text-ink-3">fills</span> : sees(s.key, f, c.key) ? <Check className="mx-auto size-3.5 text-success-text" aria-label="sees" /> : <span className="text-ink-3">—</span>}
                  </td>
                ))}
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
