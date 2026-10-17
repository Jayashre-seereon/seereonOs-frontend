// Shared bits for the workflow screens: labels, the per-field input, read-only values, the stage timeline,
// the compensation facts card and the "start a workflow" dialog.
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Clock, Search } from '@/ui/icons'
import { useMut } from '@/api/query'
import { useDirectory } from '@/api/core'
import { wfApi, WF_INV, useWfMeta, useWfTemplates, type WfFacts, type WfPerson, type WfStageView, type WfStatus } from '@/api/wf'
import type { ApiError } from '@/api/http'
import type { WfField, WfProcess } from '@/types/v7'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import type { Tone } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Button, Callout, Card, CardHeader, Checkbox, Dialog, Field, FileUpload, Input, MoneyInput, Select, Textarea } from '@/ui'
import { RatingInput } from '@/modules/hr/components'

export const PROCESS_LABEL: Record<WfProcess, string> = {
  appraisal: 'Appraisal', onboarding: 'Onboarding', exit: 'Exit', confirmation: 'Confirmation', promotion: 'Promotion', expense: 'Expense', leave: 'Leave', document_approval: 'Document approval', general: 'General',
}
export const WF_STATUS: Record<WfStatus, { label: string; tone: Tone }> = {
  in_progress: { label: 'In progress', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}
export const FIELD_TYPE_LABEL: Record<WfField['type'], string> = {
  rating: 'Rating 1–5', text: 'Short text', textarea: 'Long text', number: 'Number', percent: 'Percent', money: 'Money (₹)', select: 'Select', date: 'Date', checkbox: 'Checkbox', file: 'File',
}
export const HISTORY_LABEL: Record<string, string> = {
  started: 'Started', submitted: 'Submitted', approved: 'Approved', sent_back: 'Sent back', rejected: 'Rejected', reassigned: 'Reassigned', completed: 'Completed', escalated: 'Escalated (overdue)', cancelled: 'Cancelled',
}

export function PersonChip({ p, sub, size = 24 }: { p: WfPerson | null; sub?: ReactNode; size?: number }) {
  if (!p) return <span className="text-ink-3">—</span>
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={p.name} hue={p.hue} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-ink">{p.name}</span>
        {sub !== undefined ? <span className="block truncate text-[12px] text-ink-3">{sub}</span> : <span className="block truncate text-[12px] text-ink-3">{p.title}</span>}
      </span>
    </span>
  )
}

/** The input for one workflow field (reviewer parameter). */
export function FieldInput({ f, value, onChange, error }: { f: WfField; value: unknown; onChange: (v: unknown) => void; error?: string | null }) {
  const id = `wf-${f.key}`
  const hint = f.help ?? (f.type === 'percent' && (f.min !== undefined || f.max !== undefined) ? `${f.min ?? 0}–${f.max ?? 100}%` : f.type === 'textarea' && f.min ? `At least ${f.min} characters` : undefined)
  if (f.type === 'checkbox')
    return (
      <div className="min-w-0">
        <Checkbox id={id} checked={value === true} onChange={(v) => onChange(v)} label={<>{f.label}{f.required && <span className="ml-0.5 text-danger-text">*</span>}</>} description={f.help} />
        {error && <p className="mt-1 text-[12.5px] font-medium text-danger-text">{error}</p>}
      </div>
    )
  let input: ReactNode
  switch (f.type) {
    case 'rating':
      input = <RatingInput value={typeof value === 'number' ? value : null} onChange={(v) => onChange(v)} />
      break
    case 'textarea':
      input = <Textarea id={id} rows={4} value={String(value ?? '')} invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      break
    case 'select':
      input = <Select id={id} value={String(value ?? '')} invalid={!!error} placeholder="Choose…" options={f.options ?? []} onChange={(e) => onChange(e.target.value)} />
      break
    case 'date':
      input = <Input id={id} type="date" value={String(value ?? '')} invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      break
    case 'money':
      input = <MoneyInput id={id} value={typeof value === 'number' ? value : null} invalid={!!error} onChange={(p) => onChange(p)} />
      break
    case 'percent':
    case 'number':
      input = (
        <Input id={id} type="number" inputMode="decimal" step="0.5" min={f.min} max={f.max} value={value === null || value === undefined ? '' : String(value)} invalid={!!error} suffix={f.type === 'percent' ? '%' : undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
      )
      break
    case 'file':
      input = <FileUpload file={(value as { name: string; size?: number } | null) ?? null} onFile={(file) => onChange({ name: file.name, size: file.size })} onClear={() => onChange(null)} />
      break
    default:
      input = <Input id={id} value={String(value ?? '')} invalid={!!error} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <Field label={f.label} required={f.required} htmlFor={id} error={error} hint={hint}>
      {input}
    </Field>
  )
}

/** Read-only value of a field from an earlier stage. */
export function FieldValue({ f, display }: { f: WfField; display: string }) {
  const long = f.type === 'textarea'
  return (
    <div className={cn('min-w-0', long && 'sm:col-span-2')}>
      <dt className="text-[12px] text-ink-3">{f.label}</dt>
      <dd className={cn('mt-0.5 text-[13.5px] text-ink', long ? 'whitespace-pre-line leading-relaxed text-ink-2' : 'font-medium', (f.type === 'rating' || f.type === 'percent' || f.type === 'money' || f.type === 'number') && 'tnum')}>{display}</dd>
    </div>
  )
}

/** Horizontal (desktop) / vertical (phone) stage timeline. */
export function StageTimeline({ stages, compact }: { stages: Pick<WfStageView, 'name' | 'status' | 'person' | 'acted_at' | 'due_on' | 'overdue'>[]; compact?: boolean }) {
  return (
    <ol className={cn('grid gap-2', compact ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5')}>
      {stages.map((s, i) => {
        const done = s.status === 'done'
        const cur = s.status === 'current'
        return (
          <li key={i} className={cn('min-w-0 rounded-md border px-3 py-2', cur ? 'border-brand bg-brand-soft' : 'border-line bg-surface', s.status === 'skipped' && 'opacity-60')}>
            <div className="flex items-center gap-1.5">
              {done ? <Check className="size-4 shrink-0 text-success-text" /> : <span className={cn('tnum grid size-4 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold', cur ? 'bg-brand text-white' : 'bg-surface-2 text-ink-3')}>{i + 1}</span>}
              <span className={cn('truncate text-[13px]', cur ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-ink-3')}>{s.name}</span>
            </div>
            <div className="mt-0.5 truncate pl-[22px] text-[11.5px] text-ink-3">
              {s.person ? s.person.name : 'Unassigned'}
              {done && s.acted_at ? ` · ${fmtDate(s.acted_at.slice(0, 10))}` : cur && 'due_on' in s && s.due_on ? ` · due ${fmtDate(s.due_on)}` : ''}
            </div>
            {cur && 'overdue' in s && s.overdue && <Badge size="sm" tone="danger" className="ml-[22px] mt-1">Overdue</Badge>}
          </li>
        )
      })}
    </ol>
  )
}

/** Compensation facts — every number comes from the server. */
export function FactsCard({ f, live }: { f: WfFacts; live?: boolean }) {
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`)
  const BASIS: Record<string, string> = { approved: 'approved', normalised: 'HR’s normalised', endorsed: 'unit head’s endorsed', recommended: 'manager’s recommended' }
  if (f.limited)
    return (
      <Card>
        <CardHeader title="Outcome" />
        <dl className="grid grid-cols-2 gap-3">
          <Fact label="Hike" value={pct(f.approved_pct)} />
          <Fact label="New monthly CTC" value={fmtMoney(f.new_ctc_paise)} />
          <Fact label="New annual CTC" value={fmtMoney(f.new_annual_paise)} />
          <Fact label="Effective from" value={f.effective_from ? fmtDate(f.effective_from, 'long') : '—'} />
        </dl>
      </Card>
    )
  return (
    <Card>
      <CardHeader title="Compensation" subtitle={live ? 'Updates as you type — computed from the current cost rate' : 'From the current cost rate and the hikes in this workflow'} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label="Current monthly CTC" value={fmtMoney(f.current_ctc_paise)} hint={f.current_from ? `since ${fmtDate(f.current_from)}` : undefined} />
        <Fact label="Current annual CTC" value={fmtMoney(f.current_annual_paise)} />
        <Fact label="Recommended (manager)" value={pct(f.recommended_pct)} />
        <Fact label="Endorsed (unit head)" value={pct(f.endorsed_pct)} />
        <Fact label="Normalised (HR)" value={pct(f.normalised_pct)} />
        <Fact label="Approved (finance)" value={pct(f.approved_pct)} />
      </dl>
      <div className="mt-4 rounded-md border border-line bg-surface-2/50 p-3">
        <div className="text-[12px] text-ink-3">{f.basis ? `New CTC at the ${BASIS[f.basis]} hike (${f.basis_pct}%)` : 'New CTC appears once a hike is recommended'}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tnum whitespace-nowrap text-[20px] font-semibold">{fmtMoney(f.new_ctc_paise)}</span>
          <span className="tnum whitespace-nowrap text-[12.5px] text-ink-3">/ month · {fmtMoney(f.new_annual_paise)} / year</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <Fact label="Monthly increase" value={fmtMoney(f.monthly_increase_paise)} />
          <Fact label="Budget impact (12 months)" value={fmtMoney(f.annual_impact_paise)} />
        </dl>
      </div>
      {f.band && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span className="min-w-0 text-ink-2">Pay band {f.band.grade}: <span className="tnum whitespace-nowrap">{fmtMoney(f.band.min_paise)} – {f.band.max_paise === null ? 'no cap' : fmtMoney(f.band.max_paise)}</span> / year</span>
          <Badge size="sm" tone={f.band.status === 'within' ? 'success' : 'warning'}>{f.band.status === 'within' ? 'Within band' : f.band.status === 'above' ? 'Above band' : 'Below band'}</Badge>
        </div>
      )}
    </Card>
  )
}
function Fact({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="tnum mt-0.5 whitespace-nowrap text-[14px] font-medium">{value}</dd>
      {hint && <dd className="text-[11.5px] text-ink-3">{hint}</dd>}
    </div>
  )
}

export function DueText({ due, overdue }: { due: string | null; overdue: boolean }) {
  if (!due) return <span className="text-ink-3">—</span>
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', overdue ? 'font-medium text-danger-text' : 'text-ink-2')}>
      <Clock className="size-3.5" />
      {overdue ? `Overdue · ${fmtDate(due)}` : fmtDate(due)}
    </span>
  )
}
export const when = (iso: string | null | undefined) => (iso ? fmtDateTime(iso) : '—')

/* ---------------- Start a workflow ---------------- */
export function StartDialog({ open, onClose, canStartOthers, meId, presetTemplate }: { open: boolean; onClose: () => void; canStartOthers: boolean; meId: string; presetTemplate?: string | null }) {
  const nav = useNavigate()
  const tq = useWfTemplates()
  const meta = useWfMeta()
  const dir = useDirectory()
  const templates = (tq.data ?? []).filter((t) => t.active && (canStartOthers || t.self_service))
  const [tid, setTid] = useState<string>(presetTemplate ?? '')
  const tpl = templates.find((t) => t.id === tid) ?? null
  const [picked, setPicked] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const [cycle, setCycle] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const people = useMemo(() => {
    const act = (dir.data ?? []).filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name, sub: p.title, hue: p.avatar_hue, invited: false }))
    const joiners = tpl?.process === 'onboarding' ? (meta.data?.joiners ?? []).map((j) => ({ id: j.id, name: j.name, sub: `Joining · ${j.email}`, hue: 200, invited: true })) : []
    const all = canStartOthers ? [...joiners, ...act] : act.filter((p) => p.id === meId)
    const s = q.trim().toLowerCase()
    return all.filter((p) => !s || p.name.toLowerCase().includes(s) || p.sub.toLowerCase().includes(s)).sort((a, b) => Number(b.invited) - Number(a.invited) || a.name.localeCompare(b.name))
  }, [dir.data, meta.data, tpl?.process, canStartOthers, meId, q])
  const start = useMut(
    () => wfApi.start({ template_id: tid, subject_ids: canStartOthers ? picked : [meId], note: note.trim() || undefined, cycle_id: tpl?.process === 'appraisal' && cycle ? cycle : null }),
    {
      invalidate: WF_INV, silentError: true,
      success: (r) => (r.created.length === 1 ? 'Workflow started' : `${r.created.length} workflows started`),
      onSuccess: (r) => {
        onClose()
        if (r.created.length === 1) nav(`/workflows/run/${r.created[0].id}`)
      },
      onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
    },
  )
  const submit = () => {
    const e: Record<string, string> = {}
    if (!tid) e.template_id = 'Choose a workflow.'
    if (canStartOthers && !picked.length) e.subject_ids = 'Choose at least one person.'
    setErrs(e)
    if (!Object.keys(e).length) start.mutate(undefined)
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} size="lg" title="Start a workflow" description="Each person gets their own workflow. The first stage is assigned straight away."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={start.isPending} onClick={submit}>{canStartOthers && picked.length > 1 ? `Start ${picked.length} workflows` : 'Start workflow'}</Button></>}>
      <div className="space-y-4">
        <Field label="Workflow" required error={errs.template_id}>
          <Select value={tid} invalid={!!errs.template_id} placeholder="Choose a workflow" options={templates.map((t) => ({ value: t.id, label: `${t.name} · ${PROCESS_LABEL[t.process]}` }))} onChange={(e) => { setTid(e.target.value); setPicked([]) }} />
        </Field>
        {tpl && <p className="-mt-2 text-[12.5px] leading-snug text-ink-3">{tpl.stage_names.join(' → ')}</p>}
        {canStartOthers ? (
          <Field label={tpl?.process === 'onboarding' ? 'New joiners or employees' : 'Employees'} required error={errs.subject_ids} aside={picked.length ? <span className="tnum text-[12px] text-ink-3">{picked.length} selected</span> : undefined}>
            <div className="rounded-md border border-line">
              <div className="border-b border-line p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" className="h-9 w-full rounded-md bg-surface-2 pl-8 pr-2 text-[13.5px] outline-none" />
                </div>
              </div>
              <ul className="max-h-[240px] overflow-y-auto p-1 scroll-thin">
                {people.map((p) => {
                  const on = picked.includes(p.id)
                  return (
                    <li key={p.id}>
                      <button type="button" onClick={() => setPicked((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))} className={cn('flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2', on && 'bg-brand-soft')}>
                        <span className={cn('grid size-[17px] shrink-0 place-items-center rounded-[5px] border', on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface')}>{on && <Check className="size-3" />}</span>
                        <Avatar name={p.name} hue={p.hue} size={24} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
                          <span className="block truncate text-[12px] text-ink-3">{p.sub}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
                {!people.length && <li className="px-2 py-4 text-center text-[13px] text-ink-3">No one matches.</li>}
              </ul>
            </div>
          </Field>
        ) : (
          <Callout tone="info">This workflow is about you. It starts with your own submission.</Callout>
        )}
        {tpl?.process === 'appraisal' && (meta.data?.cycles.length ?? 0) > 0 && (
          <Field label="Appraisal cycle" hint="Links each workflow to the person’s appraisal in that cycle." error={errs.cycle_id}>
            <Select value={cycle} placeholder="Not linked to a cycle" options={(meta.data?.cycles ?? []).map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => setCycle(e.target.value)} />
          </Field>
        )}
        <Field label="Note" hint="Shown at the top of the workflow.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}
