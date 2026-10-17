// Create / edit project (Feature Guide §3, checklist G3.06–G3.11): name, client, PM, dates with a working-day
// calendar summary, type, commercial model, priority, AUTO MILESTONE SETUP, documents and the PROJECT COST CALCULATOR.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, List, Paperclip, Plus, Rows3, Trash2, X } from '@/ui/icons'
import type { BillingModel, Project, ProjectType, RevenueStream } from '@/types/entities'
import { costingApi, projectsApi, type ProjectInput } from '@/api/projects'
import { usePermissionHolders } from '@/api/core'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import { BILLING_MODEL, PROJECT_TYPE, STREAM } from '@/domain/labels'
import { PROJECT_PRIORITY } from '@/domain/delivery'
import { COMMERCIAL_MODELS, parseMilestoneLines } from '@/domain/costing'
import { addMonths, fmtDate, todayISO } from '@/domain/calendar'
import { useSession } from '@/stores/session'
import { Badge, Button, Callout, Dialog, Field, IconButton, Input, MoneyInput, PeoplePicker, PersonName, Segmented, Select, Textarea, useCan } from '@/ui'
import { fmtMoney } from '@/domain/money'
import { readFileAsDataURL, cn } from '@/lib/utils'
import { CalendarLine, CostingEditor } from '../costing/CostingEditor'
import { draftHasContent, draftToInput, emptyDraft, useCostingPreview, type CostingDraft } from '../costing/costingDraft'

type MsRow = { key: number; name: string; planned_end: string; billing_amount_paise: number }
const DEFAULT_STREAM: Record<ProjectType, RevenueStream> = { product: 'products', service: 'services', saas: 'saas', ams: 'ams' }
const DOC_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'md', 'csv']
const DOC_MAX = 20 * 1024 * 1024
const rupeesText = (p: number) => String(Math.round(p / 100))

export function ProjectFormDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: Project | null }) {
  const nav = useNavigate()
  const { user, tenant } = useSession()
  const can = useCan()
  // projects.manage_all may pick (or hand over to) any PM; everyone else creates projects they manage themselves.
  const manageAll = can('projects.manage_all')
  // Costing is for editors: margins (totals) or salaries (cost per day) permission; otherwise the section is hidden.
  const canPlan = (can('margins.view') || can('cost_rates.view')) && can('allocation.edit')
  const pms = usePermissionHolders('projects.edit')
  const editing = !!project
  const blank = (): ProjectInput => ({
    name: '', client: '', type: 'product', billing_model: 'fixed', stream: 'products', pm_id: !manageAll && user ? user.id : null,
    start_on: todayISO(), end_on: addMonths(todayISO(), 3), contract_value_paise: 0, priority: 3, description: '',
  })
  const [f, setF] = useState<ProjectInput>(blank)
  const [msText, setMsText] = useState('')
  const [msMode, setMsMode] = useState<'text' | 'rows'>('text')
  const [msRows, setMsRows] = useState<MsRow[]>([])
  const [docs, setDocs] = useState<File[]>([])
  const [docError, setDocError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CostingDraft>(emptyDraft)
  const [contractTouched, setContractTouched] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [costErrors, setCostErrors] = useState<Record<string, string>>({})
  const [streamTouched, setStreamTouched] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setCostErrors({})
    setMsText('')
    setMsRows([])
    setMsMode('text')
    setDocs([])
    setDocError(null)
    setDraft(emptyDraft())
    setContractTouched(!!project)
    setStreamTouched(!!project)
    setF(project ? { name: project.name, client: project.client, type: project.type, billing_model: project.billing_model, stream: project.stream, pm_id: project.pm_id, start_on: project.start_on, end_on: project.end_on, contract_value_paise: project.contract_value_paise, priority: project.priority, description: project.description } : blank())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id])

  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
  }

  /* ---------- milestones: text (one per line) or rows ---------- */
  const parsed = useMemo(() => parseMilestoneLines(msText), [msText])
  const msList = useMemo(
    () =>
      msMode === 'text'
        ? parsed.items.filter((x) => !x.error).map((x) => ({ name: x.name, billing_amount_paise: x.amount_paise, planned_end: null as string | null }))
        : msRows.filter((m) => m.name.trim()).map((m) => ({ name: m.name.trim(), billing_amount_paise: m.billing_amount_paise, planned_end: m.planned_end || null })),
    [msMode, parsed, msRows],
  )
  const msTotal = msList.reduce((s, m) => s + m.billing_amount_paise, 0)
  const toRows = () => {
    setMsRows(parsed.items.filter((x) => x.name).map((x, i) => ({ key: Date.now() + i, name: x.name, planned_end: '', billing_amount_paise: x.amount_paise })))
    setMsMode('rows')
  }
  const toText = () => {
    setMsText(msRows.filter((m) => m.name.trim()).map((m) => (m.billing_amount_paise ? `${m.name.trim()} | ${rupeesText(m.billing_amount_paise)}` : m.name.trim())).join('\n'))
    setMsMode('text')
  }

  /* ---------- server preview: calendar summary, provisional milestone dates, costing ---------- */
  const datesOk = !!f.start_on && !!f.end_on && f.end_on >= f.start_on
  const previewInput = useMemo(
    () => (editing || !datesOk ? null : { start_on: f.start_on, end_on: f.end_on, milestones: msList.map(({ name, billing_amount_paise }) => ({ name, billing_amount_paise })), ...(canPlan ? draftToInput(draft) : draftToInput(emptyDraft())) }),
    [editing, datesOk, f.start_on, f.end_on, msList, canPlan, draft],
  )
  const pv = useCostingPreview(previewInput, open && !editing)
  const preview = pv.data
  const nextCode = useApi(['project-next-code'], () => costingApi.nextCode(), { enabled: open && !editing, staleTime: 0 })
  // The contract value defaults to the calculator's project price until the user types one.
  useEffect(() => {
    if (editing || contractTouched || !canPlan || !draftHasContent(draft)) return
    if (preview?.price_paise !== null && preview?.price_paise !== undefined && preview.price_paise !== f.contract_value_paise) setF((x) => ({ ...x, contract_value_paise: preview.price_paise! }))
  }, [preview?.price_paise, contractTouched, canPlan, draft, editing, f.contract_value_paise])

  /* ---------- documents ---------- */
  const addFiles = (list: FileList | null) => {
    if (!list) return
    const next = [...docs]
    for (const file of Array.from(list)) {
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
      if (!DOC_EXT.includes(ext)) return setDocError(`${file.name}: use PDF, images (PNG, JPG, GIF, WebP, SVG), text (TXT, MD) or CSV.`)
      if (file.size > DOC_MAX) return setDocError(`${file.name} is larger than 20 MB.`)
      if (!next.some((x) => x.name === file.name && x.size === file.size)) next.push(file)
    }
    setDocError(null)
    setDocs(next.slice(0, 20))
  }

  /* ---------- save ---------- */
  const onErr = (e: ApiError) => {
    if (!e.field) return
    if (/^(resources|additional_costs|costing)\./.test(e.field)) setCostErrors({ [e.field]: e.message })
    else if (e.field.startsWith('milestones')) setErrors((x) => ({ ...x, milestones: e.message }))
    else if (e.field.startsWith('documents')) setDocError(e.message)
    else setErrors((x) => ({ ...x, [e.field!]: e.message }))
  }
  const create = useMut((b: ProjectInput) => projectsApi.create(b), {
    invalidate: [['projects'], ['project-next-code'], ['documents'], ['margins']],
    success: (p) => `${p.code} created`,
    onSuccess: (p) => {
      onOpenChange(false)
      nav(`/projects/${p.id}`)
    },
    onError: onErr,
  })
  const save = useMut((b: Partial<ProjectInput>) => projectsApi.update(project!.id, b, project!.version), {
    invalidate: [['projects'], ['project', project?.id]],
    success: 'Project updated',
    onSuccess: () => onOpenChange(false),
    onError: onErr,
  })
  const [reading, setReading] = useState(false)

  const submit = async () => {
    const e: Record<string, string> = {}
    if (!f.name.trim()) e.name = 'Give the project a name.'
    if (!f.client.trim()) e.client = 'Who is the client? Use “Internal” for your own products.'
    if (!f.pm_id) e.pm_id = 'Choose the project manager.'
    if (!f.start_on) e.start_on = 'Pick a start date.'
    if (!f.end_on) e.end_on = 'Pick the planned end.'
    if (f.start_on && f.end_on && f.end_on < f.start_on) e.end_on = 'The planned end is before the start date.'
    if (!editing && msMode === 'text' && parsed.errors.length) e.milestones = parsed.errors[0]
    setErrors(e)
    setCostErrors({})
    if (Object.values(e).some(Boolean)) return
    if (editing) {
      const { pm_id, ...rest } = f
      save.mutate(pm_id !== project!.pm_id ? f : rest)
      return
    }
    setReading(true)
    try {
      const documents = await Promise.all(docs.map(async (d) => ({ name: d.name, mime: d.type, size_bytes: d.size, data_url: await readFileAsDataURL(d) })))
      create.mutate({
        ...f,
        milestones: msList.map((m) => ({ name: m.name, billing_amount_paise: m.billing_amount_paise, planned_end: m.planned_end })),
        costing: canPlan && draftHasContent(draft) ? draftToInput(draft) : null,
        documents,
      })
    } finally {
      setReading(false)
    }
  }
  const pending = create.isPending || save.isPending || reading
  const canReassignPm = manageAll
  const msDates = preview?.milestones ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size={editing ? 'lg' : 'xl'}
      title={editing ? `Edit ${project!.code}` : 'Create project'}
      description={
        editing
          ? 'Status changes live in the status control, so the reason is recorded. The costing plan is on the Money tab.'
          : `Project code ${nextCode.data?.code ?? `${tenant?.settings['projects.code_prefix'] ?? 'PRJ'}-NNN`} is assigned automatically. New projects start as Initiated.`
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <Field label="Project name" required error={errors.name} className="sm:col-span-2 lg:col-span-3">
          <Input autoFocus value={f.name} invalid={!!errors.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. EduReon (meraCampus)" />
        </Field>
        <Field label="Client" required error={errors.client} className="sm:col-span-2 lg:col-span-3">
          <Input value={f.client} invalid={!!errors.client} onChange={(e) => set('client', e.target.value)} placeholder="Company name or Internal" />
        </Field>
        <Field label="Project manager" required error={errors.pm_id} className="sm:col-span-2 lg:col-span-2" hint={!canReassignPm ? (editing ? 'Only an admin can hand the project to another PM.' : 'You manage the projects you create.') : undefined}>
          {canReassignPm ? (
            <PeoplePicker value={f.pm_id} placeholder="Choose a PM" onChange={(v) => set('pm_id', v)} invalid={!!errors.pm_id} filter={(p) => (pms ? pms.has(p.id) : p.role === 'pm' || p.role === 'admin')} />
          ) : (
            <div className="flex h-[var(--ctl-h)] items-center rounded-md border border-line bg-surface-2 px-3">
              <PersonName id={f.pm_id} size={22} />
            </div>
          )}
        </Field>
        <Field label="Start" required error={errors.start_on} className="lg:col-span-2">
          <Input type="date" value={f.start_on} invalid={!!errors.start_on} onChange={(e) => set('start_on', e.target.value)} />
        </Field>
        <Field label="Planned end" required error={errors.end_on} className="lg:col-span-2">
          <Input type="date" value={f.end_on} min={f.start_on} invalid={!!errors.end_on} onChange={(e) => set('end_on', e.target.value)} />
        </Field>
        {!editing && <CalendarLine className="sm:col-span-2 lg:col-span-6" preview={datesOk ? preview : null} />}
        <Field label="Project type" required error={errors.type} className="sm:col-span-2 lg:col-span-3">
          <Segmented
            block
            value={f.type}
            onChange={(v) => {
              set('type', v)
              if (!streamTouched) set('stream', DEFAULT_STREAM[v])
            }}
            options={(Object.keys(PROJECT_TYPE) as ProjectType[]).map((k) => ({ value: k, label: PROJECT_TYPE[k] }))}
          />
        </Field>
        <Field label="Commercial model" required error={errors.billing_model} className="lg:col-span-3" hint={f.billing_model === 'tm' ? 'Time & material: the contract value is the estimated billing.' : undefined}>
          <Select value={f.billing_model} onChange={(e) => set('billing_model', e.target.value as BillingModel)} options={COMMERCIAL_MODELS.map((m) => ({ value: m.value, label: BILLING_MODEL[m.value] }))} />
        </Field>
        <Field label="Priority" className="lg:col-span-3">
          <Select value={String(f.priority)} onChange={(e) => set('priority', Number(e.target.value))} options={PROJECT_PRIORITY.map((p) => ({ value: String(p.value), label: p.label }))} />
        </Field>
        <Field label="Revenue stream" required error={errors.stream} className="lg:col-span-3" hint="Drives revenue by stream on the CEO dashboard.">
          <Select
            value={f.stream}
            onChange={(e) => {
              setStreamTouched(true)
              set('stream', e.target.value as RevenueStream)
            }}
            options={(Object.keys(STREAM) as RevenueStream[]).map((k) => ({ value: k, label: STREAM[k] }))}
          />
        </Field>
        <Field
          label={f.billing_model === 'tm' ? 'Estimated billing (₹)' : 'Contract value (₹)'}
          error={errors.contract_value_paise}
          className="sm:col-span-2 lg:col-span-3"
          hint={!editing && canPlan && !contractTouched && draftHasContent(draft) ? 'Follows the project price from the costing below. Type to set it yourself.' : 'Excluding GST.'}
        >
          <MoneyInput
            value={f.contract_value_paise}
            onChange={(v) => {
              setContractTouched(true)
              set('contract_value_paise', v)
            }}
            invalid={!!errors.contract_value_paise}
          />
        </Field>
        <Field label="Description" className="sm:col-span-2 lg:col-span-3">
          <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Scope in a sentence or two. The client view shows this." rows={2} className="min-h-[var(--ctl-h)]" />
        </Field>
      </div>

      {!editing && (
        <>
          {/* ---------------- AUTO MILESTONE SETUP ---------------- */}
          <section className="mt-6">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold">Milestones</h3>
                <p className="text-[12.5px] text-ink-3">Numbered M1, M2… in delivery order. Deadlines are spread across the project for now; once tasks exist, a milestone’s deadline is the target end of its last task.</p>
              </div>
              <Button size="sm" variant="ghost" icon={msMode === 'text' ? <Rows3 className="size-4" /> : <List className="size-4" />} onClick={msMode === 'text' ? toRows : toText}>
                {msMode === 'text' ? 'Edit as rows' : 'Edit as text'}
              </Button>
            </div>
            {msMode === 'text' ? (
              <Field
                label={<>Milestones, one per line in delivery order. Optional billing amount after a | e.g. “UAT sign-off | 200000”</>}
                error={errors.milestones}
              >
                <Textarea
                  aria-label="Milestones, one per line"
                  value={msText}
                  invalid={!!errors.milestones || parsed.errors.length > 0}
                  rows={4}
                  placeholder={'Requirements sign-off | 150000\nCore modules | 300000\nUAT sign-off | 200000'}
                  onChange={(e) => {
                    setMsText(e.target.value)
                    setErrors((x) => ({ ...x, milestones: '' }))
                  }}
                  className="tnum"
                />
              </Field>
            ) : (
              <div className="space-y-2">
                {msRows.map((m, i) => (
                  <div key={m.key} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[28px_minmax(0,1fr)_160px_160px_auto]">
                    <span className="tnum mt-2.5 text-center text-[12px] font-semibold text-ink-3">M{i + 1}</span>
                    <Input aria-label={`Milestone ${i + 1} name`} value={m.name} placeholder="e.g. UAT sign-off" onChange={(e) => setMsRows((x) => x.map((y) => (y.key === m.key ? { ...y, name: e.target.value } : y)))} />
                    <IconButton label="Remove milestone" className="sm:order-last" onClick={() => setMsRows((x) => x.filter((y) => y.key !== m.key))}>
                      <Trash2 className="size-4" />
                    </IconButton>
                    <div className="col-span-2 col-start-2 grid grid-cols-2 gap-2 sm:col-span-2 sm:col-start-auto">
                      <Input aria-label={`Milestone ${i + 1} end date (optional)`} type="date" value={m.planned_end} min={f.start_on} max={f.end_on} title="Optional. Leave empty to spread deadlines automatically." onChange={(e) => setMsRows((x) => x.map((y) => (y.key === m.key ? { ...y, planned_end: e.target.value } : y)))} />
                      <MoneyInput value={m.billing_amount_paise} placeholder="Billing" onChange={(v) => setMsRows((x) => x.map((y) => (y.key === m.key ? { ...y, billing_amount_paise: v } : y)))} />
                    </div>
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setMsRows((x) => [...x, { key: Date.now(), name: '', planned_end: '', billing_amount_paise: 0 }])}>
                  Add milestone
                </Button>
                {errors.milestones && <p className="text-[12.5px] font-medium text-danger-text">{errors.milestones}</p>}
                <p className="text-[12px] text-ink-3">End dates are optional. Set all of them to fix the deadlines yourself; otherwise they are spread across the project.</p>
              </div>
            )}
            {msMode === 'text' && parsed.items.length > 0 && (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {parsed.items.map((it) => {
                  const d = !it.error ? msDates.find((x) => x.code === it.code) : undefined
                  return (
                    <li key={it.line} className="flex min-w-0 items-baseline gap-3 px-3 py-2 text-[13px]">
                      <span className={cn('tnum w-8 shrink-0 font-semibold', it.error ? 'text-danger-text' : 'text-ink-3')}>{it.code || `L${it.line}`}</span>
                      {it.error ? (
                        <span className="min-w-0 flex-1 text-danger-text">{it.error}</span>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate">{it.name}</span>
                          {d && <span className="tnum hidden shrink-0 whitespace-nowrap text-[12px] text-ink-3 sm:inline">{fmtDate(d.planned_start)} – {fmtDate(d.planned_end)}</span>}
                          <span className="tnum shrink-0 whitespace-nowrap font-medium">{it.amount_paise ? fmtMoney(it.amount_paise) : <span className="font-normal text-ink-3">No billing</span>}</span>
                        </>
                      )}
                    </li>
                  )
                })}
                {msTotal > 0 && (
                  <li className="flex items-baseline justify-between gap-3 bg-surface-2/60 px-3 py-2 text-[12.5px]">
                    <span className="text-ink-3">{msList.length} milestone{msList.length === 1 ? '' : 's'}{f.contract_value_paise > 0 && msTotal !== f.contract_value_paise ? ` · contract ${fmtMoney(f.contract_value_paise)}` : ''}</span>
                    <span className="tnum font-semibold">{fmtMoney(msTotal)}</span>
                  </li>
                )}
              </ul>
            )}
          </section>

          {/* ---------------- documents ---------------- */}
          <section className="mt-6">
            <h3 className="text-[14px] font-semibold">Documents</h3>
            <p className="mb-2 text-[12.5px] text-ink-3">PDF, images, text or CSV; up to 20 MB each. They are filed under the project’s documents.</p>
            <input ref={fileRef} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.txt,.md,.csv" onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }} />
            <Button size="sm" icon={<Paperclip className="size-4" />} onClick={() => fileRef.current?.click()}>
              Choose files
            </Button>
            {docs.length > 0 && (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {docs.map((d) => (
                  <li key={d.name + d.size} className="flex min-w-0 items-center gap-3 px-3 py-2">
                    <FileText className="size-4 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
                    <span className="tnum shrink-0 text-[12px] text-ink-3">{d.size >= 1048576 ? `${(d.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(d.size / 1024))} KB`}</span>
                    <IconButton label={`Remove ${d.name}`} size="sm" onClick={() => setDocs((x) => x.filter((y) => y !== d))}>
                      <X className="size-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            {docError && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{docError}</p>}
          </section>

          {/* ---------------- PROJECT COST CALCULATOR ---------------- */}
          {canPlan && (
            <section className="mt-6 border-t border-line pt-5">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-semibold">Costing</h3>
                <Badge size="sm">Visible to editors only</Badge>
              </div>
              <p className="mb-3 text-[12.5px] text-ink-3">{datesOk ? 'Plan who works on which milestone. Cost, price and margin update as you type.' : 'Set the project start and end dates to calculate working days and man-days.'}</p>
              {Object.keys(costErrors).length > 0 && (
                <Callout tone="danger" className="mb-3">
                  {Object.values(costErrors)[0]}
                </Callout>
              )}
              <CostingEditor draft={draft} onChange={(d) => { setDraft(d); setCostErrors({}) }} preview={preview} errors={costErrors} loading={pv.isFetching} />
            </section>
          )}
        </>
      )}
    </Dialog>
  )
}
