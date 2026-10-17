// Create / edit a GST tax invoice for a project (/finance/invoices/new, /finance/invoices/:id/edit).
// Project → milestones (each pre-fills a line at its billing amount) or ad-hoc lines (change requests, AMC months,
// approved T&M hours). Seller from the org profile, bill-to from the client master (editable; optional save-back),
// optional ship-to, numbering, place of supply, PO, reverse charge, bank, notes, terms, signatory.
// Every total, the tax mode (CGST+SGST vs IGST vs export) and the amount in words come from the server preview.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Clock, Pencil, Plus, Save, Send } from '@/ui/icons'
import { Badge, Button, Callout, Card, CardHeader, Checkbox, Combobox, ErrorState, Field, Input, PageHeader, Select, SkeletonCards, Switch, Textarea, useCan, useConfirm, useReadOnly } from '@/ui'
import { useApi, useMut } from '@/api/query'
import type { ApiError } from '@/api/http'
import { INVOICE_INVALIDATE, invoicesApi, useInvoice, useInvoiceMeta, type InvoiceDetail, type InvoiceLine, type InvoiceMeta, type PrefillMilestone, type SaveBody } from '@/api/invoices'
import { addDays, diffDays, fmtDate } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { HoursDialog, LinesEditor, PartyFields, PartySummary, blankLine, type Errs } from './invoice/editorParts'
import { TAX_MODE, inr } from './invoice/labels'

export default function InvoiceEditorPage() {
  const { id } = useParams()
  const meta = useInvoiceMeta()
  const existing = useInvoice(id)
  if (meta.isLoading || (id && existing.isLoading)) return <SkeletonCards n={3} />
  if (meta.error || !meta.data) return <ErrorState error={meta.error} onRetry={() => meta.refetch()} />
  if (id && (existing.error || !existing.data)) return <ErrorState error={existing.error ?? new Error('Invoice not found')} onRetry={() => existing.refetch()} />
  if (existing.data && existing.data.status !== 'draft') return <LockedEditor d={existing.data} />
  return <Editor meta={meta.data} existing={existing.data ?? null} />
}

/* ---------------- issued invoices: notes only ---------------- */
function LockedEditor({ d }: { d: InvoiceDetail }) {
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const [notes, setNotes] = useState(d.invoice.notes ?? '')
  const mut = useMut(() => invoicesApi.saveNotes(d.invoice.id, notes, d.invoice.version), { invalidate: INVOICE_INVALIDATE, success: 'Notes saved', onSuccess: () => nav(`/finance/invoices/${d.invoice.id}`) })
  const cancelled = d.status === 'cancelled'
  return (
    <div className="max-w-[760px]">
      <PageHeader back={{ to: `/finance/invoices/${d.invoice.id}`, label: d.invoice.number }} title={`Edit ${d.invoice.number}`} />
      <Callout tone={cancelled ? 'danger' : 'info'} className="mb-4">
        {cancelled ? 'This invoice is cancelled and can’t be changed.' : 'An issued invoice is locked except its notes (GST rules). To change anything else, cancel it with a reason and raise a new one.'}
      </Callout>
      {!cancelled && (
        <Card>
          <Field label="Notes">
            <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button onClick={() => nav(`/finance/invoices/${d.invoice.id}`)}>Back to invoice</Button>
            <Button variant="primary" disabled={readOnly} loading={mut.isPending} onClick={() => mut.mutate(undefined)}>Save notes</Button>
          </div>
        </Card>
      )}
    </div>
  )
}

/* ---------------- draft editor ---------------- */
type Form = SaveBody
function fromDetail(d: InvoiceDetail): Form {
  const i = d.invoice
  return {
    id: i.id, project_id: i.project_id, milestone_ids: i.milestone_ids ?? [], client_id: i.client_id ?? null, seller: i.seller!, bill_to: i.bill_to!, ship_to: i.ship_to ?? null, invoiced_on: i.invoiced_on, due_on: i.due_on,
    place_of_supply: i.place_of_supply ?? '', po_reference: i.po_reference ?? '', po_date: i.po_date ?? null, reverse_charge: !!i.reverse_charge, lines: i.lines ?? [], tds_pct: i.tds_pct ?? 0,
    bank: i.bank ?? { bank_name: '', account_name: '', account_number: '', ifsc: '', branch: '', upi: '' }, notes: i.notes ?? '', terms: i.terms ?? '', signatory: i.signatory ?? { name: '', title: '' },
  }
}
function blankForm(meta: InvoiceMeta): Form {
  const s = meta.settings
  return {
    project_id: '', milestone_ids: [], client_id: null, seller: meta.seller, bill_to: { name: '', address: '', city: '', state: '', state_code: '', pincode: '', country: 'India', gstin: '', pan: '', email: '', phone: '', contact: '' },
    ship_to: null, invoiced_on: meta.today, due_on: addDays(meta.today, s.payment_terms_days), place_of_supply: '', po_reference: '', po_date: null, reverse_charge: false, lines: [], tds_pct: s.default_tds_pct,
    bank: { ...s.bank }, notes: s.default_notes, terms: s.default_terms, signatory: { name: s.signatory_name, title: s.signatory_title },
  }
}
function useDebounced<T>(v: T, ms: number) {
  const [x, setX] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return x
}

function Editor({ meta, existing }: { meta: InvoiceMeta; existing: InvoiceDetail | null }) {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const can = useCan()
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const disabled = readOnly || !can('finance.edit')
  const s = meta.settings
  const [form, setForm] = useState<Form>(() => (existing ? fromDetail(existing) : blankForm(meta)))
  const [termsDays, setTermsDays] = useState(() => (existing ? Math.max(0, diffDays(existing.invoice.due_on, existing.invoice.invoiced_on)) : s.payment_terms_days))
  const [posTouched, setPosTouched] = useState(!!existing)
  const [editSeller, setEditSeller] = useState(false)
  const [editBank, setEditBank] = useState(false)
  const [saveClient, setSaveClient] = useState(false)
  const [numberOverride, setNumberOverride] = useState<string | null>(null)
  const [hours, setHours] = useState(false)
  const [showErrs, setShowErrs] = useState(false)
  const [serverErr, setServerErr] = useState<Errs>({})
  const [loadingProject, setLoadingProject] = useState(false)
  const dirty = useRef(false)

  const patch = (p: Partial<Form>) => {
    dirty.current = true
    setForm((f) => ({ ...f, ...p }))
  }

  // project → milestones list (billing state, already-invoiced flags)
  const ms = useApi(['invoices', 'ms', form.project_id, existing?.invoice.id ?? ''], () => invoicesApi.milestones(form.project_id, existing?.invoice.id), { enabled: !!form.project_id, staleTime: 0 })
  const project = meta.projects.find((p) => p.id === form.project_id) ?? null

  // load a project's prefill (seller, client, place of supply, due date, milestone lines)
  const loadProject = async (pid: string, mids: string[]) => {
    setLoadingProject(true)
    try {
      const pf = await invoicesApi.prefill(pid, mids)
      setForm((f) => ({ ...pf.draft, id: f.id, lines: [...pf.draft.lines, ...f.lines.filter((l) => l.source?.kind === 'manual' && l.item && f.project_id === pid)] }))
      setTermsDays(pf.payment_terms_days)
      setPosTouched(false)
      setSaveClient(false)
    } finally {
      setLoadingProject(false)
    }
  }
  const initDone = useRef(false)
  useEffect(() => {
    if (initDone.current || existing) return
    initDone.current = true
    const pid = params.get('project')
    if (pid && meta.projects.some((p) => p.id === pid)) loadProject(pid, (params.get('milestones') ?? params.get('milestone') ?? '').split(',').filter(Boolean))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeProject = async (pid: string | null) => {
    if (!pid || pid === form.project_id) return
    if (form.lines.length && !(await confirm({ title: 'Switch project?', body: 'Milestone and hours lines belong to the current project and are removed. Typed-in lines are removed too.', confirmLabel: 'Switch project', tone: 'primary' }))) return
    setForm((f) => ({ ...f, lines: [] }))
    loadProject(pid, [])
  }

  // server preview (totals, tax mode, words, issues) — debounced
  const body = useMemo<Form>(() => ({ ...form, number: numberOverride ?? undefined }), [form, numberOverride])
  const debounced = useDebounced(body, 300)
  const preview = useApi(['invoice-preview', JSON.stringify(debounced)], () => invoicesApi.preview(debounced), { placeholderData: (prev) => prev, staleTime: 60_000 })
  const totals = preview.data?.totals ?? null
  const mode = totals?.tax_mode ?? (form.place_of_supply === '96' ? 'export' : form.place_of_supply && form.place_of_supply === form.seller.state_code ? 'intra' : 'inter')
  const issues = preview.data?.issues ?? []
  const errs: Errs = useMemo(() => {
    const e: Errs = {}
    if (showErrs) for (const i of issues) if (!e[i.field]) e[i.field] = i.message
    return { ...e, ...serverErr }
  }, [issues, showErrs, serverErr])

  // bill-to state drives the place of supply until the user picks one
  useEffect(() => {
    if (posTouched) return
    const pos = form.bill_to.state_code || ''
    if (pos && pos !== form.place_of_supply) setForm((f) => ({ ...f, place_of_supply: pos }))
  }, [form.bill_to.state_code, posTouched, form.place_of_supply])

  const toggleMilestone = (m: PrefillMilestone, on: boolean) => {
    if (!project) return
    const gst = mode === 'export' ? 0 : s.default_gst_rate
    if (on)
      patch({
        milestone_ids: [...form.milestone_ids, m.id],
        lines: [...form.lines, { id: `ms_${m.id}`, item: `M${m.no} ${m.name}`, description: `${project.name} — milestone ${m.no}`, hsn_sac: s.default_sac, qty: 1, unit: 'Lot', rate_paise: m.billing_amount_paise, discount_pct: 0, gst_rate: gst, source: { kind: 'milestone', milestone_id: m.id } }],
      })
    else patch({ milestone_ids: form.milestone_ids.filter((x) => x !== m.id), lines: form.lines.filter((l) => !(l.source?.kind === 'milestone' && l.source.milestone_id === m.id)) })
  }
  const setLines = (lines: InvoiceLine[]) => {
    // removing a milestone line also unticks the milestone
    const kept = new Set(lines.filter((l) => l.source?.kind === 'milestone').map((l) => l.source!.milestone_id))
    patch({ lines, milestone_ids: form.milestone_ids.filter((x) => kept.has(x)) })
  }
  const pickClient = async (cid: string | null) => {
    if (!cid) return
    const r = await invoicesApi.clientParty(cid)
    patch({ client_id: cid, bill_to: r.party })
    setTermsDays(r.payment_terms_days)
    patch({ due_on: addDays(form.invoiced_on || meta.today, r.payment_terms_days) })
    setPosTouched(false)
  }

  const onErr = (e: ApiError) => {
    setShowErrs(true)
    if (e.field) setServerErr({ [e.field]: e.message })
  }
  const save = useMut((issue: boolean) => {
    const b: SaveBody = { ...form, number: issue ? numberOverride ?? undefined : undefined, issue, save_client: saveClient }
    return existing ? invoicesApi.save(existing.invoice.id, b, existing.invoice.version) : invoicesApi.create(b)
  }, {
    invalidate: INVOICE_INVALIDATE,
    success: (r, issue) => (issue ? `Invoice ${r.invoice.number} issued` : 'Draft saved'),
    onSuccess: (r) => {
      dirty.current = false
      nav(`/finance/invoices/${r.invoice.id}`, { replace: true })
    },
    onError: onErr,
  })
  const doSave = (issue: boolean) => {
    setServerErr({})
    if (issue) {
      setShowErrs(true)
      if (issues.length) return
    }
    save.mutate(issue)
  }

  const exportMode = mode === 'export'
  const ready = !!form.project_id
  const milestoneOpts = ms.data ?? []
  const states = meta.states
  const e = (k: string) => errs[k] || undefined
  const numberShown = numberOverride ?? preview.data?.next_number ?? meta.next_number

  return (
    <div>
      <PageHeader
        back={{ to: existing ? `/finance/invoices/${existing.invoice.id}` : '/finance/invoices', label: existing ? 'Draft invoice' : 'Invoices' }}
        title={existing ? `Edit draft invoice ${existing.invoice.draft_no ?? ''}`.trim() : 'Create invoice'}
        subtitle="A GST tax invoice for a project. Totals, CGST/SGST or IGST and the amount in words are calculated as you type."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* project & milestones */}
          <Card>
            <CardHeader title="Project and what you are billing" subtitle="Pick milestones to bill, add approved hours (T&M), or add lines for change requests, AMC months and other items." />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Project" required error={e('project_id')}>
                <Combobox
                  value={form.project_id || null}
                  onChange={changeProject}
                  invalid={!!e('project_id')}
                  disabled={disabled || loadingProject}
                  placeholder="Choose a project"
                  options={meta.projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}`, hint: `${p.client} · ${p.billing_model === 'tm' ? 'T&M' : p.billing_model === 'fixed' ? 'Fixed price' : p.billing_model.replace('_', ' ')}` }))}
                />
              </Field>
              {project && (
                <div className="min-w-0 text-[13px] md:pt-7">
                  <span className="text-ink-3">Client </span>
                  <span className="font-medium text-ink">{project.client}</span>
                  <span className="text-ink-3"> · {project.billing_model === 'tm' ? 'Time & material' : project.billing_model === 'fixed' ? 'Fixed price' : project.billing_model.replace('_', ' ')}</span>
                </div>
              )}
            </div>
            {ready && (
              <div className="mt-4">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-ink">Milestones</h3>
                  {e('milestone_ids') && <span className="text-[12.5px] font-medium text-danger-text">{e('milestone_ids')}</span>}
                </div>
                {ms.isLoading ? (
                  <p className="text-[13px] text-ink-3">Loading milestones…</p>
                ) : !milestoneOpts.length ? (
                  <p className="text-[13px] text-ink-3">This project has no milestones. Add lines below instead.</p>
                ) : (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {milestoneOpts.map((m) => {
                      const taken = !!m.invoice_number || m.billing_status !== 'none'
                      const on = form.milestone_ids.includes(m.id)
                      return (
                        <li key={m.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                          <div className="min-w-0 flex-1">
                            <Checkbox
                              checked={on}
                              disabled={disabled || (taken && !on) || !m.billing_amount_paise}
                              onChange={(v) => toggleMilestone(m, v)}
                              label={<span className="font-medium">M{m.no} {m.name}</span>}
                              description={
                                taken ? `Already ${m.billing_status === 'paid' ? 'paid' : 'invoiced'}${m.invoice_number ? ` on ${m.invoice_number}` : ''}` : !m.billing_amount_paise ? 'No billing amount set on this milestone' : `${m.state.startsWith('achieved') ? 'Achieved — ready to invoice' : `Deadline ${fmtDate(m.planned_end)}`}${m.draft_numbers.length ? ` · also on ${m.draft_numbers.join(', ')}` : ''}`
                              }
                            />
                          </div>
                          <span className="tnum shrink-0 pl-7 text-[13px] font-medium sm:pl-0">{m.billing_amount_paise ? inr(m.billing_amount_paise) : '—'}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </Card>

          {/* lines */}
          {ready && (
            <Card>
              <CardHeader title="Line items" subtitle={`${TAX_MODE[mode].label}. HSN/SAC 998314 covers IT consulting and support.`} />
              <div className="-mt-1 mb-3 flex flex-wrap gap-2">
                <Button size="sm" icon={<Clock className="size-4" />} disabled={disabled} onClick={() => setHours(true)}>Bill approved hours</Button>
                <Button size="sm" icon={<Plus className="size-4" />} disabled={disabled} onClick={() => patch({ lines: [...form.lines, blankLine(s.default_sac, exportMode ? 0 : s.default_gst_rate, s.default_unit)] })}>Add line</Button>
              </div>
              {e('lines') && <p className="mb-2 text-[12.5px] font-medium text-danger-text">{e('lines')}</p>}
              <LinesEditor lines={form.lines} onChange={setLines} totals={totals} units={meta.units} rates={meta.gst_rates} exportMode={exportMode} errs={errs} />
            </Card>
          )}

          {/* parties */}
          {ready && (
            <Card>
              <CardHeader title="Bill to" subtitle="From the client master. Change it here for this invoice; tick the box to update the client master too." />
              <div className="mb-3 grid gap-3 md:grid-cols-2">
                <Field label="Client">
                  <Combobox value={form.client_id} onChange={pickClient} disabled={disabled} placeholder="Pick a client from the master" options={meta.clients.map((c) => ({ value: c.id, label: c.name, hint: c.gstin ? `${c.gstin} · ${c.state}` : c.state || c.country }))} />
                </Field>
                {form.client_id && (
                  <div className="md:pt-7">
                    <Checkbox checked={saveClient} disabled={disabled} onChange={setSaveClient} label="Save these details to the client master" />
                  </div>
                )}
              </div>
              <PartyFields prefix="bill_to" value={form.bill_to} onChange={(p) => patch({ bill_to: p })} states={states} errs={errs} />
              <div className="mt-4 border-t border-line pt-4">
                <Switch checked={!!form.ship_to} disabled={disabled} onChange={(v) => patch({ ship_to: v ? { ...form.bill_to } : null })} label="Different ship-to / site address" description="Shown as a separate block on the invoice" />
                {form.ship_to && (
                  <div className="mt-3">
                    <PartyFields prefix="ship_to" value={form.ship_to} onChange={(p) => patch({ ship_to: p })} states={states} errs={errs} />
                  </div>
                )}
              </div>
            </Card>
          )}

          {ready && (
            <Card>
              <CardHeader
                title="Seller"
                subtitle="Your company, from Setup → Organisation. Edit for this invoice only."
                action={!editSeller && <Button size="sm" icon={<Pencil className="size-4" />} disabled={disabled} onClick={() => setEditSeller(true)}>Edit</Button>}
              />
              {editSeller || Object.keys(errs).some((k) => k.startsWith('seller.')) ? (
                <PartyFields prefix="seller" seller value={form.seller} onChange={(p) => patch({ seller: p })} states={states} errs={errs} />
              ) : (
                <PartySummary p={form.seller} />
              )}
            </Card>
          )}

          {/* details */}
          {ready && (
            <Card>
              <CardHeader title="Invoice details" />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Field label="Invoice number" error={e('number')} hint={numberOverride === null ? 'Assigned from the series when you issue' : 'Must be unique, up to 16 characters'} aside={<button type="button" className="text-[12.5px] font-semibold text-brand-text hover:underline disabled:opacity-50" disabled={disabled} onClick={() => setNumberOverride(numberOverride === null ? numberShown : null)}>{numberOverride === null ? 'Change' : 'Use series'}</button>}>
                  <Input value={numberShown} disabled={numberOverride === null || disabled} onChange={(x) => setNumberOverride(x.target.value)} invalid={!!e('number')} className="tnum" />
                </Field>
                <Field label="Invoice date" required error={e('invoiced_on')}>
                  <Input type="date" value={form.invoiced_on} max={meta.today} disabled={disabled} invalid={!!e('invoiced_on')} onChange={(x) => patch({ invoiced_on: x.target.value, due_on: x.target.value ? addDays(x.target.value, termsDays) : form.due_on })} />
                </Field>
                <Field label="Due date" required error={e('due_on')} hint={`${termsDays}-day terms`}>
                  <Input type="date" value={form.due_on} min={form.invoiced_on} disabled={disabled} invalid={!!e('due_on')} onChange={(x) => { patch({ due_on: x.target.value }); if (x.target.value && form.invoiced_on) setTermsDays(Math.max(0, diffDays(x.target.value, form.invoiced_on))) }} />
                </Field>
                <Field label="Place of supply" required error={e('place_of_supply')} hint={mode === 'intra' ? 'Same state as yours: CGST + SGST' : mode === 'inter' ? 'Another state: IGST' : 'Outside India: export under LUT'}>
                  <Select value={form.place_of_supply} disabled={disabled} invalid={!!e('place_of_supply')} placeholder="Choose state" onChange={(x) => { setPosTouched(true); patch({ place_of_supply: x.target.value }) }} options={states.map((st) => ({ value: st.code, label: `${st.code} · ${st.name}` }))} />
                </Field>
                <Field label="PO / work order reference">
                  <Input value={form.po_reference} disabled={disabled} onChange={(x) => patch({ po_reference: x.target.value })} placeholder="e.g. PO-4471 or SOW title" />
                </Field>
                <Field label="PO date" error={e('po_date')}>
                  <Input type="date" value={form.po_date ?? ''} disabled={disabled} onChange={(x) => patch({ po_date: x.target.value || null })} />
                </Field>
                <Field label="TDS expected (%)" error={e('tds_pct')} hint="For information; the client deducts it">
                  <Input type="number" min={0} max={20} step={0.5} value={form.tds_pct} disabled={disabled} invalid={!!e('tds_pct')} onChange={(x) => patch({ tds_pct: Number(x.target.value) || 0 })} />
                </Field>
                <div className="sm:col-span-2 xl:col-span-2 xl:pt-7">
                  <Switch checked={form.reverse_charge} disabled={disabled} onChange={(v) => patch({ reverse_charge: v })} label="Tax payable on reverse charge" description="GST is shown but paid by the recipient, so it is left out of the total" />
                </div>
              </div>
            </Card>
          )}

          {ready && (
            <Card>
              <CardHeader
                title="Bank details, notes and terms"
                subtitle="Bank details come from Invoice settings."
                action={!editBank && <Button size="sm" icon={<Pencil className="size-4" />} disabled={disabled} onClick={() => setEditBank(true)}>Edit bank</Button>}
              />
              {editBank || Object.keys(errs).some((k) => k.startsWith('bank.')) ? (
                <div className="mb-4 grid gap-3 sm:grid-cols-2">
                  {([['bank_name', 'Bank name'], ['account_name', 'Account name'], ['account_number', 'Account number'], ['ifsc', 'IFSC'], ['branch', 'Branch'], ['upi', 'UPI ID']] as const).map(([k, l]) => (
                    <Field key={k} label={l} required={['bank_name', 'account_name', 'account_number', 'ifsc'].includes(k)} error={e(`bank.${k}`)}>
                      <Input value={form.bank[k] ?? ''} disabled={disabled} invalid={!!e(`bank.${k}`)} onChange={(x) => patch({ bank: { ...form.bank, [k]: k === 'ifsc' ? x.target.value.toUpperCase() : x.target.value } })} />
                    </Field>
                  ))}
                </div>
              ) : (
                <div className="tnum mb-4 text-[13px] text-ink-2">
                  {form.bank.bank_name || 'No bank'} · A/c {form.bank.account_number || '—'} · IFSC {form.bank.ifsc || '—'}{form.bank.branch ? ` · ${form.bank.branch}` : ''}{form.bank.upi ? ` · UPI ${form.bank.upi}` : ''}
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Notes" className="sm:col-span-2">
                  <Input value={form.notes} disabled={disabled} onChange={(x) => patch({ notes: x.target.value })} />
                </Field>
                <Field label="Terms and conditions" hint="One term per line" className="sm:col-span-2">
                  <Textarea rows={4} value={form.terms} disabled={disabled} onChange={(x) => patch({ terms: x.target.value })} />
                </Field>
                <Field label="Authorised signatory" required error={e('signatory.name')}>
                  <Input value={form.signatory.name} disabled={disabled} invalid={!!e('signatory.name')} onChange={(x) => patch({ signatory: { ...form.signatory, name: x.target.value } })} />
                </Field>
                <Field label="Designation">
                  <Input value={form.signatory.title} disabled={disabled} onChange={(x) => patch({ signatory: { ...form.signatory, title: x.target.value } })} />
                </Field>
              </div>
            </Card>
          )}
        </div>

        {/* summary */}
        <aside className="min-w-0">
          <div className="space-y-4 lg:sticky lg:top-4">
            <Card>
              <CardHeader title="Summary" action={<Badge size="sm" tone="neutral">{TAX_MODE[mode].short}</Badge>} />
              {!ready ? (
                <p className="text-[13px] text-ink-3">Choose a project to start.</p>
              ) : (
                <>
                  <dl className="tnum space-y-1.5 text-[13px]">
                    {[
                      ['Subtotal', totals?.subtotal ?? 0],
                      ...(totals?.discount ? [['Discount', -totals.discount]] : []),
                      ['Taxable value', totals?.taxable ?? 0],
                      ...(mode === 'intra' ? [['CGST', totals?.cgst ?? 0], ['SGST', totals?.sgst ?? 0]] : []),
                      ...(mode === 'inter' ? [['IGST', totals?.igst ?? 0]] : []),
                      ...(totals?.round_off ? [['Round off', totals.round_off]] : []),
                    ].map(([k, v]) => (
                      <div key={k as string} className="flex items-baseline justify-between gap-3">
                        <dt className="text-ink-3">{k}</dt>
                        <dd className="whitespace-nowrap text-ink">{inr(v as number)}</dd>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                      <dt className="font-semibold text-ink">Grand total</dt>
                      <dd className={cn('whitespace-nowrap text-[17px] font-semibold text-ink', preview.isFetching && 'opacity-60')}>{inr(totals?.total ?? 0)}</dd>
                    </div>
                  </dl>
                  {totals && <p className="mt-2 text-[12.5px] leading-snug text-ink-2">{totals.words}</p>}
                  {totals?.reverse_charge && <p className="mt-1 text-[12px] text-ink-3">GST of {inr(totals.tax)} payable by the recipient (reverse charge).</p>}
                  <p className="mt-2 text-[12px] text-ink-3">Revenue booked on issue: {inr(totals?.taxable ?? 0)} (taxable value). GST is a liability and is not revenue.</p>
                </>
              )}
              {ready && issues.length > 0 && (
                <div className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2">
                  <div className="text-[12.5px] font-semibold text-ink">To issue, fix {issues.length === 1 ? 'this' : `these ${issues.length}`}</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-2">
                    {issues.slice(0, 8).map((x, i) => <li key={i}>{x.message}</li>)}
                    {issues.length > 8 && <li>…and {issues.length - 8} more</li>}
                  </ul>
                </div>
              )}
              <div className="mt-4 flex flex-col gap-2">
                <Button variant="primary" icon={<Send className="size-4" />} disabled={disabled || !ready} loading={save.isPending && save.variables === true} onClick={() => doSave(true)}>Issue invoice</Button>
                <Button icon={<Save className="size-4" />} disabled={disabled || !ready} loading={save.isPending && save.variables === false} onClick={() => doSave(false)}>Save draft</Button>
                <Link to={existing ? `/finance/invoices/${existing.invoice.id}` : '/finance/invoices'} className="text-center text-[13px] font-medium text-ink-3 hover:text-ink">Cancel</Link>
              </div>
              <p className="mt-3 text-[12px] text-ink-3">Issuing assigns the number, books the revenue in the ledger{form.milestone_ids.length ? ' and marks the milestone Invoiced' : ''}. After that only the notes can change.</p>
            </Card>
          </div>
        </aside>
      </div>
      {ready && <HoursDialog open={hours} onClose={() => setHours(false)} projectId={form.project_id} invoiceId={existing?.invoice.id} sac={s.default_sac} gst={exportMode ? 0 : s.default_gst_rate} onAdd={(ls) => patch({ lines: [...form.lines, ...ls] })} />}
    </div>
  )
}
