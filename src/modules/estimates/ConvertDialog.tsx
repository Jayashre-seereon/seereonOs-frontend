// Convert an estimate into a project: the create-project flow (same fields, AUTO MILESTONE SETUP and the Feature
// Guide cost calculator) pre-filled from the estimate. Role placeholders become resource rows without a person —
// choose who does the work. The project is created by POST /projects (all its rules apply), then the estimate is
// linked (status Converted) and the deal, if any, points at the new project.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BillingModel, ProjectType, RevenueStream } from '@/types/entities'
import { ApiError } from '@/api/http'
import { useMut } from '@/api/query'
import { usePermissionHolders } from '@/api/core'
import { estimatesApi, ESTIMATES_INVALIDATE, type EstimateDetail, type EstimatePreview } from '@/api/estimates'
import { BILLING_MODEL, PROJECT_TYPE, STREAM } from '@/domain/labels'
import { PROJECT_PRIORITY } from '@/domain/delivery'
import { COMMERCIAL_MODELS } from '@/domain/costing'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtPct } from '@/domain/money'
import { useSession } from '@/stores/session'
import { Badge, Button, Callout, Dialog, Field, Input, MoneyInput, PeoplePicker, PersonName, Segmented, Select, Textarea, useCan } from '@/ui'
import { CalendarLine, CostingEditor } from '@/modules/projects/costing/CostingEditor'
import { draftToInput, useCostingPreview, type CostingDraft } from '@/modules/projects/costing/costingDraft'

const DEFAULT_STREAM: Record<string, RevenueStream> = { product: 'products', service: 'services', saas: 'saas', ams: 'ams' }

function draftFromEstimate(pv: EstimatePreview, d: EstimateDetail): CostingDraft {
  const e = d.estimate
  return {
    rows: pv.rows.map((r, i) => ({
      key: e.resources[i]?.id ?? r.key,
      id: null,
      user_id: r.kind === 'person' ? r.user_id : null,
      ms: r.milestone_index !== null ? `i:${r.milestone_index}` : '',
      pct: r.pct === null ? '' : String(r.pct),
      from_on: e.resources[i]?.from_on ?? null,
      to_on: e.resources[i]?.to_on ?? null,
    })),
    additional: e.additional_costs.map((a) => ({ key: a.id, category: a.category, description: a.description, amount_paise: a.amount_paise })),
    maintenance_paise: e.maintenance_paise,
    contingency_pct: String(e.contingency_pct),
    markup_pct: String(e.markup_pct ?? 0),
    price_paise: pv.totals.price,
    price_mode: 'price',
  }
}

export function ConvertDialog({ open, onOpenChange, d, pv }: { open: boolean; onOpenChange: (o: boolean) => void; d: EstimateDetail; pv: EstimatePreview }) {
  const nav = useNavigate()
  const can = useCan()
  const { user } = useSession()
  const e = d.estimate
  const manageAll = can('projects.manage_all')
  const pms = usePermissionHolders('projects.edit')
  const [f, setF] = useState(() => ({
    name: e.name.replace(/ — Scenario [A-Z]$/, ''), client: e.client, type: e.type as ProjectType, billing_model: e.billing_model as BillingModel, stream: (e.stream as RevenueStream) || DEFAULT_STREAM[e.type] || 'services',
    pm_id: manageAll ? null : user?.id ?? null, start_on: e.start_on, end_on: e.end_on, contract_value_paise: pv.totals.price ?? e.price_paise, priority: 3, description: e.description ?? '',
  }))
  const [draft, setDraft] = useState<CostingDraft>(() => draftFromEstimate(pv, d))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [costErrors, setCostErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    setCostErrors({})
    setDraft(draftFromEstimate(pv, d))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, e.id, e.version])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }
  const withPlan = d.can_plan_cost
  const milestones = useMemo(() => e.milestones.map((m) => ({ name: m.name, billing_amount_paise: m.billing_amount_paise })), [e.milestones])
  const datesOk = !!f.start_on && !!f.end_on && f.end_on >= f.start_on
  const input = useMemo(() => (datesOk ? { start_on: f.start_on, end_on: f.end_on, milestones, ...draftToInput(withPlan ? draft : { ...draft, rows: [], additional: [], maintenance_paise: 0 }) } : null), [datesOk, f.start_on, f.end_on, milestones, draft, withPlan])
  const live = useCostingPreview(input, open)
  const preview = live.data
  const placeholders = pv.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === 'role')
  const unmapped = withPlan ? draft.rows.filter((r) => !r.user_id).length : 0

  const onErr = (x: ApiError) => {
    if (!x.field) return
    if (/^(resources|additional_costs|costing)\./.test(x.field)) setCostErrors({ [x.field]: x.message })
    else setErrors((s) => ({ ...s, [x.field!]: x.message }))
  }
  const run = useMut(
    async () => {
      const created = await estimatesApi.createProject({
        ...f,
        deal_id: e.deal_id,
        milestones: milestones.map((m) => ({ ...m, planned_end: null })),
        costing: withPlan && (draft.rows.length > 0 || draft.additional.length > 0 || draft.maintenance_paise > 0) ? draftToInput(draft) : null,
      })
      const p = created.data
      const linked = await estimatesApi.convert(e.id, p.id)
      return { data: { project: p }, warnings: [...created.warnings, ...linked.warnings] }
    },
    {
      invalidate: [...ESTIMATES_INVALIDATE, ['projects'], ['project'], ['project-next-code'], ['margins'], ['deals'], ['deal']],
      success: (r) => `${r.project.code} created from ${e.number}`,
      onSuccess: (r) => {
        onOpenChange(false)
        nav(`/projects/${r.project.id}`)
      },
      onError: onErr,
    },
  )
  const submit = () => {
    const x: Record<string, string> = {}
    if (!f.name.trim()) x.name = 'Give the project a name.'
    if (!f.client.trim()) x.client = 'Who is the client?'
    if (!f.pm_id) x.pm_id = 'Choose the project manager.'
    if (!datesOk) x.end_on = 'The planned end must be on or after the start.'
    setErrors(x)
    if (Object.values(x).some(Boolean)) return
    if (unmapped) {
      setCostErrors({ 'resources.0.user_id': `Choose a person for ${unmapped} row${unmapped === 1 ? '' : 's'} (the role placeholders), or remove ${unmapped === 1 ? 'it' : 'them'}.` })
      return
    }
    run.mutate(undefined)
  }
  const pt = preview?.totals

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={`Convert ${e.number} to a project`}
      description="The create-project form, filled in from the estimate. The project code is assigned automatically and the project starts as Initiated."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} onClick={submit}>
            Create project
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <Field label="Project name" required error={errors.name} className="sm:col-span-2 lg:col-span-3">
          <Input value={f.name} invalid={!!errors.name} onChange={(ev) => set('name', ev.target.value)} />
        </Field>
        <Field label="Client" required error={errors.client} className="sm:col-span-2 lg:col-span-3">
          <Input value={f.client} invalid={!!errors.client} onChange={(ev) => set('client', ev.target.value)} />
        </Field>
        <Field label="Project manager" required error={errors.pm_id} className="sm:col-span-2 lg:col-span-2" hint={!manageAll ? 'You manage the projects you create.' : undefined}>
          {manageAll ? (
            <PeoplePicker value={f.pm_id} placeholder="Choose a PM" invalid={!!errors.pm_id} onChange={(v) => set('pm_id', v)} filter={(p) => (pms ? pms.has(p.id) : p.role === 'pm' || p.role === 'admin')} />
          ) : (
            <div className="flex h-[var(--ctl-h)] items-center rounded-md border border-line bg-surface-2 px-3">
              <PersonName id={f.pm_id} size={22} />
            </div>
          )}
        </Field>
        <Field label="Start" required error={errors.start_on} className="lg:col-span-2">
          <Input type="date" value={f.start_on} onChange={(ev) => set('start_on', ev.target.value)} />
        </Field>
        <Field label="Planned end" required error={errors.end_on} className="lg:col-span-2">
          <Input type="date" value={f.end_on} min={f.start_on} invalid={!!errors.end_on} onChange={(ev) => set('end_on', ev.target.value)} />
        </Field>
        <CalendarLine className="sm:col-span-2 lg:col-span-6" preview={datesOk ? preview : null} />
        <Field label="Project type" required className="sm:col-span-2 lg:col-span-3">
          <Segmented block value={f.type} onChange={(v) => { set('type', v); set('stream', DEFAULT_STREAM[v]) }} options={(Object.keys(PROJECT_TYPE) as ProjectType[]).map((k) => ({ value: k, label: PROJECT_TYPE[k] }))} />
        </Field>
        <Field label="Commercial model" required className="lg:col-span-3">
          <Select value={f.billing_model} onChange={(ev) => set('billing_model', ev.target.value as BillingModel)} options={COMMERCIAL_MODELS.map((m) => ({ value: m.value, label: BILLING_MODEL[m.value] }))} />
        </Field>
        <Field label="Priority" className="lg:col-span-3">
          <Select value={String(f.priority)} onChange={(ev) => set('priority', Number(ev.target.value))} options={PROJECT_PRIORITY.map((p) => ({ value: String(p.value), label: p.label }))} />
        </Field>
        <Field label="Revenue stream" required className="lg:col-span-3">
          <Select value={f.stream} onChange={(ev) => set('stream', ev.target.value as RevenueStream)} options={(Object.keys(STREAM) as RevenueStream[]).map((k) => ({ value: k, label: STREAM[k] }))} />
        </Field>
        <Field label={f.billing_model === 'tm' ? 'Estimated billing (₹)' : 'Contract value (₹)'} error={errors.contract_value_paise} className="sm:col-span-2 lg:col-span-3" hint={`Estimate price ${fmtMoney(pv.totals.price)}. Excluding GST.`}>
          <MoneyInput value={f.contract_value_paise} invalid={!!errors.contract_value_paise} onChange={(v) => set('contract_value_paise', v)} />
        </Field>
        <Field label="Description" className="sm:col-span-2 lg:col-span-3">
          <Textarea rows={2} value={f.description} onChange={(ev) => set('description', ev.target.value)} className="min-h-[var(--ctl-h)]" />
        </Field>
      </div>

      <section className="mt-6">
        <h3 className="text-[14px] font-semibold">Milestones</h3>
        <p className="mb-2 text-[12.5px] text-ink-3">From the estimate, in delivery order. Deadlines are spread across the project until tasks exist.</p>
        {e.milestones.length === 0 ? (
          <p className="text-[13px] text-ink-3">The estimate has no milestones; the project is created without any.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {(preview?.milestones ?? pv.milestones).map((m) => (
              <li key={m.code} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]">
                <span className="tnum w-8 shrink-0 font-semibold text-ink-3">{m.code}</span>
                <span className="min-w-0 flex-1 basis-[160px] truncate">{m.name}</span>
                <span className="tnum whitespace-nowrap text-[12px] text-ink-3">{fmtDate(m.planned_start)} – {fmtDate(m.planned_end)}</span>
                <span className="tnum whitespace-nowrap font-medium">{m.billing_amount_paise ? fmtMoney(m.billing_amount_paise) : <span className="font-normal text-ink-3">No billing</span>}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 border-t border-line pt-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold">Costing</h3>
          <Badge size="sm">Visible to editors only</Badge>
        </div>
        {!withPlan ? (
          <Callout tone="info">
            Your role can’t save resource plans (it needs the margins or salaries permission and allocation rights), so the project is created with its milestones and contract value. Someone with costing rights can add the plan on the project’s Costing & margin tab.
          </Callout>
        ) : (
          <>
            {placeholders.length > 0 && (
              <Callout tone="warning" className="mb-3" title="Choose people for the role placeholders">
                {placeholders.map(({ r, i }) => (
                  <div key={r.key}>
                    Row {i + 1}: {r.role_label} ({r.ms_code}, {r.pct}%, assumed {fmtMoney(r.monthly_ctc_paise)} a month)
                  </div>
                ))}
              </Callout>
            )}
            {pt && pt.total_cost !== null && unmapped === 0 && (
              <p className="mb-3 text-[12.5px] text-ink-3">
                Estimate cost <span className="tnum font-medium text-ink">{fmtMoney(pv.totals.total_cost)}</span> ({fmtPct(pv.totals.margin)} margin) → project plan with these people <span className="tnum font-medium text-ink">{fmtMoney(pt.total_cost)}</span> ({fmtPct(pt.margin)} margin).
              </p>
            )}
            {Object.keys(costErrors).length > 0 && <Callout tone="danger" className="mb-3">{Object.values(costErrors)[0]}</Callout>}
            <CostingEditor draft={draft} onChange={(x) => { setDraft(x); setCostErrors({}) }} preview={preview} errors={costErrors} loading={live.isFetching} />
          </>
        )}
      </section>
    </Dialog>
  )
}
