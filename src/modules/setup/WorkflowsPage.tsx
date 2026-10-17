// Setup → Approval workflows: who approves leave, expenses, purchase orders, vendor bills, timesheets
// and task reviews — in which order, from which amount, with what deadline and escalation.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ApproverType, WorkflowProcess, WorkflowStep } from '@/types/access'
import { workflowsApi, useWorkflows, type SimulationResult, type WorkflowView, type WorkflowsResult } from '@/api/workflows'
import { announce } from '@/api/changes'
import { useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { useSpendMeta } from '@/api/spend'
import type { ApiError } from '@/api/http'
import { fmtMoney } from '@/domain/money'
import { relTime } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from '@/ui/icons'
import {
  Avatar, Badge, Button, Callout, Card, Checkbox, ErrorState, Field, IconButton, Input, MoneyInput, PageHeader, PeoplePicker, Select, Sheet, SkeletonCards, useConfirm, useReadOnly, useCan,
} from '@/ui'
import { approverName } from '@/modules/workflows/ChangeDiff'

const AMOUNT: WorkflowProcess[] = ['expense', 'purchase_order', 'vendor_bill']
const PROJECT: WorkflowProcess[] = ['expense', 'purchase_order', 'task_review']
function approverTypes(p: WorkflowProcess): ApproverType[] {
  const all: ApproverType[] = ['reports_to', 'skip_level', 'department_head', 'project_pm', 'project_pm_or_manager', 'task_reviewer', 'role', 'user']
  return all.filter((t) => (t === 'task_reviewer' ? p === 'task_review' : t === 'project_pm' || t === 'project_pm_or_manager' ? PROJECT.includes(p) : true))
}

export default function WorkflowsPage() {
  const q = useWorkflows()
  const [edit, setEdit] = useState<WorkflowProcess | null>(null)
  const can = useCan()
  const canEdit = can('workflows.manage')
  if (q.isLoading) return <><PageHeader title="Approval workflows" /><SkeletonCards n={4} /></>
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  const roleNames = Object.fromEntries(d.roles.map((r) => [r.key, r.name]))
  const current = d.workflows.find((w) => w.process === edit) ?? null
  return (
    <div>
      <PageHeader title="Approval workflows" subtitle="Who approves each request, in which order, and how long they have. New requests follow these steps; requests already waiting keep their approvers." />
      {d.maker_checker && <Callout tone="info" className="mb-4">Workflow changes need a second person: saving sends the change to Change approvals, and it applies once a checker approves it.</Callout>}
      <div className="grid gap-4 md:grid-cols-2">
        {d.workflows.map((w) => <WorkflowCard key={w.process} w={w} roleNames={roleNames} canEdit={canEdit} onEdit={() => setEdit(w.process)} />)}
      </div>
      {current && <Editor key={current.process + current.version} w={current} data={d} roleNames={roleNames} onClose={() => setEdit(null)} />}
    </div>
  )
}

function StepLine({ s, i, roleNames }: { s: WorkflowStep; i: number; roleNames: Record<string, string> }) {
  const people = usePeopleNames()
  return (
    <li className="flex gap-3">
      <span className="tnum mt-px grid size-6 shrink-0 place-items-center rounded-full border border-line text-[12px] font-medium text-ink-2">{i + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-[13.5px] text-ink">
          {approverName(s, (k) => roleNames[k] ?? k, people)}
          {s.min_amount_paise ? <span className="text-ink-2"> · above <span className="tnum whitespace-nowrap">{fmtMoney(s.min_amount_paise)}</span></span> : null}
        </div>
        <div className="text-[12px] text-ink-3">
          {s.name} · {s.sla_days} working day{s.sla_days === 1 ? '' : 's'}
          {s.escalate_to ? ` · escalates to ${approverName(s.escalate_to, (k) => roleNames[k] ?? k, people)}` : ''}
        </div>
      </div>
    </li>
  )
}
function usePeopleNames() {
  const m = usePeopleMap()
  return (id: string) => m.get(id)?.name ?? 'A person'
}

function WorkflowCard({ w, roleNames, canEdit, onEdit }: { w: WorkflowView; roleNames: Record<string, string>; canEdit: boolean; onEdit: () => void }) {
  const ro = useReadOnly()
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">{w.process_label}</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">{w.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {w.is_default ? <Badge size="sm">Default</Badge> : <Badge size="sm" tone="info">Customised</Badge>}
        </div>
      </div>
      <ol className="mt-3 space-y-2.5">{w.steps.map((s, i) => <StepLine key={s.id} s={s} i={i} roleNames={roleNames} />)}</ol>
      {w.pending_change && (
        <div className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-[12.5px] text-warning-text">
          Change waiting for approval — proposed by {w.pending_change.maker_name} {relTime(w.pending_change.created_at)}. <Link className="font-medium underline" to={`/changes?id=${w.pending_change.id}`}>Review</Link>
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <span className="min-w-0 truncate text-[12px] text-ink-3">{w.steps.length} step{w.steps.length === 1 ? '' : 's'}{AMOUNT.includes(w.process) ? ' · amount rules apply' : ''}</span>
        {canEdit && !ro ? <Button size="sm" onClick={onEdit}>Edit</Button> : <Button size="sm" variant="ghost" onClick={onEdit}>View</Button>}
      </div>
    </Card>
  )
}

/* ================================================================== */
/* Editor                                                              */
/* ================================================================== */
type Draft = WorkflowStep & { _k: string }
let seq = 0
const newKey = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`

function Editor({ w, data, roleNames, onClose }: { w: WorkflowView; data: WorkflowsResult; roleNames: Record<string, string>; onClose: () => void }) {
  const ro = useReadOnly() || !useCan()('workflows.manage')
  const { confirm } = useConfirm()
  const personName = usePeopleNames()
  const [steps, setSteps] = useState<Draft[]>(() => w.steps.map((s) => ({ ...s, _k: s.id })))
  const [ack, setAck] = useState(false)
  const amount = AMOUNT.includes(w.process)
  const types = approverTypes(w.process)
  const roles = data.roles.filter((r) => r.active)
  const clean = (): WorkflowStep[] => steps.map(({ _k, ...s }) => ({ ...s, min_amount_paise: s.min_amount_paise || null }))
  const allAmounts = amount && steps.length > 0 && steps.every((s) => !!s.min_amount_paise)
  const dirty = JSON.stringify(clean()) !== JSON.stringify(w.steps.map((s) => ({ ...s, min_amount_paise: s.min_amount_paise || null })))
  const save = useMut(() => workflowsApi.save(w.process, { steps: clean(), acknowledge_fallback: ack }, w.version), {
    invalidate: [['workflows'], ['changes']],
    onSuccess: (r) => {
      announce(r, `${w.process_label} workflow saved`)
      onClose()
    },
  })
  const reset = useMut(() => workflowsApi.reset(w.process, w.version), {
    invalidate: [['workflows'], ['changes']],
    onSuccess: (r) => {
      announce(r, `${w.process_label} workflow reset to the default`)
      onClose()
    },
  })
  const err = (save.error ?? reset.error) as ApiError | null
  const fe = (f: string) => (err?.field === f ? err.message : null)
  const set = (i: number, patch: Partial<WorkflowStep>) => setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const move = (i: number, d: -1 | 1) => setSteps((xs) => {
    const ys = [...xs]
    const [x] = ys.splice(i, 1)
    ys.splice(i + d, 0, x)
    return ys
  })
  const add = () => setSteps((xs) => [...xs, { _k: newKey(), id: newKey(), name: 'Approval', approver: 'role', role_id: roles.find((r) => r.key === 'ceo')?.key ?? roles[0]?.key ?? null, sla_days: 2, min_amount_paise: null, escalate_to: null, allow_self: false }])
  const pend = w.pending_change
  const busy = save.isPending || reset.isPending
  const stepsErr = err?.field === 'steps' ? err.message : null

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      width={760}
      title={w.process_label}
      subtitle={ro ? 'Read-only' : 'Steps run top to bottom. A step that resolves to the requester is skipped.'}
      footer={
        ro ? <Button onClick={onClose}>Close</Button> : (
          <>
            {!w.is_default && (
              <Button
                variant="ghost"
                icon={<RotateCcw className="size-4" />}
                disabled={busy || !!pend}
                className="mr-auto"
                onClick={async () => (await confirm({ title: 'Reset to the default steps?', body: 'The workflow goes back to how SeereonOS ships it. Requests already waiting keep their approvers.', confirmLabel: 'Reset' })) && reset.mutate(undefined)}
              >
                Reset to default
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} disabled={!dirty || busy || !!pend || (allAmounts && !ack)} onClick={() => save.mutate(undefined)}>
              {data.maker_checker ? 'Propose change' : 'Save workflow'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        {pend && (
          <Callout tone="warning" title="A change is waiting for approval" action={<Link to={`/changes?id=${pend.id}`}><Button size="sm">Open</Button></Link>}>
            {pend.summary}. Edit again once it is approved, rejected or withdrawn.
          </Callout>
        )}
        {(stepsErr || (err && !err.field?.startsWith('steps.'))) && <Callout tone="danger">{stepsErr ?? err?.message}</Callout>}
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s._k} className="rounded-lg border border-line">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="tnum grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] font-medium text-ink-2">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{s.name || `Step ${i + 1}`}</span>
                {!ro && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton size="sm" variant="ghost" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></IconButton>
                    <IconButton size="sm" variant="ghost" label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></IconButton>
                    <IconButton size="sm" variant="ghost" label="Remove step" disabled={steps.length === 1} onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
                  </div>
                )}
              </div>
              <div className="grid gap-3 p-3 sm:grid-cols-2">
                <Field label="Step name" htmlFor={`n-${s._k}`} error={fe(`steps.${i}.name`)} required>
                  <Input id={`n-${s._k}`} value={s.name} disabled={ro} maxLength={60} onChange={(e) => set(i, { name: e.target.value })} invalid={!!fe(`steps.${i}.name`)} />
                </Field>
                <Field label="Who approves" htmlFor={`a-${s._k}`} error={fe(`steps.${i}.approver`)} required>
                  <Select id={`a-${s._k}`} value={s.approver} disabled={ro} options={types.map((t) => ({ value: t, label: data.approver_labels[t] }))} onChange={(e) => set(i, { approver: e.target.value as ApproverType, role_id: e.target.value === 'role' ? s.role_id ?? roles[0]?.key ?? null : null, user_id: e.target.value === 'user' ? s.user_id ?? null : null })} />
                </Field>
                {s.approver === 'role' && (
                  <Field label="Role" htmlFor={`r-${s._k}`} error={fe(`steps.${i}.role_id`)} required hint={s.role_id ? holdersHint(data, s.role_id) : undefined}>
                    <Select id={`r-${s._k}`} value={s.role_id ?? ''} disabled={ro} placeholder="Choose a role" options={roles.map((r) => ({ value: r.key, label: r.name }))} onChange={(e) => set(i, { role_id: e.target.value || null })} invalid={!!fe(`steps.${i}.role_id`)} />
                  </Field>
                )}
                {s.approver === 'user' && (
                  <Field label="Person" error={fe(`steps.${i}.user_id`)} required>
                    {ro ? <Input value={personName(s.user_id ?? '')} disabled /> : <PeoplePicker value={s.user_id ?? null} onChange={(v) => set(i, { user_id: v })} invalid={!!fe(`steps.${i}.user_id`)} />}
                  </Field>
                )}
                {amount && (
                  <Field label="Only when the amount is above" htmlFor={`m-${s._k}`} error={fe(`steps.${i}.min_amount_paise`)} hint="Leave empty to apply to every request.">
                    <MoneyInput
                      id={`m-${s._k}`}
                      value={s.min_amount_paise ?? null}
                      disabled={ro}
                      // keep a name like "CEO approval above ₹25,000" in step with the threshold
                      onChange={(v) => set(i, { min_amount_paise: v || null, ...(s.min_amount_paise && v && s.name.includes(fmtMoney(s.min_amount_paise)) ? { name: s.name.replace(fmtMoney(s.min_amount_paise), fmtMoney(v)) } : {}) })}
                      invalid={!!fe(`steps.${i}.min_amount_paise`)}
                    />
                  </Field>
                )}
                <Field label="Deadline (working days)" htmlFor={`d-${s._k}`} error={fe(`steps.${i}.sla_days`)} hint="1 to 15. Overdue items are flagged in the inbox.">
                  <Input id={`d-${s._k}`} type="number" min={1} max={15} value={String(s.sla_days)} disabled={ro} onChange={(e) => set(i, { sla_days: Number(e.target.value) })} invalid={!!fe(`steps.${i}.sla_days`)} />
                </Field>
                <Field label="After the deadline, escalate to" htmlFor={`e-${s._k}`} error={fe(`steps.${i}.escalate_to.approver`) ?? fe(`steps.${i}.escalate_to.role_id`) ?? fe(`steps.${i}.escalate_to.user_id`)}>
                  <Select
                    id={`e-${s._k}`}
                    value={s.escalate_to?.approver ?? ''}
                    disabled={ro}
                    options={[{ value: '', label: 'Nobody — keep it with the approver' }, ...types.filter((t) => t !== 'task_reviewer').map((t) => ({ value: t, label: data.approver_labels[t] }))]}
                    onChange={(e) => set(i, { escalate_to: e.target.value ? { approver: e.target.value as ApproverType, role_id: e.target.value === 'role' ? roles.find((r) => r.key === 'ceo')?.key ?? roles[0]?.key ?? null : null, user_id: null } : null })}
                  />
                </Field>
                {s.escalate_to?.approver === 'role' && (
                  <Field label="Escalation role" htmlFor={`er-${s._k}`} error={fe(`steps.${i}.escalate_to.role_id`)}>
                    <Select id={`er-${s._k}`} value={s.escalate_to.role_id ?? ''} disabled={ro} options={roles.map((r) => ({ value: r.key, label: r.name }))} onChange={(e) => set(i, { escalate_to: { ...s.escalate_to!, role_id: e.target.value } })} />
                  </Field>
                )}
                {s.escalate_to?.approver === 'user' && (
                  <Field label="Escalation person" error={fe(`steps.${i}.escalate_to.user_id`)}>
                    <PeoplePicker value={s.escalate_to.user_id ?? null} onChange={(v) => set(i, { escalate_to: { ...s.escalate_to!, user_id: v } })} />
                  </Field>
                )}
                <div className="sm:col-span-2">
                  <Checkbox checked={!!s.allow_self} disabled={ro} onChange={(v) => set(i, { allow_self: v })} label="Allow self-approval" description="Off: when the approver is the requester, this step is skipped. Turn on only for steps where that is acceptable." />
                </div>
              </div>
            </li>
          ))}
        </ol>
        {!ro && steps.length < 5 && (
          <Button variant="ghost" icon={<Plus className="size-4" />} onClick={add}>Add step</Button>
        )}
        {allAmounts && !ro && (
          <Callout tone="warning" title="Small requests have no step">
            <Checkbox checked={ack} onChange={setAck} label={`Requests at or below ${fmtMoney(Math.min(...steps.map((s) => s.min_amount_paise ?? 0)))} go to the CEO`} description="Every step has a threshold. Confirm this fallback, or add a step without an amount." />
          </Callout>
        )}
        <TestPanel w={w} steps={clean()} />
      </div>
    </Sheet>
  )
}
function holdersHint(d: WorkflowsResult, key: string) {
  const r = d.roles.find((x) => x.key === key)
  if (!r) return undefined
  return r.holders ? `${r.holders} active ${r.holders === 1 ? 'person holds' : 'people hold'} this role; the longest-serving one is asked.` : 'Nobody holds this role yet — the step will be skipped.'
}

/* ---------------- "Test this workflow" ---------------- */
function TestPanel({ w, steps }: { w: WorkflowView; steps: WorkflowStep[] }) {
  const me = useSession((s) => s.user?.id ?? null)
  const meta = useSpendMeta()
  const [requester, setRequester] = useState<string | null>(me)
  const [amt, setAmt] = useState<number>(w.process === 'expense' ? 3_000_000 : 5_000_000)
  const [project, setProject] = useState<string>('')
  const [res, setRes] = useState<SimulationResult | null>(null)
  const amount = AMOUNT.includes(w.process)
  const proj = PROJECT.includes(w.process)
  const sim = useMut(() => workflowsApi.simulate(w.process, { requester_id: requester!, amount_paise: amount ? amt : null, project_id: proj && project ? project : null, steps }), { onSuccess: (r) => setRes(r) })
  const projects = useMemo(() => (meta.data?.projects ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })), [meta.data])
  return (
    <section className="rounded-lg border border-line bg-surface-2/50 p-3">
      <h3 className="text-[14px] font-semibold text-ink">Test this workflow</h3>
      <p className="mt-0.5 text-[12.5px] text-ink-3">See who would approve a request with the steps above — nothing is saved.</p>
      <div className={cn('mt-3 grid gap-3', amount || proj ? 'sm:grid-cols-2' : '')}>
        <Field label="Requester">
          <PeoplePicker value={requester} onChange={setRequester} />
        </Field>
        {amount && (
          <Field label="Amount" htmlFor="sim-amt">
            <MoneyInput id="sim-amt" value={amt} onChange={setAmt} />
          </Field>
        )}
        {proj && (
          <Field label="Project" htmlFor="sim-proj" className={amount ? 'sm:col-span-2' : ''}>
            <Select id="sim-proj" value={project} onChange={(e) => setProject(e.target.value)} options={[{ value: '', label: 'No project' }, ...projects]} />
          </Field>
        )}
      </div>
      <div className="mt-3">
        <Button size="sm" disabled={!requester} loading={sim.isPending} onClick={() => sim.mutate(undefined)}>Run test</Button>
      </div>
      {res && (
        <div className="mt-3 space-y-2" aria-live="polite">
          {res.auto_approved ? (
            <p className="text-[13px] text-ink-2">{res.summary}</p>
          ) : (
            <ol className="space-y-2">
              {res.steps.map((s, i) => (
                <li key={i} className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2">
                  <span className="tnum grid size-6 shrink-0 place-items-center rounded-full border border-line text-[12px] text-ink-2">{i + 1}</span>
                  <Avatar name={s.approver_name} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{s.approver_name}</div>
                    <div className="truncate text-[12px] text-ink-3">{s.name} · {s.sla_days}d{s.escalate_to_name ? ` · then ${s.escalate_to_name}` : ''}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {res.fallback && !res.auto_approved && <p className="text-[12.5px] text-warning-text">No step matched, so the top approver decides.</p>}
          {res.skipped.length > 0 && (
            <ul className="space-y-0.5 text-[12.5px] text-ink-3">
              {res.skipped.map((s, i) => <li key={i}>Skipped “{s.name}”: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
