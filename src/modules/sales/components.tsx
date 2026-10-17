// Shared pieces for the sales module: lead form, stage mover (F23 rules), create-project dialog, small atoms.
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from '@/ui/icons'
import {
  Button, Dialog, Field, Input, MoneyInput, PeoplePicker, Select, Textarea, toast, useCan, useConfirm, Callout, Badge, Dot,
} from '@/ui'
import { useMut } from '@/api/query'
import { PRODUCTS, SALES_INVALIDATE, salesApi, type CreateProjectInput, type DealInput, type DealView } from '@/api/sales'
import { DEAL_SOURCE, DEAL_STAGE, DEAL_STAGES_OPEN, PROJECT_TYPE, STREAM, BILLING_MODEL } from '@/domain/labels'
import { addDays, todayISO } from '@/domain/calendar'
import { useSession } from '@/stores/session'
import { usePermissionHolders } from '@/api/core'
import type { DealSource, DealStage, ProjectType, RevenueStream, BillingModel } from '@/types/entities'
import { cn } from '@/lib/utils'
import { storage } from '@/lib/storage'
import type { PeriodValue } from '@/ui'
import { fmtMoney } from '@/domain/money'
import { dealValue, validEmail, validPhone } from '@/domain/sales'
import type { ApiError } from '@/api/http'

export const ALL_STAGES: DealStage[] = ['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won', 'lost']
export const isClosedStage = (s: DealStage) => s === 'won' || s === 'lost'
export const STAGE_BAR: Record<DealStage, string> = {
  lead: 'bg-ink-3', qualified: 'bg-info', demo: 'bg-info', proposal: 'bg-accent', negotiation: 'bg-warning', won: 'bg-success', lost: 'bg-danger',
}

/** Month / Quarter / Year choice shared by Compensation and Performance (G12.01), remembered per browser. */
const PERIOD_KEY = 'seereonos.sales.period'
export function useSalesPeriod(): [PeriodValue, (v: PeriodValue) => void] {
  const [v, setV] = useState<PeriodValue>(() => {
    const saved = storage.get<PeriodValue | null>(PERIOD_KEY, null)
    return saved && ['month', 'quarter', 'fy'].includes(saved.kind) && /^\d{4}-\d{2}-\d{2}$/.test(saved.anchor) && saved.anchor <= todayISO() ? saved : { kind: 'month', anchor: todayISO() }
  })
  const set = (n: PeriodValue) => {
    setV(n)
    storage.set(PERIOD_KEY, n)
  }
  return [v, set]
}

export function StageDot({ stage }: { stage: DealStage }) {
  return <Dot tone={DEAL_STAGE[stage].tone} />
}
export function StaleBadge({ days }: { days: number }) {
  return (
    <Badge tone="warning" size="sm">
      {days}d idle
    </Badge>
  )
}

/* ------------------------------------------------------------------ */
/* Stage mover: one place that applies the F23 rules in the UI          */
/* ------------------------------------------------------------------ */
export function useStageMover(opts: { onWon?: (d: DealView) => void } = {}) {
  const { askReason, confirm } = useConfirm()
  const can = useCan()
  const isAdmin = can('deals.edit_all')
  const mut = useMut((v: { id: string; stage: DealStage; reason?: string }) => salesApi.move(v.id, v.stage, v.reason), { invalidate: SALES_INVALIDATE })
  const move = async (deal: DealView, stage: DealStage): Promise<boolean> => {
    if (stage === deal.stage) return false
    if (isClosedStage(deal.stage) && !isAdmin) {
      toast.error(`Only an admin can move a deal out of ${DEAL_STAGE[deal.stage].label}.`)
      return false
    }
    if (stage === 'won' && dealValue(deal) <= 0) {
      toast.error('Add the deal value before marking it won.', { description: 'Open the deal and edit its value.' })
      return false
    }
    let reason: string | undefined
    if (stage === 'lost') {
      const r = await askReason({ title: `Why was “${deal.title}” lost?`, body: 'Recording the reason is how the win rate improves.', label: 'Reason', placeholder: 'e.g. Budget moved to next year', confirmLabel: 'Mark lost', minLength: 3, tone: 'danger' })
      if (!r) return false
      reason = r
    } else if (isClosedStage(deal.stage)) {
      const ok = await confirm({ title: `Reopen “${deal.title}”?`, body: `It moves from ${DEAL_STAGE[deal.stage].label} back to ${DEAL_STAGE[stage].label}. The ${deal.stage === 'won' ? 'won date' : 'lost reason'} is cleared and the change is kept in the timeline.`, confirmLabel: 'Reopen deal' })
      if (!ok) return false
    }
    try {
      const res = await mut.mutateAsync({ id: deal.id, stage, reason })
      if (stage === 'won') {
        toast.success('Deal won', { description: isAdmin && !deal.project_id ? 'Create its project next.' : 'An admin can now create its project.' })
        opts.onWon?.(res)
      } else if (stage === 'lost') toast.success('Deal marked lost')
      else toast.success(`Moved to ${DEAL_STAGE[stage].label}`)
      return true
    } catch {
      return false
    }
  }
  return { move, pending: mut.isPending }
}

/* ------------------------------------------------------------------ */
/* Lead / deal form (G11.01)                                           */
/* ------------------------------------------------------------------ */
type FormState = DealInput
const blank = (ownerId: string): FormState => ({
  title: '', client: '', contact: '', phone: '', email: '', product: 'EduReon', source: 'bni', owner_id: ownerId, stage: 'lead',
  value_paise: 0, mrr_paise: 0, expected_close: addDays(todayISO(), 28), notes: '', first_conversation: '', next_step: '', next_step_on: addDays(todayISO(), 2),
})

export function DealFormDialog({ open, onOpenChange, deal, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; deal?: DealView | null; onSaved?: (d: DealView) => void }) {
  const me = useSession((s) => s.user)
  const can = useCan()
  const dealOwners = usePermissionHolders('deals.edit_own')
  const isAdmin = can('deals.edit_all')
  const [f, setF] = useState<FormState>(blank(me?.id ?? ''))
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    if (deal)
      setF({
        title: deal.title, client: deal.client, contact: deal.contact, phone: deal.phone, email: deal.email, product: deal.product, source: deal.source, owner_id: deal.owner_id,
        value_paise: deal.value_paise, mrr_paise: deal.mrr_paise, expected_close: deal.expected_close, notes: deal.notes, first_conversation: deal.first_conversation ?? '',
        next_step: deal.next_step ?? '', next_step_on: deal.next_step_on ?? '',
      })
    else setF(blank(me?.id ?? ''))
  }, [open, deal, me?.id])
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    if (errors[k]) setErrors((e) => ({ ...e, [k]: '' }))
  }
  const onErr = (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message }))
  const create = useMut((b: DealInput) => salesApi.create(b), { invalidate: SALES_INVALIDATE, success: 'Lead created', onError: onErr })
  const save = useMut((b: DealInput) => salesApi.update(deal!.id, b, deal!.version), { invalidate: SALES_INVALIDATE, success: 'Deal updated', onError: onErr })
  const total = dealValue(f)
  const submit = async () => {
    const e: Record<string, string> = {}
    if (!f.title.trim()) e.title = 'Name the opportunity.'
    if (!f.client.trim()) e.client = 'Enter the company or school.'
    if (!f.expected_close) e.expected_close = 'Pick an expected close date.'
    if (!validEmail(f.email)) e.email = 'Enter a valid email or leave it blank.'
    if (!validPhone(f.phone)) e.phone = 'Enter 7 to 15 digits (spaces, + and - are fine) or leave it blank.'
    if (!f.owner_id) e.owner_id = 'Choose who owns this lead.'
    if (f.next_step?.trim() && !f.next_step_on) e.next_step_on = 'Pick the date for the next step.'
    if (deal?.stage === 'won' && total <= 0) e.value_paise = 'A won deal needs a value.'
    setErrors(e)
    if (Object.values(e).some(Boolean)) return
    const body = { ...f, first_conversation: f.first_conversation?.trim() || null, next_step: f.next_step?.trim() || null, next_step_on: f.next_step?.trim() ? f.next_step_on || null : null }
    try {
      const r = deal ? await save.mutateAsync(body) : await create.mutateAsync(body)
      onOpenChange(false)
      onSaved?.(r)
    } catch {
      /* toasted */
    }
  }
  const busy = create.isPending || save.isPending
  const half = 'sm:col-span-3'
  const third = 'sm:col-span-2'
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={deal ? 'Edit deal' : 'New lead'}
      description={deal ? `${deal.client} · ${DEAL_STAGE[deal.stage].label}` : 'Capture the opportunity while it’s fresh. Creating it logs a “New lead” line in the activity log.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {deal ? 'Save changes' : 'Create lead'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-6">
        <Field label="Opportunity" required error={errors.title} className={half} htmlFor="lf-title">
          <Input id="lf-title" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. EduReon for 2 campuses" invalid={!!errors.title} autoFocus={!deal} />
        </Field>
        <Field label="Company or school" required error={errors.client} className={half} htmlFor="lf-client">
          <Input id="lf-client" value={f.client} onChange={(e) => set('client', e.target.value)} invalid={!!errors.client} />
        </Field>
        <Field label="Contact person" error={errors.contact} className={third} htmlFor="lf-contact">
          <Input id="lf-contact" value={f.contact} onChange={(e) => set('contact', e.target.value)} />
        </Field>
        <Field label="Phone" error={errors.phone} className={third} htmlFor="lf-phone">
          <Input id="lf-phone" type="tel" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} invalid={!!errors.phone} />
        </Field>
        <Field label="Email" error={errors.email} className={third} htmlFor="lf-email">
          <Input id="lf-email" type="email" inputMode="email" value={f.email} onChange={(e) => set('email', e.target.value)} invalid={!!errors.email} />
        </Field>
        <Field label="Product" className={third}>
          <Select value={f.product} onChange={(e) => set('product', e.target.value)} options={[...PRODUCTS]} />
        </Field>
        <Field label="Source" className={third}>
          <Select value={f.source} onChange={(e) => set('source', e.target.value as DealSource)} options={Object.entries(DEAL_SOURCE).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Owner" hint={isAdmin ? undefined : 'Leads you create are yours.'} error={errors.owner_id} className={third}>
          {isAdmin ? (
            <PeoplePicker value={f.owner_id || null} onChange={(v) => set('owner_id', v ?? '')} placeholder="Choose" filter={(p) => (dealOwners ? dealOwners.has(p.id) : p.role === 'sales' || p.role === 'admin')} />
          ) : (
            <Input value={me?.name ?? ''} disabled />
          )}
        </Field>
        {!deal && (
          <Field label="Stage" className={third}>
            <Select value={f.stage} onChange={(e) => set('stage', e.target.value as DealStage)} options={DEAL_STAGES_OPEN.map((s) => ({ value: s, label: DEAL_STAGE[s].label }))} />
          </Field>
        )}
        <Field label="One-time value (₹)" error={errors.value_paise} className={third} htmlFor="lf-value">
          <MoneyInput id="lf-value" value={f.value_paise} onChange={(v) => set('value_paise', v)} invalid={!!errors.value_paise} />
        </Field>
        <Field label="Recurring (₹/month)" error={errors.mrr_paise} className={third} htmlFor="lf-mrr">
          <MoneyInput id="lf-mrr" value={f.mrr_paise} onChange={(v) => set('mrr_paise', v)} />
        </Field>
        {deal && (
          <div className={cn(third, 'flex flex-col justify-end')}>
            <p className="text-[12px] text-ink-3">Deal value</p>
            <p className="tnum text-[14px] font-semibold text-ink">{fmtMoney(total)}</p>
          </div>
        )}
        <Field label="Expected close" required error={errors.expected_close} className={third} htmlFor="lf-close">
          <Input id="lf-close" type="date" value={f.expected_close} onChange={(e) => set('expected_close', e.target.value)} invalid={!!errors.expected_close} />
        </Field>
        <Field label="Next step" className={third} htmlFor="lf-next">
          <Input id="lf-next" value={f.next_step ?? ''} onChange={(e) => set('next_step', e.target.value)} placeholder="e.g. Book demo" />
        </Field>
        <Field label="By" error={errors.next_step_on} className={third} htmlFor="lf-by">
          <Input id="lf-by" type="date" value={f.next_step_on ?? ''} onChange={(e) => set('next_step_on', e.target.value)} disabled={!f.next_step?.trim()} invalid={!!errors.next_step_on} />
        </Field>
        <Field label="How the lead came in / first conversation" error={errors.first_conversation} className="sm:col-span-6" htmlFor="lf-fc">
          <Textarea id="lf-fc" value={f.first_conversation ?? ''} onChange={(e) => set('first_conversation', e.target.value)} rows={3} placeholder="Optional" />
        </Field>
        <Field label="Notes" className="sm:col-span-6" hint="Decision makers, budget, anything to remember.">
          <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} placeholder="Optional" />
        </Field>
        {!deal && total > 0 && (
          <p className="tnum text-[12.5px] text-ink-3 sm:col-span-6">
            Deal value {fmtMoney(total)} = one-time {fmtMoney(f.value_paise)} + 12 × {fmtMoney(f.mrr_paise)} recurring
          </p>
        )}
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Create project from a won deal                                      */
/* ------------------------------------------------------------------ */
const TYPE_BY_PRODUCT: Record<string, ProjectType> = { EduReon: 'saas', SeerHR: 'product', LeadSync: 'saas', 'Munim AI': 'saas', MineReon: 'product', 'SAP consulting': 'service', 'Custom software': 'service' }
const STREAM_BY_PRODUCT: Record<string, RevenueStream> = { EduReon: 'saas', SeerHR: 'products', LeadSync: 'saas', 'Munim AI': 'saas', MineReon: 'products', 'SAP consulting': 'sap_consulting', 'Custom software': 'services' }

export function CreateProjectDialog({ deal, open, onOpenChange }: { deal: DealView | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const nav = useNavigate()
  const pms = usePermissionHolders('projects.edit')
  const [f, setF] = useState<CreateProjectInput>({ name: '', client: '', contract_value_paise: 0, type: 'service', start_on: todayISO(), end_on: addDays(todayISO(), 90), pm_id: null })
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (open && deal) {
      setErrors({})
      setF({
        name: deal.title, client: deal.client, contract_value_paise: dealValue(deal), type: TYPE_BY_PRODUCT[deal.product] ?? 'service',
        stream: STREAM_BY_PRODUCT[deal.product] ?? 'services', billing_model: deal.mrr_paise > 0 && deal.value_paise === 0 ? 'subscription' : 'fixed',
        start_on: todayISO(), end_on: addDays(todayISO(), 90), pm_id: null,
      })
    }
  }, [open, deal])
  const set = <K extends keyof CreateProjectInput>(k: K, v: CreateProjectInput[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
  }
  const mut = useMut((b: CreateProjectInput) => salesApi.createProject(deal!.id, b), {
    invalidate: SALES_INVALIDATE,
    onError: (e) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message })),
  })
  const submit = async () => {
    const e: Record<string, string> = {}
    if (!f.name.trim()) e.name = 'Name the project.'
    if (!f.client.trim()) e.client = 'Enter the client.'
    if (f.end_on < f.start_on) e.end_on = 'End must be on or after the start.'
    setErrors(e)
    if (Object.values(e).some(Boolean)) return
    try {
      const p = await mut.mutateAsync(f)
      onOpenChange(false)
      toast.success(`Project ${p.code} created`, { description: 'Linked to this deal. Add milestones next.', action: { label: 'Open project', onClick: () => nav(`/projects/${p.id}`) } })
    } catch {
      /* toasted */
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create project from deal"
      description={deal ? `The project starts as Initiated and is linked to “${deal.title}”.` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Not now</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>
            Create project
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name" required error={errors.name} className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} invalid={!!errors.name} />
        </Field>
        <Field label="Client" required error={errors.client}>
          <Input value={f.client} onChange={(e) => set('client', e.target.value)} invalid={!!errors.client} />
        </Field>
        <Field label="Contract value" error={errors.contract_value_paise} hint="One-time value + 12 months of recurring">
          <MoneyInput value={f.contract_value_paise} onChange={(v) => set('contract_value_paise', v)} />
        </Field>
        <Field label="Type">
          <Select value={f.type} onChange={(e) => set('type', e.target.value as ProjectType)} options={Object.entries(PROJECT_TYPE).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Revenue stream">
          <Select value={f.stream} onChange={(e) => set('stream', e.target.value as RevenueStream)} options={Object.entries(STREAM).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Billing model">
          <Select value={f.billing_model} onChange={(e) => set('billing_model', e.target.value as BillingModel)} options={Object.entries(BILLING_MODEL).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Project manager" error={errors.pm_id}>
          <PeoplePicker value={f.pm_id ?? null} onChange={(v) => set('pm_id', v)} filter={(p) => (pms ? pms.has(p.id) : p.role === 'pm' || p.role === 'admin')} clearable placeholder="Assign later" />
        </Field>
        <Field label="Start" error={errors.start_on}>
          <Input type="date" value={f.start_on} onChange={(e) => set('start_on', e.target.value)} />
        </Field>
        <Field label="Planned end" error={errors.end_on}>
          <Input type="date" value={f.end_on} onChange={(e) => set('end_on', e.target.value)} invalid={!!errors.end_on} />
        </Field>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Stage stepper (deal page header)                                    */
/* ------------------------------------------------------------------ */
export function StageStepper({ deal, onMove, disabled }: { deal: DealView; onMove: (s: DealStage) => void; disabled?: boolean }) {
  const cur = DEAL_STAGE[deal.stage].order
  const closed = isClosedStage(deal.stage)
  const openIdx = DEAL_STAGES_OPEN.indexOf(deal.stage)
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
        <div className="min-w-0 flex-1">
          <ol className="grid grid-cols-5 gap-1" aria-label="Deal stage">
            {DEAL_STAGES_OPEN.map((s) => {
              const o = DEAL_STAGE[s].order
              const done = deal.stage === 'won' || (!closed && o < cur) || (deal.stage === 'lost' && o < cur - 3)
              const active = s === deal.stage
              return (
                <li key={s} className="min-w-0">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onMove(s)}
                    aria-current={active ? 'step' : undefined}
                    aria-label={`Move to ${DEAL_STAGE[s].label}`}
                    className={cn('group flex w-full min-w-0 flex-col gap-1.5 rounded-sm py-1 text-left outline-none disabled:cursor-not-allowed', !disabled && 'focus-visible:ring-2 focus-visible:ring-brand/30')}
                  >
                    <span className={cn('h-1 w-full rounded-full transition-colors', active ? 'bg-brand' : done ? 'bg-brand/40' : 'bg-line', !disabled && !active && 'group-hover:bg-brand/60')} />
                    <span className={cn('hidden min-w-0 items-center gap-1 text-[12.5px] sm:flex', active ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-ink-3')}>
                      {done && !active && <Check className="size-3 shrink-0" />}
                      <span className="truncate">{DEAL_STAGE[s].label}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          <p className="mt-1 text-[12.5px] text-ink-3 sm:hidden">
            {openIdx >= 0 ? <>Stage {openIdx + 1} of {DEAL_STAGES_OPEN.length} · <span className="font-medium text-ink">{DEAL_STAGE[deal.stage].label}</span></> : <span className="font-medium text-ink">{DEAL_STAGE[deal.stage].label}</span>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant={deal.stage === 'won' ? 'primary' : 'secondary'} disabled={disabled || deal.stage === 'won'} onClick={() => onMove('won')} className="flex-1 sm:flex-none">
            {deal.stage === 'won' ? 'Won' : 'Mark won'}
          </Button>
          <Button size="sm" variant={deal.stage === 'lost' ? 'danger' : 'secondary'} disabled={disabled || deal.stage === 'lost'} onClick={() => onMove('lost')} className="flex-1 sm:flex-none">
            {deal.stage === 'lost' ? 'Lost' : 'Mark lost'}
          </Button>
        </div>
      </div>
      {deal.stage === 'lost' && deal.lost_reason && (
        <Callout tone="danger" title={`Lost ${deal.lost_on ? 'on ' + new Date(deal.lost_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}`}>
          {deal.lost_reason}
        </Callout>
      )}
    </div>
  )
}

export function Metric({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="tnum mt-1 whitespace-nowrap text-[14px] font-semibold text-ink">{children}</div>
    </div>
  )
}
