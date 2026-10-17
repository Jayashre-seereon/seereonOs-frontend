// Building blocks of the invoice editor: party fields (seller / bill-to / ship-to), the line-item editor,
// and the "Bill approved hours" picker for T&M projects. Totals and taxable values come from the server preview.
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from '@/ui/icons'
import { Button, Checkbox, Dialog, EmptyState, Field, IconButton, Input, MoneyInput, Select, Textarea } from '@/ui'
import { useApi } from '@/api/query'
import { invoicesApi, type InvoiceLine, type InvoiceParty, type InvoiceTotals } from '@/api/invoices'
import { addDays, todayISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { fmtQty, inr } from './labels'

export type Errs = Record<string, string>
const errOf = (errs: Errs, k: string) => errs[k] || undefined

/* ---------------- party ---------------- */
export function PartyFields({ prefix, value, onChange, states, errs, seller }: { prefix: string; value: InvoiceParty; onChange: (p: InvoiceParty) => void; states: { code: string; name: string }[]; errs: Errs; seller?: boolean }) {
  const set = (k: keyof InvoiceParty, v: string) => {
    const next = { ...value, [k]: v }
    if (k === 'state_code') {
      next.state = v === '96' ? value.state && value.country !== 'India' ? value.state : '' : states.find((s) => s.code === v)?.name ?? ''
      if (v === '96' && (!value.country || value.country === 'India')) next.country = ''
      if (v !== '96' && value.country !== 'India') next.country = 'India'
    }
    if (k === 'gstin' && /^\d{2}/.test(v) && !value.state_code) {
      const st = states.find((s) => s.code === v.slice(0, 2))
      if (st) Object.assign(next, { state_code: st.code, state: st.name })
    }
    if (k === 'gstin' && v.length === 15 && !value.pan) next.pan = v.slice(2, 12)
    onChange(next)
  }
  const e = (k: string) => errOf(errs, `${prefix}.${k}`)
  const foreign = value.state_code === '96'
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={seller ? 'Legal name' : 'Name'} required error={e('name')} className="sm:col-span-2">
        <Input value={value.name} onChange={(x) => set('name', x.target.value)} invalid={!!e('name')} />
      </Field>
      <Field label="Address" required error={e('address')} className="sm:col-span-2">
        <Textarea rows={2} value={value.address} onChange={(x) => set('address', x.target.value)} invalid={!!e('address')} className="min-h-[60px]" />
      </Field>
      <Field label="City">
        <Input value={value.city} onChange={(x) => set('city', x.target.value)} />
      </Field>
      <Field label="PIN code" error={e('pincode')}>
        <Input inputMode="numeric" value={value.pincode} onChange={(x) => set('pincode', x.target.value)} invalid={!!e('pincode')} />
      </Field>
      <Field label="State (GST code)" required error={e('state_code')}>
        <Select value={value.state_code} onChange={(x) => set('state_code', x.target.value)} invalid={!!e('state_code')} placeholder="Choose state" options={states.filter((s) => !seller || s.code !== '96').map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` }))} />
      </Field>
      {foreign ? (
        <Field label="Country">
          <Input value={value.country} onChange={(x) => onChange({ ...value, country: x.target.value })} placeholder="e.g. Germany" />
        </Field>
      ) : (
        <Field label="GSTIN" required={seller} error={e('gstin')} hint={seller ? undefined : 'Leave blank for an unregistered client'}>
          <Input value={value.gstin} onChange={(x) => set('gstin', x.target.value.toUpperCase())} invalid={!!e('gstin')} maxLength={15} className="tnum" />
        </Field>
      )}
      {foreign && (
        <Field label="Region / state" className="sm:col-span-2">
          <Input value={value.state} onChange={(x) => onChange({ ...value, state: x.target.value })} placeholder="e.g. Bavaria" />
        </Field>
      )}
      <Field label="PAN" error={e('pan')}>
        <Input value={value.pan} onChange={(x) => set('pan', x.target.value.toUpperCase())} invalid={!!e('pan')} maxLength={10} className="tnum" />
      </Field>
      {seller ? (
        <Field label="CIN">
          <Input value={value.cin ?? ''} onChange={(x) => onChange({ ...value, cin: x.target.value.toUpperCase() })} className="tnum" />
        </Field>
      ) : (
        <Field label="Contact person">
          <Input value={value.contact} onChange={(x) => set('contact', x.target.value)} />
        </Field>
      )}
      <Field label="Email" error={e('email')}>
        <Input type="email" value={value.email} onChange={(x) => set('email', x.target.value)} invalid={!!e('email')} />
      </Field>
      <Field label="Phone">
        <Input value={value.phone} onChange={(x) => set('phone', x.target.value)} />
      </Field>
    </div>
  )
}

export function PartySummary({ p }: { p: InvoiceParty }) {
  return (
    <div className="min-w-0 text-[13px]">
      <div className="font-medium text-ink">{p.name || '—'}</div>
      <div className="text-ink-2">{[p.address, p.city, p.pincode].filter(Boolean).join(', ')}</div>
      <div className="tnum text-ink-3">
        {p.state_code ? `${p.state || ''} (${p.state_code})` : 'State not set'} · GSTIN {p.gstin || '—'}{p.pan ? ` · PAN ${p.pan}` : ''}
      </div>
    </div>
  )
}

/* ---------------- lines ---------------- */
let seq = 0
export const newLineId = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`
export function blankLine(sac: string, gst: number, unit: string): InvoiceLine {
  return { id: newLineId(), item: '', description: '', hsn_sac: sac, qty: 1, unit, rate_paise: 0, discount_pct: 0, gst_rate: gst, source: { kind: 'manual' } }
}

export function LinesEditor({ lines, onChange, totals, units, rates, exportMode, errs }: { lines: InvoiceLine[]; onChange: (l: InvoiceLine[]) => void; totals: InvoiceTotals | null; units: string[]; rates: number[]; exportMode: boolean; errs: Errs }) {
  const set = (i: number, patch: Partial<InvoiceLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const remove = (i: number) => onChange(lines.filter((_, j) => j !== i))
  const calc = (l: InvoiceLine, i: number) => totals?.lines.find((x) => x.id === l.id) ?? totals?.lines[i]
  const e = (i: number, k: string) => errOf(errs, `lines.${i}.${k}`)
  const sourceTag = (l: InvoiceLine) => (l.source?.kind === 'milestone' ? 'Milestone' : l.source?.kind === 'hours' ? `Approved hours ${l.source.from ?? ''} → ${l.source.to ?? ''}` : null)
  const unitOpts = (u: string) => (units.includes(u) ? units : [...units, u])
  if (!lines.length) return <EmptyState compact title="No line items yet" body="Pick a milestone above, bill approved hours, or add a line." />
  return (
    <>
      {/* desktop table */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[980px] text-[13px]">
          <thead className="border-b border-line text-left text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
            <tr>
              <th className="py-2 pr-2 font-semibold">Item and description</th>
              <th className="w-[96px] py-2 pr-2 font-semibold">HSN/SAC</th>
              <th className="w-[84px] py-2 pr-2 font-semibold">Qty</th>
              <th className="w-[96px] py-2 pr-2 font-semibold">Unit</th>
              <th className="w-[136px] py-2 pr-2 font-semibold">Rate</th>
              <th className="w-[76px] py-2 pr-2 font-semibold">Disc. %</th>
              <th className="w-[84px] py-2 pr-2 font-semibold">GST</th>
              <th className="w-[120px] py-2 pr-2 text-right font-semibold">Taxable</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="border-b border-line align-top">
                <td className="py-2 pr-2">
                  <Input aria-label={`Line ${i + 1} item`} value={l.item} onChange={(x) => set(i, { item: x.target.value })} invalid={!!e(i, 'item')} placeholder="Item name, e.g. M2 Core ERP modules" />
                  <Input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(x) => set(i, { description: x.target.value })} placeholder="Description (optional)" className="mt-1.5 [--ctl-h:32px] text-[12.5px]" />
                  {sourceTag(l) && <div className="mt-1 text-[11.5px] text-ink-3">{sourceTag(l)}</div>}
                  {(e(i, 'item') || e(i, 'qty') || e(i, 'hsn_sac') || e(i, 'rate_paise')) && <div className="mt-1 text-[12px] font-medium text-danger-text">{e(i, 'item') || e(i, 'qty') || e(i, 'hsn_sac') || e(i, 'rate_paise')}</div>}
                </td>
                <td className="py-2 pr-2"><Input aria-label={`Line ${i + 1} HSN/SAC`} value={l.hsn_sac} onChange={(x) => set(i, { hsn_sac: x.target.value.replace(/\D/g, '') })} invalid={!!e(i, 'hsn_sac')} className="tnum" /></td>
                <td className="py-2 pr-2"><Input aria-label={`Line ${i + 1} quantity`} type="number" min={0} step="0.01" value={Number.isFinite(l.qty) ? l.qty : ''} onChange={(x) => set(i, { qty: x.target.value === '' ? NaN : Number(x.target.value) })} invalid={!!e(i, 'qty')} className="tnum" /></td>
                <td className="py-2 pr-2"><Select aria-label={`Line ${i + 1} unit`} value={l.unit} onChange={(x) => set(i, { unit: x.target.value })} options={unitOpts(l.unit)} /></td>
                <td className="py-2 pr-2"><MoneyInput value={l.rate_paise} onChange={(v) => set(i, { rate_paise: v })} invalid={!!e(i, 'rate_paise')} /></td>
                <td className="py-2 pr-2"><Input aria-label={`Line ${i + 1} discount`} type="number" min={0} max={100} step="0.5" value={l.discount_pct} onChange={(x) => set(i, { discount_pct: Number(x.target.value) || 0 })} invalid={!!e(i, 'discount_pct')} className="tnum" /></td>
                <td className="py-2 pr-2">
                  <Select aria-label={`Line ${i + 1} GST rate`} value={String(exportMode ? 0 : l.gst_rate)} disabled={exportMode} onChange={(x) => set(i, { gst_rate: Number(x.target.value) })} options={rates.map((r) => ({ value: String(r), label: `${r}%` }))} />
                </td>
                <td className="tnum whitespace-nowrap py-2 pr-2 pt-[9px] text-right">
                  <div className="font-medium text-ink">{inr(calc(l, i)?.taxable)}</div>
                  {!!calc(l, i)?.discount && <div className="text-[11.5px] text-ink-3">− {inr(calc(l, i)?.discount)}</div>}
                </td>
                <td className="py-2"><IconButton size="sm" label={`Remove line ${i + 1}`} onClick={() => remove(i)}><Trash2 className="size-4" /></IconButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* phones and tablets: one card per line */}
      <ul className="space-y-3 lg:hidden">
        {lines.map((l, i) => (
          <li key={l.id} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink-3">Line {i + 1}{sourceTag(l) ? ` · ${sourceTag(l)}` : ''}</span>
              <IconButton size="sm" label={`Remove line ${i + 1}`} onClick={() => remove(i)}><Trash2 className="size-4" /></IconButton>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Item" required error={e(i, 'item')} className="col-span-2"><Input value={l.item} onChange={(x) => set(i, { item: x.target.value })} invalid={!!e(i, 'item')} /></Field>
              <Field label="Description" className="col-span-2"><Input value={l.description} onChange={(x) => set(i, { description: x.target.value })} /></Field>
              <Field label="HSN/SAC" error={e(i, 'hsn_sac')}><Input inputMode="numeric" value={l.hsn_sac} onChange={(x) => set(i, { hsn_sac: x.target.value.replace(/\D/g, '') })} invalid={!!e(i, 'hsn_sac')} /></Field>
              <Field label="GST">
                <Select value={String(exportMode ? 0 : l.gst_rate)} disabled={exportMode} onChange={(x) => set(i, { gst_rate: Number(x.target.value) })} options={rates.map((r) => ({ value: String(r), label: `${r}%` }))} />
              </Field>
              <Field label="Qty" error={e(i, 'qty')}><Input type="number" min={0} step="0.01" value={Number.isFinite(l.qty) ? l.qty : ''} onChange={(x) => set(i, { qty: x.target.value === '' ? NaN : Number(x.target.value) })} invalid={!!e(i, 'qty')} /></Field>
              <Field label="Unit"><Select value={l.unit} onChange={(x) => set(i, { unit: x.target.value })} options={unitOpts(l.unit)} /></Field>
              <Field label="Rate" error={e(i, 'rate_paise')}><MoneyInput value={l.rate_paise} onChange={(v) => set(i, { rate_paise: v })} invalid={!!e(i, 'rate_paise')} /></Field>
              <Field label="Discount %"><Input type="number" min={0} max={100} step="0.5" value={l.discount_pct} onChange={(x) => set(i, { discount_pct: Number(x.target.value) || 0 })} /></Field>
            </div>
            <div className="tnum mt-2 flex items-baseline justify-between border-t border-line pt-2 text-[13px]">
              <span className="text-ink-3">{fmtQty(Number.isFinite(l.qty) ? l.qty : 0)} × {inr(l.rate_paise)}</span>
              <span className="font-medium">Taxable {inr(calc(l, i)?.taxable)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

/* ---------------- bill approved hours ---------------- */
const monthStart = (iso: string) => iso.slice(0, 8) + '01'
export function HoursDialog({ open, onClose, projectId, invoiceId, sac, gst, onAdd }: { open: boolean; onClose: () => void; projectId: string; invoiceId?: string; sac: string; gst: number; onAdd: (lines: InvoiceLine[]) => void }) {
  const today = todayISO()
  const lastMonthEnd = addDays(monthStart(today), -1)
  const [from, setFrom] = useState(monthStart(lastMonthEnd))
  const [to, setTo] = useState(lastMonthEnd)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [rates, setRates] = useState<Record<string, number>>({})
  const valid = !!from && !!to && from <= to
  const q = useApi(['invoices', 'hours', projectId, from, to, invoiceId ?? ''], () => invoicesApi.billableHours(projectId, from, to, invoiceId), { enabled: open && !!projectId && valid, staleTime: 0 })
  useEffect(() => {
    if (!q.data) return
    setPicked(Object.fromEntries(q.data.people.filter((p) => p.unbilled_hours > 0).map((p) => [p.user_id, true])))
    setRates(Object.fromEntries(q.data.people.map((p) => [p.user_id, p.rate_paise])))
  }, [q.data])
  const chosen = useMemo(() => (q.data?.people ?? []).filter((p) => picked[p.user_id] && p.unbilled_hours > 0), [q.data, picked])
  const add = () => {
    onAdd(
      chosen.map((p) => ({
        id: newLineId(), item: `Professional services — ${p.name}`, description: `Approved timesheet hours ${from} to ${to}`, hsn_sac: sac, qty: p.unbilled_hours, unit: 'Hrs', rate_paise: rates[p.user_id] ?? p.rate_paise,
        discount_pct: 0, gst_rate: gst, source: { kind: 'hours', user_id: p.user_id, from, to, hours: p.unbilled_hours },
      })),
    )
    onClose()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Bill approved hours"
      description="Approved timesheet hours on this project's tasks that are not on an issued invoice yet. Each person becomes a line: hours × rate."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen.length} onClick={add}>{chosen.length ? `Add ${chosen.length} line${chosen.length === 1 ? '' : 's'}` : 'Add lines'}</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" error={!valid ? 'The start is after the end.' : undefined}><Input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} invalid={!valid} /></Field>
        <Field label="To"><Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        {q.isLoading ? (
          <p className="text-[13px] text-ink-3">Loading hours…</p>
        ) : !q.data?.people.length ? (
          <EmptyState compact title="No hours in this period" body="Nobody logged time on this project's tasks between these dates." />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {q.data.people.map((p) => (
              <li key={p.user_id} className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_150px] sm:items-center">
                <div className="min-w-0">
                  <Checkbox
                    checked={!!picked[p.user_id] && p.unbilled_hours > 0}
                    disabled={p.unbilled_hours <= 0}
                    onChange={(v) => setPicked((x) => ({ ...x, [p.user_id]: v }))}
                    label={<span className="font-medium">{p.name}</span>}
                    description={
                      <span className={cn('tnum', p.unbilled_hours <= 0 && 'text-ink-3')}>
                        {fmtQty(p.unbilled_hours)} h to bill{p.billed_hours ? ` · ${fmtQty(p.billed_hours)} h already billed` : ''}{p.pending_hours ? ` · ${fmtQty(p.pending_hours)} h awaiting approval` : ''}
                      </span>
                    }
                  />
                </div>
                <Field label="Rate per hour">
                  <MoneyInput value={rates[p.user_id] ?? p.rate_paise} onChange={(v) => setRates((x) => ({ ...x, [p.user_id]: v }))} disabled={p.unbilled_hours <= 0} />
                </Field>
              </li>
            ))}
          </ul>
        )}
        {q.data && <p className="mt-2 text-[12.5px] text-ink-3">{fmtQty(q.data.total_unbilled)} approved hours not yet billed. Suggested rates are cost per hour plus the project markup; change them as agreed with the client.</p>}
      </div>
    </Dialog>
  )
}

export function AddLineButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" icon={<Plus className="size-4" />} onClick={onClick}>Add line</Button>
}
